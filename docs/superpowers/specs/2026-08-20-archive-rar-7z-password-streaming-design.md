# RAR / CBR / 7z、全格式密码与远程 ZIP 流式读取设计

> 日期：2026-08-20
> 状态：用户已逐节确认，待书面规格审查
> 前置：`v0.1.0-module3.4.0-remote-archive` 已交付远程 CBZ/ZIP 物化、断点续传、预载与 LRU cache
> 关联：`DESIGN.md` §16.1「RAR / 7z 压缩包（Phase 3 收尾）」

## 0. 已确认决策

1. 桌面端不照搬 Android 的 libarchive；采用按格式专用库，上层统一抽象。
2. 支持 CBZ、ZIP、CBR、RAR、7z 五种格式；本地、SMB、WebDAV 三类来源全部支持。
3. 五种格式都支持密码；密码只在本次应用运行期间保存在内存，退出即清除。
4. 只支持单卷压缩包；多卷 RAR、分卷 7z、multi-disk ZIP 明确拒绝。
5. 远程 ZIP/CBZ 流式优先：Range 读取后尽快开始阅读，后台完整物化，失败自动降级。
6. 远程 RAR/CBR/7z 完整物化后读取，不伪装成流式。
7. 保持项目 Rust 1.75 MSRV，不为采用最新 archive crate 抬高工具链门槛。
8. 现有 ZIP/CBZ、本地与远程媒体、缩略图、进度、书签、跨卷和 cache 管理不得回归。

## 1. 背景与事实基线

### 1.1 已有能力

- Rust 与 TypeScript 的 `ArchiveFormat` 已包含 `cbz/cbr/zip/rar/7z`，文件浏览器与 MIME 判断也已识别五种扩展名。
- `ArchiveMediaSource` 已实现 CBZ/ZIP 的 `list_directory/read_file/file_count/stat/test`。
- `SourceDescriptor::Archive` 已能表达 Local、SMB、WebDAV 来源，并通过 `origin`、`originEntryPath`、`archiveRelPath` 保持历史/进度身份。
- M3 Materializer 已提供远程整包物化、`.part + sidecar` 断点续传、远端变化校验、in-flight 去重、取消、清空闸门、80% 水位和 LRU 淘汰。
- SMB/WebDAV `MediaSource` 都支持 `stat` 与强契约 `ByteRange`，具备远程 ZIP 随机读取的基础。

### 1.2 当前缺口

- CBR/RAR/7z 在 `ArchiveMediaSource` 中仍返回 `NotImplemented`。
- ZIP 每次 list/read/stat 都把整个压缩包读进 `Vec<u8>`，大包产生整包 RAM 副本并重复解析。
- Materializer 的格式闸门只允许 CBZ/ZIP，最终缓存文件名固定为 `{cacheKey}.zip`。
- 前端远程 Archive 预载过滤只允许 CBZ/ZIP。
- 没有压缩包密码状态、密码弹窗和类型化密码错误。
- 远程 ZIP 首开必须等整包下载完成，无法利用已有 Range 能力快速开始阅读。

## 2. 目标与非目标

### 2.1 目标

- 完成本地与远程 CBR/RAR/7z 的列目录、读取图片、Range、stat、缩略图与阅读全链路。
- 五种格式统一支持会话密码解锁。
- ZIP/CBZ 从整包 RAM 读取迁移到路径或随机访问源读取。
- 远程 ZIP/CBZ 先流式打开、后台物化，并可在物化完成后无缝切换到本地 cache。
- 保持现有 Archive descriptor、数据库、media protocol 与上层阅读器调用方式稳定。
- 提供可区分、可测试、不会泄露密码的错误语义。

### 2.2 非目标

- 多卷 RAR、分卷 7z、multi-disk ZIP。
- 创建、修改或重新压缩 Archive。
- 密码永久保存、同步、找回或写入 OS 凭据管理器。
- RAR/7z 的远程边下边读。
- 整包解压到临时目录或新增按条目磁盘 cache。
- 在本模块升级项目 MSRV。
- 修改 Reader、历史、进度、书签或缩略图的数据模型。

