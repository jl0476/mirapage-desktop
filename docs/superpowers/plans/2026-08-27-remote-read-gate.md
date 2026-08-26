# 远程读取总闸门与 WebDAV 连接复用 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 一把全局两阶段远程读取闸门（并发 permit + ×2 记账字节预算）覆盖 WebDAV/SMB 的 `read_file`/`stat`，WebDAV 复用共享 Client + 单响应上限 + 流式累加，media path singleflight 收敛 warm 与 media:// miss。

**架构：** 新模块 `remote_gate.rs`（`Arc` 注入两个 `MediaSource`，factory 持全局）；webdav 改共享 client（按 `accept_invalid_tls` 两实例）+ `read_body_capped` 流式上限；`media_cache` 加 generation 守卫 + watch 单飞注册表；`lib.rs`/`warm.rs` 统一走 `fetch_remote_to_cache`。

**技术栈：** Rust（tokio Semaphore/watch、reqwest pool、futures-util Stream）；spec：`docs/superpowers/specs/2026-08-26-remote-read-gate-design.md`（三轮审查定稿，51a1b1f）。

**规格章节 → 任务映射：** §5→任务1/4/6；§6→任务2/3/4；§7→任务5/6；§8/§8.1/§8.2→任务7/8；§9 常量散布各任务；§11 测试散布各任务；§13→任务9。

---

## 工程师须知（先读）

- **所有命令在 `src-tauri/` 下跑**（Rust）或仓库根（前端）。Rust 包名 `mirapage-desktop-lib`（lib）+ `mirapage-desktop`（bin）。
- **勿跑 `cargo update`**——锁文件钉了 zeroize 1.8.1 / zeroize_derive 1.4.2（edition2024 问题，见 `Cargo.toml` 注释）。
- **CRLF 文件**：`AGENTS.md` / `DESIGN.md` 是 CRLF。用 Edit 工具时选**单行锚点**；多行替换会失配。
- **每任务结束必须全绿再 commit**：`cargo test --lib` 0 fail。
- 错误变体：`MediaSourceError::Network(String)`（本计划闸忙/超上限/超时全用它——spec §10 定死，勿用 `Timeout` 变体，media:// 映射不变）。
- 现有基线：Rust lib 588 passed、前端 1216、type-check 0 err。本计划**前端零改动**（仅最后跑回归）。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `src-tauri/src/source/remote_gate.rs` | 创建 | 两阶段闸门（并发/字节双 Semaphore + acquire 超时） |
| `src-tauri/src/source/mod.rs` | 修改 | 注册 `pub mod remote_gate;` |
| `src-tauri/src/source/webdav_impl.rs` | 修改 | 共享 client、`read_body_capped`、read/stat/PROPFIND 接闸 |
| `src-tauri/src/source/smb/connection.rs` | 修改 | 公开 `invalidate` |
| `src-tauri/src/source/smb/mock_transport.rs` | 修改 | 延迟/挂起钩子 + 在途计数 |
| `src-tauri/src/source/smb/source.rs` | 修改 | gate/read_timeout 注入、read/stat 过闸、读超时摘槽 |
| `src-tauri/src/source/factory.rs` | 修改 | 两个 source 构造传全局 gate |
| `src-tauri/src/media_cache.rs` | 修改 | generation + `put_if_generation` + `fetch_remote_to_cache`（watch 单飞） |
| `src-tauri/src/lib.rs` | 修改 | media:// miss 分支改 `fetch_remote_to_cache` |
| `src-tauri/src/commands/warm.rs` | 修改 | `read_and_cache_media` 改调统一函数 |

---

### 任务 1：RemoteGate 模块

**文件：**
- 创建：`src-tauri/src/source/remote_gate.rs`
- 修改：`src-tauri/src/source/mod.rs`

- [ ] **步骤 1.1：编写失败的测试**

创建 `src-tauri/src/source/remote_gate.rs`，先只写测试骨架（实现体为空 `todo!()` 会编译失败，所以先写完整文件但实现用最小可编译的空壳 + 测试）：

```rust
//! 全局远程读取两阶段闸门（spec 2026-08-26 §5）。
//! 阶段① enter/enter_conn_only：并发 permit（发请求前拿）；
//! 阶段② reserve_bytes：字节 permit（响应头后按 Content-Length ×2 记账拿）。
//! 两类 permit 全 RAII，错误/超时/panic 路径天然释放。

use crate::source::trait_def::MediaSourceError;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const REMOTE_GATE_CONCURRENCY: usize = 8;
pub const REMOTE_GATE_BYTES: usize = 512 * 1024 * 1024;
pub const REMOTE_GATE_ACCOUNT_MULTIPLIER: usize = 2;
pub const GATE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);

const GATE_BUSY: &str = "远程读取闸门繁忙";

pub struct RemoteGate {
    permits: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    acquire_timeout: Duration,
}

/// 阶段① permit（含后续 reserve_bytes 所需的预算句柄与超时配置）。
pub struct RemotePermit {
    bytes: Arc<Semaphore>,
    acquire_timeout: Duration,
    _conn: OwnedSemaphorePermit,
}

/// stat/HEAD 专用：仅并发 permit，无字节 reservation（无 body）。
pub struct ConnOnlyPermit {
    _conn: OwnedSemaphorePermit,
}

/// 阶段② permit：字节预算记账（载荷 × REMOTE_GATE_ACCOUNT_MULTIPLIER）。
pub struct ByteReservation {
    _bytes: OwnedSemaphorePermit,
}

impl RemoteGate {
    pub fn new(concurrency: usize, bytes: usize, acquire_timeout: Duration) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(concurrency)),
            bytes: Arc::new(Semaphore::new(bytes)),
            acquire_timeout,
        }
    }

    /// 全局共享单例（factory 用；测试一律用 new 注入，不触碰本单例——防并行串扰）。
    pub fn global_arc() -> Arc<Self> {
        static GLOBAL: std::sync::OnceLock<Arc<RemoteGate>> = std::sync::OnceLock::new();
        GLOBAL
            .get_or_init(|| Arc::new(Self::new(REMOTE_GATE_CONCURRENCY, REMOTE_GATE_BYTES, GATE_ACQUIRE_TIMEOUT)))
            .clone()
    }

    /// 阶段①（默认 acquire 超时）。
    pub async fn enter(&self) -> Result<RemotePermit, MediaSourceError> {
        self.enter_timeout(self.acquire_timeout).await
    }

    pub async fn enter_timeout(&self, d: Duration) -> Result<RemotePermit, MediaSourceError> {
        let conn = tokio::time::timeout(d, Arc::clone(&self.permits).acquire_owned())
            .await
            .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?  // AcquireError 仅在 close 时
            .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?;
        Ok(RemotePermit { bytes: Arc::clone(&self.bytes), acquire_timeout: self.acquire_timeout, _conn: conn })
    }

    /// stat/HEAD 专用阶段①（无字节）。
    pub async fn enter_conn_only(&self) -> Result<ConnOnlyPermit, MediaSourceError> {
        let conn = tokio::time::timeout(self.acquire_timeout, Arc::clone(&self.permits).acquire_owned())
            .await
            .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?
            .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?;
        Ok(ConnOnlyPermit { _conn: conn })
    }
}

impl RemotePermit {
    /// 阶段②：accounted 是**记账值**（载荷 ×2，调用方算好传入）。
    pub async fn reserve_bytes(&self, accounted: u32) -> Result<ByteReservation, MediaSourceError> {
        let bytes = tokio::time::timeout(
            self.acquire_timeout,
            Arc::clone(&self.bytes).acquire_many_owned(accounted),
        )
        .await
        .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（字节预算）")))?
        .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（字节预算）")))?;
        Ok(ByteReservation { _bytes: bytes })
    }
}
```

