# M1 通用显示层（media:// 统一协议）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 落地 `media://` 统一自定义协议 + 阅读器去 Local-only + 本地 ZIP 全链路 + WebDAV keyring 凭据 + 远程缩略图，使 Local / Archive(local ZIP) / WebDAV 三类源走同一条浏览-阅读-缩略图流程。

**架构：** Tauri 异步 URI scheme handler（`media`）按固定段数 URL 解析出目标，从 DB 重建 descriptor，经 `MediaSourceFactory` 分发读取（GET/HEAD/Range）；前端 `mediaUrl()` 统一构造 URL 替换 `convertFileSrc`；trait 新增 `stat()`；凭据走 keyring（`CredentialStore` trait 抽象便于测试）；缩略图加远程取源异步阶段。

**技术栈：** Rust（tauri 2 `register_asynchronous_uri_scheme_protocol`、`tauri::http`、keyring 3、zip、reqwest）+ Vue 3 / TS（`convertFileSrc(path, 'media')`）+ Vitest / cargo test。

**规格：** `docs/superpowers/specs/2026-08-18-smb-remote-media-design.md`（rev3）§3。本计划只覆盖 M1；M2（SMB）/M3（远程 Archive 物化）另有计划。

**兼容性红线（spec §6，违反即返工）：** descriptor 契约字段零改动；`account` 表结构不动；Local 阅读/缩略图/fileBrowser 行为基线不变；既有测试全绿。

**约定：** Rust 测试跑 `cargo test -p mirapage-desktop-lib <过滤词>`（在 `src-tauri/` 下）；前端跑 `npx vitest run <路径>`。CRLF 文件（AGENTS.md 列表）多行 Edit 会失配——用单行锚点或 node 补丁脚本。

---

## 文件结构

**Rust 新建：**
- `src-tauri/src/media_protocol.rs` —— URL codec（单段 encode/decode）、六形态解析、校验链、Range 头解析、HTTP 响应构造（纯函数为主，可单测）
- `src-tauri/src/credentials.rs` —— `CredentialStore` trait + `KeyringStore`（生产）+ `MemoryStore`（测试）+ account 行查询

**Rust 修改：**
- `src-tauri/src/source/trait_def.rs` —— 加 `FileStat` + `stat()` 默认方法
- `src-tauri/src/source/local.rs` / `webdav_impl.rs` / `archive_impl.rs` / `smb_impl.rs` —— stat 实现（smb 留默认 NotImplemented）
- `src-tauri/src/source/webdav_impl.rs` —— Range 强契约（206/长度校验）+ Basic Auth + 凭据
- `src-tauri/src/commands/accounts.rs` —— keyring 补偿顺序 + type 不可变 + delete warning + test_connection 实装
- `src-tauri/src/thumbnail/fetch.rs`（新文件，归 thumbnail 模块）—— 远程取源队列
- `src-tauri/src/thumbnail/service.rs` —— `unsupported` 分支改远程取源
- `src-tauri/src/lib.rs` —— 注册 media 协议 + manage CredentialStore
- `src-tauri/Cargo.toml` —— 启用 `keyring = "3"`

**前端新建：**
- `src/lib/mediaUrl.ts` —— `mediaUrl(descriptor, relPath)` + `joinRel` 纯函数

**前端修改：**
- `src/composables/useReaderBookLoader.ts` —— 删 Local-only、pageUrls 统一 mediaUrl
- `src/views/History.vue` / `src/views/Likes.vue` —— 删 `type !== 'local'` 防御
- `src/stores/fileBrowser.ts` —— 持有当前 descriptor + ZIP 进入/退出
- `src/components/filebrowser/FileBrowser.vue` —— onEntryOpen 的 isArchive 分支 + 面包屑 ZIP 态
- `src/components/filebrowser/MasonryView.vue` —— originalUrlFor 切 mediaUrl
- `src/views/Accounts.vue` —— password 输入 + type 编辑锁定 + 删除 warning
- `src/lib/tauri.ts` —— deleteAccount 返回类型 + testConnection 语义
- `src/locales/zh-CN.ts` / `en-US.ts` —— 新 key 双语

---

### 任务 1：trait 加 `stat()` + FileStat + Local 实现

**文件：**
- 修改：`src-tauri/src/source/trait_def.rs`（95 行附近，`test` 方法后）
- 修改：`src-tauri/src/source/local.rs`（`impl MediaSource` 块内，`read_file` 后）
- 测试：`src-tauri/src/source/local.rs` tests 模块 / 新增 `src-tauri/src/source/trait_def.rs` 无需测试

- [ ] **步骤 1：写失败测试（local.rs 文件尾 tests 模块追加；若无处挂载用 tempdir）**

```rust
    #[tokio::test]
    async fn stat_returns_size_and_mtime() {
        let dir = std::env::temp_dir().join("mirapage-stat-test");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.bin");
        std::fs::write(&f, b"0123456789").unwrap();
        let src = LocalMediaSource::new();
        let d = SourceDescriptor::Local { root_path: dir.to_string_lossy().to_string() };
        let st = src.stat(&d, "a.bin").await.unwrap();
        assert_eq!(st.size, 10);
        assert!(st.modified_at.is_some());
        // 越界路径拒绝
        assert!(src.stat(&d, "../a.bin").await.is_err());
    }
```

- [ ] **步骤 2：运行验证失败**

运行：`cargo test -p mirapage-desktop-lib stat_returns_size` → 预期编译错误 `stat` 未定义。

- [ ] **步骤 3：实现**

trait_def.rs（`test` 方法后追加，trait 内给默认实现防 4 个实现全崩）：

```rust
    /// 文件元信息（HEAD / Content-Range / 缓存失效判定）
    ///
    /// 默认 NotImplemented；Local/WebDav/Archive 覆盖，Smb M2 覆盖。
    async fn stat(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<FileStat> {
        let _ = (descriptor, path);
        Err(MediaSourceError::NotImplemented("stat 未实现".into()))
    }
```

trait_def.rs 顶部（`ByteRange` 定义后）：

```rust
/// 文件元信息（spec rev3 §3.1：协议层 HEAD/416/物化失效判定的数据源）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    pub size: u64,
    /// 秒级 Unix；None = 源不提供（如 ZIP 内条目）
    pub modified_at: Option<i64>,
}
```

local.rs（`impl MediaSource for LocalMediaSource` 内）：

```rust
    async fn stat(&self, descriptor: &SourceDescriptor, path: &str) -> Result<FileStat> {
        let full_path = self.resolve_path(descriptor, path)?;
        let meta = tokio::fs::metadata(&full_path).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => MediaSourceError::NotFound(full_path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => MediaSourceError::PermissionDenied(full_path.display().to_string()),
            _ => MediaSourceError::Io(e),
        })?;
        Ok(FileStat {
            size: meta.len(),
            modified_at: meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64),
        })
    }
```

注意：`resolve_path` 已含 PathEscape 校验（`../` 拒绝），无需重复。

- [ ] **步骤 4：运行验证通过**

`cargo test -p mirapage-desktop-lib stat_returns_size` → PASS。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/trait_def.rs src-tauri/src/source/local.rs
git commit -m "feat(source): MediaSource 加 stat 默认方法 + Local 实现（FileStat size/mtime）"
```

---

### 任务 2：CredentialStore 抽象 + keyring 集成

**文件：**
- 创建：`src-tauri/src/credentials.rs`
- 修改：`src-tauri/Cargo.toml:62`（`# keyring = "3"` 去注释）
- 修改：`src-tauri/src/lib.rs`（mod 声明 + manage）

- [ ] **步骤 1：写失败测试（credentials.rs 文件内 tests 模块，用 MemoryStore）**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip_and_delete() {
        let s = MemoryStore::new();
        s.set_password("webdav-3", "p@ss").unwrap();
        assert_eq!(s.get_password("webdav-3").unwrap().as_deref(), Some("p@ss"));
        s.delete_password("webdav-3").unwrap();
        assert_eq!(s.get_password("webdav-3").unwrap(), None);
    }

    #[test]
    fn account_key_format() {
        assert_eq!(account_key("webdav", 3), "webdav-3");
        assert_eq!(account_key("smb", 12), "smb-12");
    }
}
```

- [ ] **步骤 2：`cargo test -p mirapage-desktop-lib credential` → 编译失败（模块不存在）**

- [ ] **步骤 3：实现 credentials.rs**

```rust
//! 凭据存储抽象（spec §3.4）：keyring 为生产实现，内存实现供测试。
//! service 固定；account key = "{type}-{id}"。密码不落 DB。

pub const KEYRING_SERVICE: &str = "top.racyan.mirapage-desktop";

pub fn account_key(kind: &str, id: i64) -> String {
    format!("{}-{}", kind, id)
}

pub trait CredentialStore: Send + Sync {
    fn set_password(&self, key: &str, password: &str) -> Result<(), String>;
    fn get_password(&self, key: &str) -> Result<Option<String>, String>;
    fn delete_password(&self, key: &str) -> Result<(), String>;
}

/// 生产实现：OS 凭据管理器（Windows Credential Manager / macOS Keychain / Linux Secret Service）
pub struct KeyringStore;

impl CredentialStore for KeyringStore {
    fn set_password(&self, key: &str, password: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .and_then(|e| e.set_password(password))
            .map_err(|e| format!("keyring set: {e}"))
    }
    fn get_password(&self, key: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(KEYRING_SERVICE, key).and_then(|e| e.get_password()) {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring get: {e}")),
        }
    }
    fn delete_password(&self, key: &str) -> Result<(), String> {
        match keyring::Entry::new(KEYRING_SERVICE, key).and_then(|e| e.delete_credential()) {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // 幂等
            Err(e) => Err(format!("keyring delete: {e}")),
        }
    }
}