## 3. 格式与依赖策略

| 格式 | 后端 | 密码范围 | 输入形态 |
|---|---|---|---|
| CBZ / ZIP | 现有 `zip 2.x`，显式启用 AES 能力 | ZipCrypto、WinZip AES AE-1/AE-2 | 本地文件或远程随机访问源 |
| CBR / RAR | `unrar 0.5.x` + 内置 RARLab UnRAR | RAR4、RAR5 加密 | 本地文件路径 |
| 7z | `sevenz-rust 0.6.1`，启用 AES | 普通/solid、内容与文件名加密 | 本地文件路径 |

依赖选择以 Rust 1.75 可编译为硬门槛。最新 `unrar-ng 0.7` 要求 Rust 1.85，最新 `sevenz-rust2 0.21` 要求 Rust 1.93，因此本模块不采用。实现计划的首个依赖 spike 必须在 Windows 当前工具链和 Rust 1.75 上分别验证；若间接依赖漂移破坏 MSRV，则锁定兼容补丁版本，不抬高 MSRV。

RAR Rust 封装为 MIT/Apache-2.0；内置 UnRAR 使用 RARLab 专用免费许可。分发包、仓库第三方许可清单和 About/License 文档必须包含 UnRAR 完整许可文本。不得使用其代码开发 RAR 兼容压缩器或复刻 RAR 压缩算法。

## 4. 后端架构

### 4.1 模块边界

在 `src-tauri/src/source/archive/` 下形成以下职责：

```text
archive/
├─ backend.rs          统一类型、错误与 backend 分派
├─ zip_backend.rs      本地 ZIP + 远程随机访问 ZIP
├─ rar_backend.rs      RAR/CBR 路径读取
├─ sevenz_backend.rs   7z 路径读取
├─ password.rs         会话密码库与 archive identity
├─ remote_zip.rs       Range Read+Seek 适配与内存块 LRU
├─ materializer.rs     现有整包物化，泛化格式
├─ prefetch.rs         现有预载，扩展五格式
└─ dao.rs              现有 cache DAO
```

`ArchiveMediaSource` 只负责：

1. 解析 Archive descriptor。
2. 决定本地路径、远程 ZIP 随机访问或远程完整物化。
3. 取得 archive identity 对应的会话密码。
4. 按 `ArchiveFormat` 分派 backend。
5. 将 backend 返回值映射为现有 `MediaEntry`、`FileStat` 与 `MediaSourceError`。

Reader、缩略图、media protocol、commands 不引用具体 backend。

### 4.2 统一操作契约

backend 对上层暴露四种语义操作：

- `probe`：验证容器、识别多卷/加密、验证候选密码。
- `catalog`：列出 `entryPrefix` 下的图片条目。
- `read_entry`：完整解压指定图片条目。
- `stat_entry`：返回条目解压后大小；时间不可可靠取得时继续返回 `None`。

所有 backend 保持当前目录语义：递归收集 `entryPrefix` 下的图片，返回相对路径，过滤非图片，自然排序，不合成虚拟目录。`ByteRange` 仍在完整解压单个条目后进行严格切片；offset + length 溢出或越界返回错误，不静默截断。

### 4.3 阻塞任务与并发

ZIP、UnRAR、7z 的解析/解压均视为阻塞 IO/CPU 工作，统一在 `tokio::task::spawn_blocking` 中执行，不占用 async runtime worker。

- ZIP backend：最多 8 个并发解码任务。
- RAR backend：最多 2 个并发任务。
- 7z backend：最多 2 个并发任务。

并发限制为进程级 semaphore。获取许可前可取消；任务已进入第三方同步库后不能强杀，只丢弃结果并禁止写入陈旧状态。单个任务 panic 必须在 join 边界转换为类型化错误，不能使后续请求永久卡住。

### 4.4 目录索引缓存

增加进程内 catalog LRU，键为 archive identity + `size/mtime` 指纹 + `entryPrefix`，值只包含条目元数据，不包含图片字节或密码。最大 32 个 archive catalog；文件指纹变化、密码失效或 cache 清空时移除对应项。该缓存不写 DB，退出自动释放。

