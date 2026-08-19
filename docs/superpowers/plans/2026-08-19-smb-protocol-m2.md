# M2 SMB 协议层（module3.3.0）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** `SmbMediaSource` 5 方法实装 + 连接管理器（accountId 复用 / TTL 懒回收 / 连接级错误重建重试），SMB 全链路（账户→浏览→阅读→跨卷→Range→断网恢复）走通，`test_connection` 真握手。

**架构：** `SmbTransport` trait 抽象 SMB 传输（connect/list/read_block_exact/stat），生产实现 `SmbClientTransport` 包 `smb` crate 0.11 真实 API，测试用 `MockSmbTransport` 驱动全部逻辑单测（无 NAS 的 CI 可跑）；`SmbConnectionManager` 按 accountId 管理 Transport 生命周期（懒建连 + 5 分钟 TTL 懒清理 + 连接级错误剔除重建）；`SmbMediaSource` 在 transport 之上做 MediaEntry 映射与 Range 强契约包装。

**技术栈：** Rust（smb 0.11 真实 API 已核对本地 registry 源码：`Client::new(ClientConfig)` / `share_connect(&UncPath, user, password)` / `get_tree` / `Tree::open_existing` / `Directory::query::<FileIdBothDirectoryInformation>` / `File::read_block` 短读语义）+ tokio + Vitest（前端零改动的回归确认）。

**规格：** `docs/superpowers/specs/2026-08-19-smb-protocol-m2-design.md`（M2）；母设计 `docs/superpowers/specs/2026-08-18-smb-remote-media-design.md` §4。

**兼容性红线（母 spec §6）：** descriptor 契约零改动；account 表不动；M1 全链路（协议 handler / 缩略图 / 阅读器 / 跨卷 WebDAV）零回归；既有 Rust 375+ / 前端 1122+ 全绿是硬门槛。

**约定：** Rust 测试跑 `cargo test -j 2 <过滤词>`（在 `src-tauri/` 下；**必须 `-j 2`**——本机全并发编译有 Defender 文件锁致 rmeta 随机损坏的实测教训）；前端跑 `npx vitest run <路径>`；CRLF 文件多行 Edit 失配用单行锚点或 python 行号补丁。

**smb crate 0.11 真实 API 摘要（已对 registry 源码核对，区别于 stub 注释里的 README 假设）：**

```rust
use smb::{Client, ClientConfig, UncPath, Error as SmbError};
// 连接：Client::new(ClientConfig::default()) → client.share_connect(&unc, username, password)
//       → client.get_tree(&unc) -> Arc<Tree>（Client 内部按 UncPath 缓存 connection/session/tree）
// UncPath builder：UncPath::new(server)?.with_share(share)?.with_path(path)（path 相对 share）
// 列目录：tree.open_existing(rel, access) -> Resource → resource.as_dir() →
//         Directory::query::<FileIdBothDirectoryInformation>(this: &Arc<Self>, "*")
//         -> QueryDirectoryStream（futures Stream；同 Directory 实例不可并发 query——每次 open 新实例）
//         公共字段：file_name / attributes / end_of_file / last_write_time: FileTime
// 读：resource.as_file() → file.read_block(&mut buf, pos, None, false) -> io::Result<usize>
//     （短读语义：返回实际字节数，EOF 返 0——Range 强契约需循环包装）
// stat：open_existing → query_info::<FileStandardInformation>()（含 end_of_file / last_write_time）
// 时间：FileTime::date_time() -> time::PrimitiveDateTime → .assume_utc().unix_timestamp()
// 错误：SmbError::{TransportError, IoError, OperationTimeout, ReceivedErrorMessage(Status, _),
//       NotFound(String), InvalidState, ...}——连接级 = Transport/IoError/Timeout/InvalidState 类
```

---

## 文件结构

**Rust 新建：**
- `src-tauri/src/source/smb/mod.rs` —— SMB 模块声明（transport / connection / 三个子模块收口；替代 `smb_impl.rs` 的 mod 入口地位）
- `src-tauri/src/source/smb/transport.rs` —— `SmbTransport` trait + `TransportError` + 原始类型（`RawDirEntry` / `RawStat` / `ConnectParams`）
- `src-tauri/src/source/smb/mock_transport.rs` —— `MockSmbTransport`（可编程响应 + 调用记录；`#[cfg(test)]` 外也可用——生产 factory 不用，单测/集成用）
- `src-tauri/src/source/smb/connection.rs` —— `SmbConnectionManager`（TTL / 建连 / 重连）
- `src-tauri/src/source/smb/path.rs` —— UNC 拼接 + share 契约校验纯函数
- `src-tauri/examples/smb_spike.rs` —— spike demo（实机验证，不进 lib）

**Rust 修改：**
- `src-tauri/src/source/smb_impl.rs` —— 删 stub，改为 `mod smb` 的薄转发（或直接移动：`smb_impl.rs` 删除，`source/mod.rs` 改声明 `pub mod smb;`，`SmbMediaSource` 实装放 `smb/source.rs`——采用此方案，见任务 7）
- `src-tauri/src/source/smb/source.rs` —— `SmbMediaSource` 5 方法实装 + MediaEntry 映射
- `src-tauri/src/source/smb/real_transport.rs` —— `SmbClientTransport`（smb crate 接线）
- `src-tauri/src/source/factory.rs` —— 构造 SmbConnectionManager 注入
- `src-tauri/src/commands/accounts.rs` —— test_connection smb 真握手
- `src-tauri/src/commands/find_next_volume.rs` —— listing_kind 放开 Smb
- `src/locales/zh-CN.ts` / `en-US.ts` —— testFail 三态文案

---

### 任务 0：spike（实机；无 NAS 环境时标注 SKIP 后置到验收前）

**文件：**
- 创建：`src-tauri/examples/smb_spike.rs`

- [ ] **步骤 1：写 spike demo（完整可跑骨架，替换 `<...>` 占位为你的 NAS 参数后 `cargo run --example smb_spike --features async`）**

```rust
//! smb-rs spike（spec §2 七点验证）。运行前替换 NAS 参数。
//! 验证点结论回写 docs/superpowers/specs/2026-08-18-smb-remote-media-design.md §4.1。
use std::sync::Arc;
use std::time::Instant;
use smb::resource::Resource;
use smb::{Client, ClientConfig, UncPath};
use smb_fscc::FileIdBothDirectoryInformation;
use futures_util::StreamExt;
use smb::resource::directory::Directory;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let server = "192.168.x.x";           // NAS 地址
    let share = "media";                   // 共享名
    let user = "user";
    let password = std::env::var("SMB_PASS").expect("set SMB_PASS env");
    let dir_rel = "comics";                // share 下测试目录
    let big_file = "comics/big.jpg";       // 4-8MB 测试文件

    // ① dialect 协商 + NTLM 认证
    let t0 = Instant::now();
    let client = Client::new(ClientConfig::default());
    let unc = UncPath::new(server)?.with_share(share)?.with_no_path();
    client.share_connect(&unc, user, password.clone()).await?;
    println!("[1] connect+auth ok in {:?}", t0.elapsed());

    // ② 列目录字段映射
    let tree = client.get_tree(&unc).await?;
    let res = tree.open_existing(dir_rel, smb::AccessMask::new().with_generic_read(true)).await?;
    let dir = Arc::new(res.unwrap_dir());
    let mut stream = Directory::query::<FileIdBothDirectoryInformation>(&dir, "*").await?;
    let mut n = 0;
    while let Some(item) = stream.next().await {
        let info = item?;
        println!("  {} dir={} size={} mtime={:?}",
            info.file_name, info.attributes.directory(),
            info.end_of_file, info.last_write_time.date_time());
        n += 1;
    }
    println!("[2] list ok, {n} entries");

    // ③④ stat + Range 读（含越界行为）
    let fres = tree.open_existing(big_file, smb::AccessMask::new().with_generic_read(true)).await?;
    let file = fres.unwrap_file();
    let std_info: smb_fscc::FileStandardInformation = fres.query_info().await?;
    println!("[3] stat size={} mtime={:?}", std_info.end_of_file,
        std_info.last_write_time.date_time());
    let mut buf = vec![0u8; 16];
    let got = file.read_block(&mut buf, 0, None, false).await?;
    println!("[3] read_block(0,16) -> {got} bytes"); // 验证恰好 16 或短读
    let mut over = vec![0u8; 16];
    let got2 = file.read_block(&mut over, u64::MAX / 2, None, false).await;
    println!("[3] read_block(远超 offset) -> {:?}", got2.map_err(|e| e.to_string())); // 越界行为

    // ⑤ 大图吞吐
    let size = std_info.end_of_file as usize;
    let t1 = Instant::now();
    let mut pos = 0u64;
    let mut chunk = vec![0u8; 1024 * 1024];
    while pos < size as u64 {
        let cap = ((size as u64 - pos) as usize).min(chunk.len());
        let got = file.read_block(&mut chunk[..cap], pos, None, false).await?;
        if got == 0 { break; }
        pos += got as u64;
    }
    let secs = t1.elapsed().as_secs_f64();
    println!("[4] read {pos} bytes in {secs:.2}s = {:.1} MB/s", pos as f64 / 1024.0 / 1024.0 / secs);

    // ⑥ Client Arc 并发共享
    let c2 = client.clone(); // Client 是否 Clone/Arc 可共享——记录结论
    let tree2 = client.get_tree(&unc).await?;
    println!("[5] re-get_tree ok (Client 可复用): {:?}", tree2.is_dfs_root());

    // ⑦ 自定义端口 + 深层 initialPath（评审补充验证点）
    let deep = UncPath::new(server)?.with_share(share)?.with_path("comics");
    let tree3 = client.get_tree(&deep).await?;
    let _ = tree3.open_existing(".", smb::AccessMask::new().with_generic_read(true)).await;
    println!("[7] deep initialPath tree ok");
    // 端口：把 server 换 "{server}:1445"（若 NAS 支持非 445）重跑验证 parse_socket_address 路径

    // ⑧ 错误分类观察：访问不存在文件
    let miss = tree.open_existing("no_such_dir_xyz", smb::AccessMask::new().with_generic_read(true)).await;
    println!("[6] missing dir err = {:?}", miss.err().map(|e| e.to_string()));

    let _ = c2;
    Ok(())
}
```

