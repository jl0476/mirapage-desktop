# SMB / 远程媒体访问统一层设计（M1-M3）

> 日期：2026-08-18（rev2：按审查修订——URL codec、stat 接口、Archive 依赖方向、远程缩略图范围、异步协议 API、Range 强契约、缓存策略、keyring 补偿）
> 状态：设计定稿，待审查
> 来源：brainstorming 会话（用户蓝图 + 代码探索整合）+ 用户技术审查 10 条全采纳；DESIGN.md §5 Phase 7/8、§7.7 参考
> 关联：DESIGN.md §16.1「SMB 协议层」条目将随本设计推进划掉

## 0. 背景与事实基线

探索发现的五个存量缺口，本 epic 全部修复：

1. **阅读器全链路 Local-only**：`useReaderBookLoader.ts:126` 对非 Local descriptor 直接抛错；History/Likes/浏览跳转多处 `type !== 'local'` 防御。WebDAV（Phase 8 ✅）协议层通但进不了阅读。
2. **本地 ZIP 是协议层孤儿**：后端 `zip` crate 实现完好（`archive_impl.rs`），但前端从未构造 Archive descriptor——双击 ZIP 进条目列表、ZIP 阅读、ZIP 内图片显示全部不存在。
3. **密码全局不存**：`upsert_account` 把 `encrypted_password` 永远插 NULL（keyring 是注释 stub）。WebDAV 目前只能匿名访问。
4. **缩略图服务 Local-only**（rev2 修正事实基线）：`thumbnail/service.rs:476` 非 Local descriptor 直接返回 `unsupported`（525/550/679 三处）；`MasonryView.vue:181` 原图 URL 用 `convertFileSrc` 拼本地绝对路径。远程源的 masonry 视图当前完全不可用。
5. **SMB 全 stub**：`smb_impl.rs` 4 方法 `NotImplemented`；`smb` crate 0.11（smb-rs，纯 Rust SMB2/3 客户端）已编译在构建里，API 齐备（`Directory::query` / `File::read_block` / NTLM via sspi）。

已就位的地基：`account` 表（migration 001）、`commands/accounts.rs` list/upsert/delete 真实现、`Accounts.vue` 真 UI、`Archive` descriptor 的 `origin`/`originEntryPath`/`archiveRelPath` 三字段（契约零改动）、`MediaSourceFactory` 分发点。

另两个审查确认的代码事实：`local.rs:97` 的 `MediaEntry.path` 是相对当前目录的**文件名**（strip_prefix 产物），不是绝对路径；`webdav_impl.rs:262-268` Range 请求只验证 `is_success()`，服务端忽略 Range 返回 200 整包时会静默返回错误字节区间。

## 1. 目标 / 非目标

**目标**（对应用户验收清单 §7）：

- 统一 `media://` 自定义协议：图片字节不进 IPC，OSD `<img>` 直载，按 descriptor 分发到 `MediaSourceFactory`
- 阅读器去 Local-only：Local / Archive(local ZIP) / WebDAV / SMB 四类源同一条打开流程
- 远程缩略图与 masonry：缩略图服务放开 Local-only，远程源经 factory 取字节生成
- SMB 全链路：账户（含 keyring 凭据）→ 测试连接 → 浏览目录 → 阅读图片 → Range 请求
- 远程 Archive 物化缓存：SMB/WebDAV 上的 CBZ/ZIP 完整下载至本地缓存后解压，LRU + 失效 + 预载
- 与 Likes / History / Shortcuts / 跨卷 / 书签 / 进度共用同一 descriptor 流程（源无关自动成立，验收确认）

**非目标**（YAGNI，不做清单）：

- RAR/7z 格式（`unrar`/`sevenz-rust` 另行模块，见 DESIGN §16.1）
- ZIP 基于 Range 的随机读取优化（首期完整下载后解压）
- WebDAV ETag 缓存失效（首期 size+mtime，ETag 后置可选字段）
- `media://` 响应的 WebView 缓存复用（首期 `no-store`，见 §3.1；账户配置版本号方案后置）
- 任何写操作（上传/删除/重命名——项目铁律不做编辑类）
- SMB over QUIC / multichannel 等 smb-rs 高级特性
- 通用"下载管理"（§16.5 远期方向）
- 手写 OS 凭据加密（用 keyring crate）

