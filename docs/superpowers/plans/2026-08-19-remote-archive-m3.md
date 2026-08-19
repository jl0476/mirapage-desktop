# M3 远程 Archive 物化 + 预载 + cache 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** SMB/WebDAV 上的 CBZ/ZIP 完整下载至本地 archive-cache 后解压读取——远程 ZIP 全链路（双击进入 → 准备态 → 条目视图 → 阅读 → 缩略图）+ 失效判定 + 断点续传 + 三级预载 + LRU 管理。

**架构：** `Materializer`（持 WebDAV/SMB 源的 `Arc<dyn MediaSource>`，不经 factory——断环）提供 `ensure_cached(origin, rel) -> PathBuf`；`ArchiveMediaSource` 三方法前置统一 `resolve_archive_path`（origin None 本地直开零回归 / Some 走物化）；下载 = 4MB 顺序 Range 循环 → `.part` 追加 → rename 前二次 stat 防变更；`archive_cache` 表（migration **016**）只存 ready 态；预载复用 thumbnail scheduler 模式。

**技术栈：** Rust（tokio / rusqlite / sha2 已在树内 / zip）+ Vue 3 / TS + Vitest / cargo test。

**规格：** `docs/superpowers/specs/2026-08-19-remote-archive-m3-design.md`（母设计 `2026-08-18-smb-remote-media-design.md` §5）。**migration 用 016**（015 已被 module3.1.1 position_kind 占用——计划期复核发现，spec 已勘误）。

**约定：** Rust 测试 `cargo test -p mirapage-desktop-lib <过滤词>`（`src-tauri/` 下）；前端 `npx vitest run <路径>`。CRLF 文件多行 Edit 用单行锚点。每任务收尾跑全量防回归。

**兼容性红线：** descriptor 契约零改动；Local ZIP（M1 已验收）零回归是硬门槛；表结构只增不改。

---

## 文件结构

**Rust 新建：**
- `src-tauri/src/source/archive/mod.rs` —— 模块声明（materializer / prefetch / dao）
- `src-tauri/src/source/archive/dao.rs` —— archive_cache 表 DAO（upsert/touch/get/evict/clear/usage）
- `src-tauri/src/source/archive/materializer.rs` —— cache_key / is_stale 纯函数 + ensure_cached 状态机 + chunk 下载 + 进度事件
- `src-tauri/src/source/archive/prefetch.rs` —— 三级预载调度（元数据 stat 预热 / 内容低优 / 强制=同步路径天然承担）

**Rust 修改：**
- `src-tauri/src/source/archive_impl.rs` —— 构造注入 `Arc<Materializer>` + `resolve_archive_path` 前置 + 三方法改造（旧文件保留，`source/archive/` 是新子模块不含它——避免大规模路径迁移，`archive_impl.rs` 顶层保留）
- `src-tauri/src/source/factory.rs` —— 构造顺序：concrete → Materializer → ArchiveMediaSource::new(mat) → Factory
- `src-tauri/src/source/webdav_impl.rs:247` —— `is_archive` 按扩展名判定
- `src-tauri/src/db/migrations.rs` —— migration 016
- `src-tauri/src/commands/mod.rs` + 新 `src-tauri/src/commands/archive_cache.rs` —— `clear_archive_cache` / `get_archive_cache_info`
- `src-tauri/src/lib.rs` —— Materializer manage + 命令注册 + 启动清理调用

**前端修改：**
- `src/stores/fileBrowser.ts` —— `openArchive` 泛化（archiveParent descriptor 形态）+ 进度事件文案
- `src/lib/tauri.ts` —— 清空/用量 IPC 封装
- `src/views/Settings.vue` —— remote section（3 UI 项）
- `src/locales/zh-CN.ts` / `en-US.ts` —— i18n 双语

---

### 任务 1：migration 016 + archive_cache DAO

**文件：**
- 修改：`src-tauri/src/db/migrations.rs`（015 之后追加 016）
- 创建：`src-tauri/src/source/archive/mod.rs`（`pub mod dao;` 等，后续任务逐个启用）
- 创建：`src-tauri/src/source/archive/dao.rs`
- 修改：`src-tauri/src/source/mod.rs`（`pub mod archive;`）

- [ ] **步骤 1：写失败测试（dao.rs 文件尾 tests 模块；连接用 migrations 跑全量的内存库——复用项目既有测试基建，见 `migrations.rs` 现有测试怎么建库，找不到先例就 `Connection::open_in_memory()` + `migrations::run(&conn)`）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn row(key: &str) -> NewCacheRow {
        NewCacheRow {
            cache_key: key.into(),
            origin_kind: "webdav".into(),
            archive_rel_path: "books/a.cbz".into(),
            origin_size: 100,
            origin_mtime: Some(1000),
            cache_abs_path: format!("C:/cache/{key}.zip"),
            byte_size: 100,
        }
    }

    #[test]
    fn upsert_get_touch_roundtrip() {
        let conn = db();
        upsert(&conn, &row("k1")).unwrap();
        let got = get(&conn, "k1").unwrap().unwrap();
        assert_eq!(got.archive_rel_path, "books/a.cbz");
        assert_eq!(got.origin_size, 100);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        touch(&conn, "k1").unwrap();
        let got2 = get(&conn, "k1").unwrap().unwrap();
        assert!(got2.last_accessed_at > got.last_accessed_at, "touch 刷新访问时间");
    }

    #[test]
    fn evict_oldest_first_respecting_protected() {
        let conn = db();
        upsert(&conn, &row("old")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        upsert(&conn, &row("new")).unwrap();
        // 淘汰 1 条（old 更旧），protected 指向 old 时跳过它淘汰 new
        let n = evict_to_limit(&conn, 0, &["old".to_string()]).unwrap();
        assert_eq!(n, 1);
        assert!(get(&conn, "old").unwrap().is_some(), "protected 不被淘汰");
        assert!(get(&conn, "new").unwrap().is_none());
    }

    #[test]
    fn clear_and_usage() {
        let conn = db();
        upsert(&conn, &row("k")).unwrap();
        let (count, bytes) = usage(&conn).unwrap();
        assert_eq!((count, bytes), (1, 100));
        // rev4：clear_all 返回被清路径（命令层实删文件依赖）
        let paths = clear_all(&conn).unwrap();
        assert_eq!(paths, vec!["C:/cache/k.zip".to_string()]);
        assert_eq!(usage(&conn).unwrap(), (0, 0));
        assert!(get(&conn, "k").unwrap().is_none());
    }

    #[test]
    fn migration_016_table_exists() {
        let conn = db();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='archive_cache'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
```

- [ ] **步骤 2：`cargo test -p mirapage-desktop-lib archive_cache\|dao::` → 编译失败（模块不存在）**

- [ ] **步骤 3：实现**

migrations.rs 追加（照抄既有 015 条目的样板结构——版本号、SQL、时间戳）：

```rust
        // 016: module3.4.0 远程 Archive 物化缓存索引（M3 spec §3）
        //      只存 ready 态；.part 不入表（断点续传靠文件系统存在性）
        conn.execute_batch(
            "CREATE TABLE archive_cache (
              cache_key TEXT PRIMARY KEY,
              origin_kind TEXT NOT NULL,
              archive_rel_path TEXT NOT NULL,
              origin_size INTEGER NOT NULL,
              origin_mtime INTEGER,
              cache_abs_path TEXT NOT NULL,
              byte_size INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              last_accessed_at INTEGER NOT NULL
            );",
        )?;
        // INSERT INTO _migrations (16, ...) —— 版本断言测试（migrations.rs 既有
        // 「版本号 == 16」断言，若有 COUNT 断言同步 bump）
```

dao.rs：

```rust
//! archive_cache 表 DAO（M3 spec §3；模式镜像 thumbnail/index.rs）

use rusqlite::{params, Connection, Result};

pub struct NewCacheRow {
    pub cache_key: String,
    pub origin_kind: String,
    pub archive_rel_path: String,
    pub origin_size: i64,
    pub origin_mtime: Option<i64>,
    pub cache_abs_path: String,
    pub byte_size: i64,
}

pub struct CacheRow {
    pub cache_key: String,
    pub origin_kind: String,
    pub archive_rel_path: String,
    pub origin_size: i64,
    pub origin_mtime: Option<i64>,
    pub cache_abs_path: String,
    pub byte_size: i64,
    pub created_at: i64,
    pub last_accessed_at: i64,
}

fn row_of(r: &rusqlite::Row) -> Result<CacheRow> {
    Ok(CacheRow {
        cache_key: r.get(0)?, origin_kind: r.get(1)?, archive_rel_path: r.get(2)?,
        origin_size: r.get(3)?, origin_mtime: r.get(4)?, cache_abs_path: r.get(5)?,
        byte_size: r.get(6)?, created_at: r.get(7)?, last_accessed_at: r.get(8)?,
    })
}

const COLS: &str = "cache_key, origin_kind, archive_rel_path, origin_size, origin_mtime, cache_abs_path, byte_size, created_at, last_accessed_at";

pub fn upsert(conn: &Connection, row: &NewCacheRow) -> Result<()> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    conn.execute(
        "INSERT INTO archive_cache (cache_key, origin_kind, archive_rel_path, origin_size, origin_mtime, cache_abs_path, byte_size, created_at, last_accessed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
         ON CONFLICT(cache_key) DO UPDATE SET origin_size=?4, origin_mtime=?5, cache_abs_path=?6, byte_size=?7, last_accessed_at=?8",
        params![row.cache_key, row.origin_kind, row.archive_rel_path, row.origin_size,
                row.origin_mtime, row.cache_abs_path, row.byte_size, now],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, cache_key: &str) -> Result<Option<CacheRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM archive_cache WHERE cache_key = ?1"))?;
    let mut rows = stmt.query(params![cache_key])?;
    match rows.next()? {
        Some(r) => Ok(Some(row_of(r)?)),
        None => Ok(None),
    }
}

pub fn touch(conn: &Connection, cache_key: &str) -> Result<()> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    conn.execute("UPDATE archive_cache SET last_accessed_at = ?1 WHERE cache_key = ?2", params![now, cache_key])?;
    Ok(())
}