## 5. 密码模型

### 5.1 Archive identity

密码键不能只用展示路径：

- Local：规范化绝对路径 + size + mtime。
- SMB/WebDAV：canonical origin descriptor JSON + `archiveRelPath` + 远端 size + mtime。

文件发生变化即产生新 identity，不复用旧密码。无法取得 mtime 时使用 size；同 size 内容替换导致旧密码先被尝试，失败后立即删除并重新提示。

### 5.2 会话密码库

Rust managed state 中新增 `ArchivePasswordStore`：

- 使用并发安全 map；value 使用可在 drop 时清零的字节容器。
- 只在 `unlock_archive` 完整验证成功后写入。
- 错误密码、取消和损坏包不写入。
- 密码不进入 descriptor、SQLite、日志、事件、URL、sidecar、崩溃上下文或前端持久状态。
- 应用退出时 map 与临时副本清零。

密码按 UTF-8 字节传给 backend，不做 OEM/系统编码猜测。非 UTF-8 时代工具创建且依赖本地代码页的密码不在保证范围。

### 5.3 验证规则

`probe` 不以“目录能列出”作为解锁成功。某些容器只加密文件内容，不加密文件名；ZipCrypto 的快速校验也存在错误密码误通过概率。统一规则是：

1. 找到第一个加密图片条目。
2. 完整读取并执行 backend 提供的 CRC/MAC/完整性校验。
3. 成功后才缓存密码并返回 `ready`。

没有图片的加密包以第一个加密普通文件验证；完全空包返回 `CorruptArchive/EmptyArchive`，不误报密码成功。

## 6. 打开状态机与 IPC

### 6.1 新命令

新增两个 Tauri command，并继续只由 `src/lib/tauri.ts` 封装：

- `prepare_archive(descriptor) -> ArchivePrepareResult`
- `unlock_archive(descriptor, password) -> ArchivePrepareResult`

返回结果为带 tag 的结构化枚举：

```text
ready { accessMode: local | streaming | materialized }
passwordRequired
```

命令在 probe、Range 准备或完整物化结束后才返回；等待期间的 `materializing` UI 状态继续由既有 archive 进度事件驱动，不把一个无人接管的中间结果返回给前端。错误使用结构化 `ArchiveAccessError`，不由前端解析字符串。`forget_archive_password` 只保留 Rust 内部方法；前端没有“永久记住/忘记”按钮。

### 6.2 事务式打开

文件浏览器先构造候选 descriptor，但不修改 `currentDescriptor/currentPath/archiveParent`：

```text
idle
  → probing
  → password-required → unlocking → ready
                      ↘ wrong-password → password-required
                      ↘ cancel → idle
  → materializing → ready
  → error → idle
```

只有 `ready` 后才提交导航状态、历史、快捷方式身份和列表加载。取消、密码错误、网络失败或坏包都留在原目录，不产生半切换状态。

### 6.3 密码弹窗

新增统一模态组件，包含：压缩包名称、密码输入、显示/隐藏、确认、取消、错误提示，以及“密码仅在本次运行期间保留”的说明。

- Enter 提交，Esc 取消。
- 提交中禁用重复提交。
- 错误密码保留弹窗并清空输入。
- 不回显原始路径中的账户、主机凭据或 query。
- 不提供永久保存选项。

## 7. 远程读取策略

### 7.1 ZIP/CBZ 流式优先

```text
stat(size, mtime)
  → Range 读取尾部 central directory / ZIP64 元数据
  → catalog 返回，进入压缩包
  → Range 读取首图及当前条目压缩数据
  → 后台完整物化
  → 新请求检测 ready cache 后切换为本地文件
```

`ArchiveOriginAccess` 为 Archive 层提供三项能力：

- `stat(origin, relPath)`
- `read_range(origin, relPath, range)`
- `ensure_cached(origin, relPath)`