注意：`AccessMask`/`FileAccessMask` 的确切导入路径与构造（`smb::AccessMask` vs `smb_msg::FileAccessMask`）以编译器提示为准微调——本骨架已按 `Tree::open_existing(&self, file_name, access: FileAccessMask)` 核对；`query_info::<T>` 的 trait bound（`QueryInformationValue` 类）若不满足则改用 `open_existing 后 as_file` + `GetLen`。**spike 的产出之一就是把这两处真实路径记录回写**。

- [ ] **步骤 2：跑通并记录验证点结论（含评审补充的深层 initialPath 与自定义端口两项）**（connect 时长 / 字段映射可行 / read_block 恰好语义 / stat API / 吞吐 MB/s / Client 复用 / 错误形态），回写母 spec §4.1。

- [ ] **步骤 3：Commit（无 NAS 时跳过本任务，在验收任务 9 前必须补跑）**

```bash
git add src-tauri/examples/smb_spike.rs
git commit -m "chore(smb): spike demo——dialect/NTLM/query/read_block/stat/复用/错误七点验证骨架"
```

---

### 任务 1：TransportError + 原始类型 + 分类纯函数

**文件：**
- 创建：`src-tauri/src/source/smb/mod.rs`（模块声明）
- 创建：`src-tauri/src/source/smb/transport.rs`
- 修改：`src-tauri/src/source/mod.rs`（`pub mod smb;` 追加）
- 修改：`src-tauri/src/source/smb_impl.rs`（暂不动——任务 7 才删；本任务只加新模块）

- [ ] **步骤 1：写失败测试（transport.rs 文件尾 tests 模块）**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_level_classification() {
        // 连接级：传输断开 / IO / 超时 / 会话失效 —— 可重连
        assert!(TransportError::Disconnected.is_connection_level());
        assert!(TransportError::Io("read fail".into()).is_connection_level());
        assert!(TransportError::Timeout.is_connection_level());
        // 文件级：NotFound / 权限 / 路径违规 —— 重连无意义
        assert!(!TransportError::FileNotFound("x".into()).is_connection_level());
        assert!(!TransportError::PermissionDenied("x".into()).is_connection_level());
        assert!(!TransportError::InvalidPath("x".into()).is_connection_level());
        assert!(!TransportError::Other("x".into()).is_connection_level());
    }

    #[test]
    fn file_time_zero_maps_to_none() {
        assert_eq!(file_time_to_unix_secs(0), None);
        // 2026-01-01 00:00:00 UTC ≈ 13385082240（FILETIME 100ns）
        assert!(file_time_to_unix_secs(133_850_822_400_000_000).is_some());
    }
}
```

- [ ] **步骤 2：`cargo test -j 2 transport_error` → 编译失败（模块不存在）**

- [ ] **步骤 3：实现 transport.rs（类型层，无 smb crate 依赖——smb::Error 的映射放任务 6 生产 transport）**

```rust
//! SMB 传输层抽象（spec §3）：trait + 原始类型 + 错误分类。
//! 生产实现在 real_transport.rs（包 smb crate）；测试用 mock_transport.rs。

/// SMB 传输错误。is_connection_level() 决定连接管理器的重连策略（spec §3）。
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("连接已断开: {0}")]
    Disconnected,
    #[error("IO 错误: {0}")]
    Io(String),
    #[error("操作超时")]
    Timeout,
    #[error("文件不存在: {0}")]
    FileNotFound(String),
    #[error("权限被拒绝: {0}")]
    PermissionDenied(String),
    #[error("路径非法: {0}")]
    InvalidPath(String),
    #[error("SMB 错误: {0}")]
    Other(String),
}

impl TransportError {
    /// 连接级错误（传输断开/IO/超时）→ 剔除连接重建重试一次；
    /// 文件级（NotFound/权限/路径）→ 直接上抛。
    pub fn is_connection_level(&self) -> bool {
        matches!(self, TransportError::Disconnected | TransportError::Io(_) | TransportError::Timeout)
    }
}

/// 建连参数（连接管理器从 DB+keyring 解出后传入 transport）
#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: i32,
    pub share: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// initial_path 首段必须等于 share（根路径契约，source 侧同款校验在 path.rs）
    pub initial_path: String,
}

/// 目录项原始形态（MediaEntry 映射前的中立类型，is_archive 判定在 source 层）
#[derive(Debug, Clone)]
pub struct RawDirEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    /// Unix 秒；0 = 源未提供
    pub modified_unix_secs: i64,
}

#[derive(Debug, Clone)]
pub struct RawStat {
    pub size: u64,
    pub modified_unix_secs: Option<i64>,
}

/// Windows FILETIME（100ns since 1601-01-01）→ Unix 秒；0（源未提供）→ None。
/// 纯整数换算，不依赖 smb-dtyp（生产接线处直接传 u64 字段值）。
pub fn file_time_to_unix_secs(file_time_100ns: u64) -> Option<i64> {
    if file_time_100ns == 0 {
        return None;
    }
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000; // 1601→1970
    file_time_100ns
        .checked_sub(EPOCH_DIFF_100NS)
        .map(|v| (v / 10_000_000) as i64)
}

/// SMB 传输抽象：connect 一次后可重复调用 list/read_block_exact/stat。
#[async_trait::async_trait]
pub trait SmbTransport: Send + Sync {
    /// 建立认证连接（含 share 树连接）。重复调用返回 Ok（幂等）。
    async fn connect(&self, params: &ConnectParams) -> Result<(), TransportError>;

    /// 列目录（rel 相对 initial_path 的 '/' 分隔路径；返回自然序未保证——排序在 source 层）。
    async fn list(&self, rel: &str) -> Result<Vec<RawDirEntry>, TransportError>;

    /// 恰好读满 buf（Range 强契约：不足即 Err，禁止短读返回——EOF 早到按 Disconnected 处理
    /// 以触发外层重连一次的兜底语义）。
    async fn read_block_exact(&self, rel: &str, offset: u64, buf: &mut [u8]) -> Result<(), TransportError>;

    /// stat 单个文件。
    async fn stat(&self, rel: &str) -> Result<RawStat, TransportError>;
}
```

`src-tauri/src/source/smb/mod.rs`：

```rust
//! SMB 协议层（module3.3.0）：transport 抽象 / 连接管理 / source 实装 / 真实接线。
pub mod connection;
pub mod mock_transport;
pub mod path;
pub mod real_transport;
pub mod source;
pub mod transport;
```

`src-tauri/src/source/mod.rs` 追加 `pub mod smb;`（其余任务逐步填充；本任务先只声明 `pub mod transport;` 其余行注释掉避免空文件编译错——按下面顺序逐任务解注释，或一次创建全部空壳文件含 `// 任务 N 填充` 头注释。**采用空壳方案**：一次性创建六个空壳文件，每个文件头一行注释标注填充任务号）。

- [ ] **步骤 4：`cargo test -j 2 transport_error` → PASS（2 个）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/smb/ src-tauri/src/source/mod.rs
git commit -m "feat(smb): TransportError 连接级/文件级分类 + RawDirEntry/RawStat + FILETIME 换算"
```

---

### 任务 2：UNC 拼接 + share 契约校验纯函数

**文件：**
- 填充：`src-tauri/src/source/smb/path.rs`

- [ ] **步骤 1：写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_join_converts_slashes() {
        // descriptor path 是 '/' 分隔的 source-relative；UNC 用 '\'
        assert_eq!(unc_rel("comics/v1", "001.jpg"), r"comics\v1\001.jpg");
        assert_eq!(unc_rel("", "001.jpg"), "001.jpg");
        assert_eq!(unc_rel("comics", ""), "comics");
    }

    #[test]
    fn share_contract_first_segment_must_match() {
        // 根路径契约（母 spec §4.2）：initialPath 首段 === account.share
        assert!(share_root_matches("media", Some("media")).is_ok());
        assert!(share_root_matches("media/comics", Some("media")).is_ok());
        assert!(share_root_matches("other", Some("media")).is_err());   // 跨 share 越权
        assert!(share_root_matches("media", None).is_err());            // share NULL = 配置错误
        // initial_path 为空同样违约（首段不存在）
        assert!(share_root_matches("", Some("media")).is_err());
    }

    #[test]
    fn rel_below_initial_path() {
        // MediaSource.path 参数语义：相对 initial_path 的子路径（不含 initial_path 前缀）
        assert_eq!(strip_initial_prefix("media/comics", "media/comics/v1"), Some("v1".to_string()));
        assert_eq!(strip_initial_prefix("media", "media"), Some(String::new()));
        assert_eq!(strip_initial_prefix("media", "other/x"), None); // 前缀不符
    }
}
```

- [ ] **步骤 2：`cargo test -j 2 unc_join` → 编译失败**

- [ ] **步骤 3：实现 path.rs**