## 2. 总体架构

```text
Vue / OSD <img src="media://...">
        ↓
register_asynchronous_uri_scheme_protocol 异步 handler（lib.rs 注册）
        ↓
校验：URL 解析（固定段数）→ accountId 存在且类型匹配 → 路径规范化
        ↓
从 DB 重建真实 descriptor（host/port/凭据不进 URL）
        ↓
MediaSourceFactory::resolve
        ├─ Local：直接读文件
        ├─ SMB：连接管理器 → smb-rs Client
        ├─ WebDAV：reqwest GET / Range（206 严格验证）
        └─ Archive：origin.is_some() → materializer 物化 → 本地解压
                     origin None    → archivePath 直开（绝对路径）
```

**依赖方向（rev2 新增，断开循环）**：factory 构造 ArchiveMediaSource 需要物化能力，物化又需读 origin——若物化器回调 factory 即成环。解法：

```text
lib.rs 启动构造顺序：
  concrete sources（Local/Smb/WebDav Arc）→ Materializer（持三源 Arc，不经 factory）→ Factory（持四源 + Materializer）
ArchiveMediaSource 由 factory 注入 Arc<Materializer>，只做两件事：
  对已物化的本地缓存文件列条目、解压读取
```

Materializer 持具体源 Arc 而非 factory 引用，origin 读取不递归经 factory——环断开。未来新增源：在 factory::new 补一行 concrete source + materializer 源列表追加。

前端统一用 `mediaUrl(descriptor, path)`；缩略图缓存仍走现有 `convertFileSrc(cachePath)`（Rust 端生成的缓存绝对路径，不动）；Masonry 原图 `originalUrlFor` 切 `mediaUrl`（见 §3.6）。

**Local 也走 `media://local/`**（决策）：`media://archive/local/...` 反正要处理本地绝对路径，本地图片走同分支零额外代码，loader 消除 Local 特判。信任级别与 asset protocol 等价（本地单机、WebView 内自家代码），无安全降级。`convertFileSrc` 退役到仅缩略图缓存使用。M1 验收含本地阅读 + masonry 回归。

## 3. M1 —— 通用显示层

### 3.1 media:// 协议规范

