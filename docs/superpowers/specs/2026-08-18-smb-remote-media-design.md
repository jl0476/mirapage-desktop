# SMB / 远程媒体访问统一层设计（M1-M3）

> 日期：2026-08-18
> 状态：设计定稿，待审查
> 来源：brainstorming 会话（用户蓝图 + 代码探索整合）；DESIGN.md §5 Phase 7/8、§7.7 参考
> 关联：DESIGN.md §16.1「SMB 协议层」条目将随本设计推进划掉

## 0. 背景与事实基线

探索发现的四个存量缺口，本 epic 全部修复：

1. **阅读器全链路 Local-only**：`useReaderBookLoader.ts:126` 对非 Local descriptor 直接抛错；History/Likes/浏览跳转多处 `type !== 'local'` 防御。WebDAV（Phase 8 ✅）协议层通但进不了阅读。
2. **本地 ZIP 是协议层孤儿**：后端 `zip` crate 实现完好（`archive_impl.rs`），但前端从未构造 Archive descriptor——双击 ZIP 进条目列表、ZIP 阅读、ZIP 内图片显示全部不存在。
3. **密码全局不存**：`upsert_account` 把 `encrypted_password` 永远插 NULL（keyring 是注释 stub）。WebDAV 目前只能匿名访问。
4. **SMB 全 stub**：`smb_impl.rs` 4 方法 `NotImplemented`；`smb` crate 0.11（smb-rs，纯 Rust SMB2/3 客户端）已编译在构建里，API 齐备（`Directory::query` / `File::read_block` / NTLM via sspi）。

已就位的地基：`account` 表（migration 001）、`commands/accounts.rs` list/upsert/delete 真实现、`Accounts.vue` 真 UI、`Archive` descriptor 的 `origin`/`originEntryPath`/`archiveRelPath` 三字段（契约零改动）、`MediaSourceFactory` 分发点、缩略图链路源无关（Rust 端走 factory）。

## 1. 目标 / 非目标

**目标**（对应用户验收清单 §7）：

- 统一 `media://` 自定义协议：图片字节不进 IPC，OSD `<img>` 直载，按 descriptor 分发到 `MediaSourceFactory`
- 阅读器去 Local-only：Local / Archive(local ZIP) / WebDAV / SMB 四类源同一条打开流程
- SMB 全链路：账户（含 keyring 凭据）→ 测试连接 → 浏览目录 → 阅读图片 → Range 请求
- 远程 Archive 物化缓存：SMB/WebDAV 上的 CBZ/ZIP 完整下载至本地缓存后解压，LRU + 失效 + 预载
- 与 Likes / History / Shortcuts / 跨卷 / 书签 / 进度共用同一 descriptor 流程（源无关自动成立，验收确认）

**非目标**（YAGNI，不做清单）：

- RAR/7z 格式（`unrar`/`sevenz-rust` 另行模块，见 DESIGN §16.1）
- ZIP 基于 Range 的随机读取优化（首期完整下载后解压）
- WebDAV ETag 缓存失效（首期 size+mtime，ETag 后置可选字段）
- 任何写操作（上传/删除/重命名——项目铁律不做编辑类）
- SMB over QUIC / multichannel 等 smb-rs 高级特性
- 通用"下载管理"（§16.5 远期方向）
- 手写 OS 凭据加密（用 keyring crate）

## 2. 总体架构

```text
Vue / OSD <img src="media://...">
        ↓
异步 media protocol handler（lib.rs 注册）
        ↓
校验：URL 解析 → accountId 存在且类型匹配 → 路径规范化
        ↓
从 DB 重建真实 descriptor（host/port/凭据不进 URL）
        ↓
MediaSourceFactory::resolve
        ├─ Local：直接读文件
        ├─ SMB：连接管理器 → smb-rs Client
        ├─ WebDAV：reqwest GET / Range
        └─ Archive：origin.is_some() → materializer 物化 → 本地解压
                     origin None    → archivePath 直开
```