```rust
//! UNC 路径拼接 + 根路径契约（母 spec §4.2 双侧校验的 source 侧）。

/// descriptor 的 '/' 分隔 rel → UNC '\' 分隔（相对 share 的路径段拼接）。
pub fn unc_rel(initial_path: &str, path: &str) -> String {
    let a = initial_path.replace(['\\'], "/");
    let b = path.replace(['\\'], "/");
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b,
        (false, true) => a,
        (false, false) => format!("{}\\{}", a.trim_end_matches('/'), b.trim_start_matches('/')),
    }
}

/// 根路径契约：initialPath 首段必须等于 account.share（share NULL 视为配置错误）。
pub fn share_root_matches(initial_path: &str, account_share: Option<&str>) -> Result<(), &'static str> {
    let Some(share) = account_share else {
        return Err("账户缺少 share 配置（固定共享根必填）");
    };
    let first = initial_path.split('/').next().unwrap_or("");
    if first.is_empty() || first != share {
        return Err("initialPath 首段必须等于 account.share（跨 share 访问被拒绝）");
    }
    Ok(())
}

/// full_rel（含 initial_path 前缀的 '/' 分隔路径）→ 相对 initial_path 的子路径。
/// 前缀不符返回 None（调用方按 PathEscape 拒绝）。
pub fn strip_initial_prefix(initial_path: &str, full_rel: &str) -> Option<String> {
    let init = initial_path.trim_matches('/');
    let full = full_rel.trim_matches('/');
    if init.is_empty() {
        return Some(full.to_string());
    }
    full.strip_prefix(&format!("{init}/"))
        .map(|s| s.to_string())
        .or(if full == init { Some(String::new()) } else { None })
}
```

- [ ] **步骤 4：`cargo test -j 2 unc_join` 与 `share_contract`、`rel_below` → 全 PASS（3 组）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/smb/path.rs
git commit -m "feat(smb): UNC 拼接（/→\\）+ share 根契约 + initial_path 前缀剥离纯函数"
```

---

### 任务 3：MockSmbTransport（可编程测试基座）

**文件：**
- 填充：`src-tauri/src/source/smb/mock_transport.rs`

- [ ] **步骤 1：写失败测试（先测 mock 自身行为——它是后续所有任务的测试工具，自身必须可靠）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn params() -> ConnectParams {
        ConnectParams {
            host: "h".into(), port: 445, share: "media".into(),
            username: Some("u".into()), password: Some("p".into()),
            initial_path: "media".into(),
        }
    }

    #[tokio::test]
    async fn scripted_list_and_call_recording() {
        let m = MockSmbTransport::new();
        m.script_list("comics", vec![RawDirEntry {
            name: "v1".into(), is_directory: true, size: 0, modified_unix_secs: 100,
        }]);
        m.connect(&params()).await.unwrap();
        let entries = m.list("comics").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "v1");
        assert_eq!(m.connect_calls(), 1);
        assert_eq!(m.list_calls("comics"), 1);
    }

    #[tokio::test]
    async fn read_exact_fails_when_script_short() {
        let m = MockSmbTransport::new();
        m.script_bytes(b"abcdef"); // 6 字节
        let mut buf = vec![0u8; 10];
        // 脚本数据不足 buf —— Err（而不是静默短读）
        assert!(m.read_block_exact("f", 0, &mut buf).await.is_err());
    }

    #[tokio::test]
    async fn error_injection_and_disconnect_mode() {
        let m = MockSmbTransport::new();
        m.set_fail_all(TransportError::Disconnected);
        assert!(m.list("x").await.is_err());
        // connect 后 fail 被触发过 disconnect 观察计数（重连测试用）
        assert_eq!(m.disconnect_signals(), 1);
    }
}
```

- [ ] **步骤 2：`cargo test -j 2 scripted_list` → 编译失败**

- [ ] **步骤 3：实现 mock_transport.rs**

```rust
//! 可编程 mock transport（spec §7 测试策略）：脚本化响应 + 调用记录 + 错误注入。
//! 连接管理器 / source 实装的全部单测基座。

use super::transport::{ConnectParams, RawDirEntry, RawStat, SmbTransport, TransportError};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

#[derive(Default)]
struct Inner {
    lists: HashMap<String, Vec<RawDirEntry>>,
    stats: HashMap<String, RawStat>,
    list_calls: HashMap<String, u32>,
    connect_calls: AtomicU32,
    fail_all: Option<TransportError>,
    fail_once: Option<TransportError>,
    /// bytes 脚本：read_block_exact 从 offset 切片（不足即 Err——模拟短读/EOF 早到）
    bytes: Vec<u8>,
}

pub struct MockSmbTransport {
    inner: Mutex<Inner>,
    connected: AtomicBool,
    disconnect_signals: AtomicU32,
}

impl MockSmbTransport {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            connected: AtomicBool::new(false),
            disconnect_signals: AtomicU32::new(0),
        }
    }

    pub fn script_list(&self, rel: &str, entries: Vec<RawDirEntry>) {
        self.inner.lock().unwrap().lists.insert(rel.to_string(), entries);
    }

    pub fn script_stat(&self, rel: &str, stat: RawStat) {
        self.inner.lock().unwrap().stats.insert(rel.to_string(), stat);
    }

    pub fn script_bytes(&self, bytes: &[u8]) {
        self.inner.lock().unwrap().bytes = bytes.to_vec();
    }

    /// 全部操作注入错误（连接级场景）；错误触发时 disconnect 信号 +1（重连测试观察点）。
    pub fn set_fail_all(&self, e: TransportError) {
        let mut g = self.inner.lock().unwrap();
        g.fail_all = Some(e);
    }

    /// 下一次操作注入一次性错误（重试一次成功场景）。
    pub fn set_fail_once(&self, e: TransportError) {
        self.inner.lock().unwrap().fail_once = Some(e);
    }

    pub fn connect_calls(&self) -> u32 {
        self.inner.lock().unwrap().connect_calls.load(Ordering::SeqCst)
    }

    pub fn list_calls(&self, rel: &str) -> u32 {
        *self.inner.lock().unwrap().list_calls.get(rel).unwrap_or(&0)
    }

    pub fn disconnect_signals(&self) -> u32 {
        self.disconnect_signals.load(Ordering::SeqCst)
    }
}

#[async_trait::async_trait]
impl SmbTransport for MockSmbTransport {
    async fn connect(&self, _params: &ConnectParams) -> Result<(), TransportError> {
        self.inner.lock().unwrap().connect_calls.fetch_add(1, Ordering::SeqCst);
        self.connected.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn list(&self, rel: &str) -> Result<Vec<RawDirEntry>, TransportError> {
        if let Some(e) = self.take_injected() {
            if e.is_connection_level() {
                self.connected.store(false, Ordering::SeqCst);
                self.disconnect_signals.fetch_add(1, Ordering::SeqCst);
            }
            return Err(e);
        }
        let mut g = self.inner.lock().unwrap();
        *g.list_calls.entry(rel.to_string()).or_insert(0) += 1;
        g.lists.get(rel).cloned().ok_or_else(|| TransportError::FileNotFound(rel.to_string()))
    }

    async fn read_block_exact(&self, _rel: &str, offset: u64, buf: &mut [u8]) -> Result<(), TransportError> {
        if let Some(e) = self.take_injected() {
            if e.is_connection_level() {
                self.connected.store(false, Ordering::SeqCst);
                self.disconnect_signals.fetch_add(1, Ordering::SeqCst);
            }
            return Err(e);
        }
        let g = self.inner.lock().unwrap();
        let start = offset as usize;
        let end = start.checked_add(buf.len()).ok_or_else(|| TransportError::InvalidPath("offset overflow".into()))?;
        // 脚本数据不足（EOF 早到/文件变小）→ Err（Range 强契约，禁止短读）
        if end > g.bytes.len() {
            return Err(TransportError::Disconnected); // EOF 早到按连接级处理，触发外层重连兜底
        }
        buf.copy_from_slice(&g.bytes[start..end]);
        Ok(())
    }

    async fn stat(&self, rel: &str) -> Result<RawStat, TransportError> {
        if let Some(e) = self.take_injected() {
            return Err(e);
        }
        let g = self.inner.lock().unwrap();
        g.stats.get(rel).cloned().ok_or_else(|| TransportError::FileNotFound(rel.to_string()))
    }
}

impl MockSmbTransport {
    fn take_injected(&self) -> Option<TransportError> {
        let mut g = self.inner.lock().unwrap();
        if g.fail_all.is_some() {
            return g.fail_all.clone();
        }
        g.fail_once.take()
    }
}
```

