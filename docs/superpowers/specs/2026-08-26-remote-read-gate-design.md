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
media:// GET ──┐                     ┌─ RemoteGate（全局共享，Arc 注入两个 MediaSource）
warm 预读 ─────┼→ read_file ──过闸──→│  ① 并发 permit（8）——发请求前拿
缩略图远取 ────┤   (webdav/smb)      │  ② 字节 permit（512 MiB 预算，载荷 ×2 保守记账）——响应头后按 CL 拿
materializer ──┘                     └─ 两类 permit 随 RAII 同时释放
                ↑
      media path singleflight（media_cache::fetch_remote_to_cache）
      ——仅 media:// miss 与 warm 两条路径，缩略图/物化各已有去重，不接
```

闸门下沉在两个 `read_file` impl 内部：四条通道全部汇入该入口（已核对：`lib.rs:322`、`warm.rs:74`、`service.rs:504`、`materializer.rs:1078`），零调用方改动，未来新增调用点天然覆盖。无嵌套锁（双闸一次 `tokio::join!` 风格获取），materializer 串行逐块持有一对 permit，无自锁。

## 5. RemoteGate 两阶段 API（用户定死，不可变）

WebDAV 完整读取在**发 GET 前不知道 `Content-Length`**。因此闸门拆两阶段——否则"等响应头才入闸"会留下最多 8 条未计入预算的 WebDAV 连接，正好削弱处理网络压力的目标：

1. **请求开始前先拿并发 permit**（限制连接/请求数）。
2. **收到响应头后**，按 `Content-Length` 拿字节 permit；**无长度头则按 256 MiB 载荷保守预留**（×2 记账即 512 MiB）；`Content-Length > 256 MiB` 立即拒绝。
3. **流读取结束、出错或取消时同时释放两类 permit**（RAII drop，错误路径天然覆盖）。

```rust
// src-tauri/src/source/remote_gate.rs（新模块）
pub struct RemoteGate {
    permits: Arc<tokio::sync::Semaphore>, // 并发，初始 8
    bytes: Arc<tokio::sync::Semaphore>,   // 在途字节预算，初始 512 MiB（×2 保守记账口径）
}

pub struct RemotePermit {
    bytes: Arc<tokio::sync::Semaphore>,     // gate 内部 Arc 的 clone
    _conn: tokio::sync::OwnedSemaphorePermit,
}

impl RemoteGate {
    /// OnceLock<Arc<RemoteGate>>，对齐 media_cache::global() 先例。
    pub fn global_arc() -> Arc<RemoteGate>;
    /// 阶段①：只拿并发 permit；默认 GATE_ACQUIRE_TIMEOUT(30s) 内拿不到 → Err（UI 排队有界）。
    pub async fn enter(&self) -> Result<RemotePermit, MediaSourceError>;
    pub async fn enter_timeout(&self, d: Duration) -> Result<RemotePermit, MediaSourceError>;
    pub fn new(concurrency: usize, bytes: usize) -> Self; // pub：生产 factory 与测试共用
}