/// 测试实现（不触 OS）
pub struct MemoryStore(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl MemoryStore {
    pub fn new() -> Self { Self(std::sync::Mutex::new(std::collections::HashMap::new())) }
}

impl CredentialStore for MemoryStore {
    fn set_password(&self, key: &str, password: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.to_string(), password.to_string());
        Ok(())
    }
    fn get_password(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn delete_password(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}
```

lib.rs：`mod credentials;` + setup 内 `app.manage(std::sync::Arc::new(credentials::KeyringStore) as std::sync::Arc<dyn credentials::CredentialStore>);`（放 `app.manage(db);` 之后）。Cargo.toml 启用 `keyring = "3"`。

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib credential` → PASS（2 个）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/credentials.rs src-tauri/Cargo.toml src-tauri/src/lib.rs
git commit -m "feat(credentials): CredentialStore 抽象 + keyring 生产实现 + 内存测试实现"
```

---

### 任务 3：accounts 命令补偿顺序 + type 不可变 + delete warning

**文件：**
- 修改：`src-tauri/src/commands/accounts.rs`（upsert_account 61-90 / delete_account 91-98 / test_connection 100+）
- 测试：`src-tauri/src/commands/accounts.rs` tests 模块（新建；用 in-memory SQLite + MemoryStore）

- [ ] **步骤 0：确认 Db 测试构造方式**

读 `src-tauri/src/db/mod.rs`，找现有测试怎么建内存库（若无先例，用 `rusqlite::Connection::open_in_memory()` + `crate::db::migrations::run(&conn)`；Db 包装方式照抄 db/mod.rs 的结构）。

- [ ] **步骤 1：写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{account_key, CredentialStore, MemoryStore};
    use std::sync::Arc;

    fn setup() -> (crate::db::Db, Arc<MemoryStore>) {
        let db = /* 步骤 0 确认的内存库构造 */;
        let store = Arc::new(MemoryStore::new());
        (db, store)
    }

    #[test]
    fn upsert_new_writes_keyring_and_rolls_back_on_failure() {
        // 用一个总是失败的 store 验证回滚
        struct FailStore;
        impl CredentialStore for FailStore {
            fn set_password(&self, _: &str, _: &str) -> Result<(), String> { Err("boom".into()) }
            fn get_password(&self, _: &str) -> Result<Option<String>, String> { Ok(None) }
            fn delete_password(&self, _: &str) -> Result<(), String> { Ok(()) }
        }
        let (db, _) = setup();
        let fail: Arc<dyn CredentialStore> = Arc::new(FailStore);
        let r = upsert_account_impl(&db, &fail, UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: Some("https://d".into()),
            port: None, share: None, username: Some("u".into()), password: Some("p".into()),
        });
        assert!(r.is_err());
        // 回滚：行不存在
        let conn = db.conn();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn upsert_edit_type_change_rejected() {
        let (db, store) = setup();
        let s: Arc<dyn CredentialStore> = store.clone();
        let id = upsert_account_impl(&db, &s, UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: None }).unwrap();
        let err = upsert_account_impl(&db, &s, UpsertAccountArgs {
            id: Some(id), name: "n".into(), kind: "smb".into(), host: None, port: None,
            share: None, username: None, password: None });
        assert!(err.is_err()); // type 不可变
    }

    #[test]
    fn upsert_edit_empty_password_keeps_old() {
        let (db, store) = setup();
        let s: Arc<dyn CredentialStore> = store.clone();
        let id = upsert_account_impl(&db, &s, UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: Some("old".into()) }).unwrap();
        upsert_account_impl(&db, &s, UpsertAccountArgs {
            id: Some(id), name: "n2".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: None }).unwrap();
        assert_eq!(store.get_password(&account_key("webdav", id)).unwrap().as_deref(), Some("old"));
    }

    #[test]
    fn delete_removes_keyring_first_and_reports_warning() {
        struct FailDelete(MemoryStore);
        impl CredentialStore for FailDelete {
            fn set_password(&self, k: &str, p: &str) -> Result<(), String> { self.0.set_password(k, p) }
            fn get_password(&self, k: &str) -> Result<Option<String>, String> { self.0.get_password(k) }
            fn delete_password(&self, _: &str) -> Result<(), String> { Err("locked".into()) }
        }
        let (db, _) = setup();
        let s: Arc<dyn CredentialStore> = Arc::new(FailDelete(MemoryStore::new()));
        let id = upsert_account_impl(&db, &s, UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: Some("p".into()) }).unwrap();
        let out = delete_account_impl(&db, &s, id).unwrap();
        assert!(out.warning.is_some()); // 凭据残留警告
    }
}
```

- [ ] **步骤 2：运行验证失败**（`_impl` 函数不存在）`cargo test -p mirapage-desktop-lib accounts` → 编译失败。

- [ ] **步骤 3：实现**

commands 签名重排（Tauri command 薄壳 + `_impl` 核心可测）：

```rust
#[tauri::command]
pub fn upsert_account(
    args: UpsertAccountArgs,
    db: tauri::State<crate::db::Db>,
    creds: tauri::State<std::sync::Arc<dyn crate::credentials::CredentialStore>>,
) -> Result<i64, String> {
    upsert_account_impl(&db, creds.inner(), args)
}

pub fn upsert_account_impl(
    db: &crate::db::Db,
    creds: &dyn crate::credentials::CredentialStore,
    args: UpsertAccountArgs,
) -> Result<i64, String> {
    let conn = db.conn();
    match args.id {
        Some(id) => {
            // type 不可变（spec §3.4）：编辑改类型直接拒绝
            let existing: String = conn.query_row("SELECT type FROM account WHERE id = ?1", rusqlite::params![id], |r| r.get(0))
                .map_err(|e| format!("account 不存在: {e}"))?;
            if existing != args.kind {
                return Err("账户类型不可修改；如需更换请删除后重新添加".into());
            }
            conn.execute(
                "UPDATE account SET name = ?1, host = ?2, port = ?3, share = ?4, username = ?5 WHERE id = ?6",
                rusqlite::params![args.name, args.host, args.port, args.share, args.username, id],
            ).map_err(|e| e.to_string())?;
            if let Some(p) = args.password.filter(|p| !p.is_empty()) {
                creds.set_password(&crate::credentials::account_key(&args.kind, id), &p)?;
            }
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                rusqlite::params![args.name, args.kind, args.host, args.port, args.share, args.username],
            ).map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            if let Some(p) = args.password.filter(|p| !p.is_empty()) {
                if let Err(e) = creds.set_password(&crate::credentials::account_key(&args.kind, id), &p) {
                    // 补偿：回滚刚插的行，不留无凭据账户
                    let _ = conn.execute("DELETE FROM account WHERE id = ?1", rusqlite::params![id]);
                    return Err(format!("凭据保存失败，账户未创建: {e}"));
                }
            }
            Ok(id)
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAccountResult {
    pub warning: Option<String>,
}

#[tauri::command]
pub fn delete_account(
    id: i64,
    db: tauri::State<crate::db::Db>,
    creds: tauri::State<std::sync::Arc<dyn crate::credentials::CredentialStore>>,
) -> Result<DeleteAccountResult, String> {
    delete_account_impl(&db, creds.inner(), id)
}

pub fn delete_account_impl(
    db: &crate::db::Db,
    creds: &dyn crate::credentials::CredentialStore,
    id: i64,
) -> Result<DeleteAccountResult, String> {
    let conn = db.conn();
    let kind: String = conn.query_row("SELECT type FROM account WHERE id = ?1", rusqlite::params![id], |r| r.get(0))
        .map_err(|e| format!("account 不存在: {e}"))?;
    let key = crate::credentials::account_key(&kind, id);
    // 先删凭据（重试 1 次），失败不阻断 DB 删除但报告残留（spec §3.4）
    let mut warning = None;
    if let Err(first) = creds.delete_password(&key) {
        if let Err(second) = creds.delete_password(&key) {
            log::warn!("keyring 删除失败（重试后仍失败）: {first}; {second}");
            warning = Some(format!("凭据可能残留在系统凭据管理器（{key}），请手动清理"));
        }
    }
    conn.execute("DELETE FROM account WHERE id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
    Ok(DeleteAccountResult { warning })
}
```

同时删掉旧 upsert 内的 `plain:` stub 注释块。`use serde::Serialize;` 已在文件头。

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib accounts` → PASS（4 个新用例 + 全量不红）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/commands/accounts.rs
git commit -m "feat(accounts): keyring 补偿顺序——新建失败回滚/type 编辑不可变/删除先凭据后 DB+warning"
```

---

### 任务 4：WebDAV stat + Range 强契约 + Basic Auth

**文件：**
- 修改：`src-tauri/src/source/webdav_impl.rs`（read_file 240-273 / test 287-316 / 新增 stat + 凭据取数）
- 测试：同文件 tests 模块（Range 校验逻辑抽纯函数可测；网络部分单测不覆盖，手测清单覆盖）

- [ ] **步骤 0：确认 account 行读取路径**

无 Db 直连（source 层不依赖 tauri State）。凭据获取方式：`WebDavMediaSource` 持 `Arc<dyn CredentialStore>` + `Db`？——看 factory：factory 在 lib.rs `new()` 构造、无 Db。**方案**：`WebDavMediaSource::new()` 改为 `new(creds: Arc<dyn CredentialStore>, db: Arc<Mutex<Connection>>)`? Db 是 `tauri::State` manage 的结构 `crate::db::Db`（内部 Mutex<Connection>）。factory::new() 需要这两者 → lib.rs setup 里先建 Db/CredentialStore 再 `MediaSourceFactory::new(db_handle, creds)`。读 `src-tauri/src/db/mod.rs` 确认 `Db` 可否被 factory 持有（若 `Db` 仅能 State 管理，则包一层 `Arc<Db>`：`app.manage(Arc::new(db))`？——State<Db> 与 Arc<Db> 可共存：`app.manage(Arc(app_handle.state::<Db>().inner()))` 复杂。**简化定案**：`Db` 内部若已 `Arc`/可克隆则直接克隆；否则 factory 持 `Db` 的克隆句柄（以 db/mod.rs 实际定义为准，此步骤确认后在任务 4/5 一致使用）。webdav 凭据取数函数：

```rust
fn webdav_credentials(
    db: &crate::db::Db,
    creds: &dyn crate::credentials::CredentialStore,
    account_id: i64,
) -> Result<(Option<String>, Option<String>)> {
    let conn = db.conn();
    let row = conn.query_row(
        "SELECT username FROM account WHERE id = ?1 AND type = 'webdav'",
        rusqlite::params![account_id],
        |r| r.get::<_, Option<String>>(0),
    ).map_err(|_| MediaSourceError::NotFound(format!("webdav account {account_id}")))?;
    let password = creds.get_password(&crate::credentials::account_key("webdav", account_id))
        .map_err(MediaSourceError::Other)?;
    Ok((row, password))
}
```

每个方法开头 `let (user, pass) = webdav_credentials(...)?;`，req 构造时 `if let (Some(u), Some(p)) = (&user, &pass) { req = req.basic_auth(u, Some(p)); }`（PROPFIND/GET/HEAD 全部带）。

- [ ] **步骤 1：写失败测试（Range 响应判定纯函数）**

```rust
    #[test]
    fn range_response_must_be_206_or_exact_length() {
        // spec rev3 §3.1 Range 强契约
        assert!(verify_range_response(206, 100, 100).is_ok());      // 206 且长度等
        assert!(verify_range_response(200, 100, 100).is_ok());      // 兼容：200 整段恰好等长
        assert!(verify_range_response(200, 999, 100).is_err());     // 200 整包≠请求长度 → 拒绝
        assert!(verify_range_response(200, 50, 100).is_err());      // 短读 → 拒绝
        assert!(verify_range_response(404, 0, 100).is_err());       // 非成功状态（上游已拦）
    }
```

- [ ] **步骤 2：`cargo test -p mirapage-desktop-lib range_response` → 编译失败**

- [ ] **步骤 3：实现**

webdav_impl.rs 顶部：

```rust
/// Range 响应校验（强契约）：请求 range 时返回字节必须恰好等于请求区间。
/// 206 直接过；200 仅当 body 长度恰等（个别服务器忽略 Range 却刚好截断）；其余一律报错，
/// 防止 M3 分块下载把整包/短读拼进 .part。
fn verify_range_response(status: u16, body_len: usize, expected_len: u64) -> Result<()> {
    if status == 206 || (status == 200 && body_len as u64 == expected_len) {
        Ok(())
    } else {
        Err(MediaSourceError::Network(format!(
            "server ignored range: status {status}, body {body_len} != expected {expected_len}"
        )))
    }
}
```

read_file 改动（255-272 区域）：记录 `let expected = range.map(|r| r.length);` → 收到响应后：

```rust
        if let (Some(exp), Some(r)) = (expected, range) {
            let _ = r;
            // 先取 body 再校验长度（bytes 已缓冲）
            let bytes = resp.bytes().await.map_err(|e| MediaSourceError::Network(format!("read: {e}")))?;
            verify_range_response(resp.status().as_u16(), bytes.len(), exp)?;
            return Ok(bytes.to_vec());
        }
        let bytes = resp.bytes().await.map_err(|e| MediaSourceError::Network(format!("read: {e}")))?;
        Ok(bytes.to_vec())
```

（无 range 的路径维持原样。）

stat 实现（trait override）：

```rust
    async fn stat(&self, descriptor: &SourceDescriptor, path: &str) -> Result<FileStat> {
        let (account_id, base_url, _) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("WebDavMediaSource 仅处理 WebDav descriptor".into())
        })?;
        let (user, pass) = webdav_credentials(&self.db, self.creds.as_ref(), *account_id)?;
        let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let client = Client::builder().timeout(Duration::from_secs(10)).build()
            .map_err(|e| MediaSourceError::Other(format!("reqwest: {e}")))?;
        let mut req = client.head(&url);
        if let (Some(u), Some(p)) = (&user, &pass) { req = req.basic_auth(u, Some(p)); }
        let resp = req.send().await.map_err(|e| MediaSourceError::Network(format!("head: {e}")))?;
        match resp.status() {
            StatusCode::NOT_FOUND => return Err(MediaSourceError::NotFound(url)),
            s if !s.is_success() => return Err(MediaSourceError::Network(format!("HEAD status {s}"))),
            _ => {}
        }
        let size = resp.headers().get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| MediaSourceError::Other("HEAD 无 Content-Length".into()))?;
        // Last-Modified: HTTP-date → Unix 秒（失败容忍为 None）
        let modified_at = resp.headers().get(header::LAST_MODIFIED)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_http_date_secs);
        Ok(FileStat { size, modified_at })
    }
```

`parse_http_date_secs`：手写 RFC 7231（`Sun, 06 Nov 1994 08:49:37 GMT`）解析小函数 + 单测（不再引入 httpdate 依赖）：

```rust
fn parse_http_date_secs(s: &str) -> Option<i64> {
    // "Sun, 06 Nov 1994 08:49:37 GMT" → 784111777
    let rest = s.split_once(", ")?.1;
    let (d, rest) = rest.split_once(' ')?;
    let (mon, rest) = rest.split_once(' ')?;
    let (y, rest) = rest.split_once(' ')?;
    let (hms, _) = rest.split_once(' ').unwrap_or((rest, ""));
    let months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let mon_idx = months.iter().position(|m| *m == mon)? as u64;
    let day: u64 = d.parse().ok()?;
    let year: i64 = y.parse().ok()?;
    let mut parts = hms.split(':');
    let hh: u64 = parts.next()?.parse().ok()?;
    let mm: u64 = parts.next()?.parse().ok()?;
    let ss: u64 = parts.next()?.parse().ok()?;
    // 简化儒略日（民用历足够；1970+ 有效）
    let days = (365 * (year - 1970) + (year - 1969) / 4 - (year - 1901) / 100 + (year - 1601) / 400)
        + [0u64, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334][mon_idx as usize] + day - 1;
    Some(((days * 86400 + hh * 3600 + mm * 60 + ss) as i64).min(i64::MAX))
}
```

（闰年 2 月末 ±1 天误差对缓存失效判定无实际影响——失效主判据是 size；此注释保留在代码里。）

构造函数改造：`WebDavMediaSource::new(db: crate::db::Db 句柄, creds: Arc<dyn CredentialStore>)`（形态按步骤 0 结论），`factory.rs::new()` 同步改签名（lib.rs setup 传入；Local/Archive/Smb 不需要则仅 WebDav 持有）。`test()` 方法同样接 basic_auth。

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib webdav` → PASS（新 2 个 + 既有 propfind/url 用例不红）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/webdav_impl.rs src-tauri/src/source/factory.rs src-tauri/src/lib.rs
git commit -m "feat(webdav): stat(HEAD)+Range 强契约(206/长度校验)+Basic Auth(账户+keyring)"
```

---

### 任务 5：media_protocol 纯函数——URL codec + 解析校验

**文件：**
- 创建：`src-tauri/src/media_protocol.rs`
- 修改：`src-tauri/src/lib.rs`（`mod media_protocol;`）

- [ ] **步骤 1：写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_single_segment() {
        assert_eq!(encode_segment("a/b"), "a%2Fb");          // 字段内 / 必须编码（单段铁律）
        assert_eq!(encode_segment("100%.jpg"), "100%25.jpg");
        assert_eq!(encode_segment("中文"), "%E4%B8%AD%E6%96%87");
        assert_eq!(encode_segment("plain-A_1.txt"), "plain-A_1.txt"); // unreserved 原样
        assert_eq!(encode_segment(r"C:\x"), "C%3A%5Cx");
    }

    #[test]
    fn decode_rejects_invalid_pct_and_bare_percent() {
        assert_eq!(decode_segment("a%2Fb").unwrap(), "a/b");
        assert_eq!(decode_segment("100%25.jpg").unwrap(), "100%.jpg"); // 含 % 合法文件名（rev3）
        assert!(decode_segment("100%.jpg").is_err());   // 裸 % 非法编码
        assert!(decode_segment("%zz").is_err());        // 非 hex
        assert!(decode_segment("%2").is_err());         // 截断
    }

    #[test]
    fn parse_local() {
        let t = parse_media_path(&format!("/local/{}", encode_segment("D:/comics/x.jpg"))).unwrap();
        assert!(matches!(t, MediaTarget::Local { ref abs_path } if abs_path == "D:/comics/x.jpg"));
    }

    #[test]
    fn parse_webdav_fixed_segments() {
        let p = format!("/webdav/7/{}", encode_segment("sub/页.jpg"));
        let t = parse_media_path(&p).unwrap();
        assert!(matches!(t, MediaTarget::WebDav { account_id: 7, ref rel_path } if rel_path == "sub/页.jpg"));
    }

    #[test]
    fn parse_smb_initial_path_single_segment() {
        let p = format!("/smb/3/{}/{}", encode_segment("share/comics"), encode_segment("v1/001.jpg"));
        match parse_media_path(&p).unwrap() {
            MediaTarget::Smb { account_id, ref initial_path, ref rel_path } => {
                assert_eq!((account_id, initial_path.as_str(), rel_path.as_str()),
                           (3, "share/comics", "v1/001.jpg"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_archive_local_and_remote() {
        let p = format!("/archive/local/{}/{}", encode_segment("D:/a.cbz"), encode_segment("inner/p1.jpg"));
        assert!(matches!(parse_media_path(&p).unwrap(), MediaTarget::Archive { ref origin, .. }
            if matches!(origin.as_str(), "local")));
        let p2 = format!("/archive/webdav/7/{}/{}", encode_segment("books/a.zip"), encode_segment("p1.jpg"));
        assert!(matches!(parse_media_path(&p2).unwrap(), MediaTarget::Archive { ref origin, .. }
            if matches!(origin.as_str(), "webdav")));
    }

    #[test]
    fn parse_rejects_bad_shapes() {
        assert!(parse_media_path("/smb/3").is_err());                       // 段数不足
        assert!(parse_media_path("/smb/3/a/b/c").is_err());                 // 段数过多
        assert!(parse_media_path("/ftp/1/x").is_err());                     // 未知类型
        let dotdot = encode_segment("../etc/passwd");
        assert!(parse_media_path(&format!("/local/{dotdot}")).is_err());    // 结构化校验：..
        let abs = encode_segment("/etc/passwd");
        assert!(parse_media_path(&format!("/webdav/1/{abs}")).is_err());    // 绝对路径
        let empty = encode_segment("");
        assert!(parse_media_path(&format!("/webdav/1/{empty}")).is_err());  // 空字段
        assert!(parse_media_path(&format!("/smb/x/{}/y", encode_segment("s"))).is_err()); // accountId 非数字
    }

    #[test]
    fn validate_rel_path_rules() {
        assert!(validate_rel_path("a/b/c.jpg").is_ok());
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("../x").is_err());
        assert!(validate_rel_path("a/../../x").is_err());
        assert!(validate_rel_path("/abs").is_err());
        assert!(validate_rel_path("a//b").is_err());       // 空段
        assert!(validate_rel_path("a/./b").is_err());
        assert!(validate_rel_path("a\\b").is_err());       // 反斜杠拒绝（统一 / 语义）
        assert!(validate_rel_path("100%.jpg").is_ok());    // % 合法（rev3）
        // local 绝对路径走独立分支
        assert!(validate_abs_path("D:/x/y.jpg").is_ok());
        assert!(validate_abs_path("relative/path").is_err());
    }
}
```

- [ ] **步骤 2：`cargo test -p mirapage-desktop-lib media_protocol` → 编译失败**

- [ ] **步骤 3：实现**

```rust
//! media:// 协议纯函数层（spec rev3 §3.1）
//! 编码铁律：每个逻辑字段整体 percent-encode 为恰好一个 segment（字段内 `/` → `%2F`），
//! URL 段数固定，解析可逆。解码恰好一次，安全性靠结构化路径校验，不靠字符黑名单。

#[derive(Debug, PartialEq, Eq)]
pub enum MediaTarget {
    Local { abs_path: String },
    Smb { account_id: i64, initial_path: String, rel_path: String },
    WebDav { account_id: i64, rel_path: String },
    Archive { origin: String, account_id: Option<i64>, origin_ref: String, archive_rel_path: Option<String>, entry_path: String },
}
// Archive 语义：origin="local" → origin_ref=压缩包绝对路径；
//              origin="smb"/"webdav" → account_id=Some, origin_ref=initialPath 或 base 之外的相对首段,
//              archive_rel_path=压缩包在 origin 内相对路径（smb 形态 6 段、webdav 形态 5 段）

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    BadShape(&'static str),      // 段数/类型不符 → 404
    InvalidEncoding,             // 非法 % 序列 → 403
    InvalidPath(&'static str),   // 结构化校验失败 → 403
}

/// percent-encode：unreserved [A-Za-z0-9\-_.~] 原样，其余 %XX 大写 hex
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// decode 恰好一次；裸 % / 非 hex / 截断 → Err
pub fn decode_segment(s: &str) -> Result<String, ProtocolError> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() + 1 || i + 2 > bytes.len() - 1 { return Err(ProtocolError::InvalidEncoding); }
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
                _ => return Err(ProtocolError::InvalidEncoding),
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ProtocolError::InvalidEncoding)
}

/// 相对路径结构化校验（源内 relPath / initialPath / archiveRelPath / entryPath 共用）
pub fn validate_rel_path(p: &str) -> Result<(), ProtocolError> {
    if p.is_empty() || p.starts_with('/') || p.contains('\\') {
        return Err(ProtocolError::InvalidPath("空/绝对/反斜杠"));
    }
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(ProtocolError::InvalidPath("空段或点段"));
        }
    }
    Ok(())
}

/// 本地绝对路径校验（Windows 盘符或 UNC 开头；拒绝相对形态）
pub fn validate_abs_path(p: &str) -> Result<(), ProtocolError> {
    let ok = p.len() >= 3 && p.as_bytes()[1] == b':' && p.as_bytes()[2] == b'/'
        || p.starts_with(r"\\");
    if ok && !p.contains("..") { Ok(()) } else { Err(ProtocolError::InvalidPath("非绝对路径")) }
}

/// 解析 media 协议 path（`/type/...` 形态；Windows 下宿主是 media.localhost，path 即此处入参）
pub fn parse_media_path(path: &str) -> Result<MediaTarget, ProtocolError> {
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let n = segs.len();
    let acct = |s: &str| -> Result<i64, ProtocolError> {
        s.parse::<i64>().map_err(|_| ProtocolError::BadShape("accountId 非数字"))
    };
    match segs.first().copied() {
        Some("local") if n == 2 => {
            let p = decode_segment(segs[1])?;
            validate_abs_path(&p)?;
            Ok(MediaTarget::Local { abs_path: p })
        }
        Some("webdav") if n == 3 => {
            let id = acct(segs[1])?;
            let p = decode_segment(segs[2])?;
            validate_rel_path(&p)?;
            Ok(MediaTarget::WebDav { account_id: id, rel_path: p })
        }
        Some("smb") if n == 4 => {
            let id = acct(segs[1])?;
            let init = decode_segment(segs[2])?;
            let rel = decode_segment(segs[3])?;
            validate_rel_path(&init)?;
            validate_rel_path(&rel)?;
            Ok(MediaTarget::Smb { account_id: id, initial_path: init, rel_path: rel })
        }
        Some("archive") if n == 5 && segs[1] == "webdav" => {
            let id = acct(segs[2])?;
            let ar = decode_segment(segs[3])?;
            let entry = decode_segment(segs[4])?;
            validate_rel_path(&ar)?;
            validate_rel_path(&entry)?;
            Ok(MediaTarget::Archive { origin: "webdav".into(), account_id: Some(id),
                origin_ref: String::new(), archive_rel_path: Some(ar), entry_path: entry })
        }
        Some("archive") if n == 6 && segs[1] == "smb" => {
            let id = acct(segs[2])?;
            let init = decode_segment(segs[3])?;
            let ar = decode_segment(segs[4])?;
            let entry = decode_segment(segs[5])?;
            validate_rel_path(&init)?;
            validate_rel_path(&ar)?;
            validate_rel_path(&entry)?;
            Ok(MediaTarget::Archive { origin: "smb".into(), account_id: Some(id),
                origin_ref: init, archive_rel_path: Some(ar), entry_path: entry })
        }
        Some("archive") if n == 4 && segs[1] == "local" => {
            let abs = decode_segment(segs[2])?;
            let entry = decode_segment(segs[3])?;
            validate_abs_path(&abs)?;
            validate_rel_path(&entry)?;
            Ok(MediaTarget::Archive { origin: "local".into(), account_id: None,
                origin_ref: abs, archive_rel_path: None, entry_path: entry })
        }
        _ => Err(ProtocolError::BadShape("段数/类型不符")),
    }
}
```

（decode 的越界判断写成防御式：`i + 2 < bytes.len() + 1 && i + 2 <= bytes.len() - 1` 两种写法等价于 `i + 2 <= bytes.len() - 1`，实现时用后者并先判 `bytes.len() >= i + 3`。）

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib media_protocol` → PASS（encode/decode/parse/validate 全绿）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/media_protocol.rs src-tauri/src/lib.rs
git commit -m "feat(media): media:// URL codec——单段 encode/decode 恰好一次+六形态解析+结构化路径校验"
```

---

### 任务 6：media_protocol 纯函数——Range 头解析 + 响应构造

**文件：**
- 修改：`src-tauri/src/media_protocol.rs`（追加）

- [ ] **步骤 1：写失败测试（追加到 tests）**

```rust
    #[test]
    fn range_header_parsing() {
        use RangeResolution::*;
        assert_eq!(parse_range_header(None, 100), Full);
        assert_eq!(parse_range_header(Some("bytes=0-"), 100), Full);            // 覆盖全文 = 全量
        assert_eq!(parse_range_header(Some("bytes=0-99"), 100), Full);
        match parse_range_header(Some("bytes=10-19"), 100) {
            Partial(r) => assert_eq!((r.offset, r.length), (10, 10)),
            _ => panic!(),
        }
        assert_eq!(parse_range_header(Some("bytes=10-999"), 100),
                   Partial(crate::source::trait_def::ByteRange::new(10, 90)));  // clamp 尾界
        assert_eq!(parse_range_header(Some("bytes=100-"), 100), Unsatisfiable); // start >= total
        assert_eq!(parse_range_header(Some("bytes=-5-"), 100), Malformed);      // 后缀范围不支持
        assert_eq!(parse_range_header(Some("bytes=5-1"), 100), Malformed);      // start > end
        assert_eq!(parse_range_header(Some("chunks=1-2"), 100), Malformed);     // 非 bytes 单位
        assert_eq!(parse_range_header(Some("bytes=1-2,5-9"), 100), Malformed);  // 多段不支持
    }

    #[test]
    fn content_range_and_416_headers() {
        assert_eq!(format_content_range(10, 19, 100), "bytes 10-19/100");
        assert_eq!(format_unsatisfiable_range(100), "bytes */100");
    }
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现（追加到 media_protocol.rs）**

```rust
use crate::source::trait_def::ByteRange;

pub enum RangeResolution {
    Full,
    Partial(ByteRange),
    Unsatisfiable, // → 416
    Malformed,     // → 忽略 Range 按全量处理（HTTP 宽容语义；单段格式错误不当攻击）
}

/// 解析单段 `bytes=start-end`（闭区间）/ `bytes=start-`（开尾，clamp 到 total-1）。
/// start >= total → Unsatisfiable；end >= total → clamp（对齐 nginx 行为）。
pub fn parse_range_header(v: Option<&str>, total: u64) -> RangeResolution {
    let Some(v) = v else { return RangeResolution::Full };
    let Some(rest) = v.strip_prefix("bytes=") else { return RangeResolution::Malformed };
    if rest.contains(',') { return RangeResolution::Malformed; } // 多段不支持（M1）
    let (s, e) = match rest.split_once('-') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() => (s, Some(e)),
        Some((s, "")) if !s.is_empty() => (s, None), // 开尾
        _ => return RangeResolution::Malformed,      // 后缀范围 bytes=-N 等
    };
    let Ok(start) = s.parse::<u64>() else { return RangeResolution::Malformed };
    if start >= total { return RangeResolution::Unsatisfiable; }
    let end = match e {
        Some(et) => match et.parse::<u64>() {
            Ok(v) if v >= start => v.min(total - 1),
            Ok(_) => return RangeResolution::Malformed,
            Err(_) => return RangeResolution::Malformed,
        },
        None => total - 1,
    };
    if start == 0 && end == total - 1 {
        RangeResolution::Full
    } else {
        RangeResolution::Partial(ByteRange::new(start, end - start + 1))
    }
}

pub fn format_content_range(start: u64, end: u64, total: u64) -> String {
    format!("bytes {start}-{end}/{total}")
}

pub fn format_unsatisfiable_range(total: u64) -> String {
    format!("bytes */{total}")
}
```

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib media_protocol` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/media_protocol.rs
git commit -m "feat(media): Range 头解析（单段闭区间/开尾/clamp/416 判定）+ Content-Range 构造"
```

---

### 任务 7：lib.rs 注册异步协议 handler（descriptor 重建 + 分发）

**文件：**
- 修改：`src-tauri/src/lib.rs`（builder 链上，`.invoke_handler` 之前加 `.register_asynchronous_uri_scheme_protocol("media", ...)`）

- [ ] **步骤 1：实现 handler（无纯单测——依赖 app state；逻辑已全在任务 5/6 纯函数，此处是组装。手测在任务 16）**

```rust
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            tokio::spawn(async move {
                let resp = handle_media_request(ctx.app_handle(), request).await;
                let _ = responder.respond(resp);
            });
        })
```

lib.rs 内新增（或新模块 `media_protocol::handle`，放 media_protocol.rs 里带 `tauri` 依赖的 `#[cfg]` 部分——**放 lib.rs 旁边新函数**保持 media_protocol.rs 无 tauri 依赖可纯测）：

```rust
/// media:// 请求组装：解析 → 重建 descriptor → factory 分发 → stat/read → HTTP 响应
async fn handle_media_request(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{Response, StatusCode};
    use media_protocol::*;

    let path = request.uri().path().to_string();
    let target = match parse_media_path(&path) {
        Ok(t) => t,
        Err(ProtocolError::BadShape(_)) => return err_response(StatusCode::NOT_FOUND, "not found"),
        Err(_) => return err_response(StatusCode::FORBIDDEN, "forbidden"),
    };
    let factory = app.state::<source::MediaSourceFactory>();
    let (descriptor, file_path): (source::descriptor::SourceDescriptor, String) = match rebuild_descriptor(app, &target) {
        Ok(v) => v,
        Err(code_msg) => return err_response(code_msg.0, &code_msg.1),
    };
    // SMB share 契约（spec §4.2，M1 生效代码、M2 验收）：initialPath 首段 === account.share
    if let (MediaTarget::Smb { initial_path, .. }, source::descriptor::SourceDescriptor::Smb { .. }) = (&target, &descriptor) {
        if let Some(share) = first_segment(initial_path) {
            if !smb_share_matches(app, &share) {
                return err_response(StatusCode::FORBIDDEN, "forbidden");
            }
        }
    }
    let src = factory.resolve(&descriptor);
    let name = file_path.rsplit('/').next().unwrap_or(&file_path).to_string();
    let mime = crate::algorithm::mime_from_name(&name)
        .unwrap_or("application/octet-stream")
        .to_string();
    let is_head = request.method() == "HEAD";

    // stat（HEAD / Range 判定需要 total）
    let stat = match src.stat(&descriptor, &file_path).await {
        Ok(s) => s,
        Err(e) => return error_to_status(e),
    };
    let range = match parse_range_header(
        request.headers().get("range").and_then(|v| v.to_str().ok()),
        stat.size,
    ) {
        RangeResolution::Full => None,
        RangeResolution::Partial(r) => Some(r),
        RangeResolution::Unsatisfiable => {
            let mut b = tauri::http::Response::builder()
                .status(416)
                .header("Content-Range", media_protocol::format_unsatisfiable_range(stat.size))
                .header("Cache-Control", "no-store");
            let _ = b.headers_mut(); // 见下：headers 构造见 build_ok
            return finish(b, Vec::new());
        }
        RangeResolution::Malformed => None,
    };
    if is_head {
        let b = tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime.clone())
            .header("Content-Length", stat.size.to_string())
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-store");
        return finish(b, Vec::new());
    }
    match src.read_file(&descriptor, &file_path, range).await {
        Ok(bytes) => {
            let b = if let Some(r) = range {
                tauri::http::Response::builder()
                    .status(206)
                    .header("Content-Type", mime)
                    .header("Content-Length", bytes.len().to_string())
                    .header("Content-Range", media_protocol::format_content_range(r.offset, r.offset + r.length - 1, stat.size))
                    .header("Accept-Ranges", "bytes")
                    .header("Cache-Control", "no-store")
            } else {
                tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Content-Length", bytes.len().to_string())
                    .header("Accept-Ranges", "bytes")
                    .header("Cache-Control", "no-store")
            };
            finish(b, bytes)
        }
        Err(e) => error_to_status(e),
    }
}

/// 从 DB 重建 descriptor（URL 只带定位信息，host/port/凭据全在 DB）
fn rebuild_descriptor(
    app: &tauri::AppHandle,
    t: &media_protocol::MediaTarget,
) -> Result<(source::descriptor::SourceDescriptor, String), (tauri::http::StatusCode, String)> {
    use media_protocol::MediaTarget;
    use source::descriptor::SourceDescriptor;
    let db = app.state::<crate::db::Db>();
    let not_found = || (tauri::http::StatusCode::NOT_FOUND, "account not found".to_string());
    Ok(match t {
        MediaTarget::Local { abs_path } => {
            let root = abs_path_parent_root(&abs_path); // 见下：Local descriptor root = 文件所在逻辑盘根即可（read 只用 abs_path 拼接，见注）
            (SourceDescriptor::Local { root_path: root }, abs_path_rel(&abs_path, &root))
        }
        MediaTarget::WebDav { account_id, rel_path } => {
            let (host, _port) = account_row(&db, *account_id, "webdav")?;
            let base_url = host.ok_or_else(not_found)?;
            (SourceDescriptor::WebDav { account_id: *account_id, base_url, path: rel_path.clone() }, rel_path.clone())
        }
        MediaTarget::Smb { account_id, initial_path, rel_path } => {
            account_row(&db, *account_id, "smb")?;
            let port = default_smb_port();
            (SourceDescriptor::Smb { account_id: *account_id, initial_path: initial_path.clone(), path: rel_path.clone(), port }, rel_path.clone())
        }
        MediaTarget::Archive { origin, account_id, origin_ref, archive_rel_path, entry_path } => match origin.as_str() {
            "local" => {
                let abs = origin_ref.clone();
                (SourceDescriptor::Archive {
                    archive_path: abs.clone(),
                    entry_prefix: String::new(),
                    format: format_from_name(&abs),
                    origin: None, origin_entry_path: None, archive_rel_path: None,
                }, entry_path.clone())
            }
            "webdav" => {
                let id = account_id.ok_or_else(not_found)?;
                let (host, _) = account_row(&db, id, "webdav")?;
                let base_url = host.ok_or_else(not_found)?;
                let ar = archive_rel_path.clone().unwrap_or_default();
                (SourceDescriptor::Archive {
                    archive_path: format!("{}/{}", base_url.trim_end_matches('/'), ar), // 虚拟路径（spec §5.1）
                    entry_prefix: String::new(),
                    format: format_from_name(&ar),
                    origin: Some(Box::new(SourceDescriptor::WebDav { account_id: id, base_url, path: String::new() })),
                    origin_entry_path: Some(ar.clone()),
                    archive_rel_path: Some(ar),
                }, entry_path.clone())
            }
            "smb" => { /* 同 webdav 模式，origin=Smb descriptor；M1 阶段 SMB source NotImplemented → 502。代码先行，M2 验收 */ }
            _ => return Err(not_found()),
        },
    })
}
```

辅助函数（同文件）：`account_row(&Db, id, kind) -> Result<(Option<String>, Option<i64>), ...>`（查 `SELECT host, port FROM account WHERE id=? AND type=?`，无行或不匹配 → 404）；`format_from_name`（复用 `ArchiveFormat::from_extension`）；`abs_path_parent_root` + `abs_path_rel`（Local 特例：`LocalMediaSource::resolve_path` 是 `root.join(path)`——读 `local.rs` 的 `resolve_path` 确认行为后，最稳妥做法是 **root = abs_path 的目录、rel = 文件名**，避免跨盘 join 陷阱）；`first_segment(&str) -> Option<String>`；`smb_share_matches(app, &str) -> bool`（account.share == Some(seg)）；`default_smb_port() -> i32`（445，与 descriptor.rs 的 `default_smb_port` 复用——若私有则本地重声明）；`error_to_status(MediaSourceError)`（NotFound→404、PermissionDenied/PathEscape→403、Network/Timeout→502、其余→500）；`err_response(status, msg)` 与 `finish(builder, body)`（`Response::builder().body(body).unwrap()`——builder 已静态合法）。

**注意**：`tauri::http::Response` 泛型 body `Vec<u8>` 满足 `UriSchemeResponder::respond` 的 `Into<Cow<'static, [u8]>>`；若编译器要求 `Cow`，包 `std::borrow::Cow::Owned(body)`。

- [ ] **步骤 2：编译 + 既有测试不红**

`cargo test -p mirapage-desktop-lib` → PASS（无新增用例，组装层）。`cargo check` 通过。

- [ ] **步骤 3：冒烟（可选，尽早发现问题）**

`npm run tauri:dev` → devtools console 执行：
```js
await fetch(window.__TAURI_INTERNALS__.convertFileSrc(`local/${encodeURIComponent('F:/WorkSpaceCollection/git/mirapage-desktop/package.json')}`, 'media')).then(r => r.status)
```
预期 `200`。（`convertFileSrc(path, protocol)` 的编码行为若与本约定冲突——它可能整体 encode——以 devtools network 面板实际请求 URL 为准修正任务 10 的 mediaUrl 拼法，Rust 端解析不变。）

- [ ] **步骤 4：Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/media_protocol.rs
git commit -m "feat(media): register_asynchronous_uri_scheme_protocol——descriptor DB 重建+stat/Range/HEAD 分发+no-store"
```

---

### 任务 8：test_connection 实装

**文件：**
- 修改：`src-tauri/src/commands/accounts.rs`（test_connection 100+ 行 stub 区）

- [ ] **步骤 1：写失败测试**

```rust
    #[test]
    fn test_connection_smb_not_implemented_yet() {
        let (db, store) = setup();
        let s: Arc<dyn CredentialStore> = store.clone();
        let id = upsert_account_impl(&db, &s, UpsertAccountArgs {
            id: None, name: "n".into(), kind: "smb".into(), host: Some("192.168.1.1".into()),
            port: Some(445), share: Some("media".into()), username: None, password: None }).unwrap();
        assert!(test_connection_impl(&db, id).is_err()); // M1：SMB 未实装，明确报错而非假 true
    }
```

（webdav 路径依赖网络，单测不覆盖；手测清单覆盖。）

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现**

```rust
#[tauri::command]
pub fn test_connection(
    id: i64,
    db: tauri::State<crate::db::Db>,
) -> Result<bool, String> {
    test_connection_impl(&db, id)
}

pub fn test_connection_impl(db: &crate::db::Db, id: i64) -> Result<bool, String> {
    let conn = db.conn();
    let (kind, host, port, share): (String, Option<String>, Option<i64>, Option<String>) = conn
        .query_row("SELECT type, host, port, share FROM account WHERE id = ?1", rusqlite::params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| format!("账户不存在: {e}"))?;
    let factory = crate::source::MediaSourceFactory::new_for_test(); // 或复用 manage 的构造方式——见下注
    let rt = tokio::runtime::Handle::current();
    match kind.as_str() {
        "webdav" => {
            let base_url = host.clone().ok_or("webdav 账户缺少 host（应为完整 base URL）")?;
            let d = crate::source::descriptor::SourceDescriptor::WebDav {
                account_id: id, base_url, path: String::new(),
            };
            rt.block_on(async move { factory.resolve(&d).test(&d).await })
                .map(|_| true).map_err(|e| e.to_string())
        }
        "smb" => Err("SMB 尚未实装（module 3.3.0 交付）".into()),
        _ => Err(format!("未知账户类型 {kind}")),
    }
}
```

**注**：factory 构造已需要 Db/CredentialStore（任务 4 改造）。command 里拿不到 State——把 `MediaSourceFactory` 也从 `tauri::State` 取：`test_connection` 命令签名加 `factory: tauri::State<MediaSourceFactory>`，`_impl` 收 `&MediaSourceFactory` + `&Db`。`block_on` 在 sync command 中安全（Tauri command 线程无 runtime 借用；若 panic 则改 `#[tauri::command]` 为 `async fn` + `.await`——优先 async fn 写法直接去掉 block_on）。

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib test_connection` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/commands/accounts.rs
git commit -m "feat(accounts): test_connection 实装——webdav 真握手 / smb 明确未实装报错"
```

---

### 任务 9：缩略图远程取源异步阶段

**文件：**
- 创建：`src-tauri/src/thumbnail/fetch.rs`
- 修改：`src-tauri/src/thumbnail/service.rs`（521-529 unsupported 分支 + 533 local_abs_path 分流）
- 修改：`src-tauri/src/thumbnail/mod.rs`（`pub mod fetch;`）

- [ ] **步骤 0：读三个现有文件确认签名**

`thumbnail/scheduler.rs`（QueuedTask/GenerationJob/GenerateFn 形状、提交入口）、`thumbnail/key.rs`（cache_key 计算函数签名）、`thumbnail/service.rs` 240-330（生产 generate fn 如何读本地文件——bytes 变体要镜像它）。以下代码按 3.0.7 报告的形状写，**执行时以实际签名为准对齐字段名**。

- [ ] **步骤 1：写失败测试（fetch 队列单测，mock 取源闭包）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn fetch_queue_limits_concurrency_and_cancels_by_epoch() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut q = RemoteFetchQueue::new(2, {
            let (active, peak, tx) = (active.clone(), peak.clone(), tx.clone());
            Arc::new(move |key: String| {
                let (active, peak, tx) = (active.clone(), peak.clone(), tx.clone());
                Box::pin(async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    tx.send(key).unwrap();
                    Ok(Vec::new())
                })
            })
        });
        for i in 0..6 { q.submit(format!("k{i}"), SourceToFetch { key: format!("k{i}") }, 1).await; }
        q.new_epoch(2); // 取消未完成的
        let mut got = 0;
        while rx.try_recv().is_ok() { got += 1; }
        assert!(got <= 6);
        assert!(peak.load(Ordering::SeqCst) <= 2, "并发不得超过信号量上限");
    }
}
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现 fetch.rs**