- [ ] **步骤 4：`cargo test -j 2 mock` 相关 3 用例 → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/smb/mock_transport.rs
git commit -m "test(smb): MockSmbTransport——脚本化 list/stat/bytes + 错误注入 + 调用记录"
```

---

### 任务 4：SmbConnectionManager（TTL / 建连 / 重连）

**文件：**
- 填充：`src-tauri/src/source/smb/connection.rs`

**设计要点**：manager 持「transport 工厂」而非具体类型（生产=real_transport 工厂，测试=mock 工厂可计数建实例）；每 accountId 一个 transport 实例；TTL 用 `last_used + ttl` 判定，**测试注入短 ttl**（1ms）；连接级错误 → 剔除 + 重建 + 重试一次。

- [ ] **步骤 1：写失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialStore, MemoryStore};
    use crate::source::smb::mock_transport::MockSmbTransport;
    use crate::source::smb::transport::{ConnectParams, RawDirEntry, RawStat, TransportError};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// 工厂产物登记器：计数建了多少个 transport 实例（断言 TTL 回收 / 重连重建）
    struct FactoryLog {
        created: Mutex<Vec<Arc<MockSmbTransport>>>,
    }

    fn manager_with_log(ttl: Duration) -> (SmbConnectionManager, Arc<FactoryLog>) {
        let db = crate::db::Db::open_in_memory().unwrap();
        let creds = Arc::new(MemoryStore::new());
        let log = Arc::new(FactoryLog { created: Mutex::new(vec![]) });
        let log2 = log.clone();
        let factory: TransportFactory = Arc::new(move || {
            let t = Arc::new(MockSmbTransport::new());
            log2.created.lock().unwrap().push(t.clone());
            Box::pin(async move { t as Arc<dyn SmbTransport> })
        });
        // 账户行：share=media，密码进 keyring
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password)
                 VALUES ('nas', 'smb', '192.168.1.1', 445, 'media', 'u', NULL)",
                [],
            ).unwrap();
        }
        creds.set_password("smb-1", "p").unwrap();
        let mgr = SmbConnectionManager::new(db, creds, factory, ttl);
        (mgr, log)
    }

    #[tokio::test]
    async fn same_account_reuses_transport_until_ttl() {
        // ttl 足够长：两次调用同一 transport（建 1 个实例）
        let (mgr, log) = manager_with_log(Duration::from_secs(300));
        mgr.list(1, "media", "comics").await.unwrap_err(); // 未脚本化 → FileNotFound，但 transport 已建
        mgr.list(1, "media", "comics").await.unwrap_err();
        assert_eq!(log.created.lock().unwrap().len(), 1, "TTL 内复用同一连接");
    }

    #[tokio::test]
    async fn ttl_expiry_recreates_transport() {
        // ttl 极短：第一次调用后 sleep 超时，第二次重建
        let (mgr, log) = manager_with_log(Duration::from_millis(10));
        mgr.stat(1, "media", "f").await.unwrap_err();
        tokio::time::sleep(Duration::from_millis(30)).await;
        mgr.stat(1, "media", "f").await.unwrap_err();
        assert_eq!(log.created.lock().unwrap().len(), 2, "TTL 过期后懒重建");
    }

    #[tokio::test]
    async fn connection_level_error_reconnects_once_and_succeeds() {
        let (mgr, log) = manager_with_log(Duration::from_secs(300));
        // 第一次建连产物：注入一次性连接级错误 → manager 应重建并重试成功
        // （list 未脚本化会 FileNotFound——不是连接级——验证"重试后拿到文件级错误"即证明重建成功）
        {
            let first = log.created.lock().unwrap();
            // 此时还没建——先触发一次拿实例再注入不可行（实例在调用时才建）。
            // 改为：预先往 factory log 里观察。直接跑一次调用：
        }
        let r1 = mgr.list(1, "media", "comics").await;
        // 第一次：新建 transport，未脚本化 → FileNotFound（文件级，不重建）
        assert!(matches!(r1, Err(TransportError::FileNotFound(_))));
        assert_eq!(log.created.lock().unwrap().len(), 1);
        // 给当前实例注入一次性连接级错误：下一次调用应重建（实例+1）并成功执行
        let cur = log.created.lock().unwrap()[0].clone();
        cur.set_fail_once(TransportError::Disconnected);
        let r2 = mgr.list(1, "media", "comics").await;
        assert!(matches!(r2, Err(TransportError::FileNotFound(_))), "重连后到达文件层错误");
        assert_eq!(log.created.lock().unwrap().len(), 2, "连接级错误剔除重建");
    }

    #[tokio::test]
    async fn file_level_error_does_not_reconnect() {
        let (mgr, log) = manager_with_log(Duration::from_secs(300));
        mgr.list(1, "media", "nope").await.unwrap_err(); // FileNotFound
        mgr.list(1, "media", "nope").await.unwrap_err();
        assert_eq!(log.created.lock().unwrap().len(), 1, "文件级错误不重建");
    }

    #[tokio::test]
    async fn concurrent_connect_deduplicates_to_one_slot() {
        // P1-1 阶段 3 写回语义：并发两请求各自建连（实例 2 个），最终 slot 只留一个
        // 且两者都成功返回可用 transport
        let (mgr, log) = manager_with_log(std::time::Duration::from_secs(300));
        let (a, b) = tokio::join!(mgr.stat(1, "media", "f"), mgr.stat(1, "media", "f"));
        assert!(a.is_err() && b.is_err()); // 未脚本化 FileNotFound——但两请求都走通了 transport
        assert_eq!(log.created.lock().unwrap().len(), 2, "并发竞态各自建连（去重=复用先到者，非阻止建连）");
    }

    #[tokio::test]
    async fn missing_account_row_errors() {
        let (mgr, _) = manager_with_log(Duration::from_secs(300));
        let r = mgr.list(999, "media", "x").await;
        assert!(r.is_err());
    }
}
```

- [ ] **步骤 2：`cargo test -j 2 connection_manager` → 编译失败**

- [ ] **步骤 3：实现 connection.rs**

```rust
//! SMB 连接管理器（spec §3）：accountId → transport 复用 + TTL 懒回收 + 连接级重连。

use super::transport::{ConnectParams, RawDirEntry, RawStat, SmbTransport, TransportError};
use crate::credentials::CredentialStore;
use crate::db::Db;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// transport 工厂：返回已 connect 的 transport（生产=真实 smb 接线；测试=mock 计数）。
pub type TransportFactory = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Arc<dyn SmbTransport>> + Send>>
        + Send
        + Sync,
>;

struct ManagedTransport {
    transport: Arc<dyn SmbTransport>,
    last_used: Instant,
}

pub struct SmbConnectionManager {
    db: Db,
    creds: Arc<dyn CredentialStore>,
    factory: TransportFactory,
    ttl: Duration,
    slots: Mutex<HashMap<i64, ManagedTransport>>,
}

pub struct SmbAccountRow {
    pub host: String,
    pub port: i64,
    pub share: Option<String>,
    pub username: Option<String>,
    pub initial_path: String,
}

impl SmbConnectionManager {
    /// 生产构造：真实 transport 工厂 + 5 分钟 TTL（spec §3 常量）。
    pub fn new_production(db: Db, creds: Arc<dyn CredentialStore>) -> Self {
        Self::new(db, creds, real_factory(), Duration::from_secs(5 * 60))
    }

    pub fn new(db: Db, creds: Arc<dyn CredentialStore>, factory: TransportFactory, ttl: Duration) -> Self {
        Self { db, creds, factory, ttl, slots: Mutex::new(HashMap::new()) }
    }

    /// 查 account 行 + keyring 密码 → ConnectParams。share NULL / 契约不符即错误。
    fn resolve_params(&self, account_id: i64, initial_path: &str) -> Result<ConnectParams, TransportError> {
        let (host, port, share, username) = {
            let conn = self.db.conn();
            conn.query_row(
                "SELECT host, port, share, username FROM account WHERE id = ?1 AND type = 'smb'",
                rusqlite::params![account_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .map_err(|_| TransportError::FileNotFound(format!("smb account {account_id} 不存在")))?
        };
        super::path::share_root_matches(initial_path, share.as_deref())
            .map_err(TransportError::InvalidPath)?;
        let port = port.unwrap_or(445);
        if !(1..=65535).contains(&port) {
            return Err(TransportError::InvalidPath(format!("端口越界: {port}")));
        }
        let password = self
            .creds
            .get_password(&crate::credentials::account_key("smb", account_id))
            .map_err(|e| TransportError::Io(e))?;
        Ok(ConnectParams {
            host,
            port: port as i32,
            share: share.unwrap_or_default(),
            username,
            password,
            initial_path: initial_path.to_string(),
        })
    }

    /// **两阶段（P1 修复）**：std MutexGuard 不得跨 await（async_trait 要求 Send；
    /// 且连接慢时不能阻塞其他账户的缓存读取/回收）。
    /// 阶段 1 锁内查/回收 → 释放锁建连 → 阶段 2 短锁写回（并发去重：后到者复用先到者）。
    async fn get_or_connect(&self, account_id: i64, initial_path: &str) -> Result<Arc<dyn SmbTransport>, TransportError> {
        let params = self.resolve_params(account_id, initial_path)?;
        // 阶段 1：锁内——TTL 懒回收 + 命中直返（锁在 await 前释放）
        let existing = {
            let mut slots = self.slots.lock().unwrap();
            let now = Instant::now();
            slots.retain(|_, m| now.duration_since(m.last_used) < self.ttl);
            match slots.get_mut(&account_id) {
                Some(m) => {
                    m.last_used = now;
                    Some(m.transport.clone())
                }
                None => None,
            }
        }; // MutexGuard 在此 drop
        if let Some(t) = existing {
            return Ok(t);
        }
        // 阶段 2：无锁建连（慢连接不阻塞其他账户）
        let transport = (self.factory)().await;
        transport.connect(&params).await?;
        // 阶段 3：短锁写回。并发建连去重：竞态后到者发现自己已存在 → 丢弃新建实例
        // （多花一次建连握手，正确性无损——两实例行为等价），复用先到者。
        let mut slots = self.slots.lock().unwrap();
        if let Some(m) = slots.get_mut(&account_id) {
            m.last_used = Instant::now();
            return Ok(m.transport.clone());
        }
        slots.insert(account_id, ManagedTransport { transport: transport.clone(), last_used: Instant::now() });
        Ok(transport)
    }

    /// 连接级错误 → 剔除重建重试一次（spec §3）；文件级直接上抛。
    fn evict(&self, account_id: i64) {
        self.slots.lock().unwrap().remove(&account_id);
    }

    // ─── 对 source 层的操作面 ───

    pub async fn list(&self, account_id: i64, initial_path: &str, rel: &str) -> Result<Vec<RawDirEntry>, TransportError> {
        match self.get_or_connect(account_id, initial_path).await?.list(rel).await {
            Ok(v) => Ok(v),
            Err(e) if e.is_connection_level() => {
                self.evict(account_id);
                self.get_or_connect(account_id, initial_path).await?.list(rel).await
            }
            Err(e) => Err(e),
        }
    }

    pub async fn read_block_exact(&self, account_id: i64, initial_path: &str, rel: &str, offset: u64, buf: &mut [u8]) -> Result<(), TransportError> {
        match self.get_or_connect(account_id, initial_path).await?.read_block_exact(rel, offset, buf).await {
            Ok(()) => Ok(()),
            Err(e) if e.is_connection_level() => {
                self.evict(account_id);
                self.get_or_connect(account_id, initial_path).await?.read_block_exact(rel, offset, buf).await
            }
            Err(e) => Err(e),
        }
    }

    pub async fn stat(&self, account_id: i64, initial_path: &str, rel: &str) -> Result<RawStat, TransportError> {
        match self.get_or_connect(account_id, initial_path).await?.stat(rel).await {
            Ok(v) => Ok(v),
            Err(e) if e.is_connection_level() => {
                self.evict(account_id);
                self.get_or_connect(account_id, initial_path).await?.stat(rel).await
            }
            Err(e) => Err(e),
        }
    }
}

/// 生产工厂（real_transport.rs 任务 6 实装；此处前置声明保持本任务可编译测试）。
fn real_factory() -> TransportFactory {
    Arc::new(|| Box::pin(async { Arc::new(super::real_transport::SmbClientTransport::new()) as Arc<dyn SmbTransport> }))
}
```