生产实现委托现有 SMB/WebDAV `MediaSource` 与 Materializer；测试实现使用 mock。由此避免 Archive 层直接依赖具体协议实现，也不在 `MediaSourceFactory` 中制造循环引用。

### 7.2 RemoteZipReader

`RemoteZipReader` 向 `zip` crate 提供同步 `Read + Seek` 外观。它只在 `spawn_blocking` 线程运行；Range miss 时通过捕获的 Tokio runtime handle 调用异步 `read_range`，禁止在 async worker 上 `block_on`。

固定参数：

- Range block：1 MiB。
- 全局远程 ZIP 块缓存预算：32 MiB。
- LRU key：archive identity + block index。
- 同 key block 请求 in-flight 去重。
- 返回长度和 offset 必须符合现有强 Range 契约，否则判定流式不可用。

块只存在 RAM，不写 SQLite。archive 指纹变化、cache 清空或应用退出时失效。

### 7.3 后台物化与切换

远程 ZIP catalog 成功后：

- `remote_archive_prefetch_enabled=true`：启动可取消的后台完整物化。
- 设置为 false：保持 Range 读取；只有流式失败才强制物化。
- 物化完成前已有请求继续用 RemoteZipReader。
- 物化完成后，新请求优先使用 DAO 中已校验的本地 cache；在途请求自行完成，不热切换 reader。
- Range 块与 `.part` 首版不互相填充，允许少量重复下载，避免破坏 M3 sidecar 一致性状态机。

### 7.4 自动降级

以下情况自动转完整物化，不向用户先展示技术错误：

- 服务器忽略/拒绝 Range。
- 返回 offset 或长度违反强契约。
- ZIP reader 需要的 Seek 无法满足。
- 流式网络请求失败且一次原位重试仍失败。

UI 从“正在打开”切换为“正在下载完整压缩包…”，继续显示既有物化进度。完整物化也失败时才返回最终网络/IO 错误。

### 7.5 RAR/CBR/7z

本地文件直接交给路径 backend。远程文件先走完整 Materializer，成功后交给同一个路径 backend。密码只在本地解码阶段使用，不进入 SMB/WebDAV 请求。

UnRAR 只接受路径并按顺序处理条目；7z 尤其 solid archive 的随机单条读取可能需要解码整个 solid block。因此本期不为两者实现伪流式，也不把整包展开到临时目录。

## 8. Materializer 泛化

保留现有状态机，只修改格式假设：

- 格式闸门允许 `cbz/zip/cbr/rar/7z`。
- 最终路径从 `{cacheKey}.zip` 改为 `{cacheKey}.{normalizedExt}`。
- normalizedExt 由 descriptor format 决定，并与 `archiveRelPath` 扩展名双重校验。
- `.part` 与 `.part.meta` 命名保持 `{cacheKey}.part`，sidecar schema 不增加密码。
- DAO 的 `cache_abs_path` 已是字符串，无需 migration；既有 `.zip` 行继续有效。
- 启动清理、磁盘一致性、远端失效判定、条件删除、in-flight、取消、清空闸门、容量统计和 LRU 语义不变。
- 前端 metadata/content 预载过滤扩展到五种格式；预载只下载原始包，不探测或弹出密码。

多卷按两层识别：`.partNN.rar`、`.rNN`、`.7z.NNN` 等明确文件名模式在调用 backend 前拒绝；普通 `.rar/.cbr/.7z` 则由 backend 打开后的 volume/split 元数据识别并立即停止。任一层确认多卷都返回 `MultiVolumeUnsupported`，不得自动扫描、请求或下载相邻卷。

## 9. 错误模型

Archive 层新增稳定错误分类：

| 错误 | 用户行为 |
|---|---|
| `PasswordRequired` | 打开密码弹窗 |
| `WrongPassword` | 保留弹窗，允许重试 |
| `UnsupportedCodec` | 显示格式/算法不受支持 |
| `MultiVolumeUnsupported` | 说明仅支持单卷 |
| `CorruptArchive` | 说明索引、CRC/MAC 或内容损坏 |
| `EmptyArchive` | 说明未找到可阅读图片 |
| `EntryNotFound` | 显示条目已变化或不存在 |
| `RemoteRangeUnavailable` | 内部降级，最终失败前不弹出 |
| `Cancelled` | 静默回原目录或丢弃陈旧结果 |
| `Io/Network/Timeout` | 沿用现有媒体源提示与状态码 |