**URL 编码规则（rev2 重写）**：每个逻辑字段整体 percent-encode 为**恰好一个 segment**（字段内部的 `/`、`\`、中文等全部编码，`/` → `%2F`），URL 段数固定、解析可逆、无变长段分界歧义：

```text
media://local/{absPath}                                    ← 2 段
media://smb/{accountId}/{initialPath}/{relPath}            ← 4 段
media://webdav/{accountId}/{relPath}                       ← 3 段
media://archive/local/{archivePath}/{entryPath}            ← 4 段
media://archive/smb/{accountId}/{initialPath}/{archiveRelPath}/{entryPath}   ← 6 段
media://archive/webdav/{accountId}/{archiveRelPath}/{entryPath}              ← 5 段
```

- URL **不携带**：密码、主机、WebDAV base URL、port（信任源是 DB；port 从 account 表重建）
- `initialPath` 是 descriptor 身份（用户从哪层进入），原样进 URL；handler 校验链：**段数与类型匹配 → 逐段 decode → accountId 查库存在且 `type` 列匹配 → 路径规范化**（decode 后拒绝绝对路径、`..`、空段；decode 恰好一次，拒绝二次 decode 后含 `%` 的异常段）
- 不向前端回传连接细节或凭据；错误响应只带状态码 + 短文案

**注册方式（rev2）**：`register_asynchronous_uri_scheme_protocol`——handler 收 `http::Request<Vec<u8>>` + `UriSchemeResponder`，异步 IO 完成后 `responder.respond(response)` 回写，无阻塞主线程、无空响应契约缺口（同步 `register_uri_scheme_protocol` + 手动 spawn 缺 responder 契约，不采用）。

**MediaSource trait 扩展（rev2 新增）**——现有 4 方法（list/read_file/file_count/test）不够支撑协议层与物化器，新增第 5 方法：

```rust
async fn stat(&self, descriptor: &SourceDescriptor, path: &str) -> Result<FileStat>;
pub struct FileStat { pub size: u64, pub modified_at: Option<i64> }  // 秒级 Unix，None = 源不提供
```

- 用途：HEAD 请求（不读 body）、416 的 `Content-Range: bytes */{total}`、206 的 `Content-Range` 组装、materializer 的 size+mtime 失效判定
- 四个实现：Local（`std::fs::metadata`）、SMB（query file info，spike 确认 API）、WebDAV（HEAD 请求，`Content-Length` + `Last-Modified`）、Archive（对**已物化**文件 stat；origin 未物化时返回 NotImplemented——物化路径的 stat 语义见 §5.2）

**Range 强契约（rev2 新增）**：`read_file` 带 `ByteRange` 时，实现**必须**返回恰好该区间的字节，无法满足即返回错误——禁止静默回退全量。`webdav_impl` 相应修复：请求 Range 后必须收到 206（或 200 且 body 长度 == 请求长度，兼容个别服务器），否则 `MediaSourceError::Network("server ignored range")`。此契约是 M3 分块下载拼 `.part` 的正确性前提。

**HTTP 语义**：

- 方法：`GET` / `HEAD`（HEAD 用 `stat`，不读 body）
- Range：单段 `bytes=start-end`（闭区间）与 `bytes=start-`（开尾，end = stat.size - 1）；转换为 `ByteRange { offset: start, length: end - start + 1 }`
- 状态码：`200`（全量，`Content-Length` = bytes.len()）/ `206`（Range 命中，带 `Content-Range: bytes s-e/total`）/ `416`（start >= stat.size，带 `Content-Range: bytes */{total}`）/ `403`（路径违规）/ `404`（账户不存在或文件不存在）/ `502`（网络/IO 失败）
- 头：`Content-Type`（复用 Rust `algorithm::mime`）、`Content-Length`、`Content-Range`、`Accept-Ranges: bytes`、**`Cache-Control: no-store`**（rev2：端口/账户配置变更可能指向不同内容，不做 WebView 缓存复用；将来需要缓存时用账户配置版本号进 URL，后置）

### 3.2 阅读器与前端通用化

- `useReaderBookLoader`：删 Local-only 抛错；`pageUrls = imageNames.map(name => mediaUrl(descriptor, joinRel(relPath, name)))`；`validateSourceRelativePath` 数据完整性校验保留（防 DB 脏数据，与 URL 无关）
- History.vue / Likes.vue（含 132 行浏览按钮 `v-if`）/ FileBrowser 打开路径：`type !== 'local'` 防御统一删除，走 descriptor 通用流程
- 跨卷 `find_next_volume` / 书签 / 进度 / webtoon `list_image_dimensions`：已按 descriptor 派发，M1 验收逐项确认（不在 M1 提前改代码，坏了才修）

### 3.3 本地 ZIP 全链路（补齐 Phase 3）

- FileBrowser 双击 `.cbz`/`.zip`（`isArchive` entry）→ 构造 `Archive { archivePath: joinPath(joinPath(rootPath, currentPath), entry.name), entry_prefix: "", format, origin: None }`。**archivePath 必须是绝对路径**（rev2：`local.rs:97` 的 `MediaEntry.path` 只是相对当前目录的文件名，直接用会在子目录下解析到进程 CWD 导致 ZIP 打不开）→ 现有 `list_directory` IPC 返回 ZIP 内 entries → FileList 渲染
- ZIP 内"上级"导航：`entry_prefix` 为空时退到压缩包所在目录；非空时退 prefix 层级
- 双击 ZIP 内图片进阅读器（同 3.2 通用流程，URL 走 `media://archive/local/...`）

### 3.4 WebDAV 阅读 + keyring 凭据（顺带修复）

- `keyring = "3"` 依赖启用；条目：`service = "top.racyan.mirapage-desktop"`，`account = "{type}-{id}"`（如 `webdav-3`）
- **keyring 写入/补偿顺序（rev2 定死）**：
  - 新建：先 INSERT DB 拿 id → 写 keyring；keyring 失败 → 删除刚插的 DB 行并报错（不留无凭据账户，用户重试）
  - 编辑：`type` 字段**不可变**（UI 编辑态禁用；要换类型删了重建）——杜绝改类型后旧 `{type}-{id}` 条目遗留；password 非空 → 覆写 keyring；空 → 保留旧值（编辑不回显密码）
  - 删除：先删 keyring（失败重试 1 次）→ 再删 DB 行；keyring 最终失败 → DB 照删 + 返回 warning 字段（UI toast「凭据残留，请到系统凭据管理器手动清理」），不静默孤儿