（`real_transport.rs` 空壳此时含 `pub struct SmbClientTransport; impl SmbClientTransport { pub fn new() -> Self { Self } }`——任务 6 填实。）

- [ ] **步骤 4：`cargo test -j 2 connection_manager` → 5 用例 PASS**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/smb/connection.rs src-tauri/src/source/smb/real_transport.rs
git commit -m "feat(smb): 连接管理器——TTL 懒回收/凭据解析/连接级错误剔除重建重试一次"
```

---

### 任务 5：SmbMediaSource 5 方法实装（mock transport 驱动）

**文件：**
- 填充：`src-tauri/src/source/smb/source.rs`
- 删除：`src-tauri/src/source/smb_impl.rs`
- 修改：`src-tauri/src/source/mod.rs`（删 `pub mod smb_impl;`；`pub use` 处把 `SmbMediaSource` 改从 `smb::source` 导出）
- 修改：`src-tauri/src/source/factory.rs`（`use crate::source::smb::source::SmbMediaSource`；构造改 `SmbMediaSource::new(Arc::new(SmbConnectionManager::new_production(db.clone(), creds.clone())))`）

- [ ] **步骤 1：写失败测试（source.rs tests；manager 用 mock 工厂构造——复用任务 4 的 manager_with_log 模式，抽成测试 helper 函数放 tests 模块顶部）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::smb::connection::SmbConnectionManager;
    use crate::source::smb::mock_transport::MockSmbTransport;
    use crate::source::smb::transport::{RawDirEntry, RawStat, TransportError};
    use crate::credentials::MemoryStore;
    use std::sync::Arc;
    use std::time::Duration;

    fn make_source() -> (SmbMediaSource, Arc<MockSmbTransport>) {
        let db = crate::db::Db::open_in_memory().unwrap();
        let creds = Arc::new(MemoryStore::new());
        creds.set_password("smb-1", "p").unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password)
                 VALUES ('nas', 'smb', '192.168.1.1', 445, 'media', 'u', NULL)", []).unwrap();
        }
        let mock = Arc::new(MockSmbTransport::new());
        let mock2 = mock.clone();
        let factory: crate::source::smb::connection::TransportFactory = Arc::new(move || {
            let m = mock2.clone();
            Box::pin(async move { m as Arc<dyn crate::source::smb::transport::SmbTransport> })
        });
        let mgr = SmbConnectionManager::new(db, creds, factory, Duration::from_secs(300));
        (SmbMediaSource::new(Arc::new(mgr)), mock)
    }

    fn smb_desc(initial: &str, path: &str) -> SourceDescriptor {
        SourceDescriptor::Smb { account_id: 1, initial_path: initial.into(), path: path.into(), port: 445 }
    }

    fn raw(name: &str, is_dir: bool, size: u64) -> RawDirEntry {
        RawDirEntry { name: name.into(), is_directory: is_dir, size, modified_unix_secs: 86400 }
    }

    #[tokio::test]
    async fn list_maps_entries_with_archive_flag_and_sort() {
        let (src, mock) = make_source();
        // rel 相对 share = initial_path("media") + 方法 path("v1")
        mock.script_list("media/v1", vec![
            raw("page10.jpg", false, 5), raw("page2.jpg", false, 4),
            raw("sub", true, 0), raw("book.cbz", false, 100),
        ]);
        let entries = src.list_directory(&smb_desc("media", "v1"), "v1").await.unwrap();
        // 自然排序（page2 < page10），目录在前由 UI 层管（source 只保自然序——对齐 local.rs）
        assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
                   ["book.cbz", "page10.jpg", "page2.jpg", "sub"]);
        let cbz = entries.iter().find(|e| e.name == "book.cbz").unwrap();
        assert!(cbz.is_archive, "cbz 扩展名 → is_archive（对齐 local.rs）");
        let sub = entries.iter().find(|e| e.name == "sub").unwrap();
        assert!(sub.is_directory && sub.size == 0);
        assert_eq!(entries[0].modified_at, Some(86400));
    }

    #[tokio::test]
    async fn read_file_range_exact_or_error() {
        let (src, mock) = make_source();
        mock.script_bytes(b"0123456789");
        // 无 range 分支先 stat 拿全量 size——脚本必须配（rel 相对 share 含 initial_path 前缀）
        mock.script_stat("media/v1/f.bin", RawStat { size: 10, modified_unix_secs: None });
        let d = smb_desc("media", "v1");
        let full = src.read_file(&d, "f.bin", None).await.unwrap();
        assert_eq!(full, b"0123456789");
        let mut part = src.read_file(&d, "f.bin", Some(ByteRange::new(2, 4))).await.unwrap();
        assert_eq!(part, b"2345");
        part = src.read_file(&d, "f.bin", Some(ByteRange::new(0, 10))).await.unwrap();
        assert_eq!(part, b"0123456789");
        // 越界（超脚本数据）→ Err（Range 强契约）
        assert!(src.read_file(&d, "f.bin", Some(ByteRange::new(8, 10))).await.is_err());
    }

    #[tokio::test]
    async fn stat_maps_to_file_stat() {
        let (src, mock) = make_source();
        mock.script_stat("media/v1/f.bin", RawStat { size: 42, modified_unix_secs: Some(123) });
        let st = src.stat(&smb_desc("media", "v1"), "v1/f.bin").await.unwrap();
        assert_eq!(st.size, 42);
        assert_eq!(st.modified_at, Some(123));
    }

    // ─── P0 回归：initial_path 前缀必须进 transport rel（深层入口）───

    #[tokio::test]
    async fn deep_initial_path_root_list_includes_prefix() {
        let (src, mock) = make_source();
        // 账户 share=media、入口 media/comics：根目录列表（方法 path=""）→ rel="media/comics"
        mock.script_list("media/comics", vec![raw("v1", true, 0)]);
        let entries = src.list_directory(&smb_desc("media/comics", ""), "").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "v1");
    }

    #[tokio::test]
    async fn deep_initial_path_subdirectory_join() {
        let (src, mock) = make_source();
        mock.script_list("media/comics/v1", vec![raw("001.jpg", false, 7)]);
        let entries = src.list_directory(&smb_desc("media/comics", ""), "v1").await.unwrap();
        assert_eq!(entries[0].name, "001.jpg");
    }

    #[tokio::test]
    async fn deep_initial_path_read_joins_prefix() {
        let (src, mock) = make_source();
        mock.script_bytes(b"0123456789");
        let d = smb_desc("media/comics", "");
        let part = src.read_file(&d, "v1/001.jpg", Some(ByteRange::new(2, 4))).await.unwrap();
        assert_eq!(part, b"2345");
        // read 走 stat 拿全量（无 range 时）——此处 range 路径不依赖 stat 脚本
    }

    #[tokio::test]
    async fn path_escape_rejected_before_transport() {
        let (src, mock) = make_source();
        assert!(matches!(
            src.list_directory(&smb_desc("media", "../escape"), "").await,
            Err(MediaSourceError::PathEscape(_))));
        assert_eq!(mock.list_calls("escape"), 0, "越界路径不触 transport");
    }

    #[tokio::test]
    async fn test_lists_root_and_requires_share() {
        let (src, mock) = make_source();
        mock.script_list("media", vec![raw("comics", true, 0)]);
        src.test(&smb_desc("media", "")).await.unwrap();
        // initial_path 首段 ≠ share → 配置错误
        assert!(src.test(&smb_desc("wrong", "")).await.is_err());
    }
}
```

- [ ] **步骤 2：`cargo test -j 2 smb_source` → 编译失败**

- [ ] **步骤 3：实现 source.rs（含从 smb_impl.rs 迁移的 descriptor 解构）**