注：上面两段 `.map_err` 是「timeout Err → 忙」「AcquireError（semaphore close，进程退出竞态）→ 忙」双保险；写实现时合成一个链即可。文件尾部测试模块：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrency_limit_blocks_and_releases() {
        let g = RemoteGate::new(1, 1 << 30, Duration::from_millis(50));
        let p1 = g.enter().await.unwrap();
        assert!(g.enter().await.is_err(), "第 2 个 permit 应闸忙");
        drop(p1);
        assert!(g.enter().await.is_ok(), "drop 后应可再入");
    }

    #[tokio::test]
    async fn byte_budget_blocks_and_releases() {
        let g = RemoteGate::new(2, 100, Duration::from_millis(50));
        let p1 = g.enter().await.unwrap();
        let p2 = g.enter().await.unwrap();
        let r1 = p1.reserve_bytes(80).await.unwrap();
        assert!(p2.reserve_bytes(50).await.is_err(), "80+50 > 100 应闸忙");
        drop(r1);
        assert!(p2.reserve_bytes(50).await.is_ok(), "归还后应可再入");
    }

    #[tokio::test]
    async fn conn_only_uses_same_permits() {
        let g = RemoteGate::new(1, 1 << 30, Duration::from_millis(50));
        let p = g.enter().await.unwrap();
        assert!(g.enter_conn_only().await.is_err(), "conn_only 与 enter 共用并发池");
        drop(p);
        assert!(g.enter_conn_only().await.is_ok());
    }
}
```

- [ ] **步骤 1.2：注册模块**

`src-tauri/src/source/mod.rs` 在现有 `pub mod` 列表（按字母序插入 `pub mod remote_gate;`，位置在 `pub mod local;` 之后）。

- [ ] **步骤 1.3：运行测试验证通过**

运行：`cargo test --lib remote_gate`
预期：3 passed。

- [ ] **步骤 1.4：Commit**

```bash
git add src-tauri/src/source/remote_gate.rs src-tauri/src/source/mod.rs
git commit -m "feat(gate): 两阶段远程读取闸门（并发+字节预算+acquire 超时）"
```

---

### 任务 2：WebDAV 共享 Client 复用

**文件：**
- 修改：`src-tauri/src/source/webdav_impl.rs`（`:13-14` 设计取舍注释、`:67-100` build_client/send_retry_once、`:27-30` 结构体）

- [ ] **步骤 2.1：编写失败的测试**

在 `webdav_impl.rs` 尾部 `mod tests` 追加：

```rust
    #[test]
    fn shared_client_reuses_instances_per_tls_variant() {
        let a = shared_client(false);
        let b = shared_client(false);
        assert!(std::ptr::eq(a, b), "同 bad_tls 应复用同一实例");
        let c = shared_client(true);
        assert!(!std::ptr::eq(a, c), "strict 与 bad_tls 是两实例");
    }
```

- [ ] **步骤 2.2：运行测试验证失败**

运行：`cargo test --lib webdav_impl`
预期：编译失败 `cannot find function shared_client`。

- [ ] **步骤 2.3：实现**

替换 `build_client`（`:68-74`）为：

```rust
    /// 共享 client（spec §6.1）：按 accept_invalid_tls 两实例，OnceLock 全局。
    /// client 只依赖 bad_tls + 连接层参数；basic_auth 是 per-request header，
    /// 凭据/账户编辑不影响 client——无需账户失效钩子。10/15/30s 总超时由
    /// send_retry_once 在 RequestBuilder 上 per-request 设置。
    fn shared_client(bad_tls: bool) -> &'static Client {
        static STRICT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
        static BAD_TLS: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
        let cell = if bad_tls { &BAD_TLS } else { &STRICT };
        cell.get_or_init(|| {
            Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .pool_idle_timeout(Duration::from_secs(300))
                .danger_accept_invalid_certs(bad_tls)
                .build()
                .expect("reqwest client 构造（纯配置，无环境依赖，不会失败）")
        })
    }
```

`send_retry_once`（`:80-100`）改为同一 client + per-request 超时（hyper 对报错连接自动摘池，"换连接重试"意图保留且省一次握手）：

```rust
    async fn send_retry_once<F>(bad_tls: bool, timeout: Duration, make: F) -> std::result::Result<reqwest::Response, String>
    where
        F: Fn(reqwest::Client) -> reqwest::RequestBuilder,
    {
        let mut last = String::new();
        for attempt in 0..2 {
            let client = Self::shared_client(bad_tls);
            match make(client.clone()).timeout(timeout).send().await {
                Ok(r) => return Ok(r),
                Err(e) => {
                    if attempt == 0 {
                        last = e.to_string();
                        continue;
                    }
                    return Err(e.to_string());
                }
            }
        }
        unreachable!()
    }
```

同时删除文件头 `:13-14` 的旧取舍注释（"每次 list/read 都创建 reqwest Client…Phase 7+ 优化路径用 OnceCell 缓存"），替换为一行：`//! 设计取舍:共享 client 按账户 TLS 配置复用两实例(见 shared_client),连接池 idle 300s。`

- [ ] **步骤 2.4：运行测试验证通过**

运行：`cargo test --lib webdav_impl`
预期：全 passed（含既有 parse/url 测试）。

- [ ] **步骤 2.5：Commit**

```bash
git add src-tauri/src/source/webdav_impl.rs
git commit -m "refactor(webdav): 按 accept_invalid_tls 复用共享 Client（连接池+connect_timeout）"
```

---

### 任务 3：read_body_capped 流式累加

**文件：**
- 修改：`src-tauri/src/source/webdav_impl.rs`（新增常量 + 两个函数 + 测试）

- [ ] **步骤 3.1：编写失败的测试**

`mod tests` 追加：