backend 原始错误必须在各自模块映射，不把第三方库字符串直接暴露给前端。media protocol 保留现有 HTTP 状态语义；密码错误不得降级成通用 500 并无限重试。

日志只记录格式、错误分类、request id 和经过现有规则截断/脱敏的路径。任何级别都禁止记录密码、密码长度、候选密码哈希或解密后的敏感非图片内容。

## 10. UI 与进度

- 本地 Archive：probe 完成后立即进入；需要密码时先解锁。
- 远程 ZIP 流式成功：首屏可用即进入，状态栏以非阻塞信息显示“后台缓存 N%”。
- 远程 ZIP 流式降级：显示“正在下载完整压缩包…”。
- 远程 RAR/7z：沿用阻塞式“正在准备压缩包”进度；下载完成后若加密，再弹密码框。
- 后台物化取消不退出当前流式阅读；Range 仍可继续。强制清空 cache 时沿用 M3 闸门与排空语义。
- media protocol 请求若发现密码已失效，返回可识别的 Archive 密码错误；Reader 显示提示并引导回文件浏览器重新解锁，不在图片请求层弹出重入模态框。

新增中英文 i18n key 覆盖密码、加密类型、错误分类、流式准备、后台缓存和自动降级。两种 locale 的 key 集必须继续字节级一致。

## 11. 数据与兼容性

- 不新增数据库 migration。
- 不改变 `SourceDescriptor::Archive` JSON 字段与枚举值。
- history、library、progress、bookmark、shortcut 继续保存原 descriptor 与源相对路径。
- 密码和本地 cache 路径不进入业务数据。
- media URL 形态不变；Reader 与缩略图继续通过 factory 取得 `ArchiveMediaSource`。
- 既有 M3 `{cacheKey}.zip` 文件和 DAO 行继续命中；新下载按真实扩展名写入。
- 本地 ZIP 的目录过滤、自然排序、Range 和 stat 行为必须与改造前一致。

## 12. 测试设计

### 12.1 先锁定既有行为

在替换 ZIP 内部实现前补齐现有 CBZ/ZIP contract：

- 图片过滤、嵌套路径、`entryPrefix`、Unicode、自然排序。
- read、严格 ByteRange、越界、missing entry。
- stat 解压后 size、modifiedAt=None。
- Local 与远程物化 descriptor。
- 文件变化、cache 命中、清空和 LRU。

### 12.2 Backend 合同矩阵

三种 backend 复用同一组语义断言：catalog、read、Range、stat、Unicode、嵌套目录、空包、损坏包、非图片过滤、扩展名/格式不一致。

密码 fixture 矩阵：

- ZIP：ZipCrypto、AES AE-1、AES AE-2。
- RAR：RAR4、RAR5。
- 7z：普通、solid、加密文件名。
- 每类覆盖无密码、正确密码、错误密码、取消、会话复用、文件变化后缓存失效。

RAR 库不能创建 archive；仓库提交最小测试 fixture，内容只使用自生成色块图片，同时提交 README，记录生成命令、工具版本、格式、密码仅测试用途及 SHA-256。ZIP/7z 优先在测试中生成；库无法生成的特定变体同样使用有来源说明的最小 fixture。

### 12.3 单卷与安全

- RAR 分卷、7z 分卷、multi-disk ZIP 都返回 `MultiVolumeUnsupported`。
- descriptor JSON、DB 行、日志、事件、sidecar 和错误文本扫描不得包含测试密码。
- 错误密码不进入 store；正确密码在 drop/clear 后内存容器执行清零逻辑。
- 第一个加密条目完整校验，锁住 ZipCrypto 错误密码误通过防线。

### 12.4 远程 ZIP 流式