- `list_accounts` 维持不回传密码；DB 的 `encrypted_password` 列保持 NULL 不再使用（保留列兼容备份互导）
- WebDAV 源实装凭据读取：`webdav_impl` 从 account 表 + keyring 取 username/password 构造 Basic Auth
- keyring 不可用环境（Linux 无 Secret Service）：`test_connection` 返回明确错误文案；Windows 为优先目标平台

### 3.5 远程缩略图与 masonry（rev2 新增，纳入 M1）

审查确认 `thumbnail/service.rs` 非 Local 返回 unsupported、`MasonryView` 原图 URL 拼本地路径，两处都在 M1 通用化：

- **thumbnail service**：`unsupported` 分支（525/550/679 三处）改为经 `factory.resolve(descriptor).read_file()` 取源字节（Local 保留现有 std::fs 直读快路径）；字节读取走 blocking 线程（与现有一致），远程慢 IO 由 scheduler 的优先级/取消机制自然背压
- **MasonryView.originalUrlFor**：`convertFileSrc(joinPath(...))` → `mediaUrl(descriptor, joinRel(currentPath, name))`
- 生成策略/缓存 key/事件链全部不动（源信息已在 cache key 的 descriptor 序列化里）

### 3.6 M1 验收

1. 本地目录阅读回归（single/double/webtoon 三模式 + 跨卷 + 书签 + 进度）
2. 本地 CBZ：双击进 ZIP → 条目列表 → 双击图片阅读 → 翻页 → 退出再进（进度恢复）
3. masonry 瀑布流回归（Local）+ **远程 masonry**（WebDAV 目录瀑布流 + 缩略图生成 + 原图打开）
4. WebDAV（带密码的服务器）：添加账户 → test_connection 绿 → 浏览 → 阅读 → History/Likes 打开
5. Range：devtools network 面板确认 img 请求行为与 206/416 语义
6. URL 校验：伪造 accountId / `..` 路径 / 段数不符 / 类型不匹配 / 二次解码 → 404/403
7. keyring 补偿：新建失败回滚、编辑改密码生效、删除后 keyring 无残留（Windows 凭据管理器目检）

## 4. M2 —— SMB 协议层

### 4.1 spike（M2 第一个任务，建议 M1 期间并行跑）

20-100 行独立 demo 连真实 NAS（账号密码）验证，**结果决定 M2 走 smb-rs 还是备选**：

- dialect 协商 + NTLM 认证（sspi）
- `Directory::query` 列目录返回字段映射 MediaEntry
- `File::read_block` Range 读（含越界行为，对齐 §3.1 Range 强契约）
- 文件 stat API（size/modified_at 获取方式，`FileStat` 映射）
- 大图（4-8MB）顺序读吞吐
- Client 复用语义：可否 `Arc` 共享跨并发任务、断线后状态、多 share 行为
- 失败错误类型可否区分「连接级」vs「文件级」（决定重连策略）

备选路线（smb-rs 互测失败时）：Windows 原生 UNC + `WNetAddConnection2`（仅 Windows，凭据走系统会话），Linux/macOS 后置。

### 4.2 smb_impl 实装 + 连接管理器

- 5 方法实装（含 rev2 新增 stat）：`list_directory`（query → MediaEntry 映射，mtime 秒级对齐）/ `read_file`（`read_block`，Range 强契约）/ `stat` / `file_count` / `test`（真连接 + 列根一次）
- **连接管理器**（SMB 有状态，与 WebDAV 最大差异）：`HashMap<accountId, Arc<Client>>` + 每条目 `last_used` + 空闲 TTL 回收（代码常量 5 分钟，非用户设置）+ 懒清理；操作失败且错误为连接级 → 重建连接重试一次 → 再失败上抛（media:// 层映射 502）
- 凭据：account 表 username + keyring 密码；`Smb { account_id, initial_path, path, port }` 的 UNC = `\\{host}\{initial_path}\{path}`（initial_path 首段即 share）