```rust
    #[tokio::test]
    async fn accumulate_empty_and_exact_cap() {
        use futures_util::stream::{self, StreamExt};
        let empty: futures_util::stream::Iter<std::vec::IntoIter<std::result::Result<Vec<u8>, std::io::Error>>> =
            stream::iter(vec![]);
        let v = accumulate_capped(empty, 16, 1024).await.unwrap();
        assert!(v.is_empty());

        let s = stream::iter(vec![
            Ok(vec![0u8; 600]),
            Ok(vec![0u8; 400]),
        ]);
        let v = accumulate_capped(s, 16, 1024).await.unwrap();
        assert_eq!(v.len(), 1000, "恰好等长不触发上限");
    }

    #[tokio::test]
    async fn accumulate_breaks_mid_stream_over_cap() {
        use futures_util::stream::{self, StreamExt};
        let s = stream::iter(vec![
            Ok(vec![0u8; 600]),
            Ok(vec![0u8; 600]), // 累计 1200 > 1024
            Ok(vec![0u8; 1]),
        ]);
        let err = accumulate_capped(s, 16, 1024).await.unwrap_err();
        assert!(err.contains("超过上限"), "错误串：{err}");
    }

    #[tokio::test]
    async fn accumulate_does_not_preallocate_cap() {
        use futures_util::stream::{self, StreamExt};
        // 声明大 CL 场景：initial_capacity = min(CL, 1MiB)，流只发 3 字节
        let s = stream::iter(vec![Ok(vec![1u8, 2, 3])]);
        let v = accumulate_capped(s, BODY_INITIAL_CAPACITY, WEBDAV_MAX_RESPONSE).await.unwrap();
        assert_eq!(v.len(), 3);
        assert!(v.capacity() < 64 * 1024, "不应按 256MiB CL 预分配，capacity={}", v.capacity());
    }
```

- [ ] **步骤 2.2：运行测试验证失败**

运行：`cargo test --lib webdav_impl`
预期：编译失败（`accumulate_capped` / 常量未定义）。

- [ ] **步骤 3.3：实现**

在 `webdav_impl.rs` 模块级（`impl WebDavMediaSource` 之外）新增：

```rust
/// 单响应上限（spec §9，对齐 MAX_SMB_READ_BYTES 与 media LRU）。
pub(crate) const WEBDAV_MAX_RESPONSE: usize = 256 * 1024 * 1024;
/// PROPFIND 目录 XML 聚合上限（spec §6.3）。
pub(crate) const PROPFIND_MAX_RESPONSE: usize = 32 * 1024 * 1024;
/// 流式累加初始容量：min(CL, 1MiB)，不按声明 CL 预分配（复审 P2）。
pub(crate) const BODY_INITIAL_CAPACITY: usize = 1024 * 1024;

/// 流式累加核心（纯函数，测试用 stream::iter 注入；生产走 read_body_capped）。
/// 双保险：即使 CL 说谎（声明小实际大），累计超 cap 立即断开。
pub(crate) async fn accumulate_capped<S, B, E>(
    stream: S,
    initial_capacity: usize,
    cap: usize,
) -> std::result::Result<Vec<u8>, String>
where
    S: futures_util::Stream<Item = std::result::Result<B, E>>,
    B: AsRef<[u8]>,
{
    let mut body = Vec::with_capacity(initial_capacity);
    futures_util::pin_mut!(stream);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("read: {e}"))?;
        body.extend_from_slice(chunk.as_ref());
        if body.len() > cap {
            return Err(format!("read: 响应体超过上限 {cap} 字节"));
        }
    }
    Ok(body)
}

/// 响应体流式读取（reqwest "stream" feature 的 chunk_stream）。替换
/// resp.bytes() + to_vec() 双缓冲；初始容量 min(CL, BODY_INITIAL_CAPACITY)。
pub(crate) async fn read_body_capped(
    mut resp: reqwest::Response,
    cap: usize,
) -> std::result::Result<Vec<u8>, String> {
    let initial = resp
        .headers()
        .content_length()
        .unwrap_or(0)
        .min(BODY_INITIAL_CAPACITY as u64) as usize;
    accumulate_capped(resp.chunk_stream(), initial, cap).await
}
```

- [ ] **步骤 3.4：运行测试验证通过**

运行：`cargo test --lib webdav_impl`
预期：全 passed。

- [ ] **步骤 3.5：Commit**

```bash
git add src-tauri/src/source/webdav_impl.rs
git commit -m "feat(webdav): read_body_capped 流式累加（CL 预检外的第二道上限 + 不预分配）"
```

---

### 任务 4：WebDAV read_file/stat/PROPFIND 接闸

**文件：**
- 修改：`src-tauri/src/source/webdav_impl.rs`（结构体 `:27-38`、read_file `:387-431`、stat `:482-515`、list_directory `:380-384`、test `:380`）
- 修改：`src-tauri/src/source/factory.rs:48`

- [ ] **步骤 4.1：编写失败的测试**

`mod tests` 追加（闸忙先于任何网络/DB 请求——gate 在 `credentials_for` 之前 acquire，无需 account 行）。测试构造依赖任务 4.3 的三参构造器与 `gate_for_test`，一起写红：

```rust
    #[tokio::test]
    async fn stat_busy_when_gate_exhausted() {
        use crate::source::remote_gate::RemoteGate;
        let gate = std::sync::Arc::new(RemoteGate::new(1, 1 << 30, std::time::Duration::from_millis(50)));
        let db = crate::db::Db::open_in_memory().unwrap();
        let creds = std::sync::Arc::new(crate::credentials::MemoryStore::new());
        let src = super::WebDavMediaSource::new(db, creds, gate.clone());
        let _hold = src.gate_for_test().enter().await.unwrap();
        let desc = SourceDescriptor::WebDav {
            account_id: 1,
            base_url: "http://127.0.0.1:1/".into(),
            path: String::new(),
        };
        let err = src.stat(&desc, "a.jpg").await.unwrap_err();
        assert!(matches!(err, crate::source::trait_def::MediaSourceError::Network(m) if m.contains("闸门繁忙")), "{err:?}");
    }
```

- [ ] **步骤 4.2：运行测试验证失败**

运行：`cargo test --lib webdav_impl`
预期：编译失败（`WebDavMediaSource::new` 只有 2 参）。

- [ ] **步骤 4.3：实现**

结构体与构造（`:27-38`）：

```rust
pub struct WebDavMediaSource {
    db: crate::db::Db,
    creds: std::sync::Arc<dyn crate::credentials::CredentialStore>,
    gate: std::sync::Arc<crate::source::remote_gate::RemoteGate>,
}

impl WebDavMediaSource {
    pub fn new(
        db: crate::db::Db,
        creds: std::sync::Arc<dyn crate::credentials::CredentialStore>,
        gate: std::sync::Arc<crate::source::remote_gate::RemoteGate>,
    ) -> Self {
        Self { db, creds, gate }
    }

    #[cfg(test)]
    pub(crate) fn gate_for_test(&self) -> std::sync::Arc<crate::source::remote_gate::RemoteGate> {
        self.gate.clone()
    }
```

`read_file`（`:387-431`）整体替换为：