```rust
//! `SmbMediaSource` —— SMB 协议层实装（module3.3.0，spec M2 §4）。

use crate::source::descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
use crate::source::smb::connection::SmbConnectionManager;
use crate::source::trait_def::{ByteRange, FileStat, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use std::sync::Arc;

/// 单次 read_file 全量上限（建议 3：异常 stat 防御，对齐 media LRU 256MB）
const MAX_SMB_READ_BYTES: usize = 256 * 1024 * 1024;

pub struct SmbMediaSource {
    manager: Arc<SmbConnectionManager>,
}

impl SmbMediaSource {
    pub fn new(manager: Arc<SmbConnectionManager>) -> Self {
        Self { manager }
    }

    /// (account_id, initial_path)。descriptor.path 不参与路径拼接（P0：方法参数即完整路径）。
    fn extract<'a>(&self, descriptor: &'a SourceDescriptor) -> Option<(i64, &'a str)> {
        match descriptor {
            SourceDescriptor::Smb { account_id, initial_path, .. } => Some((*account_id, initial_path.as_str())),
            _ => None,
        }
    }

    fn transport_err(e: crate::source::smb::transport::TransportError) -> MediaSourceError {
        use crate::source::smb::transport::TransportError as TE;
        match e {
            TE::FileNotFound(p) => MediaSourceError::NotFound(p),
            TE::PermissionDenied(p) => MediaSourceError::PermissionDenied(p),
            TE::InvalidPath(p) => MediaSourceError::PathEscape(p),
            other => MediaSourceError::Network(other.to_string()), // 连接级/超时/IO → 502
        }
    }
}

/// RawDirEntry → MediaEntry（is_archive 按扩展名，对齐 local.rs / webdav M3 补丁）
fn map_entry(raw: crate::source::smb::transport::RawDirEntry) -> MediaEntry {
    let is_archive = !raw.is_directory
        && ArchiveFormat::from_extension(
            std::path::Path::new(&raw.name).extension().and_then(|e| e.to_str()).unwrap_or(""),
        )
        .is_some();
    MediaEntry {
        name: raw.name.clone(),
        path: raw.name,
        is_directory: raw.is_directory,
        is_archive,
        size: raw.size,
        modified_at: if raw.modified_unix_secs == 0 { None } else { Some(raw.modified_unix_secs) },
    }
}

#[async_trait]
impl MediaSource for SmbMediaSource {
    fn descriptor_type(&self) -> &'static str {
        "smb"
    }

    async fn list_directory(&self, descriptor: &SourceDescriptor, path: &str) -> Result<Vec<MediaEntry>> {
        let (account_id, initial_path) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("SmbMediaSource 仅处理 Smb descriptor".into())
        })?;
        let rel = validated_rel(initial_path, path)?;
        let raws = self.manager.list(account_id, initial_path, &rel).await.map_err(Self::transport_err)?;
        let mut entries: Vec<MediaEntry> = raws.into_iter().map(map_entry).collect();
        entries.sort_by(|a, b| crate::algorithm::natural_compare(&a.name, &b.name));
        Ok(entries)
    }

    async fn read_file(&self, descriptor: &SourceDescriptor, path: &str, range: Option<ByteRange>) -> Result<Vec<u8>> {
        let (account_id, initial_path) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("SmbMediaSource 仅处理 Smb descriptor".into())
        })?;
        let rel = validated_rel(initial_path, path)?;
        let total = match range {
            None => {
                let st = self.manager.stat(account_id, initial_path, &rel).await.map_err(Self::transport_err)?;
                // 建议 3 修复：u64→usize 显式检查 + 巨量钳制（异常/恶意 stat 防御；
                // 256MB 对齐 media LRU 容量——正常图片远小于此）
                usize::try_from(st.size)
                    .map_err(|_| MediaSourceError::Network(format!("文件过大: {}", st.size)))?
            }
            Some(r) => usize::try_from(r.length)
                .map_err(|_| MediaSourceError::Network(format!("区间过大: {}", r.length)))?,
        };
        if total > MAX_SMB_READ_BYTES {
            return Err(MediaSourceError::Network(format!("读取超过上限 {} 字节", MAX_SMB_READ_BYTES)));
        }
        let mut buf = vec![0u8; total];
        self.manager
            .read_block_exact(account_id, initial_path, &rel, range.map(|r| r.offset).unwrap_or(0), &mut buf)
            .await
            .map_err(Self::transport_err)?;
        Ok(buf)
    }

    async fn file_count(&self, descriptor: &SourceDescriptor, path: &str) -> Result<u64> {
        let entries = self.list_directory(descriptor, path).await?;
        Ok(entries.iter().filter(|e| !e.is_directory && !e.is_archive).count() as u64)
    }

    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()> {
        match descriptor {
            SourceDescriptor::Smb { account_id, initial_path, .. } => {
                // 根路径契约由 manager.resolve_params 内的 share_root_matches 把关；
                // 真握手 = 建连 + 列 initial_path 根一次
                self.manager.list(*account_id, initial_path, "").await.map_err(Self::transport_err)?;
                Ok(())
            }
            _ => Err(MediaSourceError::NotImplemented("SmbMediaSource::test 仅处理 Smb descriptor".into())),
        }
    }

    async fn stat(&self, descriptor: &SourceDescriptor, path: &str) -> Result<FileStat> {
        let (account_id, initial_path) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("SmbMediaSource 仅处理 Smb descriptor".into())
        })?;
        let rel = validated_rel(initial_path, path)?;
        let raw = self.manager.stat(account_id, initial_path, &rel).await.map_err(Self::transport_err)?;
        Ok(FileStat { size: raw.size, modified_at: raw.modified_unix_secs })
    }
}

/// **路径契约（P0 修复）**：方法 path 参数 = 相对 initial_path 入口的完整路径
/// （对齐 WebDAV 语义——webdav_impl 忽略 descriptor.path、只用方法参数拼 base_url；
/// fileBrowser fetch 传完整 currentPath、loader 传 book.absolutePath，均为完整路径）。
/// descriptor.path 是同信息的冗余双承载（身份记录），**不参与拼接**。
/// transport rel 语义 = 相对 share = initial_path 前缀 + 方法 path。
fn validated_rel(initial_path: &str, path: &str) -> Result<String> {
    let norm = crate::algorithm::validate_source_relative(path)
        .map_err(|e| MediaSourceError::PathEscape(format!("{:?}: {}", e, path)))?;
    let joined = crate::source::smb::path::unc_rel(initial_path, &norm);
    // unc_rel 产出 \' 分隔（相对 share）——转回 '/' 供 transport 层统一消费
    Ok(joined.replace('\\', '/'))
}
```

同时：删除 `src-tauri/src/source/smb_impl.rs`；`source/mod.rs` 删 `pub mod smb_impl;` 行、`pub use` 若引用 `smb_impl::SmbMediaSource` 改 `pub use smb::source::SmbMediaSource;`；`factory.rs` 的 `use crate::source::smb_impl::SmbMediaSource` 改新路径，构造改：

```rust
    smb: Arc::new(crate::source::smb::source::SmbMediaSource::new(Arc::new(
        crate::source::smb::connection::SmbConnectionManager::new_production(
            db.clone(),
            creds.clone(),
        ),
    ))),
```

（`factory.rs` 顶部 `use std::sync::Arc;` 已有。`MediaSourceFactory` 其余不动。）

- [ ] **步骤 4：`cargo test -j 2 smb_source` → 5 用例 PASS；`cargo test -j 2` 全量不红（find_next_volume 的 make_factory 走 production 构造——`real_factory()` 引用 SmbClientTransport 空壳，构造本身零网络 ✓）**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/smb/source.rs src-tauri/src/source/factory.rs src-tauri/src/source/mod.rs
git rm src-tauri/src/source/smb_impl.rs
git commit -m "feat(smb): SmbMediaSource 5 方法实装——MediaEntry 映射/Range 强契约/根契约 test"
```

---

### 任务 6：SmbClientTransport 真实接线（smb crate 0.11）

**文件：**
- 填充：`src-tauri/src/source/smb/real_transport.rs`

**注意**：本任务网络部分单测不覆盖（无 NAS CI），靠 mock 层逻辑等价 + spike 实机验证；映射函数 `map_smb_error` 用 smb::Error 真实变体写（编译期保证变体存在；变体集合以本地 registry 源码 error.rs 为准——见计划头部摘要）。

- [ ] **步骤 1：实现 real_transport.rs（无独立失败测试——纯接线；map_smb_error 的分类逻辑以单测锁定可构造的变体）**

```rust
//! 生产 transport：smb crate 0.11 真实接线（API 已对 registry 源码核对，见计划头部摘要）。
//! 每实例持一个已认证 Client + share 根 UncPath；由连接管理器管生命周期。

use super::transport::{ConnectParams, RawDirEntry, RawStat, SmbTransport, TransportError};
use smb::resource::Resource;
use smb::{AccessMask, Client, ClientConfig, Error as SmbError, UncPath};
use std::sync::Arc;

pub struct SmbClientTransport {
    client: Arc<Client>,
    share_root: tokio::sync::OnceCell<UncPath>,
}

impl SmbClientTransport {
    pub fn new() -> Self {
        Self { client: Arc::new(Client::new(ClientConfig::default())), share_root: tokio::sync::OnceCell::new() }
    }

    async fn tree(&self) -> Result<Arc<smb::Tree>, TransportError> {
        let root = self.share_root.get().ok_or_else(|| TransportError::Disconnected)?;
        self.client.get_tree(root).await.map_err(map_smb_error)
    }

    fn access() -> AccessMask {
        let mut m = AccessMask::new();
        m.set_generic_read(true);
        m
    }
}

/// smb::Error → TransportError（P1-3 修复：按 smb-0.11.2 error.rs 真实变体核对）。
/// 连接级（触发外层重连一次）：TransportError / ConnectionStopped / InvalidState /
/// NegotiationError / OperationTimeout / IoError（非 NotFound/PermissionDenied kind）。
/// 文件级：NotFound / MissingPermissions / ReceivedErrorMessage 按状态码分派。
fn map_smb_error(e: SmbError) -> TransportError {
    match &e {
        SmbError::TransportError(_) | SmbError::ConnectionStopped
        | SmbError::InvalidState(_) | SmbError::NegotiationError(_)
        | SmbError::OperationTimeout(_, _) => TransportError::Disconnected,
        SmbError::IoError(io) => match io.kind() {
            std::io::ErrorKind::NotFound => TransportError::FileNotFound(io.to_string()),
            std::io::ErrorKind::PermissionDenied => TransportError::PermissionDenied(io.to_string()),
            _ => TransportError::Io(io.to_string()),
        },
        SmbError::NotFound(p) => TransportError::FileNotFound(p.clone()),
        SmbError::MissingPermissions(p) => TransportError::PermissionDenied(p.clone()),
        // 实际签名 ReceivedErrorMessage(u32, ErrorResponse)——Status::U32_* 是 u32 常量，
        // 用 guard 比较（非枚举 match）；分派逻辑独立成纯函数供单测锁死
        SmbError::ReceivedErrorMessage(code, _) => map_status_code(*code, e.to_string()),
        _ => TransportError::Other(e.to_string()),
    }
}