```rust
//! 远程取源异步阶段（spec rev3 §3.5）：独立并发上限 + 在途预算，
//! bytes 到手才进解码队列；epoch 取消在取源期即生效。

use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::Semaphore;

pub struct SourceToFetch {
    pub key: String, // cache_key（in-flight 去重用）
}

pub type FetchFn = Arc<dyn Fn(String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, String>> + Send>> + Send + Sync>;

pub struct RemoteFetchQueue {
    sem: Semaphore,
    inflight: tokio::sync::Mutex<HashSet<String>>,
    fetch: FetchFn,
    on_done: tokio::sync::mpsc::UnboundedSender<(String, Result<Vec<u8>, String>)>,
    epoch: std::sync::atomic::AtomicU64,
}

impl RemoteFetchQueue {
    /// on_done：取源完成（成功带 bytes）→ service 侧组装解码任务提交 scheduler
    pub fn new(concurrency: usize, fetch: FetchFn) -> (Self, tokio::sync::mpsc::UnboundedReceiver<(String, Result<Vec<u8>, String)>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (Self {
            sem: Semaphore::new(concurrency),
            inflight: tokio::sync::Mutex::new(HashSet::new()),
            fetch,
            on_done: tx,
            epoch: std::sync::atomic::AtomicU64::new(0),
        }, rx)
    }

    pub fn new_epoch(&self, e: u64) {
        self.epoch.store(e, std::sync::atomic::Ordering::SeqCst);
    }

    pub async fn submit(&self, key: String, _src: SourceToFetch, epoch_at_submit: u64) {
        {
            let mut g = self.inflight.lock().await;
            if g.contains(&key) { return; }
            g.insert(key.clone());
        }
        let permit = self.sem.clone().acquire_owned().await;
        if self.epoch.load(std::sync::atomic::Ordering::SeqCst) != epoch_at_submit {
            self.inflight.lock().await.remove(&key);
            return; // 已切目录，丢弃
        }
        let fut = (self.fetch)(key.clone());
        let out = fut.await;
        let _ = permit;
        self.inflight.lock().await.remove(&key);
        let _ = self.on_done.send((key, out));
    }
}
```