```rust
    async fn read_file(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        let (account_id, base_url, _) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("WebDavMediaSource 仅处理 WebDav descriptor".into())
        })?;
        // 阶段①（spec §5）：发请求前拿并发 permit——含重试两 attempt，"一个读取任务一个槽"
        let _conn = self.gate.enter().await?;
        let (user, pass, bad_tls) = self.credentials_for(account_id)?;
        let url = format!("{}/{}", base_url.trim_end_matches('/'), path.trim_start_matches('/'));
        let resp = Self::send_retry_once(bad_tls, Duration::from_secs(30), |client| {
            let mut req = client.get(&url);
            if let Some(r) = &range {
                req = req.header(header::RANGE, format!("bytes={}-{}", r.offset, r.offset + r.length - 1));
            }
            if let (Some(u), Some(p)) = (&user, &pass) {
                req = req.basic_auth(u, Some(p));
            }
            req
        })
        .await
        .map_err(|e| MediaSourceError::Network(format!("get: {e}")))?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Err(MediaSourceError::NotFound(path.to_string()));
        }
        if !resp.status().is_success() {
            return Err(MediaSourceError::Network(format!("GET status {}", resp.status())));
        }
        let status = resp.status().as_u16();
        let content_range = resp
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        // 响应上限 + 阶段②（spec §6.2）：CL 超上限立即拒绝；×2 记账；无 CL 保守整预算
        let cap = WEBDAV_MAX_RESPONSE;
        let cl = resp.headers().content_length();
        if cl.is_some_and(|c| c as usize > cap) {
            return Err(MediaSourceError::Network(format!(
                "WebDAV 响应超过上限 {cap} 字节（声明 {}）",
                cl.unwrap()
            )));
        }
        let accounted = cl.map_or(cap * 2, |c| c as usize * 2);
        let _bytes = _conn.reserve_bytes(accounted as u32).await?;
        let bytes = read_body_capped(resp, cap)
            .await
            .map_err(MediaSourceError::Network)?;
        // Range 强契约（spec rev3 §3.1）：请求区间时返回字节必须恰好等长
        if let Some(r) = range {
            verify_range_response(status, content_range.as_deref(), r.offset, bytes.len(), r.length)?;
        }
        Ok(bytes)
    }
```

`stat`（`:482-515`）开头插闸（在 `credentials_for` 之前）：

```rust
        // spec §5 复审 P1：media:// 先 stat 后 read，HEAD 也占并发（防多图 HEAD 无上限）
        let _conn = self.gate.enter_conn_only().await?;
```

`list_directory` 的 body 读取（`:380-383` 的 `resp.text()`）替换为（**注意 rel 键无关此步**；`test` trait 方法只查状态码不读 body，不动；`commands::test_connection` 走 factory→trait test 同前）：

```rust
        let body = read_body_capped(resp, PROPFIND_MAX_RESPONSE)
            .await
            .map_err(|e| MediaSourceError::Network(e))?;
        let body = String::from_utf8(body)
            .map_err(|e| MediaSourceError::Network(format!("body utf8: {e}")))?;
        Self::parse_propfind(&body, &url)
```

（`test` 里是 `Self::parse_propfind` 无调用的那段则只删 `resp.text()` 换 capped；`test_connection` 的握手只查状态码不读 body 的路径不动。）

`factory.rs:48` 改为（`:44` 后先建 gate 再传两处）：

```rust
        let gate = crate::source::remote_gate::RemoteGate::global_arc();
        // ...
        let smb = Arc::new(SmbMediaSource::new(
            Arc::new(SmbConnectionManager::new_production(db.clone(), creds.clone())),
            gate.clone(),
        ));
        let webdav = Arc::new(WebDavMediaSource::new(db.clone(), creds, gate));
```

（smb 行本任务先改 factory 会让 SmbMediaSource::new 编译失败——**smb 行保持原样，任务 6 再改**；本任务只改 webdav 行 + 加 gate 变量。smb 行在任务 6 接。）

- [ ] **步骤 4.4：运行测试验证通过**

运行：`cargo test --lib webdav_impl && cargo test --lib source::`
预期：全 passed（含新 `stat_busy_when_gate_exhausted`）。

- [ ] **步骤 4.5：Commit**

```bash
git add src-tauri/src/source/webdav_impl.rs src-tauri/src/source/factory.rs
git commit -m "feat(webdav): read/stat/PROPFIND 接两阶段闸（CL 预检+×2 记账+32MiB 目录上限）"
```

---

### 任务 5：SMB invalidate 公开 + mock 钩子

**文件：**
- 修改：`src-tauri/src/source/smb/connection.rs:160-164`
- 修改：`src-tauri/src/source/smb/mock_transport.rs`

- [ ] **步骤 5.1：编写失败的测试**

`mock_transport.rs` 的 `mod tests` 追加：

```rust
    #[tokio::test]
    async fn read_delay_and_inflight_tracking() {
        let m = MockSmbTransport::new();
        m.script_bytes(&[0u8; 8]);
        m.set_read_delay(std::time::Duration::from_millis(30));
        let mut buf = vec![0u8; 8];
        m.read_block_exact("f", 0, &mut buf).await.unwrap();
        assert_eq!(m.max_read_inflight(), 1);
    }

    #[tokio::test]
    async fn read_hang_never_returns() {
        let m = MockSmbTransport::new();
        m.script_bytes(&[0u8; 8]);
        m.set_read_hang(true);
        let mut buf = vec![0u8; 8];
        // 50ms 内必无返回（挂起）；不直接 await 到死，用 timeout 观察
        let r = tokio::time::timeout(std::time::Duration::from_millis(50), m.read_block_exact("f", 0, &mut buf)).await;
        assert!(r.is_err(), "挂起读应超时");
    }
```

`connection.rs` 测试（`mod tests` 若无则新增，文件尾）：

```rust
    #[test]
    fn invalidate_removes_slot() {
        // invalidate 是 evict 的公开包装：插入假槽 → invalidate → 槽空
        // （具体构造见现有 connection tests 的 manager 构造模式；无现有 tests 模块时
        //  用 new(db, creds, factory, ttl) + 直插 slots 不可行（私有字段）——改测行为：
        //  先 connect 成功一次 → invalidate → connect_calls 在下次操作时 +1（重建））
    }
```

**实现约定**：connection 的 invalidate 测试走行为断言（mock factory + `list` 触发建连，`invalidate` 后再 `list` 应见 `connect_calls` +1）。写实现时按此补全真实测试体，勿留空。

- [ ] **步骤 5.2：运行测试验证失败**

运行：`cargo test --lib smb::`
预期：编译失败（`set_read_delay` / `set_read_hang` / `max_read_inflight` / `invalidate` 未定义）。

- [ ] **步骤 5.3：实现**

`connection.rs`（`:160-164` 后）：

```rust
    /// 对外摘槽（spec §7：source 层读超时后调用——transport 状态未知，下次重建）。
    pub fn invalidate(&self, account_id: i64) {
        self.evict(account_id);
    }
```

`mock_transport.rs`——`Inner` 增字段、结构体增原子量、方法 + read_block_exact/stat 改造：