前端统一用 `mediaUrl(descriptor, path)` 替换 `convertFileSrc(absPath)`；缩略图缓存仍走现有 `convertFileSrc(cachePath)`（Rust 竓生成的缓存绝对路径，不动）。

**Local 也走 `media://local/`**（决策）：`media://archive/local/...` 反正要处理本地绝对路径，本地图片走同分支零额外代码，loader 消除 Local 特判、单条 URL 构造路径。信任级别与 asset protocol 等价（本地单机、WebView 内是自家代码），无安全降级。`convertFileSrc` 退役到仅缩略图缓存使用。M1 验收含本地阅读 + masonry 回归。

## 3. M1 —— 通用显示层

### 3.1 media:// 协议规范

URL 形态（每段 percent-encode，多级路径按 `/` 拆段）：

```text
media://local/{absPath 段}
media://smb/{accountId}/{initialPath 段...}/{relPath 段...}
media://webdav/{accountId}/{relPath 段...}
media://archive/local/{archivePath 段...}/{entryPath 段...}
media://archive/smb/{accountId}/{initialPath 段...}/{archiveRelPath 段...}/{entryPath 段...}
media://archive/webdav/{accountId}/{archiveRelPath 段...}/{entryPath 段...}
```

- URL **不携带**：密码、主机、WebDAV base URL、port（用户拍板 2026-08-18：去 port，DB 重建——改端口不击穿 WebView 图片缓存）
- `initialPath` 是 descriptor 身份（用户从哪层进入），不查库、原样进 URL；host/port/share 从 account 表重建
- handler 校验链：段数与类型匹配 → accountId 查库存在且 `type` 列匹配 → 路径 decode 后规范化（拒绝绝对路径、`..`、空段、二次解码攻击）→ factory 读
- 不向前端回传连接细节或凭据；错误响应只带状态码 + 短文案

HTTP 语义（异步 handler，`register_uri_scheme_protocol` + tokio spawn 阻塞隔离）：

- 方法：`GET` / `HEAD`
- Range：单段 `bytes=start-end`（闭区间）与 `bytes=start-`（开尾）；转换为 `ByteRange { offset: start, length: end - start + 1 }`（协议层负责闭开区间转换）
- 状态码：`200`（全量）/ `206`（Range 命中）/ `416`（越界，带 `Content-Range: bytes */{total}`）/ `403`（路径违规）/ `404`（账户不存在或文件不存在）/ `502`（网络/IO 失败）
- 头：`Content-Type`（复用 Rust `algorithm::mime`）、`Content-Length`、`Content-Range`、`Accept-Ranges: bytes`

### 3.2 阅读器与前端通用化

- `useReaderBookLoader`：删 Local-only 抛错；`pageUrls = imageNames.map(name => mediaUrl(descriptor, joinRel(relPath, name)))`；`validateSourceRelativePath` 数据完整性校验保留（防 DB 脏数据，与 URL 无关）
- History.vue / Likes.vue（含 132 行浏览按钮 `v-if`）/ FileBrowser 打开路径：`type !== 'local'` 防御统一删除，走 descriptor 通用流程
- 跨卷 `find_next_volume` / 书签 / 进度 / webtoon `list_image_dimensions` / 瀑布流 `list_image_dimensions`：全部已按 descriptor 派发，M1 验收逐项确认（不在 M1 提前改代码，坏了才修）

### 3.3 本地 ZIP 全链路（补齐 Phase 3）

- FileBrowser 双击 `.cbz`/`.zip`（`isArchive` entry）→ 构造 `Archive { archivePath: entry.path, entry_prefix: "", format, origin: None }` → 现有 `list_directory` IPC 返回 ZIP 内 entries → FileList 渲染
- ZIP 内"上级"导航：`entry_prefix` 为空时退到压缩包所在目录；非空时退 prefix 层级
- 双击 ZIP 内图片进阅读器（同 3.2 通用流程，URL 走 `media://archive/local/...`）

### 3.4 WebDAV 阅读 + keyring 凭据（顺带修复）