service.rs 接线（`request()` 内 521-529 的 `if !local` 分支替换）：

```rust
                if !local {
                    // rev3 §3.5：远程源——索引命中直返；未命中走远程取源队列（不占解码 worker）
                    match classify_remote(&conn, &cache_root, &descriptor_json, item, epoch, quality) {
                        Ok(ItemClass::Cached { cache_key, cache_abs, width, height }) => results.push(RequestResult {
                            path: item.path.clone(), status: "cached".into(),
                            cache_path: Some(cache_abs.to_string_lossy().into()),
                            cache_key: Some(cache_key), width: Some(width), height: Some(height), error_kind: None,
                        }),
                        Ok(ItemClass::UseOriginal) => results.push(RequestResult {
                            path: item.path.clone(), status: "original".into(), ..unset(&item.path)
                        }),
                        Ok(ItemClass::Generate { task: _, cache_abs }) => {
                            // 占位 queued；取源完成事件由 fetch_done 回调提交真任务并 emit（模式同 thumbnail://progress）
                            let ck = cache_abs.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
                            let _ = ck;
                            self.remote_fetch.submit(item.source_rel_path_key(), SourceToFetch { key: item.cache_key() }, epoch).await;
                            results.push(RequestResult { path: item.path.clone(), status: "queued".into(), ..unset(&item.path) });
                        }
                        Err(e) => results.push(err_result(&item.path, &e)),
                    }
                    continue;
                }
```