### 4.3 M2 验收（用户清单 1-4 + 8）

1. 添加、测试 SMB 账户（密码落 keyring 不落库）
2. 浏览 SMB 目录（details + masonry 两视图，缩略图走 §3.5 通用化后的链路）
3. 阅读 SMB 普通图片目录（三模式 + 跨卷 + 书签/进度/历史/喜欢/快捷方式同一 descriptor 流程）
4. Range 请求（206/416 实测）
5. 断网恢复：拔网线 → 阅读报错 → 恢复 → 重连一次成功继续读

## 5. M3 —— 远程 Archive 物化 + 预载 + cache

### 5.1 archivePath 虚拟路径语义（决策）

远程压缩包 descriptor 的 `archivePath` 存**虚拟路径**（SMB=UNC 形态、WebDAV=URL 形态），物化后的缓存真实路径只存在 Rust 内存中由 materializer 翻译：

```text
ArchiveMediaSource 打开逻辑：
  origin.is_some() → materializer.ensure_cached(descriptor) → 返回缓存绝对路径
  origin None      → archive_path 直开（现状，绝对路径）
```

书签/历史/喜欢/进度 identity 与 DB 全程不见缓存路径（descriptor 不变，`id()` 稳定）。

物化路径的 `stat` 语义（rev2）：对 origin 未物化的 Archive descriptor，`stat` 返回 NotImplemented；物化后 stat 缓存文件。远端 size/mtime 的获取走 **origin 源的 stat**（materializer 直接调 concrete source，不经 ArchiveMediaSource）——materializer 持三源 Arc（§2），无循环。

### 5.2 物化器（`archive/materializer.rs`）

- cache key：canonical origin descriptor JSON + `archiveRelPath` + `size` + `modifiedAt` → hash（canonical 化逻辑复用 migration 013 模式，无 pub helper 则提取）；**size/mtime 经 origin 源 `stat` 获取**（rev2：不经 list_directory 间接推断）
- 失效判定：打开/预载前 `stat` 远端，size 或 mtime 变更即失效重下（ETag 后置；SMB 无 ETag，语义统一）
- 下载：chunked `read_file` Range 循环（依赖 §3.1 Range 强契约保证分块正确）→ `.part` 临时文件 → 完成原子改名；`.part` 存在则从其当前 size 断点续传；字节不过 IPC 不进内存（流式写盘）
- index：SQLite `archive_cache` 表（key → cache_path / size / mtime / last_access），migration 新版本号

### 5.3 预载调度（复用 3.0.7 thumbnail scheduler 模式）

```text
发现远程 CBZ/ZIP
  ├─ 元数据预载：列目录/预读窗口 stat（size/modifiedAt）
  ├─ 内容预载：进入预读窗口或选中 → 低优先级下载
  └─ 强制预存：用户打开阅读器 → 升最高优先级并等待完成
```

- 优先队列 + in-flight 去重 + epoch 取消（切目录取消未开始/低优任务）
- 阅读器「正在准备压缩包」占位态：`archive://progress` 事件推送下载进度（非阻塞 emit，模式同 `thumbnail://progress`）

### 5.4 archive cache 管理

- 与 thumbnail cache 分开目录、分开设置
- LRU（`last_access`）+ 容量上限 + 启动清理 + 用户手动清空
- 新设置 5 项（Settings 存储区新增 remote section）：`remote_archive_prefetch_enabled` / `archive_cache_max_mb` / `archive_prefetch_window` / `archive_download_concurrency` / 清空缓存按钮

### 5.5 M3 验收（用户清单 5-7）

1. 打开 SMB/WebDAV 上的 CBZ：首次显示准备态 → 下载完成 → 阅读
2. 二次打开同包：cache 命中秒开（无网络请求验证）
3. 远端压缩包更新（size/mtime 变）：缓存失效自动重下
4. 断点续传：下载中途断网 → 恢复 → 从 `.part` 续传不重头
5. LRU：超容量淘汰最旧；手动清空按钮生效

## 6. 安全边界汇总