/// 按 last_accessed_at 升序淘汰至 byte_total <= limit_bytes；protected 跳过。
/// 返回淘汰条数。逐批 256（模式同 thumbnail evict_to_limit）。
pub fn evict_to_limit(conn: &Connection, limit_bytes: i64, protected: &[String]) -> Result<usize> {
    let mut evicted = 0usize;
    loop {
        let total: i64 = conn.query_row("SELECT COALESCE(SUM(byte_size),0) FROM archive_cache", [], |r| r.get(0))?;
        if total <= limit_bytes { return Ok(evicted); }
        let mut stmt = conn.prepare(
            "SELECT cache_key, cache_abs_path FROM archive_cache
             WHERE cache_key NOT IN (SELECT value FROM json_each(?1))
             ORDER BY last_accessed_at ASC LIMIT 256")?;
        let victims: Vec<(String, String)> = stmt.query_map(
            params![serde_json::to_string(protected).unwrap_or_else(|_| "[]".to_string())],
            |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_>>()?;
        drop(stmt);
        if victims.is_empty() { return Ok(evicted); } // 全被保护
        for (key, abs) in &victims {
            conn.execute("DELETE FROM archive_cache WHERE cache_key = ?1", params![key])?;
            let _ = std::fs::remove_file(abs);
            evicted += 1;
        }
    }
}

/// 清表并返回被清的 cache_abs_path 列表（rev4：命令层要实删文件——裸 Result<()> 会把
/// 路径丢掉导致只清表不删文件）
pub fn clear_all(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT cache_abs_path FROM archive_cache")?;
    let paths: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_>>()?;
    drop(stmt);
    conn.execute("DELETE FROM archive_cache", [])?;
    Ok(paths)
}

/// (条数, 字节总量)
pub fn usage(conn: &Connection) -> Result<(i64, i64)> {
    conn.query_row("SELECT COUNT(*), COALESCE(SUM(byte_size),0) FROM archive_cache", [], |r| Ok((r.get(0)?, r.get(1)?)))
}
```

（`json_each(?1)` 需 SQLite JSON1——rusqlite bundled 特性默认带；若构建配置未启用则改动态拼 `NOT IN` 占位符。`evict` 循环内先 drop stmt 再删行避免借用冲突。）

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib dao` → PASS（4 用例）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/db/migrations.rs src-tauri/src/source/archive/ src-tauri/src/source/mod.rs
git commit -m "feat(archive): migration 016 archive_cache 表 + DAO（upsert/touch/evict LRU/protected/clear/usage）"
```

---

### 任务 2：Materializer 纯函数——cache_key + is_stale

**文件：**
- 创建：`src-tauri/src/source/archive/materializer.rs`（本任务只加纯函数；状态机任务 3 接续）
- 修改：`src-tauri/src/source/archive/mod.rs`（`pub mod materializer;`）

- [ ] **步骤 1：写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::descriptor::SourceDescriptor;
    use crate::source::trait_def::FileStat;

    fn webdav(path: &str) -> SourceDescriptor {
        SourceDescriptor::WebDav { account_id: 7, base_url: "https://d/x".into(), path: path.into() }
    }

    #[test]
    fn cache_key_stable_and_discriminating() {
        let k1 = cache_key(&webdav(""), "books/a.cbz");
        assert_eq!(k1, cache_key(&webdav(""), "books/a.cbz"), "同 origin+rel 同 key");
        assert_ne!(k1, cache_key(&webdav(""), "books/b.cbz"), "不同 rel 分 key");
        assert_ne!(k1, cache_key(&webdav("sub"), "books/a.cbz"), "不同 origin path 分 key");
        assert_eq!(k1.len(), 64, "sha256 hex");
    }

    #[test]
    fn is_stale_matrix() {
        let base = FileStat { size: 100, modified_at: Some(1000) };
        assert!(!is_stale(100, Some(1000), &base), "完全一致 → 新鲜");
        assert!(is_stale(200, Some(1000), &base), "size 变 → 失效");
        assert!(is_stale(100, Some(2000), &base), "mtime 变 → 失效");
        assert!(!is_stale(100, None, &base), "行 mtime None（物化时源没给）→ size 唯一判据，放行");
        assert!(is_stale(100, Some(1000), &FileStat { size: 100, modified_at: None }),
                "行有 mtime 但远端现在没有 → 保守失效（源行为变化）");
    }
}
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现（materializer.rs 头部）**

```rust
//! 远程 Archive 物化器（M3 spec §4）
//! cache_key = sha256(canonical origin descriptor JSON + '\0' + archive_rel_path)
//! （canonical = typed serde_json::to_string(SourceDescriptor)，migration 013 验证过的形态）

use crate::source::descriptor::SourceDescriptor;
use crate::source::trait_def::FileStat;

pub fn cache_key(origin: &SourceDescriptor, archive_rel_path: &str) -> String {
    let canonical = serde_json::to_string(origin).unwrap_or_default();
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(canonical.as_bytes());
    hasher.update([0u8]); // '\0' 分隔符：descriptor JSON 与 rel 边界不可伪造
    hasher.update(archive_rel_path.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 失效判定（spec §4.2）：size 不同 → 失效；双方 mtime Some 且不同 → 失效；
/// 行 mtime None → size 唯一判据（SMB mtime 缺失场景）保守放行；
/// 行有 mtime 但远端当前 None → 保守失效
pub fn is_stale(row_origin_size: i64, row_origin_mtime: Option<i64>, current: &FileStat) -> bool {
    if row_origin_size != current.size as i64 { return true; }
    match (row_origin_mtime, current.modified_at) {
        (Some(r), Some(c)) => r != c,
        (None, _) => false,
        (Some(_), None) => true,
    }
}
```

（`sha2` 依赖确认：thumbnail key.rs 用过 SHA-256——`Cargo.toml` 已有 `sha2`，无需新增；以 `grep -n sha2 src-tauri/Cargo.toml` 复核，缺则加。）

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib materializer` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/archive/materializer.rs src-tauri/src/source/archive/mod.rs
git commit -m "feat(archive): materializer 纯函数——sha256 cache_key（\\0 分隔）+ is_stale 失效矩阵"
```

---

### 任务 3：Materializer ensure_cached 状态机（mock 源全场景）

**文件：**
- 修改：`src-tauri/src/source/archive/materializer.rs`（追加状态机）

**可测性设计（spec §2「持两源 Arc」落地形态）**：Materializer 持 `webdav: Arc<dyn MediaSource>` + `smb: Arc<dyn MediaSource>`（trait 对象——生产注入真源，测试注入 mock；不递归经 factory 不变）。Db 句柄（Clone）查表。

- [ ] **步骤 1：写失败测试（mock MediaSource：字节可控 + 调用计数 + 错误注入）**

```rust
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc as StdArc;
    use crate::source::trait_def::{MediaSource, MediaSourceError, ByteRange};

    /// 内存 mock 源：stat/read 可编程 + 调用计数
    struct MockOrigin {
        stat_size: std::sync::Mutex<u64>,
        stat_mtime: std::sync::Mutex<Option<i64>>,
        bytes: std::sync::Mutex<Vec<u8>>,
        read_calls: AtomicUsize,
        fail_next_read: std::sync::atomic::AtomicBool,
    }

    impl MockOrigin {
        fn new(size: u64) -> Self {
            Self {
                stat_size: std::sync::Mutex::new(size),
                stat_mtime: std::sync::Mutex::new(Some(1000)),
                bytes: std::sync::Mutex::new(vec![7u8; size as usize]),
                read_calls: AtomicUsize::new(0),
                fail_next_read: std::sync::atomic::AtomicBool::new(false),
            }
        }
    }

    #[async_trait::async_trait]
    impl MediaSource for MockOrigin {
        fn descriptor_type(&self) -> &'static str { "mock" }
        async fn list_directory(&self, _: &SourceDescriptor, _: &str)
            -> crate::source::trait_def::Result<Vec<crate::source::descriptor::MediaEntry>> {
            Err(MediaSourceError::NotImplemented("mock".into()))
        }
        async fn read_file(&self, _: &SourceDescriptor, _: &str, range: Option<ByteRange>)
            -> crate::source::trait_def::Result<Vec<u8>> {
            if self.fail_next_read.swap(false, Ordering::SeqCst) {
                return Err(MediaSourceError::Network("injected".into()));
            }
            self.read_calls.fetch_add(1, Ordering::SeqCst);
            let bytes = self.bytes.lock().unwrap();
            match range {
                Some(r) => Ok(bytes[r.offset as usize..(r.offset + r.length) as usize].to_vec()),
                None => Ok(bytes.clone()),
            }
        }
        async fn file_count(&self, _: &SourceDescriptor, _: &str)
            -> crate::source::trait_def::Result<u64> { Ok(0) }
        async fn stat(&self, _: &SourceDescriptor, _: &str)
            -> crate::source::trait_def::Result<FileStat> {
            Ok(FileStat { size: *self.stat_size.lock().unwrap(),
                          modified_at: *self.stat_mtime.lock().unwrap() })
        }
        async fn test(&self, _: &SourceDescriptor)
            -> crate::source::trait_def::Result<()> { Ok(()) }
    }

    fn temp_materializer(origin: StdArc<MockOrigin>) -> (Materializer, tempdir_guard::Guard, crate::db::Db) {
        // tempdir 建 cache_root + part/；内存库跑 migrations；webdav 槽位注入 mock
        // （Guard = 丢弃时清理目录的简单 RAII；测试模块内定义）
        ...
    }

    #[tokio::test]
    async fn download_then_hit_then_revalidate() {
        let (m, _g, _db) = temp_materializer(StdArc::new(MockOrigin::new(10)));
        let p1 = m.ensure_cached(&webdav(""), "a.cbz").await.unwrap();
        assert!(p1.exists() && p1.extension().map(|e| e == "zip").unwrap_or(false));
        // 二次调用秒回：不再下载
        let before = { /* read_calls 计数 */ };
        let _p2 = m.ensure_cached(&webdav(""), "a.cbz").await.unwrap();
        assert_eq!(read_calls_now, before, "命中不再读源（只 stat 失效判定）");
    }

    #[tokio::test]
    async fn remote_change_invalidates() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        m.ensure_cached(&webdav(""), "a.cbz").await.unwrap();
        *mock.stat_size.lock().unwrap() = 20;              // 远端变更
        m.ensure_cached(&webdav(""), "a.cbz").await.unwrap(); // 失效重下
        // 断言：新文件 20 字节 + 表行 origin_size == 20
    }

    #[tokio::test]
    async fn rename_guard_requeues_once() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        // 下载中途换版本：第 2 次 stat（rename 前）返回不同 size
        // ——实现侧需要 stat 钩子；用 stat_size 在下载前后翻转模拟
        ... // 见步骤 3 状态机；断言最终 ready 文件是「新版本」字节且重试 ≤1 次
    }

    #[tokio::test]
    async fn resume_from_part() {
        // rev3 sidecar 严格校验（四关）：
        // ① .part(5/10) + 有效 sidecar（同 key/origin/rel/快照/downloaded=5）+ 远端一致
        //    → 只读后 5 字节（read_calls 断言）
        // ② sidecar 缺失 / JSON 损坏 / cache_key 不符 / downloaded != .part 长度
        //    → 弃 .part+sidecar 全量重下（各一子场景）
        // ③ sidecar 快照 mtime 与远端现值不符（同 size 换文件）→ 弃重下
        // ④ 远端截断（size < part size）→ 弃重下
        ...
    }

    #[tokio::test]
    async fn cancel_all_stops_forced_download_without_revive() {
        // rev3 generation 四检查点：慢源强制 ensure_cached 进行中调 cancel_all()
        // → 任务在 chunk/二次 stat/rename/upsert 之一处中止；
        // 最终：表无行 + final_path 不存在（不复活）+ 新 ensure_cached 正常工作（代际恢复）
        ...
    }

    #[tokio::test]
    async fn inflight_dedup_two_waiters() {
        // 慢源（read 带 delay）+ 并发两次 ensure_cached 同 key
        // → read_calls 只有一次全量序列；两者拿到同一路径
        ...
    }

    #[tokio::test]
    async fn network_error_keeps_part() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        mock.fail_next_read.store(true, Ordering::SeqCst);
        assert!(m.ensure_cached(&webdav(""), "a.cbz").await.is_err());
        // .part 保留（供续传）+ 表无行
        ...
    }
```

（标注 `...` 的用例体：按首用例模式补全——tempdir/计数断言都是模板化代码，步骤 3 的状态机函数签名固定后即可填。**执行者必须补全后再跑红**。）

- [ ] **步骤 2：`cargo test -p mirapage-desktop-lib materializer` → 编译失败**

- [ ] **步骤 3：实现状态机**

```rust
use crate::db::Db;
use rusqlite::params;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum MaterializeError {
    #[error("网络错误: {0}")]
    Network(String),
    #[error("远端文件不存在: {0}")]
    NotFound(String),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("其他: {0}")]
    Other(String),
}