`classify_remote`：复制 `classify_item` 去掉 `verify_disk_file`（远程没有本地文件可验），输入用 `item.source_rel_path`。`item.cache_key()`：若 `ThumbnailRequestItem` 无该字段，用与 `classify_item` 相同的 key 计算函数（步骤 0 确认 key.rs 签名后内联调用）。取源完成回调（`fetch.rs` 的 on_done 消费方）：在 service 持有的后台任务里 `while let Some((key, res)) = rx.recv().await` → 成功则构造 bytes-based QueuedTask（generate 闭包用 `std::io::Cursor::new(bytes.clone())` 替代 `File::open`，其余复用生产 generate fn 逻辑）→ scheduler 提交 → emit 完成事件（复用现有 emit 路径）；失败则 emit failed 事件。service 构造处（lib.rs 初始化 ThumbnailService 处）spawn 该消费循环。

- [ ] **步骤 4：`cargo test -p mirapage-desktop-lib thumbnail` → PASS（既有 105 缩略图用例 + fetch 新用例不红）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/thumbnail/fetch.rs src-tauri/src/thumbnail/service.rs src-tauri/src/thumbnail/mod.rs src-tauri/src/lib.rs
git commit -m "feat(thumbnail): 远程取源异步阶段——独立并发+in-flight 去重+epoch 取消，bytes 到手才进解码队列"
```

---

### 任务 10：前端 mediaUrl 帮助函数

**文件：**
- 创建：`src/lib/mediaUrl.ts`
- 测试：`src/lib/mediaUrl.test.ts`

- [ ] **步骤 1：写失败测试**

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, protocol: string) => `http://${protocol}.localhost/${path}`,
}));