/// NT 状态码 u32 → TransportError（纯函数，可全常量覆盖测试）。
/// 常量名以 smb-msg 实际导出为准（编译期裁决：缺的常量删除对应臂，落 Other 兜底）。
fn map_status_code(code: u32, ctx: String) -> TransportError {
    use smb::msg::Status as S;
    match code {
        c if c == S::U32_OBJECT_NAME_NOT_FOUND || c == S::U32_OBJECT_PATH_NOT_FOUND => {
            TransportError::FileNotFound(ctx)
        }
        c if c == S::U32_ACCESS_DENIED => TransportError::PermissionDenied(ctx),
        c if c == S::U32_NETWORK_NAME_DELETED
            || c == S::U32_CONNECTION_DISCONNECTED
            || c == S::U32_SESSION_EXPIRED
            || c == S::U32_USER_SESSION_DELETED => TransportError::Disconnected,
        _ => TransportError::Other(ctx),
    }
}

/// FileIdBothDirectoryInformation 公共字段（file_name/attributes/end_of_file/last_write_time）
/// 的中立抽取——避开 source.rs 直接依赖 smb-fscc 类型。
fn to_raw(info: &smb_fscc::FileIdBothDirectoryInformation) -> RawDirEntry {
    RawDirEntry {
        name: info.file_name.clone(),
        is_directory: info.attributes.directory(),
        size: info.end_of_file,
        modified_unix_secs: super::transport::file_time_to_unix_secs(info.last_write_time.date_time_unix_100ns())
            .unwrap_or(0),
    }
}

#[async_trait::async_trait]
impl SmbTransport for SmbClientTransport {
    async fn connect(&self, params: &ConnectParams) -> Result<(), TransportError> {
        // P1-2 修复：smb crate 的端口经 server 字符串承载——TransportUtils::parse_socket_address
        // 对无 ':' 的 endpoint 补 ":0" 后由 TcpTransport::default_port() 落到 445；
        // 非 445 端口必须显式拼 "host:port"（已核对 smb-transport utils.rs/tcp.rs 源码）。
        let server = if params.port == 445 {
            params.host.clone()
        } else {
            format!("{}:{}", params.host, params.port)
        };
        let unc = UncPath::new(&server)
            .and_then(|u| u.with_share(&params.share))
            .map_err(|e| TransportError::InvalidPath(e.to_string()))?;
        self.client
            .share_connect(
                &unc,
                params.username.as_deref().unwrap_or("guest"),
                params.password.clone().unwrap_or_default(),
            )
            .await
            .map_err(map_smb_error)?;
        self.share_root.set(unc).ok(); // 幂等：重复 connect 保留首个
        Ok(())
    }

    async fn list(&self, rel: &str) -> Result<Vec<RawDirEntry>, TransportError> {
        use futures_util::StreamExt;
        let tree = self.tree().await?;
        let unc_rel = rel.replace('/', "\\");
        let resource: Resource = tree
            .open_existing(&unc_rel, Self::access())
            .await
            .map_err(map_smb_error)?;
        let dir = Arc::new(resource.unwrap_dir());
        let mut stream =
            smb::resource::Directory::query::<smb_fscc::FileIdBothDirectoryInformation>(&dir, "*")
                .await
                .map_err(map_smb_error)?;
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            let info = item.map_err(map_smb_error)?;
            // "." / ".." 由 SMB 服务器语义不返回（FSCC）；空名防御跳过
            if info.file_name.is_empty() {
                continue;
            }
            out.push(to_raw(&info));
        }
        Ok(out)
    }

    async fn read_block_exact(&self, rel: &str, offset: u64, buf: &mut [u8]) -> Result<(), TransportError> {
        let tree = self.tree().await?;
        let resource = tree
            .open_existing(&rel.replace('/', "\\"), Self::access())
            .await
            .map_err(map_smb_error)?;
        let file = resource.unwrap_file();
        // read_block 短读语义（返回实读数，EOF=0）→ 循环填满；EOF 早到=文件变小 → Disconnected
        // 触发外层重连一次兜底（spec §3.1 强契约：请求区间必须恰好）
        let mut filled = 0usize;
        while filled < buf.len() {
            let got = file
                .read_block(&mut buf[filled..], offset + filled as u64, None, false)
                .await
                .map_err(|e| TransportError::Io(e.to_string()))?;
            if got == 0 {
                return Err(TransportError::Disconnected);
            }
            filled += got;
        }
        Ok(())
    }

    async fn stat(&self, rel: &str) -> Result<RawStat, TransportError> {
        let tree = self.tree().await?;
        let resource = tree
            .open_existing(&rel.replace('/', "\\"), Self::access())
            .await
            .map_err(map_smb_error)?;
        // query_info::<FileStandardInformation>（end_of_file/last_write_time）；
        // 若 trait bound 不满足（编译期发现），fallback：as_file + end_of_file 字段 + handle.modified()
        let std_info: smb_fscc::FileStandardInformation = resource
            .query_info()
            .await
            .map_err(map_smb_error)?;
        Ok(RawStat {
            size: std_info.end_of_file,
            modified_unix_secs: super::transport::file_time_to_unix_secs(
                std_info.last_write_time.date_time_unix_100ns(),
            ),
        })
    }
}

impl Default for SmbClientTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_classification_variants() {
        // P1-3：可构造变体逐一锁定（网络行为靠 spike/验收）
        assert!(matches!(
            map_smb_error(SmbError::TransportError(smb::transport::TransportError::NotConnected)),
            TransportError::Disconnected));
        assert!(matches!(map_smb_error(SmbError::ConnectionStopped), TransportError::Disconnected));
        assert!(matches!(map_smb_error(SmbError::InvalidState("s".into())), TransportError::Disconnected));
        assert!(matches!(map_smb_error(SmbError::NotFound("x".into())), TransportError::FileNotFound(_)));
        assert!(matches!(map_smb_error(SmbError::MissingPermissions("p".into())), TransportError::PermissionDenied(_)));
        let io_nf = SmbError::IoError(std::io::Error::new(std::io::ErrorKind::NotFound, "nf"));
        assert!(matches!(map_smb_error(io_nf), TransportError::FileNotFound(_)));
    }

    #[test]
    fn status_code_dispatch_full_coverage() {
        // map_status_code 纯函数：状态码分派全锁定（u32 直构，零网络）
        use smb::msg::Status as S;
        assert!(matches!(map_status_code(S::U32_OBJECT_NAME_NOT_FOUND, "c".into()), TransportError::FileNotFound(_)));
        assert!(matches!(map_status_code(S::U32_OBJECT_PATH_NOT_FOUND, "c".into()), TransportError::FileNotFound(_)));
        assert!(matches!(map_status_code(S::U32_ACCESS_DENIED, "c".into()), TransportError::PermissionDenied(_)));
        assert!(matches!(map_status_code(S::U32_CONNECTION_DISCONNECTED, "c".into()), TransportError::Disconnected));
        assert!(matches!(map_status_code(S::U32_SESSION_EXPIRED, "c".into()), TransportError::Disconnected));
        assert!(matches!(map_status_code(0xC000_0001, "c".into()), TransportError::Other(_))); // 未知码兜底
    }
}
```

**执行期已知不确定点（编译时以编译器为准微调，不改变设计）：**
1. `info.last_write_time.date_time_unix_100ns()`——FileTime 的公开方法只有 `date_time()`/`is_zero()`/`since_epoch()`（已核对）。**用 `since_epoch()`（相对 1601 的 Duration）或 `date_time().assume_utc().unix_timestamp()` 换算**，实现时二选一（前者纯整数）：
   ```rust
   // 首选（纯整数）：
   let dt = info.last_write_time.since_epoch().as_nanos() as u64 / 100; // 100ns
   ```
   `to_raw`/`stat` 内统一走一个小 helper `fn ft_100ns(ft: &smb_dtyp::FileTime) -> u64`。
2. `AccessMask` vs `FileAccessMask` 的导入路径（`Tree::open_existing` 参数类型为准）。
3. `query_info::<T>()` 的 trait bound；不满足则 stat 改 `resource.as_file()` + `GetLen` + `handle.modified().assume_utc().unix_timestamp()`。
4. `smb::resource::Directory::query` 的模块路径（`smb::resource::directory::Directory` re-export 形态以编译器为准）。
5. `Status::U32_*` 常量名以 `smb-msg` 实际导出为准（U32_OBJECT_NAME_NOT_FOUND 等；缺的变体删除对应 match 臂即可，分类兜底走 `Other`）。
6. `smb` crate 的 feature：`Cargo.toml` 的 `smb = "0.11"` 默认 feature 是否含 `async`（`query` 带 `#[cfg(feature = "async")]`）——若默认无 async，改 `smb = { version = "0.11", features = ["async"] }`。**先查 `smb-0.11.2/Cargo.toml` 的 `[features] default` 再定**。
7. `futures_util` 依赖：`Cargo.toml` 若无则加（StreamExt 消费 QueryDirectoryStream 必需）。

- [ ] **步骤 2：`cargo check -j 2` 通过（含上述微调落地）+ `cargo test -j 2 error_classification` PASS**

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/source/smb/real_transport.rs src-tauri/Cargo.toml
git commit -m "feat(smb): SmbClientTransport 真实接线——share_connect/get_tree/query/read_block 循环/错误分类映射"
```

---

### 任务 7：test_connection 真握手 + 跨卷放开 + i18n

**文件：**
- 修改：`src-tauri/src/commands/accounts.rs`（test_connection_impl smb 分支）
- 修改：`src-tauri/src/commands/find_next_volume.rs`（listing_kind）
- 修改：`src/locales/zh-CN.ts` / `src/locales/en-US.ts`
- 修改：`src/views/Accounts.vue`（test 失败原因 toast——现有 testResult 布尔扩展错误字符串）

- [ ] **步骤 1：写失败测试（find_next_volume tests 追加；accounts tests 改 smb 用例）**

```rust
    // find_next_volume.rs tests 内：
    #[test]
    fn listing_kind_accepts_smb_after_m2() {
        let smb = SourceDescriptor::Smb { account_id: 1, initial_path: "s".into(), path: "v1".into(), port: 445 };
        assert!(listing_kind(&smb).is_ok(), "M2 放开 SMB 跨卷");
    }