impl From<MaterializeError> for crate::source::trait_def::MediaSourceError {
    fn from(e: MaterializeError) -> Self {
        match e {
            MaterializeError::Network(s) => crate::source::trait_def::MediaSourceError::Network(s),
            MaterializeError::NotFound(s) => crate::source::trait_def::MediaSourceError::NotFound(s),
            MaterializeError::Io(io) => crate::source::trait_def::MediaSourceError::Io(io),
            MaterializeError::Other(s) => crate::source::trait_def::MediaSourceError::Other(s),
        }
    }
}

const CHUNK: u64 = 4 * 1024 * 1024;

pub struct Materializer {
    webdav: Arc<dyn MediaSource>,
    smb: Arc<dyn MediaSource>,
    db: Db,
    cache_root: std::sync::RwLock<PathBuf>,
    /// in-flight 注册表 + 清空闸门**同一临界区**（rev5：AtomicBool 闸门与注册不原子，
    /// 迟到任务带新代际穿透清空——「查 clearing + 注册 inflight」必须一把锁内完成，
    /// begin_clearing 持同锁先置位再 drain）
    inflight: tokio::sync::Mutex<InflightState>,
    /// 窗口 epoch（rev2 双通道①）：预载切目录推进；仅 cancellable 任务检查
    epoch: std::sync::atomic::AtomicU64,
    /// cancellation generation（rev2 双通道②）：cancel_all() 单调自增；
    /// 预载与强制物化在每 chunk / 二次 stat 后 / rename 前 / upsert 前四检查点比对
    cancel_gen: std::sync::atomic::AtomicU64,
}

/// in-flight 注册表 + 清空闸门（同一把 async Mutex 保护——rev5 TOCTOU 修复）
pub struct InflightState {
    pub clearing: bool,
    pub map: HashMap<String, Arc<tokio::sync::Notify>>,
}

/// sidecar 元数据（rev2 重启续传）：与 .part 同目录同名 + .meta
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PartSidecar {
    pub cache_key: String,            // 身份重算比对（防 .part 被移动/误放）
    pub canonical_origin: String,     // serde_json::to_string(origin)——与 cache_key 输入同源
    pub archive_rel_path: String,
    pub snapshot_size: u64,
    pub snapshot_mtime: Option<i64>,
    pub downloaded: u64,              // 每 chunk 后更新（与 .part 文件长度一致性校验用）
}

pub fn sidecar_path(part_path: &std::path::Path) -> std::path::PathBuf {
    let mut s = part_path.as_os_str().to_os_string();
    s.push(".meta");
    std::path::PathBuf::from(s)
}

/// sidecar 原子写（tmp + rename）——半截 JSON 会被续传校验拒绝，但原子写让这几乎不发生
fn atomic_write_sidecar(part_path: &std::path::Path, sc: &PartSidecar) -> Result<(), MaterializeError> {
    let target = sidecar_path(part_path);
    let tmp = target.with_extension("meta.tmp");
    std::fs::write(&tmp, serde_json::to_vec(sc).map_err(|e| MaterializeError::Other(e.to_string()))?)
        .map_err(MaterializeError::Io)?;
    std::fs::rename(&tmp, &target).map_err(MaterializeError::Io)
}

impl Materializer {
    pub fn new(webdav: Arc<dyn MediaSource>, smb: Arc<dyn MediaSource>, db: Db, cache_root: PathBuf) -> Self {
        Self { webdav, smb, db, cache_root: std::sync::RwLock::new(cache_root),
               inflight: tokio::sync::Mutex::new(InflightState {
                   clearing: false, map: HashMap::new(),
               }),
               epoch: std::sync::atomic::AtomicU64::new(0),
               cancel_gen: std::sync::atomic::AtomicU64::new(0) }   // rev4 补齐（漏初始化=编译失败）
    }

    fn origin_source(&self, origin: &SourceDescriptor) -> Result<&Arc<dyn MediaSource>, MaterializeError> {
        match origin {
            SourceDescriptor::WebDav { .. } => Ok(&self.webdav),
            SourceDescriptor::Smb { .. } => Ok(&self.smb),
            _ => Err(MaterializeError::Other(format!("archive origin 仅支持 webdav/smb，得到 {:?}", origin.type_str()))),
        }
    }

    fn cache_paths(&self, key: &str) -> (PathBuf, PathBuf) {
        let root = self.cache_root.read().unwrap().clone();
        (root.join(format!("{key}.zip")), root.join("part").join(format!("{key}.part")))
    }

    pub fn new_epoch(&self, e: u64) { self.epoch.store(e, std::sync::atomic::Ordering::SeqCst); }
    fn current_epoch(&self) -> u64 { self.epoch.load(std::sync::atomic::Ordering::SeqCst) }