```rust
// Inner 增：
    read_delay_ms: Option<u64>,
    hang_reads: bool,
    hang_stats: bool,
// MockSmbTransport 增字段：
    read_inflight: AtomicU32,
    max_read_inflight: AtomicU32,
// 方法：
    pub fn set_read_delay(&self, d: std::time::Duration) {
        self.inner.lock().unwrap().read_delay_ms = Some(d.as_millis() as u64);
    }
    pub fn set_read_hang(&self, on: bool) {
        self.inner.lock().unwrap().hang_reads = on;
    }
    /// stat 挂起独立标志（任务 6 stat 超时测试用；与 read 挂起分开，避免语义互扰）。
    pub fn set_read_hang_stat(&self, on: bool) {
        self.inner.lock().unwrap().hang_stats = on;
    }
    pub fn max_read_inflight(&self) -> u32 {
        self.max_read_inflight.load(Ordering::SeqCst)
    }
```

`read_block_exact` 实现体（在注入错误检查之后、切片之前）：

```rust
        {
            let g = self.inner.lock().unwrap();
            if g.hang_reads {
                drop(g);
                std::future::pending::<()>().await; // 挂起：仅靠外层 timeout 取消
            } else if let Some(ms) = g.read_delay_ms {
                drop(g); // 释放锁再睡
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            }
        }
        let cur = self.read_inflight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_read_inflight.fetch_max(cur, Ordering::SeqCst);
        struct InflightGuard(&AtomicU32);
        impl Drop for InflightGuard {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _guard = InflightGuard(&self.read_inflight);
        // ……原有切片逻辑
```

`stat` 实现体（注入错误检查之后）：

```rust
        if self.inner.lock().unwrap().hang_stats {
            std::future::pending::<()>().await;
        }
```

（注意：挂起分支放在 inflight 计数**之外**——挂起的读占的是外层 gate permit，不计 inflight；guard 只包真实切片段，early-drop（外层 timeout）也扣减。）

- [ ] **步骤 5.4：运行测试验证通过**

运行：`cargo test --lib smb::`
预期：全 passed。

- [ ] **步骤 5.5：Commit**

```bash
git add src-tauri/src/source/smb/connection.rs src-tauri/src/source/smb/mock_transport.rs
git commit -m "feat(smb): 公开 invalidate + mock 延迟/挂起钩子与在途计数"
```

---

### 任务 6：SMB read/stat 接闸 + 读超时

**文件：**
- 修改：`src-tauri/src/source/smb/source.rs`（常量 `:9-19`、read_file `:89-132`、stat `:164-178`、tests `make_source :204-225`）
- 修改：`src-tauri/src/source/factory.rs:45-47`

- [ ] **步骤 6.1：编写失败的测试**

`smb/source.rs` 的 `mod tests` 追加（并先按步骤 6.3 更新 `make_source` 签名——TDD 顺序上测试与新签名一起写红）：

```rust
    fn make_gated_source(
        concurrency: usize,
        acquire_ms: u64,
        read_timeout: Duration,
    ) -> (SmbMediaSource, Arc<MockSmbTransport>) {
        let db = crate::db::Db::open_in_memory().unwrap();
        let creds = Arc::new(MemoryStore::new());
        creds.set_password("smb-1", "p").unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password)
                 VALUES ('nas', 'smb', '192.168.1.1', 445, 'media', 'u', NULL)",
                [],
            )
            .unwrap();
        }
        let mock = Arc::new(MockSmbTransport::new());
        let mock2 = mock.clone();
        let factory: crate::source::smb::connection::TransportFactory = Arc::new(move || {
            let m = mock2.clone();
            Box::pin(async move { m as Arc<dyn crate::source::smb::transport::SmbTransport> })
        });
        let mgr = SmbConnectionManager::new(db, creds, factory, Duration::from_secs(300));
        let gate = Arc::new(crate::source::remote_gate::RemoteGate::new(
            concurrency,
            usize::MAX >> 8, // 大预算：本组测试只关心并发
            Duration::from_millis(acquire_ms),
        ));
        let mut src = SmbMediaSource::new(Arc::new(mgr), gate);
        src.set_read_timeout(read_timeout);
        (src, mock)
    }

    #[tokio::test]
    async fn read_file_capped_by_gate_concurrency() {
        let (src, mock) = make_gated_source(1, 2_000, Duration::from_secs(5));
        // rel 契约：initial("media/f") 剥首段 share + path("a.jpg") → transport rel "f/a.jpg"
        mock.script_stat("f/a.jpg", RawStat { size: 4096, modified_unix_secs: 1 });
        mock.script_bytes(&vec![7u8; 4096]);
        mock.set_read_delay(Duration::from_millis(120));
        let src = std::sync::Arc::new(src);
        let d = smb_desc("media/f", "a.jpg");
        let d2 = d.clone();
        let f = src.clone();
        let a = tokio::spawn(async move { f.read_file(&d2, "a.jpg", None).await });
        let g = src.clone();
        let b = tokio::spawn(async move { g.read_file(&d, "a.jpg", None).await });
        let (ra, rb) = (a.await.unwrap(), b.await.unwrap());
        assert!(ra.is_ok() && rb.is_ok(), "{ra:?} {rb:?}");
        assert_eq!(mock.max_read_inflight(), 1, "闸=1 时 transport 观测最大并发必须为 1");
    }

    #[tokio::test]
    async fn read_timeout_invalidates_slot() {
        let (src, mock) = make_gated_source(2, 500, Duration::from_millis(80));
        mock.script_stat("f/a.jpg", RawStat { size: 64, modified_unix_secs: 1 });
        mock.script_bytes(&vec![7u8; 64]);
        mock.set_read_hang(true);
        let d = smb_desc("media/f", "a.jpg");
        let err = src.read_file(&d, "a.jpg", None).await.unwrap_err();
        assert!(matches!(err, MediaSourceError::Network(m) if m.contains("读取超时")), "{err:?}");
        mock.set_read_hang(false);
        // 摘槽后下次读重建连接（connect_calls 增加）且成功
        let calls_before = mock.connect_calls();
        let ok = src.read_file(&d, "a.jpg", None).await;
        assert!(ok.is_ok());
        assert!(mock.connect_calls() > calls_before, "超时摘槽后应重连");
    }

    #[tokio::test]
    async fn stat_busy_when_gate_exhausted() {
        let (src, _mock) = make_gated_source(1, 50, Duration::from_secs(1));
        let _hold = src.gate_for_test().enter().await.unwrap();
        let d = smb_desc("media", "a.jpg");
        let err = src.stat(&d, "a.jpg").await.unwrap_err();
        assert!(matches!(err, MediaSourceError::Network(m) if m.contains("闸门繁忙")), "{err:?}");
    }

    #[tokio::test]
    async fn stat_timeout_invalidates_slot() {
        let (src, mock) = make_gated_source(2, 500, Duration::from_millis(80));
        mock.set_read_hang_stat(true);
        let d = smb_desc("media", "a.jpg");
        let err = src.stat(&d, "a.jpg").await.unwrap_err();
        assert!(matches!(err, MediaSourceError::Network(m) if m.contains("stat 超时")), "{err:?}");
        mock.set_read_hang_stat(false);
        mock.script_stat("a.jpg", RawStat { size: 1, modified_unix_secs: 1 });
        assert!(src.stat(&d, "a.jpg").await.is_ok(), "摘槽重连后恢复");
    }
```

