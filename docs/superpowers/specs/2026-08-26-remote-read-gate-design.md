# 远程读取总闸门与 WebDAV 连接复用设计（remote read gate）

- 日期：2026-08-26
- 状态：待用户审查
- 范围：Rust 后端（`src-tauri/`）；前端零改动
- 前置审查：用户对 WebDAV/SMB 阅读链路的并发与内存压力审查（2026-08-26，会话内逐行核对确认）

## 1. 背景与问题

用户审查 + 代码核对确认的风险点（引用行为核对过的现场）：

1. **WebDAV 每请求新建 `reqwest::Client`**（`webdav_impl.rs:80-100` `send_retry_once` 每次 attempt `build_client`）——无连接池复用、无 `connect_timeout`；每张图一次完整 TCP+TLS 握手，重试也换全新连接。
2. **`read_file` 无上限整图聚合**（`webdav_impl.rs:422-430`）——`resp.bytes()` 后再 `to_vec()`，无 SMB 那样的 256 MiB 单次上限；裸露的正是无 Range 全图路径（warm / 缩略图远取 / media:// 无 Range GET），瞬时持有约 3 倍文件大小（reqwest 缓冲 + `to_vec` + LRU `clone`）。
3. **多条独立预读通道无总协调**——warm 叠加批次（`warmGen` 只在换书递增，同书内连翻 N 页 = N 组各最多 4 任务，去重 HashSet 每次调用局部，并发上不封顶）+ WebView 自身 media:// GET 与 warm 同图双下载（无 singleflight）。
4. **缩略图字节预算事后检查**（`fetch.rs:103-134`）——按目录声明 size 预扣，实际响应在 fetch 完成后才比总预算；且 fetch 闭包走无 Range `read_file`，说谎服务器在检查前已把全量拉进内存。
5. **SMB 相对健康**（`smb/source.rs:99-119` 单读 256 MiB 硬上限 + stat 先行；`connection.rs:42-46` 按账户 5 分钟 TTL 连接复用），但同样无跨通道全局并发限制。

压缩包物化链路限制良好（`materializer.rs:164` CHUNK=4 MiB 逐块检查点、`remote_zip.rs:29-30` 1 MiB 块 + 32 MiB 块缓存），不在本轮范围。

不能仅凭代码断定 `ntoskrnl.exe` 高占用根因，但"每请求新连接 + 无上限并发聚合 + 多通道无总闸"是明确风险，值得先修；验证信号为阅读时的新建连接速率（netstat）。

## 2. 目标

- 一把**全局远程读取闸门**（并发 permit + 在途字节预算双闸），同时覆盖 WebDAV 与 SMB 的 `read_file`，自动约束四条通道：media:// GET、warm 预读、缩略图远取、materializer Range 块。
- WebDAV 按连接池复用 Client，消除每请求握手。
- WebDAV 单响应大小上限（响应头预检 + 流式累加双保险），顺带消除 `bytes()`/`to_vec()` 双缓冲。
- media path 级 singleflight：同路径并发下载只发生一份，warm 与 media:// miss 收敛为同一取数函数。

## 3. 非目标（YAGNI）

- 不动 SMB 库默认超时、不动 SMB stat/列目录（UI 驱动天然串行，不过闸）。
- 不动 media LRU 256 MiB 结构本身。
- 不拆 thumbnail actor 自身的 4 并发 + 64 MiB 双闸（保留为二级限流）。
- 不改 `MediaSource` trait 签名（仍返回 `Vec<u8>`）。
- 不做 PROPFIND 的并发闸（仅加响应上限，见 §6）。

## 4. 架构总览