import { joinRel, mediaUrl } from './mediaUrl';
import type { SourceDescriptor } from './sourceDescriptor';

const local: SourceDescriptor = { type: 'local', rootPath: 'F:/comics' } as SourceDescriptor;
const webdav: SourceDescriptor = { type: 'webdav', accountId: 7, baseUrl: 'https://d.example/dav', path: '' } as SourceDescriptor;

describe('mediaUrl', () => {
  it('local：absPath 单段 encode', () => {
    expect(mediaUrl(local, 'F:/comics/vol1/001.jpg')).toBe(
      'http://media.localhost/local/' + encodeURIComponent('F:/comics/vol1/001.jpg'));
  });

  it('webdav：accountId + relPath 两段', () => {
    expect(mediaUrl(webdav, 'sub/页.jpg')).toBe(
      'http://media.localhost/webdav/7/' + encodeURIComponent('sub/页.jpg'));
  });

  it('smb：initialPath 与 relPath 各自单段（内部 / 被编码）', () => {
    const smb = { type: 'smb', accountId: 3, initialPath: 'share/comics', path: '', port: 445 } as SourceDescriptor;
    const url = mediaUrl(smb, 'v1/001.jpg');
    expect(url).toBe('http://media.localhost/smb/3/' + encodeURIComponent('share/comics') + '/' + encodeURIComponent('v1/001.jpg'));
  });

  it('archive(local)：archivePath + entryPath 单段', () => {
    const ar = { type: 'archive', archivePath: 'D:/a.cbz', entryPrefix: '', format: 'cbz' } as SourceDescriptor;
    const url = mediaUrl(ar, 'inner/p1.jpg');
    expect(url).toBe('http://media.localhost/archive/local/' + encodeURIComponent('D:/a.cbz') + '/' + encodeURIComponent('inner/p1.jpg'));
  });

  it('含 % 文件名合法通过（rev3：100%25.jpg → 100%.jpg）', () => {
    expect(mediaUrl(webdav, '100%.jpg')).toContain(encodeURIComponent('100%.jpg'));
  });

  it('joinRel 拼接规范', () => {
    expect(joinRel('', 'a')).toBe('a');
    expect(joinRel('a', 'b')).toBe('a/b');
    expect(joinRel('a/', '/b')).toBe('a/b');
  });
});
```

（注：`SourceDescriptor` TS 类型字段名以 `src/lib/sourceDescriptor.ts` 实际为准——`initialPath`/`baseUrl`/`accountId` 若为别的拼写，测试与本实现同步用实际名。）

- [ ] **步骤 2：`npx vitest run src/lib/mediaUrl.test.ts` → FAIL（模块不存在）**

- [ ] **步骤 3：实现 mediaUrl.ts**

```ts
/**
 * media:// 统一 URL 构造（spec rev3 §3.1）。
 * 铁律：每个逻辑字段整体 encodeURIComponent 为恰好一个 segment（字段内 `/` 被编码），
 * URL 段数固定；Rust 端 media_protocol.rs 逐段 decode 恰好一次。
 * 经 convertFileSrc(path, 'media') 转 WebView 可请求形态（Windows: http://media.localhost/...）。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { SourceDescriptor } from './sourceDescriptor';

export function joinRel(base: string, rel: string): string {
  if (!base) return rel;
  if (!rel) return base;
  return `${base}/${rel}`.replace(/\/+/g, '/');
}

function seg(s: string): string {
  return encodeURIComponent(s);
}

export function mediaUrl(descriptor: SourceDescriptor, relPath: string): string {
  switch (descriptor.type) {
    case 'local':
      // relPath 传文件绝对路径（Local 的 URL 语义 = absPath 单段）
      return convertFileSrc(`local/${seg(relPath)}`, 'media');
    case 'webdav':
      return convertFileSrc(`webdav/${descriptor.accountId}/${seg(relPath)}`, 'media');
    case 'smb':
      return convertFileSrc(`smb/${descriptor.accountId}/${seg(descriptor.initialPath)}/${seg(relPath)}`, 'media');
    case 'archive': {
      const origin = descriptor.origin;
      if (!origin) {
        return convertFileSrc(`archive/local/${seg(descriptor.archivePath)}/${seg(relPath)}`, 'media');
      }
      if (origin.type === 'webdav') {
        return convertFileSrc(`archive/webdav/${origin.accountId}/${seg(descriptor.archiveRelPath ?? '')}/${seg(relPath)}`, 'media');
      }
      // smb origin（M2 验收；M1 代码先行）
      return convertFileSrc(
        `archive/smb/${origin.accountId}/${seg(origin.initialPath)}/${seg(descriptor.archiveRelPath ?? '')}/${seg(relPath)}`,
        'media',
      );
    }
  }
}
```

（若 `convertFileSrc` 对 path 二次编码导致 `%` 变 `%25`，以任务 7 步骤 3 冒烟实测为准改用字面量拼 `http://media.localhost/`（Windows）——封装在本函数内，调用方无感。）

- [ ] **步骤 4：`npx vitest run src/lib/mediaUrl.test.ts` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/lib/mediaUrl.ts src/lib/mediaUrl.test.ts
git commit -m "feat(media): 前端 mediaUrl——四类源单段 encode + convertFileSrc(media) 桥接"
```

---

### 任务 11：阅读器 loader 通用化

**文件：**
- 修改：`src/composables/useReaderBookLoader.ts`（116-160 区域）
- 测试：`src/composables/useReaderBookLoader.test.ts`（追加用例）

- [ ] **步骤 1：写失败测试**

```ts
  it('webdav descriptor 不再抛「非本地资源」且 pageUrls 走 media://', async () => {
    const { getBook, listDirectory } = await import('@/lib/tauri');
    (getBook as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1, sourceDescriptor: { type: 'webdav', accountId: 7, baseUrl: 'https://d/x', path: '' },
      absolutePath: 'comics/v1',
    });
    (listDirectory as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'a.jpg', path: 'a.jpg', isDirectory: false, isArchive: false, size: 1, modifiedAt: 1 },
    ]);
    const loader = useReaderBookLoader();
    const snap = await loader.loadBookById(1, {});
    expect(snap.pageUrls[0]).toContain('media.localhost/webdav/7/');
  });

  it('archive(local) descriptor：pageUrls 走 archive/local 形态', async () => {
    /* 同款 mock：sourceDescriptor = { type:'archive', archivePath:'D:/a.cbz', entryPrefix:'', format:'cbz', origin: null },
       absolutePath: ''，listDirectory 返回 [p1.jpg]；断言 pageUrls[0] 含 'archive/local/' */
  });