- `keyring = "3"` 依赖启用；条目：`service = "top.racyan.mirapage-desktop"`，`account = "{type}-{id}"`（如 `webdav-3`）
- `upsert_account`：password 非空 → 写 keyring；空 → 保留旧值（编辑不回显密码）；`delete_account` → 连删 keyring 条目（失败不阻断删除，写日志）
- `list_accounts` 维持不回传密码
- WebDAV 源实装凭据读取：`webdav_impl` 从 account 表 + keyring 取 username/password 构造 Basic Auth
- keyring 不可用环境（Linux 无 Secret Service）：`test_connection` 返回明确错误文案；Windows 为优先目标平台

### 3.5 M1 验收

1. 本地目录阅读回归（single/double/webtoon 三模式 + 跨卷 + 书签 + 进度）
2. 本地 CBZ：双击进 ZIP → 条目列表 → 双击图片阅读 → 翻页 → 退出再进（进度恢复）
3. masonry 瀑布流 + 缩略图缓存回归（Local）
4. WebDAV（带密码的服务器）：添加账户 → test_connection 绿 → 浏览 → 阅读 → History/Likes 打开
5. Range：devtools network 面板确认 img 请求行为与 206/416 语义
6. 四类源 URL 校验：伪造 accountId / `..` 路径 / 类型不匹配 → 404/403

## 4. M2 —— SMB 协议层

### 4.1 spike（M2 第一个任务，建议 M1 期间并行跑）

20-100 行独立 demo 连真实 NAS（账号密码）验证，**结果决定 M2 走 smb-rs 还是备选**：

- dialect 协商 + NTLM 认证（sspi）
- `Directory::query` 列目录返回字段映射 MediaEntry
- `File::read_block` Range 读
- 大图（4-8MB）顺序读吞吐
- Client 复用语义：可否 `Arc` 共享跨并发任务、断线后状态、多 share 行为
- 失败错误类型可否区分「连接级」vs「文件级」（决定重连策略）

备选路线（smb-rs 互测失败时）：Windows 原生 UNC + `WNetAddConnection2`（仅 Windows，凭据走系统会话），Linux/macOS 后置。

### 4.2 smb_impl 实装 + 连接管理器

- 4 方法实装：`list_directory`（query → MediaEntry 映射，mtime 秒级对齐）/ `read_file`（`read_block`，ByteRange 直通）/ `file_count` / `test`（真连接 + 列根一次）
- **连接管理器**（SMB 有状态，与 WebDAV 最大差异）：`HashMap<accountId, Arc<Client>>` + 每条目 `last_used` + 空闲 TTL 回收（代码常量 5 分钟，非用户设置）+ 懒清理；操作失败且错误为连接级 → 重建连接重试一次 → 再失败上抛（media:// 层映射 502）
- 凭据：account 表 username + keyring 密码；`Smb { account_id, initial_path, path, port }` 的 UNC = `\\{host}\{initial_path}\{path}`（initial_path 首段即 share）

### 4.3 M2 验收（用户清单 1-4 + 8）

1. 添加、测试 SMB 账户（密码落 keyring 不落库）
2. 浏览 SMB 目录（details + masonry 两视图，缩略图走现有缓存链路）
3. 阅读 SMB 普通图片目录（三模式 + 跨卷 + 书签/进度/历史/喜欢/快捷方式同一 descriptor 流程）
4. Range 请求（206/416 实测）
5. 断网恢复：拔网线 → 阅读报错 → 恢复 → 重连一次成功继续读

## 5. M3 —— 远程 Archive 物化 + 预载 + cache

### 5.1 archivePath 虚拟路径语义（决策）

远程压缩包 descriptor 的 `archivePath` 存**虚拟路径**（SMB=UNC 形态、WebDAV=URL 形态），物化后的缓存真实路径只存在 Rust 内存中由 materializer 翻译：