```
media:// GET ──┐                     ┌─ RemoteGate（全局单例，source/remote_gate.rs）
warm 预读 ─────┼→ read_file ──过闸──→│  ① 并发 permit（8）——发请求前拿
缩略图远取 ────┤   (webdav/smb)      │  ② 字节 permit（512 MiB）——响应头后按 CL 拿
materializer ──┘                     └─ 两类 permit 随 RAII 同时释放
                ↑
      media path singleflight（media_cache::fetch_remote_to_cache）
      ——仅 media:// miss 与 warm 两条路径，缩略图/物化各已有去重，不接
```

闸门下沉在两个 `read_file` impl 内部：四条通道全部汇入该入口（已核对：`lib.rs:322`、`warm.rs:74`、`service.rs:504`、`materializer.rs:1078`），零调用方改动，未来新增调用点天然覆盖。无嵌套锁（双闸一次 `tokio::join!` 风格获取），materializer 串行逐块持有一对 permit，无自锁。

## 5. RemoteGate 两阶段 API（用户定死，不可变）

WebDAV 完整读取在**发 GET 前不知道 `Content-Length`**。因此闸门拆两阶段——否则"等响应头才入闸"会留下最多 8 条未计入预算的 WebDAV 连接，正好削弱处理网络压力的目标：

1. **请求开始前先拿并发 permit**（限制连接/请求数）。
2. **收到响应头后**，按 `Content-Length` 拿字节 permit；**无长度头则按 256 MiB 保守预留**；`Content-Length > 256 MiB` 立即拒绝。
3. **流读取结束、出错或取消时同时释放两类 permit**（RAII drop，错误路径天然覆盖）。

```rust
// src-tauri/src/source/remote_gate.rs（新模块）
pub struct RemoteGate {
    permits: Arc<tokio::sync::Semaphore>, // 并发，初始 8
    bytes: Arc<tokio::sync::Semaphore>,   // 在途字节，初始 512 MiB
}

pub struct RemotePermit {
    bytes: Arc<tokio::sync::Semaphore>,     // gate 内部 Arc 的 clone
    _conn: tokio::sync::OwnedSemaphorePermit,
}

impl RemoteGate {
    pub fn global() -> &'static RemoteGate;          // OnceLock，对齐 media_cache::global() 先例
    pub async fn enter(&self) -> RemotePermit;        // 阶段①：只拿并发 permit
    #[cfg(test)] pub fn new(concurrency: usize, bytes: usize) -> Self; // 小闸值注入测并发上限
}

impl RemotePermit {
    /// 阶段②：响应头后拿字节 permit（acquire_many_owned）。
    /// semaphore 关闭视为错误（与 thumbnail actor 同处理）。
    pub async fn reserve_bytes(&self, n: u32) -> Result<ByteReservation, MediaSourceError>;
}
```

- SMB 侧无"响应头"概念：`enter()` 与 `reserve_bytes(total)` 在读前一次性完成（total 已由 stat/Range length 得出，`smb/source.rs:99-113` 现成）。
- 字节 permit 是 `acquire_many_owned`（u32；256/512 MiB 均在 u32 范围内）。
- 过闸等待不做日志（高频路径）；**拒绝**（超上限）记 WARN 日志。

## 6. WebDAV 接入（webdav_impl.rs）

### 6.1 Client 复用

- 按 `accept_invalid_tls` 缓存至多 **2 个全局 `Client`**（`OnceLock<Client>` 两个 static）：client 构造只依赖 bad_tls + `connect_timeout(10s)` + `pool_idle_timeout(300s)`。
- **basic_auth 是 per-request header，凭据/账户编辑不影响 client** → 不需要账户失效钩子，`accounts.rs` 零改动。
- 现有 10/15/30s 差异改 `RequestBuilder::timeout(d)` per-request 保留原语义；client 不带总超时。
- `send_retry_once` 两次 attempt 用**同一** pooled client（hyper 对报错连接自动摘池，"换新连接重试"的意图保留，还省一次握手）。

### 6.2 read_file 两阶段过闸 + 响应上限