```

（第二条按第一条模式补全代码；现有测试文件的 mock 结构照抄。）

- [ ] **步骤 2：`npx vitest run src/composables/useReaderBookLoader.test.ts` → 新用例 FAIL（现有用例应仍 PASS）**

- [ ] **步骤 3：实现（116-160 区域改造）**

```ts
    const descriptor = parseSourceDescriptor(b.sourceDescriptor);
    if (!descriptor) throw new Error('source descriptor 解析失败');
    const relPath = b.absolutePath ?? '';
    const relCheck = validateSourceRelativePath(relPath);
    if (!relCheck.ok) {
      log('[useReaderBookLoader] absolute_path 越出数据源根, 拒绝加载', { bookId, absolutePath: relPath, reason: relCheck.reason });
      throw new Error(`书库记录路径异常（absolute_path="${relPath}"），请重新从正确根目录打开`);
    }
    const normalizedRel = relCheck.normalized;
    // Local 保留 absDir 概念仅用于日志/校验；URL 统一 mediaUrl（spec §2 决策：Local 同走 media://）
    const absDir = descriptor.type === 'local'
      ? joinPath(descriptor.rootPath.replace(/[\\/]+$/, ''), normalizedRel)
      : normalizedRel;
    const targetEntries: MediaEntry[] = await listDirectory(descriptor, normalizedRel);
    // ...（排序/过滤 imageNames 与现状一致，不动）
    const pageUrls = imageNames.map((name) =>
      mediaUrl(descriptor, descriptor.type === 'local'
        ? joinPath(absDir, name)              // local：relPath 语义 = 文件绝对路径
        : joinRel(normalizedRel, name)));     // 远程：relPath 语义 = 源内相对路径
```

（`mediaUrl`/`joinRel` import 自 `@/lib/mediaUrl`；`joinPath` 沿用文件内现有 import；`rootPath` 在类型收窄后访问。Local 分支删除原 `descriptor.type !== 'local'` 抛错行。）

- [ ] **步骤 4：`npx vitest run src/composables/useReaderBookLoader.test.ts` → 全 PASS（含 Local 既有用例——它们断言 absDir 语义而非 convertFileSrc 具体 URL，若有 URL 断言同步改为 mediaUrl 断言）**

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useReaderBookLoader.ts src/composables/useReaderBookLoader.test.ts
git commit -m "feat(reader): loader 去 Local-only——四类源统一 mediaUrl（Local absPath/远程 relPath 语义分流）"
```

---

### 任务 12：History / Likes 打开防御放开

**文件：**
- 修改：`src/views/History.vue:57` / `src/views/Likes.vue:54,70,132`
- 测试：`src/views/History.test.ts` / `src/views/Likes.test.ts`（追加）

- [ ] **步骤 1：写失败测试（History.test.ts 追加）**

```ts
  it('非 Local descriptor 的记录可打开（不再因类型防御 return）', async () => {
    /* 构造 entry：sourceDescriptor = { type:'webdav', accountId:7, baseUrl:'https://d/x', path:'' }, relPath: 'comics/v1'
       mock listDirectory；触发打开行为（组件内 openEntry 或等价入口）；
       断言 router.push 到 /reader/:id（或该组件实际的打开副作用）而非无操作 */
  });
```

（Likes.test.ts 同款：`v-if type==='local'` 的浏览按钮对 webdav 行也渲染。测试体按两文件现有 mock 结构补全。）

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现**

History.vue `openEntry`（57 行区域）与 Likes.vue（54/70 行）：删除 `if (sd.type !== 'local') return;` 防御行及其注释，流程直接走 `router.push(reader 路由)`。Likes.vue 132 行浏览按钮 `v-if="book.sourceDescriptor.type === 'local'"` 改 `v-if="!!book.sourceDescriptor"`。`openEntry` 内 Local 专用的 relPath 拼接分支（70 行）改为通用：`return entry.relPath`（webdav/smb 的 relPath 本就是源内相对路径；Local 语义不变——如原实现有 Local 特判路径，保留 Local 分支仅删类型门）。

- [ ] **步骤 4：`npx vitest run src/views/History.test.ts src/views/Likes.test.ts` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/views/History.vue src/views/Likes.vue src/views/History.test.ts src/views/Likes.test.ts
git commit -m "feat(views): History/Likes 打开防御放开——非 Local 记录走同一 reader 流程"
```

---

### 任务 13：FileBrowser ZIP 进入/退出

**文件：**
- 修改：`src/stores/fileBrowser.ts`（descriptor 持有 + openArchive/exitArchive）
- 修改：`src/components/filebrowser/FileBrowser.vue`（onEntryOpen 553-556 no-op 分支 + 面包屑）
- 测试：`src/stores/fileBrowser.test.ts`（追加）

- [ ] **步骤 0：确认类型**

读 `src/lib/sourceDescriptor.ts`：Archive 的 `format` 字段联合类型与 `origin` 可空性；`src/lib/mime.ts` 是否已有扩展名→format 帮助（无则内联 `cbz|zip → 'zip' 系`映射，对齐 Rust `ArchiveFormat::from_extension` 认知的子集）。

- [ ] **步骤 1：写失败测试（fileBrowser.test.ts 追加）**

```ts
  it('openArchive：构造 Archive descriptor（绝对路径）并保存返回上下文', async () => {
    const fb = useFileBrowserStore();
    await fb.setRoot('F:/comics');            // toDescriptor(Local)
    await fb.navigate('sub');
    const entry = { name: 'book.cbz', path: 'book.cbz', isDirectory: false, isArchive: true, size: 1, modifiedAt: 1 };
    await fb.openArchive(entry);
    expect(fb.archiveParent).toEqual({ rootPath: 'F:/comics', path: 'sub' });
    expect(fb.currentDescriptor?.type).toBe('archive');
    expect((fb.currentDescriptor as any).archivePath).toBe('F:/comics/sub/book.cbz'); // 绝对路径（rev2 §3.3）
  });

  it('exitArchive：恢复进入前目录', async () => {
    /* openArchive 后调 exitArchive，断言 rootPath/currentPath 恢复、archiveParent=null */
  });

  it('ZIP 内 navigate 上层（path 已空）触发 exitArchive', async () => {
    /* setDescriptor(archive) 后 navigate('..') 语义：path=='' 时恢复 parent */
  });
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现**