```text
ArchiveMediaSource 打开逻辑：
  origin.is_some() → materializer.ensure_cached(descriptor) → 返回缓存绝对路径
  origin None      → archive_path 直开（现状）
```

书签/历史/喜欢/进度 identity 与 DB 全程不见缓存路径（descriptor 不变，`id()` 稳定）。

### 5.2 物化器（`archive/materializer.rs`）

- cache key：canonical origin descriptor JSON + `archiveRelPath` + `size` + `modifiedAt` → hash（canonical 化逻辑复用 migration 013 模式，无 pub helper 则提取）
- 失效判定：列目录/打开时取远端 size+mtime 与 index 对比，变更即失效重下（**ETag 后置**，用户拍板 2026-08-18；SMB 无 ETag，语义统一）
- 下载：chunked `read_file` Range 循环 → `.part` 临时文件 → 完成原子改名；`.part` 存在则从其当前 size 断点续传；字节不过 IPC 不进内存（流式写盘）
- index：SQLite `archive_cache` 表（key → cache_path / size / mtime / last_access），migration 新版本号

### 5.3 预载调度（复用 3.0.7 thumbnail scheduler 模式）

```text
发现远程 CBZ/ZIP
  ├─ 元数据预载：列目录自带 size/modifiedAt（零额外 IO）
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
- 路径规范化拒绝绝对路径 / `..` / 空段 / 二次解码
- `media://local/` 与 asset protocol 同信任级别（本地单机、WebView 内自家代码），无降级
- keyring 存密码，DB 的 `encrypted_password` 列保持 NULL 不再使用（保留列不删，兼容备份互导）
- 协议 handler 错误响应不含连接细节（主机名/内部路径只进日志）

## 7. 测试策略

- **Rust 单测**：URL 解析与校验链（每类源合法/非法样本）、Range 闭开区间转换、cache key 稳定性、失效判定、连接管理器 TTL/重连（mock Client）、materializer 状态机（下载/续传/原子改名/回滚）
- **集成测**：media handler 对 mock MediaSource 的 200/206/416/403/404/502 矩阵；ZIP 物化 + 解压管线（tempdir）
- **前端 vitest**：`mediaUrl` 构造（四类源快照）、loader 通用化（Local/Archive/Smb descriptor 用例）、History/Likes 打开防御删除后的行为、ZIP 进入/退出导航
- **实机**：M1 手测清单（3.5）、M2 NAS（4.3）、M3（5.5）；smb-rs 互操作风险由 spike 前置消解

## 8. i18n key 清单（新增）

`accounts.*` 补充（testFail 原因文案）、`reader.archivePreparing`（准备态）、`settings.remote.*`（5 项设置 + 清空确认）、`error.network.*` 细化（区分账户不存在/路径违规/网络失败）。中英双语同步（AGENTS §2.3）。

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| smb-rs 与真实 NAS 互操作（dialect/签名/加密默认值） | spike 前置（4.1），失败切 UNC + `WNetAddConnection2` 备选（Windows 优先） |
| WebView2 对 custom protocol 的 Range 请求行为未知（img 是否发 Range） | M1 spike 验证点：devtools network 观察；即使 img 不发，Range 实现保留（media 元素/未来视频需要） |
| keyring 在无 Secret Service 的 Linux 失败 | 明确错误文案；Windows 优先目标 |
| 阅读器通用化波及面大（History/Likes/跨卷/书签/瀑布流） | M1 验收清单逐项覆盖；不改没坏的代码，坏了才修 |
| smb-rs Client 并发语义不明 | spike 验证点；不行则 per-task 连接 + 短 TTL 复用降级 |

## 10. 实施顺序与 tag

- `v0.1.0-module3.2.0-media-display`（M1）
- `v0.1.0-module3.3.0-smb`（M2）
- `v0.1.0-module3.4.0-remote-archive`（M3）

每期独立 spec 内含验收清单 → writing-plans 出 M1 计划 → TDD 实施 → tag 推送。smb-rs spike 建议 M1 编码期间并行执行（半天），结论回写本 spec §4.1。