```
let _conn = RemoteGate::global().enter().await;          // ① 发请求前
let resp = send_retry_once(...).await?;                  //   重试共用同一 permit
let cap = WEBDAV_MAX_RESPONSE;                           //   256 MiB
match resp.headers().content_length() {
    Some(cl) if cl as usize > cap => return Err(Network("WebDAV 响应超过上限 …")),  // 立即拒绝
    _ => {}
}
let _bytes = _conn.reserve_bytes(cl.unwrap_or(cap)).await?;  // ② 无 CL → 256 MiB 保守预留
let body = read_body_capped(resp, cap).await?;           //   流式累加，累计超 cap 断开
Ok(body)                                                 //   drop ②①
```

Range GET：CL 应等于 `r.length`（`verify_range_response` 已保恰好等长语义）；超上限拒绝逻辑同一。

### 6.3 流式累加 helper `read_body_capped`

- `resp.chunk()` 循环累加进单个 `Vec<u8>`（按 CL 预分配 capacity），**替换 `resp.bytes()` + `to_vec()` 双缓冲**。
- 双保险：即使 CL 说谎（声明小、实际大），累计超 cap 立即断开报错——同时堵住缩略图"预算事后检查"的说谎服务器路径（fetch 闭包走本 `read_file`）。
- PROPFIND body（`list_directory`/`test`）改用同一 helper，上限 `PROPFIND_MAX_RESPONSE = 32 MiB`（目录 XML 串行 UI 驱动，不接并发闸，仅约束聚合大小，替换现在的 `resp.text()` 无上限）。

### 6.4 stat

`stat()`（HEAD）改用共享 client；不过闸、无 body（响应上限不适用）。

## 7. SMB 接入（smb/source.rs）

`read_file` 在现有 256 MiB 上限检查（`:114-119`）之后、`read_block_exact` 之前：

```
let _conn = RemoteGate::global().enter().await;      // ①
let _bytes = _conn.reserve_bytes(total as u32).await?; // ② total = stat size / range length
read_block_exact(...)
```

stat / list_directory 不过闸（维持 §3 边界）。

## 8. media path singleflight（media_cache.rs）

新增统一取数函数，收敛两段重复的"读源 → put LRU"：

```rust
/// 按(media path)在途去重下载远程媒体并写入 LRU。
/// owner 下载，waiter 等通知后查 LRU：命中→Ok；miss（owner 失败）→Err。
pub async fn fetch_remote_to_cache(
    media_path: &str,                 // singleflight key
    src: Arc<dyn MediaSource>,
    descriptor: &SourceDescriptor,
    file_path: &str,                  // 兼作 mime 派生（file basename → mime_from_name）
) -> std::result::Result<(), ()>;
```

- 在途注册表：`OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>>`；owner 完成后 put LRU → notify_waiters → 摘除条目；失败同样摘除 + 通知（waiter 查 LRU miss 得 Err）。
- **media:// handler**（`lib.rs:322-329` miss 分支）与 **warm**（`warm.rs:55-88` `read_and_cache_media`）改调本函数。
- 可测性：内部拆 `_with(fetch: impl FnOnce(...) -> ...Future)` 参数化版本，生产包装走 `read_file`，测试注入计数闭包（§11.3）。
- 直接消掉：warm 叠加批次的重复下载（不同批次同图共享一份）、WebView GET + warm 同图双下载。

### 8.1 warm 契约变更（显式声明）

原 rev8 契约"warm 在写 LRU 前做会话双检查"取消——统一函数无条件入 LRU。语义安全性论证：LRU 按 media path 内容寻址（path 编码 descriptor + 文件路径），同 path 同内容；账户配置变更会导致同 URL 指向不同内容，该场景已由 `accounts.rs:121/138/179` 的 `media_cache::clear_all()` 兜底。warm 保留**启动前**会话检查（rev8 前半），完成后由 singleflight 决定入缓存。`warm.rs` 注释同步改写。

## 9. 常量表（代码常量起步，对齐 thumbnail actor 先例）