- URL 不含凭据/主机/base URL；信任源是 DB（accountId 校验 + descriptor 重建）
- URL 每逻辑字段单段 encode，段数固定；decode 一次；路径规范化拒绝绝对路径 / `..` / 空段 / 二次编码
- `media://local/` 与 asset protocol 同信任级别（本地单机、WebView 内自家代码），无降级
- keyring 存密码，DB 的 `encrypted_password` 列保持 NULL 不再使用；补偿顺序见 §3.4
- 协议 handler 错误响应不含连接细节（主机名/内部路径只进日志）

## 7. 测试策略

- **Rust 单测**：URL codec（每类源合法/非法样本、`%2F` 段内分隔符、二次解码、段数不符）、stat 接口（四实现）、Range 闭开区间转换、Range 强契约（webdav 收 200 整包时报错）、cache key 稳定性、失效判定、连接管理器 TTL/重连（mock Client）、materializer 状态机（下载/续传/原子改名/回滚）
- **集成测**：media handler 对 mock MediaSource 的 200/206/416/403/404/502 矩阵（含 HEAD）；ZIP 物化 + 解压管线（tempdir）
- **前端 vitest**：`mediaUrl` 构造（四类源快照，断言每字段单段）、loader 通用化（Local/Archive/Smb descriptor 用例）、History/Likes 打开防御删除后的行为、ZIP 进入/退出导航、keyring 补偿（upsert 失败回滚/删除 warning）
- **实机**：M1 手测清单（3.6）、M2 NAS（4.3）、M3（5.5）；smb-rs 互操作风险由 spike 前置消解

## 8. i18n key 清单（新增）

`accounts.*` 补充（testFail 原因文案、凭据残留 warning）、`reader.archivePreparing`（准备态）、`settings.remote.*`（5 项设置 + 清空确认）、`error.network.*` 细化（区分账户不存在/路径违规/网络失败）。中英双语同步（AGENTS §2.3）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| smb-rs 与真实 NAS 互操作（dialect/签名/加密默认值） | spike 前置（4.1），失败切 UNC + `WNetAddConnection2` 备选（Windows 优先） |
| WebView2 对 custom protocol 的 Range 请求行为未知（img 是否发 Range） | M1 spike 验证点：devtools network 观察；即使 img 不发，Range 实现保留（HEAD/stat 与 M3 分块下载必需） |
| keyring 在无 Secret Service 的 Linux 失败 | 明确错误文案；Windows 优先目标 |
| 阅读器通用化波及面大（History/Likes/跨卷/书签/瀑布流/缩略图） | M1 验收清单逐项覆盖；不改没坏的代码，坏了才修（缩略图/masonry 明确要改，见 §3.5） |
| smb-rs Client 并发语义不明 | spike 验证点；不行则 per-task 连接 + 短 TTL 复用降级 |
| 远程缩略图慢 IO 拖垮 scheduler | 优先级/取消机制已有（3.0.7）；spike 量测吞吐定并发上限 |

## 10. 实施顺序与 tag

- `v0.1.0-module3.2.0-media-display`（M1）
- `v0.1.0-module3.3.0-smb`（M2）
- `v0.1.0-module3.4.0-remote-archive`（M3）

每期独立 spec 内含验收清单 → writing-plans 出 M1 计划 → TDD 实施 → tag 推送。smb-rs spike 建议 M1 编码期间并行执行（半天），结论回写本 spec §4.1。

## 附：审查修订记录（rev2，2026-08-18）

10 条全采纳：① URL 每逻辑字段单段 encode（§3.1 重写）② MediaSource 加 `stat`（§3.1 + 四实现）③ Archive 依赖方向定死（§2 构造顺序 + §5.1 物化 stat 语义）④ 缩略图 Local-only 纳入 M1（§0.4 + §3.5 新节）⑤ 本地 ZIP archivePath 绝对路径（§3.3）⑥ `register_asynchronous_uri_scheme_protocol`（§3.1）⑦ Range 强契约 + webdav 206 验证（§3.1 + §7）⑧ `Cache-Control: no-store`、去掉错误缓存理由（§3.1）⑨ keyring 补偿顺序 + type 不可变（§3.4）⑩ 优先级四项即 ①②③④。