impl RemotePermit {
    /// 阶段②：响应头后拿字节 permit（acquire_many_owned）。
    /// 参数是**记账值**（载荷 ×2，见下）；同样受 GATE_ACQUIRE_TIMEOUT 约束。
    /// semaphore 关闭视为错误（与 thumbnail actor 同处理）。
    pub async fn reserve_bytes(&self, accounted: u32) -> Result<ByteReservation, MediaSourceError>;
}
```

- **注入而非替换全局**（P1 修复）：`WebDavMediaSource::new` 与 `SmbMediaSource::new` 增加 `gate: Arc<RemoteGate>` 参数，生产 factory 传 `RemoteGate::global_arc()`，测试构造传 `RemoteGate::new(小闸值)`——测试不触碰全局单例，并行测试不串扰。
- **字节预算是"网络载荷 ×2"的保守记账口径**（P1 修复）：一次完整读取存在源 `Vec`、LRU 副本、响应 `Vec` 三类生命周期，峰值内存 ≈ 3× 载荷。预算按 2× 载荷预扣后，512 MiB 预算下最坏峰值内存 ≈ 3/2 × 预算 = 768 MiB；两条 256 MiB 载荷读取不可能并存（一条即占满 512 记账）。SMB 同口径（`total × 2`）。
- **闸门等待有界**（P2 修复）：两阶段 acquire 均带 30s 上限，超时返回 `Network("远程读取闸门繁忙")`——单个卡死读取最多拖累后来者 30s，不会无限排队。permit **持有**时长由各协议自身超时界定（WebDAV per-request 30s × 重试 2；SMB 见 §7 读取超时）。
- SMB 侧无"响应头"概念：`enter()` 与 `reserve_bytes(total × 2)` 在读前一次性完成（total 已由 stat/Range length 得出，`smb/source.rs:99-113` 现成）。
- 字节 permit 是 `acquire_many_owned`（u32；256×2 = 512 MiB 在 u32 范围内）。
- 过闸等待不做日志（高频路径）；**拒绝/闸超时**记 WARN 日志。

## 6. WebDAV 接入（webdav_impl.rs）

### 6.1 Client 复用

- 按 `accept_invalid_tls` 缓存至多 **2 个全局 `Client`**（`OnceLock<Client>` 两个 static）：client 构造只依赖 bad_tls + `connect_timeout(10s)` + `pool_idle_timeout(300s)`。
- **basic_auth 是 per-request header，凭据/账户编辑不影响 client** → 不需要账户失效钩子，`accounts.rs` 零改动。
- 现有 10/15/30s 差异改 `RequestBuilder::timeout(d)` per-request 保留原语义；client 不带总超时。
- `send_retry_once` 两次 attempt 用**同一** pooled client（hyper 对报错连接自动摘池，"换新连接重试"的意图保留，还省一次握手）。

### 6.2 read_file 两阶段过闸 + 响应上限

```
let _conn = self.gate.enter().await?;                     // ① 发请求前
let resp = send_retry_once(...).await?;                  //   重试共用同一 permit
let cap = WEBDAV_MAX_RESPONSE;                           //   256 MiB
let cl = resp.headers().content_length();
if cl.is_some_and(|c| c as usize > cap) {
    return Err(Network("WebDAV 响应超过上限 …"));        //   立即拒绝
}
let accounted = cl.map_or(cap * 2, |c| c as usize * 2);  //   ×2 保守记账；无 CL → 512 MiB 整预算
let _bytes = _conn.reserve_bytes(accounted as u32).await?;
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
let _conn = self.gate.enter().await?;                    // ①
let _bytes = _conn.reserve_bytes(total as u32 * 2).await?; // ② total = stat size / range length，×2 记账
let fut = self.manager.read_block_exact(...);
let out = tokio::time::timeout(SMB_READ_TIMEOUT, fut).await; // 60s 项目级读取超时
match out {
    Ok(r) => r.map_err(Self::transport_err),
    Err(_elapsed) => {
        self.manager.invalidate(account_id);             // 摘槽，下次重连（复用连接级错误恢复路径）
        Err(Network("SMB 读取超时"))
    }
}
```

- `SmbMediaSource::new(manager, gate: Arc<RemoteGate>)`——构造注入（§5）。
- **读取超时 + 摘槽**（P2 修复）：smb 库默认超时不可依赖；超时后该账户 transport 状态未知，直接走 `manager` 已有的 `evict` 摘槽路径（`connection.rs:162`，对齐"连接级错误 → 剔除重建重试一次"），不留脏连接给后续请求。
- stat / list_directory 不过闸、不加读超时（维持 §3 边界；列目录走 SMB 库自身行为）。

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

- 在途注册表：`OnceLock<Mutex<HashMap<String, Arc<tokio::sync::watch::Sender<FetchOutcome>>>>>`，`FetchOutcome = Pending | Done | Failed`。
- **唤醒协议（P1 修复，watch 值语义防丢唤醒）**：不用 `Notify`（edge 语义有"owner 在 waiter 注册前完成"的丢唤醒窗口，且 `Notified` future 借用 `Arc<Notify>` 跨作用域存续在 Rust 里立不住）。owner 建通道存 `Sender`；完成时 `send(Done/Failed)` 后持注册表锁摘除条目（先 send 后摘，任意时序对 waiter 均安全）。waiter 在注册表锁内 `tx.subscribe()` 拿 `Receiver`——watch 是**值语义**：owner 即便早已 send，waiter 的 `borrow()` 也能读到终态，不存在错过；未终态则 `changed().await` 等变更。循环复查消化 owner 失败与 clear：

```rust
// waiter
loop {
    let rx = {
        let m = registry.lock().unwrap();
        match m.get(media_path) {
            None => break,                       // 无在途 → 直接查 LRU
            Some(tx) => tx.subscribe(),          // 锁内订阅；owner 先 send 后摘条目，两序皆安全
        }
    };
    loop {
        match *rx.borrow() {
            FetchOutcome::Pending => { if rx.changed().await.is_err() { break } } // sender 全 drop：防御性退出内层
            FetchOutcome::Done | FetchOutcome::Failed => break,
        }
    }
    // 复查注册表：条目已摘 → 退出外层查 LRU；仍在（防御）→ 重走循环
    if !registry.lock().unwrap().contains_key(media_path) { break }
}
// 循环退出后：LRU 命中 → Ok(())；miss → Err（owner Failed / 或 generation 变更后 clear）
```

- owner 完成路径：下载成功 → `put_if_generation`（§8.1）成功 `send(Done)`、generation 不匹配同样走 `send(Failed)`；下载失败直接 `send(Failed)`；两者最后持锁摘条目。

- **media:// handler**（`lib.rs:322-329` miss 分支）与 **warm**（`warm.rs:55-88` `read_and_cache_media`）改调本函数。
- 可测性：内部拆 `_with(fetch: impl FnOnce(...) -> ...Future)` 参数化版本，生产包装走 `read_file`，测试注入计数闭包（§11.3）。
- 直接消掉：warm 叠加批次的重复下载（不同批次同图共享一份）、WebView GET + warm 同图双下载。

### 8.1 media_cache generation 守卫（P1 修复，取代原"clear_all 兜底"论证）

原论证"账户变更由 `clear_all()` 兜底"**不成立**：账户更新/删除时，旧请求可能已在途；`clear_all()` 后它继续完成并 `put`，会把旧账户内容重新写进同一 `media_path`。修复：

- `MediaLru` 增加 `generation: u64`（随既有 `Mutex` 保护，无新锁）。
- `clear_all()` 递增 generation（`accounts.rs:121/138/179` 三处调用点不变）。
- 新增 `put_if_generation(key, media, expected_gen) -> bool`：**在同一临界区内**比较并插入——与 `clear_all()` 的递增互斥，封死"检查后、写入前被 clear"的窗口。
- singleflight owner 在**下载启动前**捕获 generation，完成后 `put_if_generation`；不匹配 → 丢弃结果、摘条目、按失败唤醒 waiter（waiter 查 LRU miss → Err）。
- waiter 失败语义：Err，不自动重试——media:// 回 502，warm 静默；用户的下一次请求会以新 generation 重新取数。

### 8.2 warm 契约变更（显式声明）

原 rev8 契约"warm 在写 LRU 前做会话双检查"取消——统一函数按 §8.1 的 generation 守卫入 LRU（会话检查防的"陈旧内容进缓存"由 generation 承担，且语义更准：防的是**账户变更**导致的同路径异内容，而非换书）。LRU 按 media path 内容寻址（path 编码 descriptor + 文件路径）。warm 保留**启动前**会话检查（rev8 前半）。`warm.rs` 注释同步改写。

## 9. 常量表（代码常量起步，对齐 thumbnail actor 先例）

| 常量 | 值 | 位置 |
|---|---|---|
| `REMOTE_GATE_CONCURRENCY` | 8 | remote_gate.rs |
| `REMOTE_GATE_BYTES` | 512 MiB（**记账口径**：载荷 ×2，见 §5；最坏峰值内存 ≈ 768 MiB） | remote_gate.rs |
| `REMOTE_GATE_ACCOUNT_MULTIPLIER` | 2 | remote_gate.rs / 调用点 |
| `GATE_ACQUIRE_TIMEOUT` | 30s（两阶段 acquire 均适用） | remote_gate.rs |
| `WEBDAV_MAX_RESPONSE` | 256 MiB（对齐 `MAX_SMB_READ_BYTES` 与 media LRU） | webdav_impl.rs |
| `PROPFIND_MAX_RESPONSE` | 32 MiB | webdav_impl.rs |
| 无 CL 保守预留 | 2 × `WEBDAV_MAX_RESPONSE` = 整预算 | webdav_impl.rs |
| `SMB_READ_TIMEOUT` | 60s（超时摘槽重连） | smb/source.rs |
| `connect_timeout` | 10s | 共享 client |
| `pool_idle_timeout` | 300s | 共享 client |

## 10. 错误语义

- 超响应上限 / 流式累计超限：`MediaSourceError::Network("WebDAV 响应超过上限 N 字节")`（对齐 SMB `:115` "读取超过上限"句式）→ media:// 层映 502。
- semaphore 关闭（进程退出竞态）：按错误返回，与 thumbnail actor 同处理。
- singleflight waiter 等 owner 失败：Err → media:// 502 / warm 静默（维持"warm 是优化不是承诺"）。

## 11. 测试计划（TDD，先写测试）

Rust 单测：

1. `read_body_capped` / 累加核心（抽成接受 chunk 流的纯异步函数，`futures::stream::iter` mock）：空 body / 恰好等长 / 流中超 cap 断开 / CL 预检（有 CL 且超 cap、无 CL）。
2. `RemoteGate`：第 9 个 `enter()` 等待（前 8 个未释放）；字节预算耗尽阻塞 `reserve_bytes`（×2 记账断言：载荷 100 MiB 预扣 200 MiB）；drop 后 permit 归还；两阶段独立释放；`enter_timeout` 小值注入超时返回 Err。
3. singleflight：并发两个同 path `fetch_remote_to_cache`，注入计数 fetch 闭包只调 1 次；owner 失败时 waiter 得 Err；不同 path 各自下载；owner 完成后新调用直接 LRU 命中不再下载。
4. generation 守卫：owner 在途期间 `clear_all()` → 结果被丢弃（LRU 无该 key）、waiter 得 Err；`put_if_generation` 与 `clear_all` 临界区互斥（并发压力下无旧代写入，逻辑断言 generation 单调）。
5. client 复用：`shared_client(bad_tls)` 两次调用 `std::ptr::eq` 同实例；strict/bad_tls 两实例不同。
6. SMB 过闸 + 读超时：`RemoteGate::new(1, …)` 注入 `SmbMediaSource`，mock transport 延迟钩子下两并发 read_file 断言 transport 观测最大并发 = 1；mock transport 挂起钩子 + 小超时注入断言返回超时错误且账户槽被摘（下次调用重连）。

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
- **峰值内存界定**：预算是 ×2 记账口径的网络载荷预算，非精确内存预算；最坏峰值 ≈ 3× 单载荷 ≤ 768 MiB（单载荷 ≤ 256 MiB 被响应上限封死、且两条 256 MiB 载荷不能并存）。真实图片（几十 MB 级）下典型峰值 ≈ 预算 × 1.5 远达不到。
- **无 CL 响应的 512 MiB 预留**占满整预算——有意保守；真实图片 GET 几乎都有 CL（HEAD/stat 已要求 CL 存在），materializer Range 块 CL 恒为 4 MiB×2。
- **permit 持有时长有界**：WebDAV 由 per-request timeout（30s × 2 attempts）+ connect_timeout 界定；SMB 由 `SMB_READ_TIMEOUT` 界定（超时摘槽）；acquire 排队由 `GATE_ACQUIRE_TIMEOUT` 界定——三级超时链下无永久占位路径。
- **重试期间 permit 持有**：一次 read_file 一个并发 permit（含重试两 attempt），语义为"一个读取任务一个槽"，无泄漏。
- **测试隔离**：所有闸门相关测试用 `RemoteGate::new` 注入，不触碰 `global_arc` 单例——并行测试不串扰。