| 常量 | 值 | 位置 |
|---|---|---|
| `REMOTE_GATE_CONCURRENCY` | 8 | remote_gate.rs |
| `REMOTE_GATE_BYTES` | 512 MiB | remote_gate.rs |
| `WEBDAV_MAX_RESPONSE` | 256 MiB（对齐 `MAX_SMB_READ_BYTES` 与 media LRU） | webdav_impl.rs |
| `PROPFIND_MAX_RESPONSE` | 32 MiB | webdav_impl.rs |
| 无 CL 保守预留 | = `WEBDAV_MAX_RESPONSE` | webdav_impl.rs |
| `connect_timeout` | 10s | 共享 client |
| `pool_idle_timeout` | 300s | 共享 client |

## 10. 错误语义

- 超响应上限 / 流式累计超限：`MediaSourceError::Network("WebDAV 响应超过上限 N 字节")`（对齐 SMB `:115` "读取超过上限"句式）→ media:// 层映 502。
- semaphore 关闭（进程退出竞态）：按错误返回，与 thumbnail actor 同处理。
- singleflight waiter 等 owner 失败：Err → media:// 502 / warm 静默（维持"warm 是优化不是承诺"）。

## 11. 测试计划（TDD，先写测试）

Rust 单测：

1. `read_body_capped` / 累加核心（抽成接受 chunk 流的纯异步函数，`futures::stream::iter` mock）：空 body / 恰好等长 / 流中超 cap 断开 / CL 预检（有 CL 且超 cap、无 CL）。
2. `RemoteGate`：第 9 个 `enter()` 等待（前 8 个未释放）；字节预算耗尽阻塞 `reserve_bytes`；drop 后 permit 归还（后续可入）；两阶段独立释放。
3. singleflight：并发两个同 path `fetch_remote_to_cache`，注入计数 fetch 闭包只调 1 次；owner 失败时 waiter 得 Err；不同 path 各自下载。
4. client 复用：`shared_client(bad_tls)` 两次调用 `std::ptr::eq` 同实例；strict/bad_tls 两实例不同。
5. SMB 过闸：mock transport 加延迟钩子，两并发 read_file 断言 transport 观测最大并发 ≤ 闸值（用小闸值注入的 RemoteGate 构造参数化）。

回归：`cargo test` 全绿（现有 webdav parse 测试、warm 相关、12 integration 不回归）；前端 `type-check` + 测试零改动零回归。

## 12. 验收

- 自动化：§11 全绿。
- 实机（用户手测，本环境无 NAS）：① WebDAV 阅读时 netstat 新建连接速率显著下降（连接复用）；② 快速连翻多页时并发下载 ≤ 8、系统内存平稳；③ 缩略图大目录滚动无突发聚合。信号采集方式：阅读期间 `netstat -ano | grep <NAS_ip>` 观察连接数与状态分布。

## 13. 文档同步

- AGENTS.md「当前状态」表新增一行（remote-read-gate）。
- DESIGN.md 对应章节（网络源读取路径）补一段总闸描述。

## 14. 风险与边界

- **permit 泄漏**：全部 RAII（`OwnedSemaphorePermit` / `acquire_many_owned`），无手动 release 路径；panic 时 Drop 兜底。
- **死锁**：闸内无二次入闸（read_file 不递归）；materializer 每块独立 acquire/release；缩略图 actor 自身闸与全局闸是先后关系（actor 闸 → read_file 全局闸）非嵌套持有（actor permit 在 fetch 期间持有，fetch 内部再进全局闸——两层串联限流，等待图无环）。
- **无 CL 响应的 256 MiB 预留**会让单请求占满一半字节预算——有意保守（用户定死）；真实图片 GET 几乎都有 CL（HEAD/stat 已要求 CL 存在）。
- **重试期间 permit 持有**：一次 read_file 一个并发 permit（含重试两 attempt），语义为"一个读取任务一个槽"，无泄漏。