```

（原 `smb_descriptor_returns_err` 用例删除或改 Archive-only——`listing_kind_accepts_local_and_webdav_rejects_smb_archive` 拆两半：SMB 移入本用例，Archive 保留拒绝断言。）

accounts.rs tests 的 `test_connection_smb_not_implemented_yet` 改为：smb 账户 + mock factory 下 `test_connection_impl` 走到 factory.resolve().test() 路径（真实握手不可测——断言不再返回「尚未实装」固定错误）：

```rust
    #[tokio::test]
    async fn test_connection_smb_rejects_missing_share_without_network() {
        // 建议 1 修复：不用生产 factory 打真实 IP（CI 不稳定）——走配置错误路径
        // （share 缺失在 resolve_params 前置校验，零网络）断言错误语义
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "smb".into(), host: Some("192.168.1.1".into()),
            port: Some(445), share: None, username: None, password: None }).unwrap();
        let factory = crate::source::MediaSourceFactory::new(
            db.clone(), std::sync::Arc::new(crate::credentials::MemoryStore::new()));
        let r = test_connection_impl(&db, &factory, id).await;
        assert!(r.is_err());
        let msg = r.unwrap_err();
        assert!(msg.contains("share") || msg.contains("共享"), "配置错误语义: {msg}");
        assert!(!msg.contains("尚未实装"), "M2 后不再有未实装占位错误");
    }

    #[tokio::test]
    async fn test_connection_smb_rejects_out_of_range_port() {
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "smb".into(), host: Some("192.168.1.1".into()),
            port: Some(99999), share: Some("media".into()), username: None, password: None }).unwrap();
        let factory = crate::source::MediaSourceFactory::new(
            db.clone(), std::sync::Arc::new(crate::credentials::MemoryStore::new()));
        let r = test_connection_impl(&db, &factory, id).await;
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("端口"), "端口越界被拒绝而非静默忽略");
    }
```

- [ ] **步骤 2：`cargo test -j 2 listing_kind` / `test_connection` → FAIL（用例更新后）**

- [ ] **步骤 3：实现**

accounts.rs test_connection_impl：

```rust
        "smb" => {
            let host = host.ok_or("smb 账户缺少 host")?;
            let share = _share.clone().ok_or("smb 账户缺少 share（固定共享根必填）")?;
            let initial = share; // test 用 share 根做 initial_path
            // P1-2：port 用账户行值（此前硬编码 445）；port 越界在 resolve_params 校验
            let port = _port.unwrap_or(445) as i32;
            let d = crate::source::descriptor::SourceDescriptor::Smb {
                account_id: id, initial_path: initial, path: String::new(), port,
            };
            factory.resolve(&d).test(&d).await
                .map(|_| true).map_err(|e| e.to_string())
        }
```

（impl 内变量名改 `share`/`_port`——SELECT 已取 type/host，需加 port、share 两列。）

find_next_volume.rs：

```rust
fn listing_kind(d: &SourceDescriptor) -> Result<(), String> {
    match d {
        SourceDescriptor::Local { .. } | SourceDescriptor::WebDav { .. } | SourceDescriptor::Smb { .. } => Ok(()),
        _ => Err("跨卷当前仅支持 Local / WebDAV / SMB 源（Archive 无跨卷语义——包即整书）".into()),
    }
}
```

i18n（双语同步，accounts 段）：

```
accounts.testFailNetwork: 网络错误（检查地址/网络） / Network error (check address/network)
accounts.testFailAuth: 认证失败（检查用户名/密码） / Authentication failed (check credentials)
accounts.testFailConfig: 配置错误（缺少 share 或路径契约不符） / Configuration error (missing share or path contract)
```

Accounts.vue：`test()` catch 存错误信息，`testResult` 值由 boolean 扩展为 `{ ok: boolean; message?: string }`——按 e.to_string() 含「权限/认证/Auth/credential」→ testFailAuth、含「share/契约/配置」→ testFailConfig、其余 → testFailNetwork 的简单映射展示；toast/行内文案用对应 key。（实现保持轻：三态字符串 match，不引后端错误码——后端文案已人话。）

- [ ] **步骤 4：`cargo test -j 2 find_next_volume`（44 用例）+ `npx vitest run src/views/Accounts.test.ts` → PASS**

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/commands/accounts.rs src-tauri/src/commands/find_next_volume.rs src/views/Accounts.vue src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(smb): test_connection 真握手 + 跨卷放开 Smb + testFail 三态 i18n"
```

---

### 任务 8：全量验证 + 手测清单 + 收尾

**文件：**
- 修改：`AGENTS.md`（状态表加 3.3.0 行）/ `DESIGN.md` §16.1（SMB 条目划掉）

- [ ] **步骤 1：全量自动化**

```bash
npm run type-check                 # 0 error
npx vitest run                     # 全绿（基线 1122+）
cd src-tauri && cargo test -j 2    # 全绿（基线 375+）
```

- [ ] **步骤 2：本地手测（spec M2 §8 六项，`npm run tauri:dev`）**

1. 添加、测试 SMB 账户（密码落 keyring 不落库；Windows 凭据管理器目检 `smb-{id}`）
2. 浏览 SMB 目录（details + masonry 两视图；缩略图走 M1 取源链）
3. 阅读 SMB 图片目录（三模式 + 跨卷含跳已读 + 书签/进度/历史/喜欢/快捷方式）
4. Range 206/416（devtools 构造 fetch）
5. 断网恢复（拔网线 → 报错 → 恢复 → 重连一次成功继续读）
6. 预读预载复验（翻页后 3 张 LRU 命中；devtools network 看 warm）

- [ ] **步骤 3：状态表 + tag（打 tag 前 `git fetch github main` 复核 racyan 占号）**

```bash
git add AGENTS.md DESIGN.md
git commit -m "docs: 状态表补 module3.3.0-smb（M2 SMB 协议层）"
git tag v0.1.0-module3.3.0-smb
git push github main && git push github v0.1.0-module3.3.0-smb
git push origin main --tags
```

---

## 自检记录

- **规格覆盖度**：spec §2 spike（任务 0）、§3 连接管理器全部设计点（任务 4：TTL 懒清理/凭据连接期缓存由 factory 语义天然承载/UNC 拼接任务 2/契约双侧任务 2+4/重连任务 4）、§4 五方法（任务 5）、§5 接线表三行（任务 5 factory / 任务 7 test_connection+跨卷；warm 零改动已注明）、§6 i18n 三态（任务 7）、§7 测试策略逐条（任务 1-7 各 tests 模块 + spike + 手测）、§8 验收（任务 8）、§10 交付清单（文件结构节）——全覆盖。
- **占位符扫描**：无「待定/TODO/后续实现」；任务 6 的「执行期不确定点」7 条均为**编译器裁决的具体指令**（含备选写法），非占位——每条给了确定的处理动作。
- **类型一致性**：`TransportError`（任务 1 定义，2/3/4/5/6 使用）、`SmbTransport`/`RawDirEntry`/`RawStat`/`ConnectParams`（任务 1 定义，3/4/5/6 使用）、`TransportFactory`（任务 4 定义，5 复用）、`SmbConnectionManager::new/new_production`（任务 4 定义，任务 5 factory 使用）、`map_smb_error`（任务 6 内闭用）——签名一致。
- **与 M1 代码库的接线事实**：factory::new(db, creds) 现签名（M1 任务 4）、Db Clone（M1）、CredentialStore/account_key（M1 任务 2）、`Cargo.toml` smb 依赖已存在（0.11 注释已启用）——均已核对。

## 附：计划审查修订记录（rev2，2026-08-19）

外部审查 1 P0 + 3 P1 + 3 建议全采纳（每条先经本地 registry 源码/计划复核再修）：

1. **P0 路径契约**：`validated_rel` 漏拼 `initial_path` 属实——重写为「方法 path = 相对 initial_path 入口的完整路径（对齐 WebDAV 忽略 descriptor.path 的参数语义），transport rel = initial_path + path（相对 share）」；`extract` 改二元组；补深层入口根/子目录/读文件三回归用例；既有用例 script key 全部补 `media/` 前缀。
2. **P1 MutexGuard 跨 await**：`get_or_connect` 重写两阶段（锁内查/回收→释放建连→短锁写回）；并发去重策略=后到者复用先到者（各自建连、slot 单份）+ 并发用例。
3. **P1 端口静默忽略**：核实 smb-transport 源码——`TransportUtils::parse_socket_address` 对无 `:` endpoint 补 `:0` 走 `TcpTransport::default_port()=445`，**server 字符串承载端口**（`host:port` 形态过 `check_no_separators`）——修法为非 445 拼 `format!("{host}:{port}")`（crate 支持，不需拒绝）；`resolve_params` 加端口 1-65535 校验；test_connection 用账户行 port（删硬编码）；spike 补自定义端口验证点。
4. **P1 错误映射假设错误**：核实 error.rs——实际 `ReceivedErrorMessage(u32, ErrorResponse)`（`Status::U32_*` 是 u32 常量，用 guard 比较非枚举 match）；映射表按真实变体重写，`ConnectionStopped`/`InvalidState`/`NegotiationError` 归连接级、`MissingPermissions`→PermissionDenied；状态码分派独立纯函数 `map_status_code(u32)` 全常量锁定测试；「编译器提示后删 match 臂」降级为缺常量时的兜底手段而非常规策略。
5. **建议**：test_connection 测试改零网络路径（share 缺失/端口越界两用例，不打真实 IP）；spike 补深层 initialPath 验证点；read_file 全量 `usize::try_from` + 256MB 钳制（`MAX_SMB_READ_BYTES`）。

## 附：执行顺序依赖

任务 0（spike）可与其他任务并行或后置（不阻塞编译链）；任务 1→2→3→4→5 严格顺序（类型依赖）；任务 6 依赖 4（real_factory 引用）；任务 7 依赖 5；任务 8 收尾。全部任务完成后 M2 交付。