- [ ] **步骤 6.2：运行测试验证失败**

运行：`cargo test --lib smb::source`
预期：编译失败（`SmbMediaSource::new` 1 参、`set_read_timeout`/`gate_for_test` 未定义）。

- [ ] **步骤 6.3：实现**

`smb/source.rs` 头部与结构体：

```rust
use crate::source::remote_gate::RemoteGate;
use std::sync::Arc;
use std::time::Duration;

/// 单次 read_file 全量上限（建议 3：异常 stat 防御，对齐 media LRU 256MB）
const MAX_SMB_READ_BYTES: usize = 256 * 1024 * 1024;
/// 项目级读取超时（spec §7：smb 库默认超时不可依赖；超时摘槽防脏连接）
pub(crate) const SMB_READ_TIMEOUT: Duration = Duration::from_secs(60);

pub struct SmbMediaSource {
    manager: Arc<SmbConnectionManager>,
    gate: Arc<RemoteGate>,
    read_timeout: Duration,
}

impl SmbMediaSource {
    pub fn new(manager: Arc<SmbConnectionManager>, gate: Arc<RemoteGate>) -> Self {
        Self { manager, gate, read_timeout: SMB_READ_TIMEOUT }
    }

    #[cfg(test)]
    pub(crate) fn set_read_timeout(&mut self, d: Duration) {
        self.read_timeout = d;
    }

    #[cfg(test)]
    pub(crate) fn gate_for_test(&self) -> Arc<RemoteGate> {
        self.gate.clone()
    }
```

`read_file`（`:114-132` 上限检查之后到结尾）替换：

```rust
        if total > MAX_SMB_READ_BYTES {
            return Err(MediaSourceError::Network(format!(
                "读取超过上限 {} 字节",
                MAX_SMB_READ_BYTES
            )));
        }
        // 两阶段闸（spec §7）：SMB 无"响应头"概念，双闸读前一次拿；total ×2 记账
        let _conn = self.gate.enter().await?;
        let _bytes = _conn.reserve_bytes(total as u32 * 2).await?;
        let mut buf = vec![0u8; total];
        let offset = range.map(|r| r.offset).unwrap_or(0);
        let fut = self
            .manager
            .read_block_exact(account_id, initial_path, &rel, offset, &mut buf);
        match tokio::time::timeout(self.read_timeout, fut).await {
            Ok(r) => r.map_err(Self::transport_err)?,
            Err(_) => {
                // transport 状态未知：摘槽，下次 get_or_connect 重建（对齐连接级错误恢复）
                self.manager.invalidate(account_id);
                return Err(MediaSourceError::Network("SMB 读取超时（已断开重连）".into()));
            }
        }
        Ok(buf)
```

`stat`（`:164-178`）替换：

```rust
    async fn stat(&self, descriptor: &SourceDescriptor, path: &str) -> Result<FileStat> {
        let (account_id, initial_path) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("SmbMediaSource 仅处理 Smb descriptor".into())
        })?;
        let rel = validated_rel(initial_path, path)?;
        // spec §5 三审：get_or_connect 两阶段无锁建连，冷启动并发 stat 各自建 transport——
        // stat 也过并发闸；并包读超时（挂起 stat 不得永久占 permit，§14 不变量）
        let _conn = self.gate.enter_conn_only().await?;
        let fut = self.manager.stat(account_id, initial_path, &rel);
        let raw = match tokio::time::timeout(self.read_timeout, fut).await {
            Ok(r) => r.map_err(Self::transport_err)?,
            Err(_) => {
                self.manager.invalidate(account_id);
                return Err(MediaSourceError::Network("SMB stat 超时（已断开重连）".into()));
            }
        };
        Ok(FileStat { size: raw.size, modified_at: raw.modified_unix_secs })
    }
```

既有 `make_source`（`:204-225`）更新为委托：

```rust
    fn make_source() -> (SmbMediaSource, Arc<MockSmbTransport>) {
        make_gated_source(8, 2_000, SMB_READ_TIMEOUT)
    }
```

`factory.rs:45-47`：

```rust
        let smb = Arc::new(SmbMediaSource::new(
            Arc::new(SmbConnectionManager::new_production(db.clone(), creds.clone())),
            gate.clone(),
        ));
```

（`gate` 变量任务 4 已建。）

- [ ] **步骤 6.4：运行测试验证通过**

运行：`cargo test --lib smb::`
预期：全 passed（含既有 41+ source/connection 用例——`make_source` 委托后无签名破坏）。

- [ ] **步骤 6.5：Commit**

```bash
git add src-tauri/src/source/smb/source.rs src-tauri/src/source/factory.rs
git commit -m "feat(smb): read/stat 接两阶段闸 + 60s 读超时摘槽（invalidate）"
```

---

### 任务 7：media_cache generation 守卫

**文件：**
- 修改：`src-tauri/src/media_cache.rs`（`:18-24` 结构体、`:68-70` clear、`:106-115` 全局层）

- [ ] **步骤 7.1：编写失败的测试**

`media_cache.rs` `mod tests` 追加：

```rust
    #[test]
    fn put_if_generation_matches_only() {
        let mut c = MediaLru::new(1 << 20);
        let g0 = c.generation();
        assert!(c.put_if_generation(
            "a".into(),
            CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() },
            g0,
        ));
        assert!(c.get("a").is_some());

        c.clear_and_bump(); // 模拟 clear_all 的清空+递增
        let g1 = c.generation();
        assert_ne!(g0, g1);
        assert!(!c.put_if_generation(
            "b".into(),
            CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() },
            g0, // 旧代：必须拒绝
        ));
        assert!(c.get("b").is_none(), "旧代写入不得落表");
        assert!(c.put_if_generation(
            "b".into(),
            CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() },
            g1,
        ));
    }
```

- [ ] **步骤 7.2：运行测试验证失败**

运行：`cargo test --lib media_cache`
预期：编译失败（`generation` / `put_if_generation` / `clear_and_bump` 未定义）。

- [ ] **步骤 7.3：实现**

`MediaLru` 增字段 `generation: u64`（`new` 初始化 0）；方法：

```rust
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 同一临界区内比较并插入（spec §8.1）：与 clear 的递增互斥，
    /// 封死"检查后、写入前被 clear"窗口。返回是否真正写入。
    pub fn put_if_generation(&mut self, key: String, media: CachedMedia, expected: u64) -> bool {
        if self.generation != expected {
            return false;
        }
        self.put(key, media);
        true
    }

    /// 清空并递增代（clear_all 的实现细节；表级 clear 语义同旧 clear + 失效在途写入）。
    pub fn clear_and_bump(&mut self) {
        self.clear();
        self.generation += 1;
    }
```