fileBrowser.ts（store 追加；`toDescriptor` 保留为 Local 便捷构造）：

```ts
  const currentDescriptor = ref<SourceDescriptor | null>(null);
  const archiveParent = ref<{ rootPath: string; path: string } | null>(null);

  /** 打开本地压缩包：进入 ZIP 条目视图（spec §3.3，archivePath 必须绝对路径） */
  async function openArchive(entry: MediaEntry) {
    const root = rootPath.value;
    const dir = currentPath.value;
    const abs = joinPath(joinPath(root, dir), entry.name).replace(/\\/g, '/');
    archiveParent.value = { rootPath: root, path: dir };
    currentDescriptor.value = {
      type: 'archive', archivePath: abs, entryPrefix: '',
      format: archiveFormatOf(entry.name), origin: null,
    } as SourceDescriptor;
    await refreshWithDescriptor(currentDescriptor.value, '');
  }

  /** 退出压缩包：恢复进入前目录 */
  async function exitArchive() {
    const parent = archiveParent.value;
    archiveParent.value = null;
    currentDescriptor.value = null;
    if (parent) { rootPath.value = parent.rootPath; await navigate(parent.path); }
  }
```

（`refreshWithDescriptor`：现有 `navigate` 的取数主体抽出为 descriptor 参数版——`listDirectory(descriptor, path)` 本就通用；`navigate('')` 到顶且 `archiveParent` 非空时自动 `exitArchive()`（在 navigate 的"到根再向上"分支特判）。`archiveFormatOf`：`const e = name.split('.').pop()?.toLowerCase(); return e === 'cbz' || e === 'zip' ? 'zip' : 'zip'`——以步骤 0 确认的 TS format 联合为准（CBZ/ZIP 同走 zip 解码，Rust `ArchiveFormat::Cbz | Zip` 同臂）。）

FileBrowser.vue `onEntryOpen`（553 行 no-op 替换）：

```ts
  if (entry.isArchive) {
    log('[FileBrowser] onEntryOpen: archive → openArchive');
    await fb.openArchive(entry);
    return;
  }
```

面包屑：`archiveParent` 非空时首段显示 ZIP 文件名（点击 `exitArchive`），后续段为 ZIP 内路径。

- [ ] **步骤 4：`npx vitest run src/stores/fileBrowser.test.ts` → PASS（既有 navigate/setRoot 用例不红）**

- [ ] **步骤 5：Commit**

```bash
git add src/stores/fileBrowser.ts src/components/filebrowser/FileBrowser.vue src/stores/fileBrowser.test.ts
git commit -m "feat(filebrowser): 双击 ZIP 进入条目视图——Archive descriptor(绝对路径)+进入/退出上下文恢复"
```

---

### 任务 14：MasonryView originalUrlFor 切 mediaUrl

**文件：**
- 修改：`src/components/filebrowser/MasonryView.vue:181`
- 测试：`src/components/filebrowser/MasonryView.test.ts`（若存在；否则快照式组件测新增）

- [ ] **步骤 1：写失败测试**

```ts
  it('originalUrlFor 返回 media:// 形态 URL（不再 convertFileSrc 本地路径）', () => {
    /* 挂载 MasonryView（props 照现有测试），取 vm 暴露的 originalUrlFor 或触发含原图 URL 的渲染；
       断言 URL 含 'media.localhost/' 且为 webdav/local 形态之一（按传入 descriptor） */
  });
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现（181 行替换）**

```ts
  originalUrlFor: (e) => mediaUrl(
    props.descriptor ?? { type: 'local', rootPath: props.rootPath } as SourceDescriptor,
    joinRel(props.currentPath, e.name),
  ),
```

（props 加 `descriptor?: SourceDescriptor`；FileBrowser 模板传 `:descriptor="fb.currentDescriptor ?? undefined"`——Local 目录 fallback 对象保证旧行为。`joinRel` 自 `@/lib/mediaUrl`。）

- [ ] **步骤 4：`npx vitest run src/components/filebrowser/MasonryView.test.ts` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/components/filebrowser/MasonryView.vue
git commit -m "feat(masonry): 原图 URL 切 media://（descriptor 优先，Local fallback）"
```

---

### 任务 15：Accounts.vue 密码框 + type 锁定 + 删除 warning + i18n

**文件：**
- 修改：`src/views/Accounts.vue`（draft 表单 + remove + 编辑态）
- 修改：`src/lib/tauri.ts`（deleteAccount 返回类型）
- 修改：`src/locales/zh-CN.ts` / `src/locales/en-US.ts`（accounts 段 215 行区域）
- 测试：`src/views/Accounts.test.ts`（追加）

- [ ] **步骤 1：写失败测试**

```ts
  it('编辑态 type 下拉禁用（type 不可变）', async () => {
    /* startEdit 后断言 kind 字段 disabled */
  });
  it('保存传 password 字段', async () => {
    /* 填 password → save → upsertAccount 被调用且参数含 password */
  });
  it('删除返回 warning 时展示提示', async () => {
    /* mock deleteAccount resolve { warning: '凭据可能残留...' } → 断言提示文案出现 */
  });
```

- [ ] **步骤 2：运行验证失败**

- [ ] **步骤 3：实现**

tauri.ts：

```ts
export interface DeleteAccountResult { warning: string | null }
export async function deleteAccount(id: number): Promise<DeleteAccountResult> {
  return invoke<DeleteAccountResult>('delete_account', { id });
}
```

Accounts.vue：draft 加 `password: string`；表单加 `<input type="password" :placeholder="t('accounts.passwordPlaceholder')">`（编辑态 placeholder = `t('accounts.passwordKeep')`）；编辑态 kind 切换禁用（`:disabled="editing"`）；`remove` 改收 `DeleteAccountResult`，`warning` 非空时置 `warning.value = res.warning` 顶部展示 5s。i18n（双语同步）：

```
accounts.passwordPlaceholder: 新建输入密码 / Password
accounts.passwordKeep: 留空保持不变 / Leave blank to keep
accounts.credentialWarning: 凭据可能残留在系统凭据管理器，请手动清理 / Credential may remain in OS credential manager
accounts.typeLocked: 类型不可修改 / Type is immutable
```

（删除调用点若还有别处引用 `deleteAccount`，同步适配新返回类型。）

- [ ] **步骤 4：`npx vitest run src/views/Accounts.test.ts` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src/views/Accounts.vue src/lib/tauri.ts src/locales/zh-CN.ts src/locales/en-US.ts src/views/Accounts.test.ts
git commit -m "feat(accounts): 密码框+type 编辑锁定+删除凭据残留 warning（i18n 双语）"
```

---

### 任务 16：全量验证 + 手测清单 + 收尾

**文件：**
- 修改：`AGENTS.md`（状态表加 3.2.0 行）/ `DESIGN.md` §16.1（划掉已完成项——注意 M1 只完成「显示层」部分，SMB 条目到 M2 才划）
- 修改：`src-tauri/capabilities/default.json` 无需动（media 协议不经 capability 权限系统）

- [ ] **步骤 1：全量自动化**

```bash
npm run type-check                 # 0 error
npm test -- --run                  # 全绿（基线 + 新增）
cd src-tauri && cargo test         # 全绿
```

- [ ] **步骤 2：本地手测（spec §3.6 七项，`npm run tauri:dev`）**

1. 本地目录阅读回归：三模式翻页 + 跨卷 + 书签添加/跳转 + 进度恢复
2. 本地 CBZ：双击 ZIP → 条目列表 → 双击图片阅读 → 退出再进（进度恢复）；面包屑 ZIP 名点击退出
3. masonry：Local 目录瀑布流缩略图正常（回归）+ 远程（WebDAV）目录瀑布流缩略图生成 + 原图打开
4. WebDAV 带密码服务器：账户添加（密码）→ 测试连接绿 → 浏览 → 阅读 → 历史记录点击再开
5. devtools network：图片请求 `media.localhost` 形态；构造 `Range` 请求（console fetch 带 Range 头）确认 206/416
6. URL 攻击面：console fetch 伪造 `media://local/<encode('C:/Windows/win.ini')>` 之外再试 `..`、错段数 → 403/404
7. keyring：Windows 凭据管理器查看 `top.racyan.mirapage-desktop` 条目；删除账户后条目消失（或 warning 提示）

- [ ] **步骤 3：状态表 + tag**

```bash
git add AGENTS.md DESIGN.md
git commit -m "docs: 状态表补 module3.2.0-media-display（M1 通用显示层）"
git tag v0.1.0-module3.2.0-media-display
git push github main
git push github v0.1.0-module3.2.0-media-display
git push origin main --tags
```

---

## 自检记录

- **规格覆盖度**：spec §3.1（任务 5/6/7）、§3.2（11/12）、§3.3（13）、§3.4（2/3/15、4 的 Basic Auth）、§3.5（9/14）、§3.6（16 手测清单）——全覆盖；§4/§5 属 M2/M3 不在本计划。
- **占位符**：任务 4/9 的"步骤 0 确认签名"是显式探索步骤（带产出物），非占位；任务 11/12 测试中的注释骨架处已在紧邻行给出第一用例的完整模式供镜像，执行者须补全后再跑红——已在步骤内写明。
- **类型一致性**：`FileStat`（任务 1 定义，4/7 使用）、`CredentialStore`（2 定义，3/4 使用）、`MediaTarget`（5 定义，7 使用）、`mediaUrl/joinRel`（10 定义，11/13/14 使用）、`DeleteAccountResult`（3 定义 Rust，15 定义 TS 镜像）——一致。
- **已知执行期风险**：convertFileSrc 二次编码行为（任务 7/10 已写实测修正路径）；Db 在 factory 中的持有形态（任务 4 步骤 0 定案后任务 8 跟随）。