    /// rev2 双通道②：单调自增，新任务取新代际——预载在 clear 后自然恢复
    pub fn cancel_all(&self) { self.cancel_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
    pub fn cancel_generation(&self) -> u64 { self.cancel_gen.load(std::sync::atomic::Ordering::SeqCst) }
    /// rev5 清空闸门（持 inflight 同锁先置位——封死「查闸门→注册」TOCTOU）：
    /// begin = 锁内置 clearing=true 后 cancel_all；此时已注册任务都在 map 里可见，
    /// drain 会等它们；之后任何新 ensure_cached 在同一临界区看到 clearing 被拒
    pub async fn begin_clearing(&self) {
        {
            let mut st = self.inflight.lock().await;
            st.clearing = true;
        }
        self.cancel_all();
    }
    pub async fn end_clearing(&self) {
        self.inflight.lock().await.clearing = false;
    }
    pub fn cache_root(&self) -> PathBuf { self.cache_root.read().unwrap().clone() }
    pub async fn inflight_empty(&self) -> bool { self.inflight.lock().await.map.is_empty() }
    /// clear 用：等待在途任务退出（chunk/检查点粒度快速退出）；超时返回 false
    pub async fn wait_inflight_drained(&self, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while !self.inflight_empty().await {
            if tokio::time::Instant::now() >= deadline { return false; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        true
    }

    /// 强制路径（用户打开/阅读）——不可被窗口 epoch 取消，但受 cancellation generation 约束
    pub async fn ensure_cached(
        &self, origin: &SourceDescriptor, archive_rel_path: &str,
    ) -> Result<PathBuf, MaterializeError> {
        self.ensure_cached_inner(origin, archive_rel_path, false).await
    }

    /// 预载路径——窗口 epoch 与 generation 双通道均可取消
    pub async fn ensure_cached_cancellable(
        &self, origin: &SourceDescriptor, archive_rel_path: &str,
    ) -> Result<PathBuf, MaterializeError> {
        self.ensure_cached_inner(origin, archive_rel_path, true).await
    }

    async fn ensure_cached_inner(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, cancellable: bool,
    ) -> Result<PathBuf, MaterializeError> {
        let key = cache_key(origin, archive_rel_path);
        // 1. 表命中 → stat 失效判定
        //    rev4：Db 是 Mutex 包裹的连接——先读行后立刻 drop conn，再 await 远端 stat
        //    （持连接跨网络 await 会锁住整个数据库）；touch/删除时重新获取连接
        {
            let row = {
                let conn = self.db.conn();
                super::dao::get(&conn, &key).map_err(|e| MaterializeError::Other(e.to_string()))?
            };
            if let Some(row) = row {
                let src = self.origin_source(origin)?;
                let cur = src.stat(origin, archive_rel_path).await?;
                if !is_stale(row.origin_size, row.origin_mtime, &cur) {
                    let conn = self.db.conn();
                    let _ = super::dao::touch(&conn, &key);
                    return Ok(PathBuf::from(&row.cache_abs_path));
                }
                // 失效：删行 + 删文件
                {
                    let conn = self.db.conn();
                    let _ = conn.execute("DELETE FROM archive_cache WHERE cache_key = ?1", params![key]);
                }
                let _ = std::fs::remove_file(&row.cache_abs_path);
            }
        }
        // 2. 准入闸门 + in-flight 去重 + 注册——**同一把锁的单一临界区**（rev5）：
        //    rev4 的入口 AtomicBool 检查与此处注册之间有 TOCTOU 窗口（clear 在间隙
        //    begin_clearing 并观察到空表，本任务随后带新代际注册下载穿透清空）。
        //    现在「查 clearing + 查重 + 注册」原子完成；begin_clearing 持同锁置位，
        //    任何并发 ensure_cached 要么先注册（map 可见，drain 会等）、要么看到
        //    clearing=true 被拒——不存在中间态。Notified 仍持锁 enable() 预注册
        //    （rev4 丢唤醒修复保留）。
        let mut registered = false;
        {
            let mut st = self.inflight.lock().await;
            if st.clearing {
                return Err(MaterializeError::Other("cache clearing in progress".into()));
            }
            if let Some(notify) = st.map.get(&key).cloned() {
                let mut notified = notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable(); // 持锁预注册——此后 notify_waiters 不可能丢失
                drop(st);
                notified.await;
                let conn = self.db.conn();
                if let Some(row) = super::dao::get(&conn, &key)
                    .map_err(|e| MaterializeError::Other(e.to_string()))? {
                    return Ok(PathBuf::from(&row.cache_abs_path));
                }
                return Err(MaterializeError::Other("等待的物化任务未产出结果".into()));
            }
            st.map.insert(key.clone(), Arc::new(tokio::sync::Notify::new()));
            registered = true;
        }
        let _ = registered; // 调试期可断言；注册成功才走到下载
        // 3. 下载（退出时 notify + 移除 in-flight）——key 传借用（download 收 &str，
        //    且此处后续还要用 key 清理 inflight，不能 move）
        let result = self.download(origin, archive_rel_path, &key, cancellable).await;
        {
            let mut st = self.inflight.lock().await;
            if let Some(n) = st.map.remove(&key) { n.notify_waiters(); }
        }
        result
    }

    async fn download(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, key: &str, cancellable: bool,
    ) -> Result<PathBuf, MaterializeError> {
        let src = self.origin_source(origin)?;
        let (final_path, part_path) = self.cache_paths(key);
        std::fs::create_dir_all(part_path.parent().unwrap())
            .map_err(MaterializeError::Io)?;
        // 重试 ≤1（rename 前二次 stat 不一致 → 弃 .part 重下新版本）
        for attempt in 0..=1 {
            // 快照 stat
            let snap = src.stat(origin, archive_rel_path).await?;
            // 断点续传（rev2 严格校验）：.part 存在 → 先验 sidecar，四关全过才续传
            let mut offset: u64 = 0;
            if let Ok(meta) = std::fs::metadata(&part_path) {
                let have = meta.len();
                let canonical = serde_json::to_string(origin).unwrap_or_default();
                let sc_path = sidecar_path(&part_path);
                let resume_ok = std::fs::read(&sc_path).ok()
                    .and_then(|b| serde_json::from_slice::<PartSidecar>(&b).ok())
                    .map(|sc| {
                        sc.cache_key == key
                            && sc.canonical_origin == canonical
                            && sc.archive_rel_path == archive_rel_path
                            && sc.snapshot_size == snap.size
                            && sc.snapshot_mtime == snap.modified_at   // 快照 vs 远端 stat 一致
                            && sc.downloaded == have                   // sidecar 记账 vs 文件长度
                            && have <= snap.size
                    })
                    .unwrap_or(false);
                if !resume_ok {
                    // 身份/快照/记账任一不符（含 sidecar 缺失损坏、远端已换文件）→ 弃重下
                    let _ = std::fs::remove_file(&part_path);
                    let _ = std::fs::remove_file(&sc_path);
                } else {
                    offset = have; // 从 .part 当前偏移续传（重启恢复亦走此路径）
                }
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&part_path)
                .map_err(MaterializeError::Io)?;
            use std::io::Write;
            // sidecar 初始化（rev2）：身份 + 本次快照 + 当前 downloaded（续传起点=offset）；
            // 原子写（tmp+rename）防半截 JSON——侧函数 atomic_write_sidecar 实现
            atomic_write_sidecar(&part_path, &PartSidecar {
                cache_key: key.into(),
                canonical_origin: serde_json::to_string(origin).unwrap_or_default(),
                archive_rel_path: archive_rel_path.into(),
                snapshot_size: snap.size,
                snapshot_mtime: snap.modified_at,
                downloaded: offset,
            })?;
            let epoch_at_start = self.current_epoch();
            let gen_at_start = self.cancel_generation();
            while offset < snap.size {
                // 双通道取消（rev2）：generation 检查对强制路径也生效（清空缓存必须能停）；
                // epoch 检查仅 cancellable（预载）任务
                if self.cancel_generation() != gen_at_start
                    || (cancellable && self.current_epoch() != epoch_at_start) {
                    return Err(MaterializeError::Other("cancelled".into()));
                }
                let len = CHUNK.min(snap.size - offset);
                let chunk = src.read_file(origin, archive_rel_path,
                    Some(ByteRange::new(offset, len))).await?;
                if chunk.len() as u64 != len {
                    return Err(MaterializeError::Network("chunk 短读（Range 强契约被违反）".into()));
                }
                f.write_all(&chunk).map_err(MaterializeError::Io)?;
                offset += len;
                // sidecar downloaded 记账随每个 chunk 更新（原子写）——重启续传的进度真值
                atomic_write_sidecar(&part_path, &PartSidecar {
                    cache_key: key.into(),
                    canonical_origin: serde_json::to_string(origin).unwrap_or_default(),
                    archive_rel_path: archive_rel_path.into(),
                    snapshot_size: snap.size,
                    snapshot_mtime: snap.modified_at,
                    downloaded: offset,
                })?;
                emit_progress(key, archive_rel_path, offset, snap.size, "downloading");
            }
            drop(f);
            // 检查点 ②（rev2）：二次 stat 前——generation 变更（清空缓存）→ 中止
            if self.cancel_generation() != gen_at_start {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(sidecar_path(&part_path));
                return Err(MaterializeError::Other("cancelled by cache clear".into()));
            }
            let recheck = src.stat(origin, archive_rel_path).await?;
            if recheck.size != snap.size || recheck.modified_at != snap.modified_at {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(sidecar_path(&part_path));
                if attempt == 0 { continue; } // 按新版本重排队一次
                return Err(MaterializeError::Other("远端在下载期间持续变更".into()));
            }
            // 检查点 ③（rev2）：二次 stat 的 await 之后、rename 前再查（stat 期间可能 clear）
            if self.cancel_generation() != gen_at_start {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(sidecar_path(&part_path));
                return Err(MaterializeError::Other("cancelled by cache clear".into()));
            }
            std::fs::rename(&part_path, &final_path).map_err(MaterializeError::Io)?;
            let _ = std::fs::remove_file(sidecar_path(&part_path)); // ready 后 sidecar 无用
            // 表行（ready）——byte_size 复核 == origin_size
            let byte_size = std::fs::metadata(&final_path).map_err(MaterializeError::Io)?.len();
            if byte_size != snap.size {
                let _ = std::fs::remove_file(&final_path);
                return Err(MaterializeError::Other(format!("物化文件大小不符 {byte_size} != {}", snap.size)));
            }
            // 检查点 ④（rev2）：紧贴 upsert 前最后一查——rename 后若 generation 已变，
            // 删文件不上表（宁可丢一次物化也不「复活」缓存）
            if self.cancel_generation() != gen_at_start {
                let _ = std::fs::remove_file(&final_path);
                return Err(MaterializeError::Other("cancelled by cache clear".into()));
            }
            {
                let conn = self.db.conn();
                super::dao::upsert(&conn, &super::dao::NewCacheRow {
                    cache_key: key.into(),
                    origin_kind: origin.type_str().into(),
                    archive_rel_path: archive_rel_path.into(),
                    origin_size: snap.size as i64,
                    origin_mtime: snap.modified_at,
                    cache_abs_path: final_path.display().to_string(),
                    byte_size: byte_size as i64,
                }).map_err(|e| MaterializeError::Other(e.to_string()))?;
            }
            emit_progress(key, archive_rel_path, snap.size, snap.size, "ready");
            return Ok(final_path);
        }
        unreachable!("重试循环恰好 2 轮")
    }
}

/// 进度事件（非阻塞；模式同 thumbnail://progress）
fn emit_progress(cache_key: &str, rel: &str, downloaded: u64, total: u64, phase: &str) {
    // lib.rs 全局 AppHandle 的 OnceLock；未初始化（单测）静默跳过
    if let Some(app) = crate::progress_emitter() {
        use tauri::Emitter;
        let _ = app.emit("archive://progress", serde_json::json!({
            "cacheKey": cache_key, "relPath": rel,
            "downloaded": downloaded, "totalBytes": total, "phase": phase,
        }));
    }
}
```

**两个关键语义（写实现时不得偏移）**：
- **取消双通道（rev2）**：①窗口 epoch 只取消预载（`cancellable: bool` 参数：预载 true / 直调 false——用户主动打开不受切目录影响）②**内部 cancellation generation**：`AtomicU64` 单调自增 + `cancel_all()` 自增；预载与强制物化在**每个 chunk、rename 前、DB upsert 前**三检查点比对，代际变更即中止——清空缓存后在途任务不得 rename/upsert「复活」缓存；新任务取新代际，预载自然恢复。**禁止 `new_epoch(u64::MAX)` 类终值写法**（前端 epoch 从小数重计数永远追不上，会永久禁用预载）。
- **sidecar 断点续传（rev2，含重启恢复）**：下载开始写 `part/{cache_key}.part.meta`（JSON：canonical origin descriptor / archive_rel_path / 快照 size+mtime / downloaded，每 chunk 后更新 downloaded）；发现 `.part` 时先验 sidecar（cache_key 重算比对身份 + sidecar 快照 vs 远端 stat 一致）才续传，不一致或 sidecar 缺失/损坏 → 弃 `.part`+sidecar 重来。表只存 ready（不变）；重启后 sidecar 在磁盘上，恢复覆盖应用重启。

`progress_emitter()`：lib.rs 加 `static PROGRESS_EMITTER: OnceLock<AppHandle>` + `pub fn progress_emitter() -> Option<&AppHandle>` + setup 里 set。单测无 app → 静默跳过（分支已写）。

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib materializer` → PASS（纯函数 2 + 状态机 6）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/archive/materializer.rs src-tauri/src/lib.rs
git commit -m "feat(archive): ensure_cached 状态机——快照/续传/二次stat防护/重试1次/in-flight去重/epoch取消(仅预载)"
```

---

### 任务 4：ArchiveMediaSource 接入物化器

**文件：**
- 修改：`src-tauri/src/source/archive_impl.rs:23-30`（构造）+ 三方法前置（141/168/226 行区域）
- 修改：`src-tauri/src/source/factory.rs`（构造顺序）

- [ ] **步骤 0：确认现状**

读 `archive_impl.rs` 三方法的 descriptor 解构块（list 141-160 / read 168-215 / stat 226-270）——本任务把「`PathBuf::from(archive_path)` + `tokio::fs::read`」抽成统一前置。读 `factory.rs::new`（当前 48 行，任务 3 后 Materializer 可构造）。

- [ ] **步骤 1：写失败测试**

```rust
    // archive_impl.rs tests 模块追加（mock materializer 用 trait 注入）
    #[tokio::test]
    async fn remote_origin_goes_through_materializer() {
        // Materializer 抽 trait Materialize（ensure_cached 单方法）——测试注入
        // 固定返回 tempdir 里构造的真 ZIP（复用文件内既有的测试 ZIP 构造 helper）
        // descriptor: Archive { archive_path: "https://d/x/a.cbz"(虚拟), origin: Some(webdav), archive_rel_path: Some("a.cbz"), .. }
        // 断言：list_directory 返回 ZIP 内条目（物化路径被使用，虚拟路径未触碰 fs）
    }

    #[tokio::test]
    async fn local_origin_unchanged() {
        // origin None 现状路径零回归（M1 既有用例已覆盖——确认不红即可，无新断言）
    }
```

（首用例体：文件内已有 ZIP 测试构造 helper（`tests` 模块 `zip::ZipWriter` 用例），mock trait 实现 `ensure_cached` 返回该 helper 的产物路径。）

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现**

archive_impl.rs：

```rust
/// 物化抽象（生产 = source::archive::materializer::Materializer；测试 = mock）
#[async_trait::async_trait]
pub trait Materialize: Send + Sync {
    async fn ensure_cached(
        &self, origin: &SourceDescriptor, archive_rel_path: &str,
    ) -> std::result::Result<PathBuf, String>;
}

pub struct ArchiveMediaSource {
    materializer: std::sync::Arc<dyn Materialize>,
}

impl ArchiveMediaSource {
    pub fn new(materializer: std::sync::Arc<dyn Materialize>) -> Self {
        Self { materializer }
    }
}

impl ArchiveMediaSource {
    /// 三方法统一前置（spec §5）：origin None 本地直开 / Some 物化
    async fn resolve_archive_path(
        &self,
        archive_path: &str,
        origin: &Option<Box<SourceDescriptor>>,
        archive_rel_path: &Option<String>,
    ) -> Result<PathBuf> {
        match origin {
            None => Ok(PathBuf::from(archive_path)),
            Some(origin_desc) => {
                let rel = archive_rel_path.as_deref().ok_or_else(|| {
                    MediaSourceError::Other("远程 archive 缺少 archiveRelPath".into())
                })?;
                self.materializer
                    .ensure_cached(origin_desc, rel).await
                    .map_err(MediaSourceError::Other)
            }
        }
    }
}
```

三方法改造模式（list 为例，read/stat 同款）：

```rust
    async fn list_directory(&self, descriptor: &SourceDescriptor, _path: &str) -> Result<Vec<MediaEntry>> {
        let (archive_path, entry_prefix, format, origin, archive_rel_path) = match descriptor {
            SourceDescriptor::Archive { archive_path, entry_prefix, format, origin, archive_rel_path, .. } => (
                archive_path.clone(), entry_prefix.clone(), *format, origin.clone(), archive_rel_path.clone(),
            ),
            _ => return Err(MediaSourceError::NotImplemented(/* 原文保留 */)),
        };
        let resolved = self.resolve_archive_path(&archive_path, &origin, &archive_rel_path).await?;
        let bytes = tokio::fs::read(&resolved).await.map_err(|e| /* 原映射保留，archive_path→resolved */)?;
        list_archive_entries(&bytes, format, &entry_prefix)
    }
```

（read_file / stat 的 `tokio::fs::read(archive_path)` 同步换成 `read(resolved)`；`Archive { origin, .. }` 其余字段忽略。）

factory.rs 构造顺序（spec §2）：

```rust
    pub fn new(db: crate::db::Db, creds: std::sync::Arc<dyn crate::credentials::CredentialStore>) -> Self {
        let local = Arc::new(LocalMediaSource::new());
        let smb = Arc::new(SmbMediaSource::new(Arc::new(
            SmbConnectionManager::new_production(db.clone(), creds.clone()),
        )));
        let webdav = Arc::new(WebDavMediaSource::new(db.clone(), creds));
        // M3 spec §2 断环：Materializer 持具体源 Arc（不经 factory），
        // ArchiveMediaSource 注入 Materializer——未来加源：此处追加 + materializer 源列表
        let cache_root = crate::archive_cache_root(); // lib.rs 提供（app_cache_dir()/archive-cache，见任务 6）
        let materializer = Arc::new(crate::source::archive::materializer::Materializer::new(
            webdav.clone() as Arc<dyn MediaSource>,
            smb.clone() as Arc<dyn MediaSource>,
            db.clone(),
            cache_root,
        ));
        Self {
            local,
            archive: Arc::new(ArchiveMediaSource::new(materializer as Arc<dyn Materialize>)),
            smb, webdav,
        }
    }
```

（`MediaSource` 对象安全确认：全 async_trait + `&self`，`Arc<dyn MediaSource>` M1 取源 actor 已在用——同款。）

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib archive` → PASS（M1 既有 stat/list 用例 + 新 2 用例）+ `cargo test -p mirapage-desktop-lib` 全量不红**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/archive_impl.rs src-tauri/src/source/factory.rs src-tauri/src/lib.rs
git commit -m "feat(archive): 三方法接 Materialize trait——origin None 本地直开零回归/Some 物化；factory 断环构造"
```

---

### 任务 5：webdav `is_archive` 判定

**文件：**
- 修改：`src-tauri/src/source/webdav_impl.rs:240-250`（PropFindEntry → MediaEntry 构造处）

- [ ] **步骤 1：写失败测试（tests 模块追加；复用既有 parse_propfind fixture 模式）**

```rust
    #[test]
    fn parse_propfind_marks_archive_entries_by_extension() {
        let body = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/book.cbz</d:href>
    <d:propstat><d:prop><d:getcontentlength>999</d:getcontentlength></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/img.jpg</d:href>
    <d:propstat><d:prop><d:getcontentlength>1</d:getcontentlength></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let entries = WebDavMediaSource::parse_propfind(body, "/dav/").unwrap();
        assert!(entries[0].is_archive, ".cbz 按扩展名标记");
        assert!(!entries[1].is_archive, "普通文件不标记");
    }
```

- [ ] **步骤 2：`cargo test -p mirapage-desktop-lib parse_propfind_marks_archive` → FAIL（is_archive 恒 false）**

- [ ] **步骤 3：实现（247 行 `is_archive: false` 替换）**

```rust
            is_archive: !self.is_collection && crate::source::descriptor::ArchiveFormat::from_extension(
                std::path::Path::new(&name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or(""),
            ).is_some(),
```

（对齐 local.rs 同款判定；name 变量在 243 行区域已存在。）

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib webdav` → PASS（新 1 + 既有不红）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/webdav_impl.rs
git commit -m "feat(webdav): PROPFIND 条目 is_archive 按扩展名判定（远程 ZIP 浏览入口）"
```

---

### 任务 6：cache 根目录 + 启动清理 + manage

**文件：**
- 修改：`src-tauri/src/lib.rs`（`archive_cache_root()` helper + 启动清理 + Materializer 不重复 manage——factory 已持；cache 管理命令需要直接触达：把 Materializer 也 `app.manage(materializer.clone())`（factory 与 manage 共享同一 Arc））

- [ ] **步骤 1：写失败测试（清理逻辑抽纯函数 `startup_cleanup(cache_root, &Db)` 放 materializer.rs，单测直接调）**

```rust
    #[test]
    fn startup_cleanup_removes_orphans_and_parts() {
        // tempdir：无表行的 {k2}.zip（孤儿 ready）+ 有表行的 {k3}.zip + 无 sidecar 的 part/{k4}.part
        // 断言（rev2+ 语义）：孤儿 zip 删、表行对应的 k3.zip 保留、无 sidecar 的 .part 删
    }

    /// rev6 终审建议：重启续传不得被启动清理误伤（rev3 修过的方向守卫——
    /// 旧实现枚举到 .part.meta 拼出 .part.part.meta 判失败，把有效 sidecar 删了）
    #[test]
    fn startup_cleanup_keeps_resumable_part_with_valid_sidecar() {
        // tempdir part/ 布局与断言：
        // ① k1.part（半截 5 字节）+ 有效 k1.part.meta（六字段 PartSidecar，downloaded=5）
        //    → **两者均保留**——重启续传可用（下次 ensure_cached 四关校验通过后从 5 续传）
        // ② k2.part 无 sidecar → 删
        // ③ k3.part + 损坏 sidecar（半截 JSON）→ 删两者
        // ④ k4.part.meta 单独存在（.part 已 rename 走，sidecar 残留）→ 非候选不处理
        //    （保留；正常路径 ready 时已顺手删，此为极端残留）
        // 断言：①④在、②③不在
    }

    /// rev6 方向守卫：目录只有 .meta/.meta.tmp（无 .part）时 cleanup 不误删 sidecar
    #[test]
    fn startup_cleanup_ignores_meta_files_as_part_candidates() {
        // part/ 只有 k5.part.meta（无 k5.part）→ 保留；
        // k6.part.meta.tmp（原子写残留）→ 删除
    }
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现**

materializer.rs 追加：

```rust
/// 启动清理（spec §8 rev2）：①part/ 只删 sidecar 缺失/损坏的 .part（**有效 sidecar 保留——
/// 重启续传依据，原「全删 part/」与断点续传冲突已废弃**；一致性验证推迟到下次
/// ensure_cached 的 sidecar 快照 vs 远端 stat，启动时零网络请求）②孤儿缓存文件（表无行）
/// ③超容量淘汰
pub fn startup_cleanup(cache_root: &std::path::Path, db: &Db, limit_bytes: i64) {
    if let Ok(rd) = std::fs::read_dir(cache_root.join("part")) {
        for entry in rd.flatten() {
            let p = entry.path();
            // rev3：只把扩展名恰为 .part 的数据文件当候选——sidecar（.part.meta）与
            // 原子写残留（.meta.tmp）不是 part，绝不当候选（原实现会把 .meta 判为
            // 无 sidecar 的孤儿而误删，下次启动无法续传）
            if p.extension().and_then(|e| e.to_str()) != Some("part") {
                if p.extension().and_then(|e| e.to_str()) == Some("tmp") {
                    let _ = std::fs::remove_file(&p); // 原子写残留可清
                }
                continue;
            }
            // 结构化校验（非仅 JSON 可解析）：六字段齐全且类型正确才保留
            let sidecar_ok = std::fs::read(&p.with_file_name({
                let mut s = p.file_name().unwrap_or_default().to_os_string();
                s.push(".meta");
                s
            }))
            .ok()
            .and_then(|b| serde_json::from_slice::<PartSidecar>(&b).ok())
            .is_some();
            if !sidecar_ok {
                let _ = std::fs::remove_file(&p); // 无法安全续传的孤儿
                let _ = std::fs::remove_file(sidecar_path(&p));
            }
        }
    }
    let _ = std::fs::create_dir_all(cache_root.join("part"));
    let conn = db.conn();
    let known: std::collections::HashSet<String> = {
        let mut stmt = match conn.prepare("SELECT cache_abs_path FROM archive_cache") { Ok(s) => s, Err(_) => return };
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map(|it| it.filter_map(|v| v.ok()).collect::<Vec<_>>());
        match rows { Ok(v) => v.into_iter().collect(), Err(_) => return }
    };
    if let Ok(rd) = std::fs::read_dir(cache_root) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() && !known.contains(&p.display().to_string()) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    let _ = super::dao::evict_to_limit(&conn, limit_bytes, &[]);
}
```

lib.rs：`pub fn archive_cache_root() -> PathBuf`（`app.path().app_cache_dir()` 在 setup 内拿不到（先于 builder？在 setup 回调内可拿）——实现：setup 里计算后传 factory + 存 `OnceLock<PathBuf>` 供 helper 读；单测环境返回 tempdir（env var 覆盖或直接不调用）。简化：`archive_cache_root()` 读 `ARCHIVE_CACHE_ROOT: OnceLock<PathBuf>`，setup 内 `set(app.path().app_cache_dir()?.join("archive-cache"))`；factory::new 在 setup 内调用时 helper 已 set）。setup 内顺序：

```rust
// M3：archive cache root 先于 factory（factory 内 Materializer 用）
let cache_root = app.path().app_cache_dir()
    .map(|d| d.join("archive-cache"))
    .unwrap_or_else(|_| std::env::temp_dir().join("mirapage-archive-cache"));
ARCHIVE_CACHE_ROOT.get_or_init(|| cache_root.clone());
std::fs::create_dir_all(cache_root.join("part"))?;
let factory = source::MediaSourceFactory::new(db, creds); // 内部经 archive_cache_root() 取根
// 启动清理（限值从 settings 读 archive_cache_max_mb，缺省 2048）
{
    let conn = /* db.conn() */;
    let limit = read_setting_i64(&conn, "archive_cache_max_mb").unwrap_or(2048) * 1024 * 1024;
    source::archive::materializer::startup_cleanup(&cache_root, &db, limit);
}
```

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib startup_cleanup` → PASS；`cargo check` 过**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/archive/materializer.rs src-tauri/src/lib.rs src-tauri/src/source/factory.rs
git commit -m "feat(archive): cache 根目录(app_cache_dir/archive-cache)+启动清理(孤儿part/孤儿文件/超容量)+settings 限值接线"
```

---

### 任务 7：前端 openArchive 泛化 + 进度文案

**文件：**
- 修改：`src/stores/fileBrowser.ts:82`（archiveParent 形态）/ `255-285`（openArchive/exitArchive）
- 修改：`src/components/filebrowser/FileBrowser.vue`（面包屑 ZIP 态——现状已支持，确认恢复目标改 descriptor）
- 修改：`src/locales/zh-CN.ts` / `en-US.ts`
- 测试：`src/stores/fileBrowser.test.ts`（追加）

- [ ] **步骤 0：确认现状**

`fileBrowser.ts:82` archiveParent `{ rootPath, path }`；`activeDescriptor`/`currentDescriptor` 机制（114 行 openDescriptorAt、255 行 openArchive 用 rootPath 拼绝对路径）；FileBrowser.vue 面包屑对 archiveParent 的渲染点（grep `archiveParent`）。

- [ ] **步骤 1：写失败测试**

```ts
  it('openArchive 远程源：构造 origin descriptor + 虚拟 archivePath + descriptor 形态 parent', async () => {
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(
      { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' }, 'comics');
    const entry = { name: 'book.cbz', path: 'book.cbz', isDirectory: false, isArchive: true, size: 9, modifiedAt: 1 };
    await fb.openArchive(entry);
    expect(fb.archiveParent).toEqual({
      descriptor: { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' },
      relPath: 'comics',
    });
    const d = fb.currentDescriptor as any;
    expect(d.type).toBe('archive');
    expect(d.origin?.type).toBe('webdav');
    expect(d.archiveRelPath).toBe('comics/book.cbz');
    expect(d.archivePath).toBe('https://d/x/comics/book.cbz'); // 虚拟 URL 形态
  });

  it('openArchive SMB 源：虚拟 archivePath 契约 smb://{accountId}/{initialPath}/{rel}', async () => {
    const fb = useFileBrowserStore();
    await fb.openDescriptorAt(
      { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 }, '');
    const entry = { name: 'book.cbz', path: 'book.cbz', isDirectory: false, isArchive: true, size: 9, modifiedAt: 1 };
    await fb.openArchive(entry);
    const d = fb.currentDescriptor as any;
    expect(d.archivePath).toBe('smb://3/share/comics/book.cbz'); // rev3 契约（非 UNC，无 smbHostOf）
    expect(d.archiveRelPath).toBe('book.cbz');
  });

  it('exitArchive 恢复远程源目录（openDescriptorAt 复用）', async () => {
    /* openArchive 后 exitArchive → activeDescriptor 回 webdav + currentPath 回 comics */
  });

  it('本地源 openArchive 行为不变（零回归）', async () => {
    /* setRoot + navigate 后 openArchive → archiveParent { descriptor: local, relPath }，archivePath 绝对路径 */
  });
```

- [ ] **步骤 2：`npx vitest run src/stores/fileBrowser.test.ts` → 新用例 FAIL（现状 archiveParent 是 rootPath 形态）**

- [ ] **步骤 3：实现（fileBrowser.ts）**

```ts
  // 形态升级（M3 spec §6.2）：Local 或远程通用；唯一 caller 为 openArchive/exitArchive
  const archiveParent = ref<{ descriptor: SourceDescriptor; relPath: string } | null>(null);

  async function openArchive(entry: MediaEntry): Promise<void> {
    const dir = currentPath.value;
    const relInside = dir ? `${dir}/${entry.name}` : entry.name;
    if (activeDescriptor.value && activeDescriptor.value.type !== 'local') {
      // 远程源（M3 spec §6.2 rev2 统一）：虚拟 archivePath——WebDAV=URL 形态 /
      // SMB=`smb://{accountId}/{initialPath}/{rel}` 可读虚拟形态（非真 UNC：descriptor
      // 不含 host，host 查表太重且虚拟路径零解析消费方，仅展示与身份用）
      const origin = activeDescriptor.value;
      const virtualPath = origin.type === 'webdav'
        ? `${origin.baseUrl.replace(/\/+$/, '')}/${relInside}`
        : origin.type === 'smb'
          ? `smb://${origin.accountId}/${(origin.initialPath ? origin.initialPath + '/' : '')}${relInside}`
          : ''; // 不可达（外层已限定非 local）；空串防御
      archiveParent.value = { descriptor: origin, relPath: dir };
      currentDescriptor.value = {
        type: 'archive', archivePath: virtualPath, entryPrefix: '',
        format: archiveFormatOf(entry.name),
        origin, originEntryPath: relInside, archiveRelPath: relInside,
      };
    } else {
      // 本地源（module3.2.0 现状，零回归）
      const root = rootPath.value ?? '';
      const abs = [root, dir, entry.name].filter((s) => s.length > 0).join('/').replace(/\\/g, '/');
      archiveParent.value = { descriptor: { type: 'local', rootPath: root }, relPath: dir };
      currentDescriptor.value = {
        type: 'archive', archivePath: abs, entryPrefix: '',
        format: archiveFormatOf(entry.name),
      };
    }
    currentPath.value = '';
    searchQuery.value = '';
    await fetch('');
  }

  async function exitArchive(): Promise<void> {
    const parent = archiveParent.value;
    archiveParent.value = null;
    currentDescriptor.value = null;
    if (!parent) return;
    if (parent.descriptor.type === 'local') {
      rootPath.value = parent.descriptor.rootPath;
      await navigate(parent.relPath);
    } else {
      await openDescriptorAt(parent.descriptor, parent.relPath);
    }
  }
```

（`activeDescriptor` 为 M1 已有概念（openDescriptorAt 置入）——字段名以 store 现状为准。SMB 虚拟路径契约 **`smb://{accountId}/{initialPath}/{rel}`**（rev3 代码与定案注释统一，`smbHostOf` 不存在）；测试断言同一契约——远程分支用例补 SMB 形态：`archivePath === 'smb://3/share/comics/book.cbz'`。）

进度文案：FileBrowser.vue 或 fileBrowser.ts 挂 `archive://progress` 监听（`listen()` 防御同 3.0.8 isTauriEnv），`fb.archiveProgress = ref<{ downloaded: number; total: number } | null>`；fetch('') 期间 archive descriptor 时模板显示 `t('fileBrowser.archivePreparing', { downloaded: MB, total: MB })`（indeterminate 兜底：无进度数据时 `t('fileBrowser.archivePreparingIndeterminate')`）。i18n 双语：

```
fileBrowser.archivePreparing: 正在准备压缩包（{downloaded} / {total} MB） / Preparing archive ({downloaded} / {total} MB)
fileBrowser.archivePreparingIndeterminate: 正在准备压缩包… / Preparing archive…
```

- [ ] **步骤 4：`npx vitest run src/stores/fileBrowser.test.ts src/components/filebrowser/FileBrowser.test.ts` → PASS（含本地既有用例——archiveParent 断言从 rootPath 形态更新为 descriptor 形态的既有用例一并改）**

- [ ] **步骤 5：Commit**

```bash
git add src/stores/fileBrowser.ts src/stores/fileBrowser.test.ts src/components/filebrowser/FileBrowser.vue src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(filebrowser): openArchive 泛化——远程源虚拟路径+origin descriptor+descriptor 形态 parent+准备态进度文案"
```

---

### 任务 8：三级预载调度

**文件：**
- 创建：`src-tauri/src/source/archive/prefetch.rs`
- 修改：`src-tauri/src/source/archive/mod.rs` / `src-tauri/src/lib.rs`（manage Prefetcher + 设置接线）
- 修改：`src-tauri/src/commands/mod.rs` + 新 `src-tauri/src/commands/archive_prefetch.rs`（`notify_archive_window` 命令：前端 masonry 窗口变化时推送预载目标）

- [ ] **步骤 1：写失败测试（prefetch.rs；Materializer mock 化——Prefetcher 持 `Arc<Materializer>` 真类型但 Materializer 的源是 trait 注入，测试链路用 mock 源即真 Materializer）**

```rust
    #[tokio::test]
    async fn window_targets_trigger_low_priority_ensure() {
        // mock 源 + 真 Materializer + Prefetcher::new(mat)
        // notify_window(epoch=1, targets=[rel1, rel2], origin=webdav)
        // → 等待两个 rel 的 ready（或 read_calls 达全量）
    }

    #[tokio::test]
    async fn epoch_bump_cancels_pending_prefetch() {
        // notify_window(epoch=1, targets=[慢源 rel]) → 立刻 notify_window(epoch=2, [])
        // → rel1 的下载被取消（.part 保留，read_calls 未达全量）
    }

    #[tokio::test]
    async fn metadata_stat_only_no_download() {
        // 元数据预载：stat 被调、read_calls == 0
    }

    #[tokio::test]
    async fn disabled_flag_blocks_all_but_forced() {
        // Prefetcher::set_enabled(false) → notify_window 不触发下载
    }
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现（prefetch.rs 骨架——完整逻辑）**

```rust
//! 三级预载（M3 spec §7）：元数据 stat 预热 / 内容低优 ensure_cached / 强制=同步路径。
//! 复用 3.0.7 调度语义：epoch 取消 + in-flight 去重（去重由 Materializer.inflight 承担）。

use super::materializer::Materializer;
use crate::source::descriptor::SourceDescriptor;
use std::sync::Arc;

pub struct ArchivePrefetcher {
    mat: Arc<Materializer>,
    enabled: std::sync::atomic::AtomicBool,
}

impl ArchivePrefetcher {
    pub fn new(mat: Arc<Materializer>) -> Self {
        Self { mat, enabled: std::sync::atomic::AtomicBool::new(true) }
    }

    pub fn set_enabled(&self, v: bool) { self.enabled.store(v, std::sync::atomic::Ordering::SeqCst); }

    /// 元数据预载：远程目录列举完成后调，仅 stat（结果弃用或留内存——首期直接 stat
    /// 预热 SMB/WebDAV 连接缓存，不落任何状态；YAGNI）
    pub async fn warm_metadata(&self, origin: &SourceDescriptor, rels: &[String]) {
        for rel in rels {
            let _ = self.mat.stat_origin(origin, rel).await;
        }
    }

    /// 内容预载：masonry 预读窗口 / details 选中。epoch 同步给 Materializer（取消在途 chunk）。
    pub async fn notify_window(&self, epoch: u64, origin: &SourceDescriptor, rels: &[String]) {
        if !self.enabled.load(std::sync::atomic::Ordering::SeqCst) { return; }
        self.mat.new_epoch(epoch);
        let mat = self.mat.clone();
        let origin = origin.clone();
        let rels = rels.to_vec();
        tokio::spawn(async move {
            for rel in &rels {
                // cancellable=true：epoch 变更即停（ensure_cached 参数化，任务 3 语义）
                let _ = mat.ensure_cached_cancellable(&origin, rel, true).await;
            }
        });
    }
}
```

（`Materializer` 补两个 pub 方法：`stat_origin`（= `origin_source(origin)?.stat(...)` 直调）与 `ensure_cached_cancellable`（任务 3 的 `cancellable` 参数出口）。命令层：`notify_archive_window { epoch, descriptor, rels }` ——前端 masonry 窗口 watch 时调用；`warm_metadata` 并入同命令 `mode: "metadata" | "content"`。settings 接线：`remote_archive_prefetch_enabled` 变更时 `set_enabled` 推送（settings 命令里 hook，模式同 fb_thumbnail 设置推送）。）

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib prefetch` → PASS（4 用例）**

- [ ] **步骤 5：前端接线（MasonryView 窗口 → notify_archive_window）**

`src/lib/tauri.ts`：`notifyArchiveWindow(descriptor, rels, mode)` 封装；`useMasonryThumbnails` 或 MasonryView 的像素窗口 watch 处（3.0.7 `selectPathsInPixelWindow` 已产出窗口内 path 集合）追加：对 `is_archive` entries 调 `notifyArchiveWindow(activeDescriptor, names, 'content')`（100ms 防抖，切目录天然由 epoch 承担）。details 选中：EntryDetailPanel 选中 archive 项时调 metadata/content 单条。**步骤 5a**：写前端测试（mock invoke 断言窗口变化触发）；**5b**：实现；**5c**：vitest PASS。

- [ ] **步骤 6：Commit**

```bash
git add src-tauri/src/source/archive/prefetch.rs src-tauri/src/source/archive/mod.rs src-tauri/src/commands/ src-tauri/src/lib.rs src/lib/tauri.ts src/components/filebrowser/MasonryView.vue
git commit -m "feat(archive): 三级预载——metadata stat 预热/内容低优 ensure(cancellable)/epoch 取消+masonry 窗口接线+开关"
```

---

### 任务 9：cache 管理命令 + Settings remote section

**文件：**
- 创建：`src-tauri/src/commands/archive_cache.rs`
- 修改：`src-tauri/src/commands/mod.rs` / `src-tauri/src/lib.rs`（generate_handler! 注册）
- 修改：`src/lib/tauri.ts` / `src/views/Settings.vue` / i18n 双语
- 测试：`src/views/Settings.test.ts`（追加）

- [ ] **步骤 1：写失败测试（Rust 命令薄壳——`_impl` 直测）**

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn clear_removes_files_and_rows() {
        // 内存库 + tempdir cache_root：两个 ready 文件 + 表两行 + 一个 .part+sidecar
        // clear_archive_cache_impl → usage == (0,0) 且 ready 文件与 part/ 均被删除
    }
    #[test]
    fn info_reports_usage() { /* usage == (2, bytes) */ }

    #[tokio::test]
    async fn clearing_gate_rejects_new_tasks_and_recovers() {
        // rev4 闸门：begin_clearing 后新 ensure_cached 返回 "clearing in progress"；
        // end_clearing 后正常工作（且代际已变，旧 in-flight 即便漏网也不会 upsert）
    }
}
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现**

```rust
//! archive cache 管理命令（M3 spec §8；模式同 thumbnails clear/info）

#[tauri::command]
pub async fn get_archive_cache_info(
    db: tauri::State<'_, crate::db::Db>,
) -> Result<serde_json::Value, String> {
    let conn = db.conn();
    let (count, bytes) = crate::source::archive::dao::usage(&conn).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "count": count, "bytes": bytes }))
}

#[tauri::command]
pub async fn clear_archive_cache(
    db: tauri::State<'_, crate::db::Db>,
    mat: tauri::State<'_, std::sync::Arc<crate::source::archive::materializer::Materializer>>,
) -> Result<(), String> {
    // rev5 清空流程（闸门 + 排空 + 实删三段）：
    // ①begin_clearing()：**持 inflight 锁**置 clearing=true 后 cancel_all——与
    //   ensure_cached 的「查闸门+注册」临界区互斥，无中间态（TOCTOU 封死）
    // ②await 排空在途（tokio::time::sleep，禁 thread::sleep 阻塞 runtime；四检查点
    //   保证在途任务快速退出）——超时：复位闸门 + 返回忙碌错误，**不删除任何东西**
    // ③实删：ready 文件（clear_all 返回的路径逐个删）+ part/ 全部 .part/.part.meta + 清表
    // ④finally 复位闸门——新任务（新代际）自然恢复
    mat.begin_clearing().await;
    let drained = mat.wait_inflight_drained(std::time::Duration::from_secs(2)).await;
    if !drained {
        mat.end_clearing().await;
        return Err("缓存正忙（有下载在途），请稍后重试".into());
    }
    let result = (|| -> Result<(), String> {
        let conn = db.conn();
        let roots = crate::source::archive::dao::clear_all(&conn).map_err(|e| e.to_string())?;
        for abs in &roots {                       // rev4：实删 ready 文件（原来被丢弃）
            let _ = std::fs::remove_file(abs);
        }
        // part/ 目录整体重建（.part + sidecar + .meta.tmp 一并清除）
        let root = mat.cache_root();
        let _ = std::fs::remove_dir_all(root.join("part"));
        let _ = std::fs::create_dir_all(root.join("part"));
        Ok(())
    })();
    mat.end_clearing().await;
    result
}
```

（`clear_all` 改造：返回被清的 `cache_abs_path` 列表（`Vec<String>`）供命令删文件——DAO 测试同步改返回值断言。）

前端 Settings.vue：sections 加 `'remote'`；remote section 三项（spec §8 砍到 3 项 UI）——`remote_archive_prefetch_enabled`（BooleanRow，改时 Rust 侧 `set_enabled` 推送走 settings 命令 hook）/ `archive_cache_max_mb`（数值输入，钳 512–32768，保存写 settings 表）/ 清空按钮 + 用量展示（`getArchiveCacheInfo` 加载 + 清空后刷新 + confirm 文案）。tauri.ts 封装 `getArchiveCacheInfo` / `clearArchiveCache`。i18n：

```
settings.remote.title / settings.remote.prefetchEnabled / settings.remote.archiveCacheLimit
settings.remote.clearArchiveCache / settings.remote.archiveCacheUsage / settings.remote.clearConfirm
```

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib archive_cache` + `npx vitest run src/views/Settings.test.ts` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/commands/archive_cache.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/source/archive/dao.rs src/lib/tauri.ts src/views/Settings.vue src/views/Settings.test.ts src/locales/
git commit -m "feat(archive): cache 管理命令(clear/info)+Settings remote section(开关/上限/清空+用量)+i18n 双语"
```

---

### 任务 10：全量验证 + 手测清单 + 收尾

**文件：**
- 修改：`AGENTS.md`（状态表加 3.4.0 行）/ `DESIGN.md` §16.1（划掉远程 Archive 物化项）

- [ ] **步骤 1：全量自动化**

```bash
npm run type-check && npm test -- --run
cd src-tauri && cargo test
```

- [ ] **步骤 2：本地可跑的手测（无 NAS/WebDAV 也能验的子集）**

1. Local ZIP 零回归（M1 验收 2 复跑：双击进入/退出/阅读/进度）
2. 本地 ZIP 的 masonry 缩略图不回归
3. Settings remote section：用量展示 / 上限保存 / 清空按钮（清后用量归零 + 缓存目录文件消失——放一个远程包后验，或手动塞文件进 archive-cache 目录验证孤儿清理）

- [ ] **步骤 3：远程手测（spec §11 清单，需 WebDAV 带密码服务器；SMB 部分 NAS）**

1. WebDAV 上的 CBZ：双击 →「正在准备压缩包」→ 条目视图 → 三模式阅读
2. 二次打开同包秒开（devtools network 无请求）
3. 远端换文件（改 size/mtime）→ 自动失效重下
4. 断点续传（rev2 双场景）：断网恢复 + **下载中途退出应用重启**，均从 `.part`+sidecar 续传不重头（devtools 看请求 offset ≠ 0；重启场景 sidecar 快照与远端 stat 一致才续）
5. 超容量 LRU 淘汰 + 手动清空
6. 远程 ZIP masonry 缩略图 + 原图
7. （NAS）SMB 上的 CBZ 复跑 1-6
8. 预载开关关闭后无窗口预取（devtools 无额外请求）

- [ ] **步骤 4：状态表 + tag**

```bash
git add AGENTS.md DESIGN.md
git commit -m "docs: 状态表补 module3.4.0-remote-archive（M3 物化+预载+cache）"
git tag v0.1.0-module3.4.0-remote-archive
git push github main && git push github v0.1.0-module3.4.0-remote-archive
git push origin main --tags
```

---

## 自检记录

- **规格覆盖度**：spec §3 表+DAO（任务 1）、§4.2/4.3 纯函数+状态机+chunk（任务 2/3）、§5 接入（任务 4）、§6.1 is_archive（任务 5）、§6.2 openArchive 泛化+进度（任务 7）、§7 预载（任务 8）、§8 cache 管理+Settings（任务 6/9）、§9 i18n（任务 7/9）、§10 测试策略（各任务步骤 1）、§11 验收（任务 10 手测清单）、§12 风险（二次 stat/断点续传/容量/epoch 均有对应实现）、§13 交付（任务 10 tag）。遗漏：无。
- **migration 勘误**：spec 原「015」已勘误为 016（015 被 module3.1.1 占用，计划期复核确认）。
- **占位符**：任务 3/4 测试中标注 `...` 的用例体均给出首用例完整模板与断言意图（执行者补全后才跑红——已写明）；无「待定/TODO」类步骤。
- **类型一致性**：`NewCacheRow/CacheRow`（任务 1）、`cache_key/is_stale/MaterializeError/Materializer/emit_progress`（任务 2/3）、`Materialize` trait（任务 4 定义，factory 注入）、`startup_cleanup`（任务 6）、`ArchivePrefetcher`（任务 8）、命令（任务 9）——链路一致。
- **有意偏差（记录在案）**：① spec §8 五项设置砍到 3 项 UI（窗口/并发常量化——spec 自身已批准此偏差）② ~~SMB 虚拟 archivePath 与 spec UNC 不一致~~ **rev2 已统一**：spec/计划同为 `smb://{accountId}/...` 可读虚拟形态（非真 UNC；避免 host 查表，虚拟路径零解析消费方）③ `clear_all` 返回路径列表（删文件需要）。

## 附：计划审查修订记录（rev2，2026-08-19）

M3 审查 3 必须 + 1 建议全采纳：

1. **migration 统一 016**：spec §3 标题漏改（正文两处已 016）——「按标题落地会撞 position_kind」；spec §3 标题/§10 DAO 用例断言/计划引用全部统一 016。
2. **sidecar 断点续传（含重启恢复）**：原启动清理 `remove_dir_all(part/)` 与续传承诺直接冲突（重启必从 0 重下）。改为 `.part` + `.part.meta` sidecar（canonical origin/rel/快照 size+mtime/downloaded，每 chunk 更新）；续传前验 sidecar 身份+快照一致性；启动清理只删 sidecar 缺失/损坏的孤儿（保留有效 `.part`，启动零网络请求）；验收 4 扩为断网+重启双场景。
3. **cancellation generation 取代 `new_epoch(u64::MAX)`**：终值 epoch 前端小数计数永远追不上（永久禁用预载）+ 强制物化不受 epoch 控制会 rename/upsert「复活」缓存。改 Materializer 内部单调 `AtomicU64` generation：`cancel_all()` 自增；预载与强制物化在每 chunk/rename 前/upsert 前三检查点比对；`clear_archive_cache` = cancel_all → 等 in-flight 空（2s 兜底）→ 删文件+清表；新任务取新代际自然恢复。
4. **SMB 虚拟路径统一**：spec 的 UNC 表述与计划 `smb://{accountId}/...` 定案统一（见偏差记录②）。

## 附：计划审查修订记录（rev3，2026-08-19）

第五轮 5 必须（文档模板与 rev2 定案脱节）全采纳：

1. **spec §10「migration 015 建表断言」→ 016**（正文统一后测试策略漏网）。
2. **状态机模板补齐 rev2 语义**：`Materializer` 加 `cancel_gen` 字段 + `cancel_all/cancel_generation/inflight_empty/wait_inflight_drained` 方法；`ensure_cached`/`ensure_cached_cancellable` 双入口（`cancellable` 参数贯穿 `download`）；`PartSidecar` 结构体 + `sidecar_path`/`atomic_write_sidecar`；续传改**四关严格校验**（cache_key 重算 / canonical origin / rel / 快照 size+mtime vs 远端 stat / downloaded == .part 长度 / ≤ 远端 size），任一不符弃 `.part`+sidecar 重下——不再按裸文件长度续传后覆写 sidecar。chunk 循环每块后原子更新 sidecar `downloaded`。
3. **启动清理只遍历 `.part` 数据文件**：原实现对 `.part.meta` 枚举会拼出 `.part.part.meta` 判失败而**误删有效 sidecar**（下次启动无法续传）；现仅扩展名恰为 `.part` 者为候选 + sidecar 六字段结构化校验；`.meta.tmp` 原子写残留顺手清。
4. **清缓存防复活收口**：等待改 `await wait_inflight_drained`（`tokio::time::sleep`——async 命令内 `std::thread::sleep` 阻塞 runtime）；**超时返回忙碌错误不继续删除**；generation 检查点从 2 处扩到 **4 处**（chunk 前 / 二次 stat 前 / 二次 stat 后 rename 前 / 紧贴 upsert 前——rename 后若代际已变删文件不上表）。
5. **SMB virtualPath 代码与定案统一**：`smbHostOf`+UNC 分支删除，改 `smb://{accountId}/{initialPath}/{rel}` + 防御空串；测试补 SMB 契约断言用例（`smb://3/share/comics/book.cbz`）。任务 3 测试补 `cancel_all_stops_forced_download_without_revive`（强制任务可被 generation 停止且不复活、新任务代际恢复）。
（修正注：上一行 `#[test]` 应为 `#[tokio::test]`——clearing_gate 用例涉及 async。）

## 附：计划审查修订记录（rev4，2026-08-19）

第六轮 5 必须（模板编译错与竞态）全采纳：

1. **`new()` 补 `cancel_gen`/`clearing` 初始化**（漏字段初始化 = 编译失败）。
2. **`download` 调用传 `&key`**——形参 `&str` 且后续 `g.remove(&key)` 还要用 key，原 move 传值双重错误。
3. **Notify 丢唤醒窗口封死**：等待者在**仍持有 inflight 锁时**创建 `notified()` future 并 `enable()` 预注册，再 drop 锁 await——下载任务在「drop 锁 → await 注册」间隙 remove+notify_waiters 的永久挂起消除。
4. **DB 连接不跨网络 await**：表命中路径先读行 drop conn → await 远端 stat → 命中时重新取连接 touch、失效时重新取连接删行（原实现持 Mutex 连接 await 会锁住整个数据库）。
5. **清空准入闸门 + 实删**：`clearing: AtomicBool` + `begin_clearing()`（置位+cancel_all）/`end_clearing()`；`ensure_cached` 入口闸门拒绝（"clearing in progress"）——排空后新任务入场写入的竞态封死；`clear_archive_cache` 四段式（闸门→排空→实删 ready 文件+part/ 全清→复位，超时复位闸门返回忙碌错误不动文件）；DAO `clear_all` 改返回 `Vec<String>` 路径（原 `let _ = roots` 只清表不删文件的空洞），测试断言返回值 + 新增闸门拒绝/恢复用例。

## 附：计划审查修订记录（rev5，2026-08-19）

第七轮 1 必须（清缓存闸门 TOCTOU）采纳：

- **闸门与注册原子化**：`clearing` 从独立 `AtomicBool` 移入 `InflightState { clearing, map }`，与 in-flight 注册表同受一把 `async Mutex` 保护。`ensure_cached_inner` 删掉入口独立检查，「查 clearing + 查重 + 注册」在**单一临界区**原子完成；`begin_clearing()` 持同锁先置位再 `cancel_all()`——并发 `ensure_cached` 要么先注册（map 可见，drain 等它退出）、要么看到 clearing=true 被拒，不存在「读到 false → clear 观察空表 → 迟到注册带新代际穿透」的中间态。`end_clearing()` 同锁复位；命令侧两处调用补 `.await`；`inflight_empty`/清理路径读 `st.map`。rev4 的 Notified 持锁 `enable()` 预注册保留（两窗口修复叠加生效）。

## 附：计划审查修订记录（rev6，2026-08-19，终审通过 + 1 建议采纳）

终审通过（TOCTOU 由 InflightState 单锁封住、锁序与 Notify 预注册一致，无新阻断项）。建议采纳：任务 6 测试补两个方向守卫用例——`startup_cleanup_keeps_resumable_part_with_valid_sidecar`（有效 .part+sidecar **保留**、无/坏 sidecar 删、裸 .meta 非候选）与 `startup_cleanup_ignores_meta_files_as_part_candidates`（纯 .meta 目录不误删，.meta.tmp 残留清）；首用例描述同步 rev2+ 语义（原注释还是「.part 删」旧语义）。**计划定稿，可进入实现。**