全局层 `clear_all`（`:113-115`）改为调 `clear_and_bump`：

```rust
pub fn clear_all() {
    global().lock().unwrap().clear_and_bump();
}
```

- [ ] **步骤 7.4：运行测试验证通过**

运行：`cargo test --lib media_cache`
预期：全 passed（含既有 LRU 用例）。

- [ ] **步骤 7.5：Commit**

```bash
git add src-tauri/src/media_cache.rs
git commit -m "feat(cache): media LRU generation 守卫（put_if_generation 原子比较插入）"
```

---

### 任务 8：singleflight fetch_remote_to_cache + 双点接线

**文件：**
- 修改：`src-tauri/src/media_cache.rs`（新增注册表 + 函数 + 测试）
- 修改：`src-tauri/src/lib.rs:322-329`
- 修改：`src-tauri/src/commands/warm.rs:55-88`

- [ ] **步骤 8.1：编写失败的测试**

`media_cache.rs` 新测试（独立注册表测试类型，不与全局 LRU 混用——`fetch_remote_to_cache_with` 的 LRU 侧仍走 `global()`，测试先 `clear_all()` 复位）：

```rust
    #[tokio::test]
    async fn singleflight_dedups_concurrent_same_path() {
        crate::media_cache::clear_all();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let c2 = calls.clone();
        let fetch = move |_fp: String| {
            let c = c2.clone();
            async move {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                Ok(vec![1u8, 2, 3])
            }
        };
        let a = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/x", fetch, "p/x.jpg"));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await; // 让 owner 就位
        let c2b = calls.clone();
        let fetch2 = move |_fp: String| {
            let c = c2b.clone();
            async move {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(vec![9u8])
            }
        };
        let b = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/x", fetch2, "p/x.jpg"));
        let (ra, rb) = (a.await.unwrap(), b.await.unwrap());
        assert!(ra, "owner 成功");
        assert!(rb, "waiter 经 LRU 命中成功");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "同 path 并发只下载一份");
        assert!(crate::media_cache::global().lock().unwrap().get("/m/x").is_some());
    }

    #[tokio::test]
    async fn owner_failure_wakes_waiter_err() {
        crate::media_cache::clear_all();
        let fetch = move |_fp: String| async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            Err::<Vec<u8>, String>("boom".into())
        };
        let a = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/y", fetch, "p/y.jpg"));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let fetch2 = move |_fp: String| async { Ok::<Vec<u8>, String>(vec![9]) };
        let b = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/y", fetch2, "p/y.jpg"));
        assert!(!a.await.unwrap(), "owner 失败");
        assert!(!b.await.unwrap(), "waiter 查 LRU miss → false");
    }

    #[tokio::test]
    async fn generation_change_discards_owner_result() {
        crate::media_cache::clear_all();
        let fetch = move |_fp: String| async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            Ok(vec![1u8, 2, 3])
        };
        let a = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/z", fetch, "p/z.jpg"));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await; // owner 在途
        crate::media_cache::clear_all(); // 账户变更模拟：代已变
        assert!(!a.await.unwrap(), "旧代结果必须丢弃");
        assert!(crate::media_cache::global().lock().unwrap().get("/m/z").is_none());
    }
```

注：`fetch_remote_to_cache_with` 是 pub（测试用），签名 `pub async fn fetch_remote_to_cache_with<F, Fut>(media_path: &str, fetch: F, file_path: &str) -> bool`。

- [ ] **步骤 8.2：运行测试验证失败**

运行：`cargo test --lib media_cache`
预期：编译失败（函数未定义）。

- [ ] **步骤 8.3：实现**

`media_cache.rs` 头部 use 增补 + 模块级注册表：

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

/// singleflight 终态（spec §8：watch 值语义，防 Notify 丢唤醒）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FetchOutcome {
    Pending,
    Done,
    Failed,
}

fn inflight_registry() -> &'static Mutex<HashMap<String, Arc<watch::Sender<FetchOutcome>>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<watch::Sender<FetchOutcome>>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 生产入口：经 MediaSource::read_file 下载并写入 LRU（generation 守卫 + 同路径单飞）。
/// true = 该路径现可在 LRU 命中；false = 失败/旧代丢弃（media:// 回 502，warm 静默）。
pub async fn fetch_remote_to_cache(
    media_path: &str,
    src: Arc<dyn crate::source::trait_def::MediaSource>,
    descriptor: &crate::source::descriptor::SourceDescriptor,
    file_path: &str,
) -> bool {
    fetch_remote_to_cache_with(media_path, move |fp| {
        let src = src.clone();
        let d = descriptor.clone();
        async move { src.read_file(&d, &fp, None).await.map_err(|e| e.to_string()) }
    }, file_path)
    .await
}

pub async fn fetch_remote_to_cache_with<F, Fut>(media_path: &str, fetch: F, file_path: &str) -> bool
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = std::result::Result<Vec<u8>, String>>,
{
    // 注册表锁内定角色：有在途 → waiter（订阅 watch，值语义任意时序安全）；无 → owner
    let role = {
        let mut m = inflight_registry().lock().unwrap();
        match m.get(media_path) {
            Some(tx) => Either::Waiter(tx.subscribe()),
            None => {
                let (tx, _rx) = watch::channel(FetchOutcome::Pending);
                m.insert(media_path.to_string(), tx.clone());
                Either::Owner(tx)
            }
        }
    };
    match role {
        Either::Waiter(mut rx) => {
            // 等终态（owner send 先于摘条目；防御 sender 提前 drop）
            loop {
                if *rx.borrow() != FetchOutcome::Pending {
                    break;
                }
                if rx.changed().await.is_err() {
                    break;
                }
            }
            if *rx.borrow() == FetchOutcome::Done {
                return global().lock().unwrap().get(media_path).is_some();
            }
            false
        }
        Either::Owner(tx) => {
            // 代捕获在下载启动前（spec §8.1）
            let expected = global().lock().unwrap().generation();
            let res = fetch(file_path.to_string()).await;
            let ok = match res {
                Ok(bytes) => {
                    let name = file_path.rsplit('/').next().unwrap_or(file_path);
                    let mime = crate::algorithm::mime_from_name(name)
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    global()
                        .lock()
                        .unwrap()
                        .put_if_generation(
                            media_path.to_string(),
                            CachedMedia { bytes, mime },
                            expected,
                        )
                }
                Err(_) => false,
            };
            let _ = tx.send(if ok { FetchOutcome::Done } else { FetchOutcome::Failed });
            inflight_registry().lock().unwrap().remove(media_path);
            ok
        }
    }
}