WebDAV 与 SMB mock 运行同一合同：

- 首个数据请求为尾部 Range，而非 `0..size` 整包。
- catalog 后只请求首图需要的 block。
- Range block cache 命中与并发去重。
- 后台物化启动、取消、续传、完成后新请求切本地。
- Range 被忽略、offset 错、短读、网络错误时自动降级。
- 远端 size/mtime 变化使 catalog、block、密码 identity 与完整 cache 失效。
- 流式与 cache 清空并发不复活已清数据。

### 12.5 全量回归门槛

完成声明前必须执行并保存结果：

```bash
npm test
npm run type-check
npm run build
cargo test
cargo build
npm run tauri -- build --no-bundle
```

若当前环境无法完成某个平台构建，自动化测试不能代替明确的未验证声明。Windows portable 必须实构建；RAR C++ 内核至少在 Windows CI 构建。macOS/Linux 随 Phase 9 环境补 archive smoke build，但实现不得加入仅 Windows 可用的路径或 ABI 假设。

禁止通过删除既有测试、放宽断言、扩大 timeout 或静默吞错来获得全绿。任何既有测试调整必须说明是接口形态变化还是行为变化；本规格不允许未批准的行为变化。

## 13. 验收清单

### 13.1 本地

- CBZ/ZIP 未加密与 ZipCrypto/AES 包均可浏览、缩略图和阅读。
- CBR/RAR 的 RAR4/RAR5 未加密与加密包均可浏览和阅读。
- 7z 普通/solid、未加密/加密文件名包均可浏览和阅读。
- 错误密码可重试，取消留在原目录，正确密码本次运行内复用，重启后重新询问。
- 大 ZIP 不再产生整包 `Vec<u8>` 副本。

### 13.2 远程

- WebDAV/SMB ZIP 首开通过 Range 返回目录和首图，不等待整包下载。
- 后台物化完成后后续读取切本地 cache，二次打开命中 cache。
- Range 不支持时自动完整下载；断点续传、远端变化、LRU 和手动清空继续有效。
- WebDAV/SMB RAR/7z 完整物化后正常解锁、浏览与阅读。
- 密码不出现在网络请求、缓存元数据和日志中。

### 13.3 明确拒绝

- 分卷 RAR/7z/multi-disk ZIP 显示单卷限制，不崩溃、不扫描相邻文件。
- 不支持 codec 显示具体类别，不误报密码错误。
- 损坏包显示损坏错误，不污染导航、历史或密码缓存。

## 14. 实施边界与提交拆分原则

实现计划应按以下可独立验证的边界拆分：

1. 依赖/MSRV/许可 spike 与 fixture 基线。
2. 锁定现有 ZIP 行为。
3. ArchiveBackend 抽象与 ZIP 路径化迁移，保持零行为变化。
4. 类型化错误、密码 store、prepare/unlock IPC 与密码弹窗。
5. ZIP 全密码支持。
6. RAR/CBR backend。
7. 7z backend。
8. Materializer 与预载五格式泛化。
9. RemoteZipReader、块 LRU、自动降级与后台物化切换。
10. 全量回归、portable 构建、文档与 UnRAR 许可归档。

每一步独立提交并运行对应定向测试。不得顺带重构 Reader、文件浏览器其他交互、缩略图调度或数据库模块。

## 15. 参考资料

- UnRAR 原始许可：<https://raw.githubusercontent.com/muja/unrar.rs/master/unrar_sys/vendor/unrar/license.txt>
- `unrar` API 与路径/顺序读取限制：<https://github.com/muja/unrar.rs>
- `zip` 加密与格式支持：<https://docs.rs/zip/latest/zip/>
- `ZipArchive::by_*_decrypt`：<https://docs.rs/zip/latest/zip/read/struct.ZipArchive.html>
- `sevenz-rust 0.6.1`：<https://docs.rs/crate/sevenz-rust/0.6.1>
- `sevenz-rust2` 最新版 MSRV 1.93（本模块不采用）：<https://docs.rs/crate/sevenz-rust2/latest/source/Cargo.toml>