enum Either {
    Waiter(watch::Receiver<FetchOutcome>),
    Owner(Arc<watch::Sender<FetchOutcome>>),
}
```

**接线一：`lib.rs:322-329`**——miss 分支改统一函数（保持 cacheable 直读结构）：

```rust
    if cacheable {
        if let Some(hit) = media_cache::global().lock().unwrap().get(&path) {
            return finish(
                Response::builder()
                    .status(200)
                    .header("Content-Type", hit.mime.clone())
                    .header("Content-Length", hit.bytes.len().to_string())
                    .header("Accept-Ranges", "bytes")
                    .header("Cache-Control", "no-store"),
                hit.bytes.to_vec(),
            );
        }
        // singleflight miss 分支（spec §8）：与 warm 共享同路径单飞 + generation 守卫
        if media_cache::fetch_remote_to_cache(&path, src.clone(), &descriptor, &file_path).await {
            if let Some(hit) = media_cache::global().lock().unwrap().get(&path) {
                return finish(
                    Response::builder()
                        .status(200)
                        .header("Content-Type", hit.mime.clone())
                        .header("Content-Length", hit.bytes.len().to_string())
                        .header("Accept-Ranges", "bytes")
                        .header("Cache-Control", "no-store"),
                    hit.bytes.to_vec(),
                );
            }
        }
        return err_response(StatusCode::BAD_GATEWAY, "remote media fetch failed");
    }
    match src.read_file(&descriptor, &file_path, range).await {
```

（原 `match` 尾部不变——只服务非 cacheable（Local/Range）路径；`Ok` 分支里的 `if cacheable` put 死代码随之删除。）

**接线二：`warm.rs` `read_and_cache_media`（`:55-88`）** 替换为：

```rust
/// 读单个远程媒体并填充 LRU。失败静默（预读是优化不是承诺，调用方忽略错误）。
/// 2026-08 spec §8.2：写 LRU 前的会话双检查取消——由 media_cache generation 守卫
/// 承担（防的是账户变更的同路径异内容，非换书）；保留启动前检查。
async fn read_and_cache_media(
    app: &tauri::AppHandle,
    media_path: &str,
    session_id: &str,
    generation: u64,
) {
    let target = match crate::media_protocol::parse_media_path(media_path) {
        Ok(t) => t,
        Err(_) => return,
    };
    if matches!(target, crate::media_protocol::MediaTarget::Local { .. }) {
        return; // Local 形态不产生 IO（文件系统页缓存已够）
    }
    if !warm_session_matches(session_id, generation) {
        return; // 启动前检查（rev8 前半保留）
    }
    let (descriptor, file_path) = match crate::rebuild_descriptor(app, &target) {
        Ok(v) => v,
        Err(_) => return,
    };
    let factory = app.state::<crate::source::MediaSourceFactory>();
    let src = factory.resolve(&descriptor);
    let _ = crate::media_cache::fetch_remote_to_cache(media_path, src, &descriptor, &file_path).await;
}
```

（文件头 `/// 图片预读。契约（rev8）` 注释块同步：把"会话取消：任务启动前 + 读源完成后双检查"改为"会话取消：任务启动前检查；完成后写缓存由 generation 守卫把关"。）

- [ ] **步骤 8.4：运行测试验证通过**

运行：`cargo test --lib media_cache && cargo test --lib warm`
预期：全 passed（warm 模块若有既有用例引用旧注释行为则一并核对——`warm_session_matches` 本身不变）。

- [ ] **步骤 8.5：全量 Rust 回归**

运行：`cargo test`
预期：全绿（lib + 12 integration）。

- [ ] **步骤 8.6：Commit**

```bash
git add src-tauri/src/media_cache.rs src-tauri/src/lib.rs src-tauri/src/commands/warm.rs
git commit -m "feat(cache): media path singleflight（watch 单飞+generation 守卫）收敛 warm 与 media:// miss"
```

---

### 任务 9：全量回归 + 文档同步 + tag

**文件：**
- 修改：`AGENTS.md`（当前状态表）、`DESIGN.md`（网络源读取章节）

- [ ] **步骤 9.1：前端回归（零改动验证）**

```bash
npm run type-check && npm test -- --run
```
预期：type-check 0 error；1216+ passed 0 fail。

- [ ] **步骤 9.2：Rust 全量 + 构建**

```bash
cd src-tauri && cargo test && cargo check
```
预期：全绿。

- [ ] **步骤 9.3：AGENTS.md 当前状态表加一行**（CRLF 文件——单行锚点 Edit）

在 3.5.1 行后追加一行（内容按实际交付微调）：

```markdown
| 3.5.2 | 远程读取总闸门 + WebDAV 连接复用 | ✅ 两阶段 RemoteGate（并发 8 + 512MiB ×2 记账 + 30s acquire 超时）覆盖 webdav/smb read/stat；webdav 共享 Client（bad_tls 两实例 + connect_timeout + pool 300s）；单响应上限（GET 256MiB/PROPFIND 32MiB，CL 预检+流式累加双保险）；SMB 60s 读超时摘槽（invalidate 公开）；media path singleflight（watch 单飞）+ generation 守卫收敛 warm 与 media:// miss（warm rev8 写前检查取消）。spec `docs/superpowers/specs/2026-08-26-remote-read-gate-design.md`（三轮审查 51a1b1f）。待实机：WebDAV 阅读连接复用率（netstat）、快速翻页并发 ≤8。 |
```

- [ ] **步骤 9.4：DESIGN.md 补一段**（网络源/media:// 章节尾部，单行锚点）

一段 4-6 行：全局 RemoteGate 位置（两 read_file/stat 内嵌）、两阶段语义、×2 记账、四通道自动覆盖、singleflight 收敛点。引用 spec 路径。

- [ ] **步骤 9.5：Commit + tag + push**

```bash
git add AGENTS.md DESIGN.md
git commit -m "docs: 补记 3.5.2 远程读取总闸门交付"
git tag v0.1.0-module3.5.2-remote-read-gate
git push github main
git push github v0.1.0-module3.5.2-remote-read-gate
```

（tag 名如与用户当期编号冲突，以用户指示为准。）

- [ ] **步骤 9.6：内网同步（可选）**

```bash
git push origin main --tags
```
（origin 近期认证失败；失败即跳过，随下次成功窗口补推。）

---

## 自检记录

1. **规格覆盖度**：§5 两阶段（任务1/4/6）、§6.1 client（任务2）、§6.2 read 接闸（任务4）、§6.3 流式（任务3）、§6.4 stat（任务4）、§7 SMB（任务5/6）、§8 singleflight（任务8）、§8.1 generation（任务7）、§8.2 warm 契约（任务8 接线二）、§9 常量（任务1/3/6）、§10 错误语义（Network 变体贯穿）、§11 测试 1-7（任务3/1/8/7/2/6）、§12 实机（任务9 文档标注）、§13 文档（任务9）。无遗漏。
2. **占位符**：全计划无 TODO/待定；mock 改造处"……原有切片逻辑"指保留 `mock_transport.rs:110-118` 现有切片实现原样，属明确指令非占位。
3. **类型一致性**：`RemoteGate::new(usize, usize, Duration)` 三参贯穿任务 1/4/6；`gate_for_test`/`set_read_timeout` 命名 webdav/smb 一致；`fetch_remote_to_cache[_with]` 任务 8 内自洽；`Network(String)` 错误统一。
