# RAR / CBR / 7z、全格式密码与远程 ZIP 流式读取设计

> 日期：2026-08-20
> 状态：用户已逐节确认，2026-08-24 第三轮书面规格审查修订完成；同日第四轮审查 7 项 P1 修订（RAR 统一低层打开与逐消息 callback 合同、session boot 代次、commit 退避复核、初始化错误收口、后台 progressKey 测试合同、Prepared 状态测试）；同日续审 4 项 P1（wchar_t 平台宽度、7z compress feature 拆分、probe 操作回归 trait、格式双重校验落地）与 3 项次要修订（boot 回拨恢复、multipart 附属卷流程、永久失败 key 回收）；第五轮 3 P1 + 1 P2（回拨恢复后 requestId 构造时序、`image_count` 空图语义、probe 逐条目资源限额、加密元数据单一真值源）；第六轮 2 P1 + 1 P2（probe 按前缀统计、混合包加密普通文件不阻塞可读图片、同毫秒 begin 竞态显式接受并合同化）；第七轮 3 P1 + 1 P2（ZIP backend 密码判定权收归 Service、7z dictionary 上限解码前自解析、7z fixture 显式 set_encrypt_header、RAR/7z prefix 测试改为真实目录构造）；第八轮 3 P1 + 1 P2（工作集预算 checked_add 拒绝而非 min 钳位、LZMA dict 取 properties[1..5]、7z 条目加密按 folder/AES coder 推导、7z 测试 helper 补全与 dict fixture 构造脚本化）；第九轮 4 P1 + 1 P2（helper 改用 push_archive_entry/set_content_methods 真实 API、TempDir 生命周期、create_7z solid 双路径定义、ArchiveLimits 完整定义与唯一 for_test 签名、spec LZMA 偏移同步）；第十轮 4 P1 + 2 P2（AesEncoderOptions 收 Password、for_test 默认生产级、声明大小未知分支删除改为谎报防线、dictionary 按条目所属 folder 计算、谎报拦截回归测试、helper 返回 TempDir guard）；第十一轮 3 P1 + 2 P2（增长-回退许可协议防谎报突破进程预算与死锁、list/stat 拆出工作集算法、谎报合同改 Service 层 fake backend、dict fixture 逐个合同说明、ZIP helper 补全）；第十二轮 3 P1 + 2 P2（许可记账 held_total = entry_dict + output_reserved、read_entry 扩 DecodeBudget/BudgetRetryRequired 接口、liar 测试改 fake SevenZ 承载非零 dict、防死锁测试加 timeout 与结果断言、spec fixture 计数同步 16/3）；第十三轮 4 P1 + 1 P2（预算覆盖范围收窄为解码期间工作集、DecodeBudget 显式持有 OwnedSemaphorePermit 的可编译构造、ZIP/RAR catalog 密码断言改 probe 候选遵单一判定合同、capacity 计费防 Vec 扩容低估、RAR 恰好达上限不误判）；第十四轮 3 P1 + 1 P2（删除 §4.5 末尾冲突旧合同、双谎报测试缩为 8 MiB 预算防 OOM、固定分块缓冲 + allocator 超额已知限制、permit_count 钳位 ≥1）；第十五轮 3 P1 + 1 P2（改单 Vec 受控增量扩容消除合并期 2×total 双份持有、尾块按非对齐剩余量计费、RAR callback 分配约束收窄为密码路径、try_grow 水位单调守卫）；第十六轮 2 P1（try_reserve_exact 的 additional 相对 len 而非 capacity、扩容目标覆盖单次 incoming 防未计费隐式扩容 + 两例回归）；第十七轮 2 P1 + 1 P2（7z open 前置边界：next_header_size/encoded-header unpack size/header coder dictionary 三值钳制 + encoded-header 构造性 fixture、删除 §4.5 末尾残留旧公式、闲余 capacity 测试制造真实 len<capacity 并在复制前断言显式 reserve）；第十八轮 3 P1（前置预检扩展到 num_files/folder/coder/pack-stream/substream 计数与位图长度、encoded-header decoder 独立 MAX_HEADER_DICT_BYTES=8MiB 上限使元数据路径免许可仍安全、spare-capacity 测试改独立 writer 并精确断言 required=1280KiB）；第十九轮 3 P1 + 1 P2（三上限常量命名固定 MAX_NEXT_HEADER_BYTES/MAX_ENCODED_HEADER_BYTES/MAX_HEADER_DICT_BYTES 逐字同步、计数预检明确 fork 或受限 header decoder 实现路径、start-header CRC+checked_add 定位不从尾部猜测、writer 测试改 ensure_capacity_for_write 可单测步骤区分预算目标与真实 capacity）；第二十轮 4 P1（header 防护唯一路线为自研受限 decoder + lzma-rust/aes/cbc 直接依赖 + 危险分配前验收、fixture 统一 16→18 含两个 header-* 构造夹具、writer 测试先预检后写入、损坏 start header 明确为有意兼容性退化 + 回归用例）；第二十一轮 3 P1（预检模块/直接依赖/MSRV/commit 范围纳入任务 1 与任务 6、外层 StreamsInfo 两阶段有界解析与精确数值上限、三个 header 防线测试 + fixture 字节合同）；第二十二轮 3 P1（内层 MainStreamsInfo 独立有界解析不复用外层 4 上限 + solid 多文件回归、防线测试改走 open_checked 生产链路 + 合法对照 open_call_count==1、lzma-rust 直接依赖 default-features=false 禁 encoder + feature-tree 验证）；第二十三轮 2 P1 + 1 P2（solid 测试改 create_solid_7z_with_files 真实 solid 载体 + folder/substream 断言、numfiles 夹具改合法外层 encoded header 携带恶意内层计数、feature-tree 命令 no-dev 排除测试 encoder）；第二十四轮 2 P1 + 1 P2（header coder 兼容矩阵 COPY/LZMA/LZMA2+BCJ+AES 对齐上游不缩减 + copy/lzma 合法 fixture、生成方案唯一化为 Python lzma FORMAT_RAW 并区分 raw/encoded 两族、solid 断言改 substreams_info 公开字段）；第二十五轮 2 P1 + 2 P2（solid 断言改 unpack_sizes.len（SubStreamsInfo 无 num_unpack_streams）、coder id 引用 SevenZMethod::ID_* 常量并补 DELTA/IA64、BCJ2 显式声明兼容性退化、fixture 计数统一 7+20 并删旧轮措辞、bytes_scanned_total 计数合同）；自审一轮（declared 测试残留 with_limit/exceeded 旧 API 改 budget 合同、writer_cap 统一为 output_cap 并在 spec 留唯一别名映射、LimitedEntryWriter 公开测试 API 与 PrecheckHarness/flip_start_header_crc 合同补全）；第二十六轮 2 P1 + 1 P2（MAX_HEADER_PACKED_BYTES=16MiB 独立上限 + pack_pos checked_add 防误拒 COPY 路径、DELTA/BCJ-X86 双 fixture 端到端验收并勘误 Python lzma filter chain 能力、Python 生成基线改环境记录锚定（双机器 3.11.4/3.12，首次生成环境为基线 + SHA-256 真值）、fixture 20→22）；第二十七轮 2 P1 + 2 P2（AES KDF numCyclesPower ≤ 24 两路径前置校验 + header-kdf-over fixture 与 kdf_invocations 测试、AES 判定改 SevenZMethod::ID_AES256SHA256 四字节比较、构造 fixture 计数十个/总数 23、基线语义改内容锁定不承诺字节级再生成）；第二十八轮 3 P1（cycles = b0 & 0x3F 低 6 位提取 + salt/IV 高位解析与 properties 精确长度 + 高位非零合法对照、KDF 测试合法对照显式传密码并断言 KDF 计数增加、content-kdf-over.7z folder 级 fixture + probe 测试 + 总数 24）；第二十九轮 1 P1 + 3 P2（AES properties 精确编码：b0&0xC0==0 时恰 1 字节，否则 b1 的 salt/IV 半字节公式 + 0x41 为 IV 标志勘误、PrecheckHarness 补 with_password/kdf_invocations 签名与计数覆盖两路径、文件清单补列 delta/bcj、22→24 注释同步）；第三十轮 2 P1（KDF 计数拆为可观测边界：header 路径注入自研 derive_key 真实计数 / folder 路径统计本模块 entry decoder 调用前置拒绝，不声称统计库内 KDF、自研 AES decoder 完整合同：UTF-16LE 密码/0x3F=salt||password 截断到 32B 直接作 key/迭代 KDF/IV 补零 16B/CBC 无 PKCS#7 + 含中文密码与 0x3F 双 known-answer 向量）；第三十一轮 2 P1 + 1 P2（迭代 KDF 勘误为单一 SHA-256 context 依次 update 只 finalize 一次 + 伪代码写死、临时秘密清零合同：Zeroizing 包裹密码/derived key + aes zeroize feature 清 key schedule + 工作缓冲不物化、KAT 固定为预核对提交的官方式向量）；第三十二轮 2 P1 + 2 P2（KDF 伪代码修正：salt/password 移入 counter 循环每轮重写、密码副本所有权改 Zeroizing<Vec<u8>> 持有 to_vec()、KAT 升级为 kat_vectors.json 字面量 + --print-kat 独立复算 + 0x3F 向量可直推内联、解密合同补密文 16 字节对齐校验并禁用 cbc 的 PKCS#7 API）；第三十三轮 2 P1（KAT 密码 UTF-16LE 长度勘误为 24B 并由脚本断言、kat_vectors.json 全路径进任务 1 清单与任务 6 git add 并注明不计入 24 fixture 计数）；第三十四轮 2 P1（生成流程补 gen_declared_dict.py 生成/--print-kat 复算/存在性校验三命令、测试过滤器改 source::archive::sevenz 前缀覆盖 backend+header_precheck 双模块并在预期显式列入 KDF 双防线与两组 KAT）；第三十五轮 1 P1 + 1 P2（RAR sink 删除固定 limit+1 预分配改为按 DecodeBudget 动态扩容 + 越界块无需保存第 limit+1 字节即中止、KAT 核对改 --verify-kat 自动化逐字段比对非零退出失败）；第三十六轮 1 P1 + 1 P2（callback 类型化错误优先于 UnRAR 原始返回码：三个调用点先 take state.error 仅无错误才映射原始码 + BudgetRetryRequired 穿真实 callback 的恢复测试、验收文字 --print-kat 残留同步 --verify-kat）；第三十七轮 1 P1 + 1 P2（NEEDPASSWORD/NEEDPASSWORDW 无密码分支先写 PasswordRequired 再中止（probe/catalog 双断言 + Service 层覆盖）、callback 单测改精确边界断言：恰好 8B Continue 保存、第 9B Abort 观察到但不保存 + ResourceLimitExceeded）；第三十八轮 2 P1（`DecodeBudget::for_limits` 防御分支按单元 `Cancelled` 变体构造修复编译、`BudgetRetryRequired` 补入 `ArchiveAccessError`——`#[serde(skip_serializing)]` 序列化守卫 + 任务 3 守卫断言 + Service 消费规则（唯一消费点/全量重试后终态兜底映射）——并接线 ZIP retry marker `BudgetRetryIoError` 与 `map_zip_io_error` 映射臂（映射单测四→五）、两处「任务 2 已定义」勘误为任务 3）；第三十九轮 1 P1 + 1 P2（`LimitedEntryWriter::ensure_capacity_for_write` 改 fallible 签名 `std::io::Result<(u64, u64)>`——越限/增长失败/分配失败经 marker 上抛、`write_all` 内部 `?` 传播、两处成功路径测试补 `.unwrap()`；ZIP 映射测试补第五条 `BudgetRetryIoError -> BudgetRetryRequired` 红灯断言并改自包含 marker 构造、删未定义 helper 引用）；第四十轮 1 P1 + 1 P2（FormatMismatch 测试修复编译：mock 与 descriptor 分离绑定（`webdav("")` 传入 `ensure_cached`、`mock.read_calls` 断言，不再把第三个返回值 Db 当 descriptor）、`unwrap_err()` 后直接 match `MaterializeError::FormatMismatch` 去掉多余 `Err(...)` 包装；`legacy_ready_row` 补完整 harness 合同——`descriptor: SourceDescriptor` 与 `mock: Arc<MockOrigin>` 两字段分离，预置 ready 行走生产 `cache_key` + `dao::upsert`，杜绝角色混用）；第四十一轮 1 必须修复（`LegacyRowHarness` 增加 `_cache_dir: TempDir` 字段并在 helper 返回时转移所有权——TempDir 是 RAII guard，只存 PathBuf 会在 helper 返回瞬间删掉 cache root 与预置 legacy 文件，命中断言全部失效）；第四十二轮 2 必须修复（`read_origin_range` 短 Range 从 `MaterializeError::Other` 改为新增 `RemoteRangeUnavailable(String)` 变体 + loader 显式映射臂 `RemoteRangeUnavailable → ArchiveAccessError::RemoteRangeUnavailable`（Other 会退化成 Io 错过降级触发）+ `From<MaterializeError> for MediaSourceError` 补 Network 臂；clear gate 测试补齐四入口断言——关闸后新增 `try_catalog`/`try_block_load`/`try_materialize` 三个独立新准入调用均断言 `Cancelled`，不再只测 ready hit（进行中 opening 是关闸前旧请求，覆盖不到其余三条路径））；第四十三轮 1 必须修复（`MaterializeError` 显式补单元变体 `Cancelled`（任务 8 错误定义处；现有枚举仅 Network/NotFound/Io/Other，subscriber 测试与 loader 映射臂已引用却无声明，无法编译）：取消 generation 命中/clear gate 拒绝 admission/subscriber 撤离三种终止统一返回它，`From<MaterializeError> for MediaSourceError` 补 `Other("cancelled")` 兼容臂，Service 与 loader 映射为 `ArchiveAccessError::Cancelled` 且不降级，取消路径由三处既有用例承载）；第四十四轮 1 建议修改（background progressKey 断言防空集合假通过：先存 `events` 断言非空 + 存在 `"ready"` 终态事件（沿用现有 emit_progress 的 phase 值域）再逐条比较 key；`ArchiveMaterializeProgress` typed 结构显式列出 `phase/downloaded/total_bytes/rel_path` 字段供测试编译）
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
| CBR / RAR | `unrar_sys 0.5.8` + 内置 RARLab UnRAR（不引入高层 `unrar` crate，见 §4.3） | RAR4、RAR5 加密（含 `-hp` 加密文件头） | 本地文件路径；读取经 UnRAR data callback 限流 |
| 7z | `sevenz-rust 0.6.1`，生产仅启用 AES 解码（`default-features = false`），测试构建经 dev-dependencies 另启用 `compress`（writer 生成 fixture） | 普通/solid、内容与文件名加密 | 本地文件路径 |

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
├─ rar_callback.rs     UnRAR data callback、限长输出与 FFI 安全边界
├─ sevenz_backend.rs   7z 路径读取
├─ password.rs         会话密码库与 archive identity
├─ remote_zip.rs       Range Read+Seek 适配与内存块 LRU
├─ cache_coordinator.rs runtime/磁盘 cache 的单一全局准入与清空协调器
├─ materializer.rs     现有整包物化，泛化格式并接入全局协调器
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

- `probe`：验证容器、识别多卷/加密、验证候选密码；`image_count` 与加密候选按 `entryPrefix` 视图统计，`entry_count` 为全容器计数（资源限额基线）。
- `catalog`：列出 `entryPrefix` 下的图片条目。
- `read_entry`：完整解压指定图片条目。
- `stat_entry`：返回条目解压后大小；时间不可可靠取得时继续返回 `None`。

所有 backend 保持当前目录语义：递归收集 `entryPrefix` 下的图片，返回相对路径，过滤非图片，自然排序，不合成虚拟目录。`ByteRange` 仍在完整解压单个条目后进行严格切片；offset + length 溢出或越界返回错误，不静默截断。

### 4.3 阻塞任务与并发

ZIP、UnRAR、7z 的解析/解压均视为阻塞 IO/CPU 工作，统一在 `tokio::task::spawn_blocking` 中执行，不占用 async runtime worker。

- ZIP backend：最多 8 个并发解码任务。
- RAR backend：最多 2 个并发任务。
- 7z backend：最多 2 个并发任务。

并发限制为进程级 semaphore。获取许可前可取消；ZIP/7z 任务已进入第三方同步库后不能强杀，只丢弃结果并禁止写入陈旧状态。RAR 是例外：probe/catalog/read/stat 全部直接经 `unrar_sys` 低层 API 走同一个 pre-open callback 打开器，不引入高层 `unrar` crate——其密码是在 `RAROpenArchiveEx` 返回之后才经 `RARSetPassword` 传入的，内部 callback 只处理 `UCM_CHANGEVOLUMEW` 与 `UCM_PROCESSDATA`、没有 `UCM_NEEDPASSWORD(W)` 分支，加密文件头（尤其 RAR5 `-hp`，header 解密阶段即索要密码）的 catalog 会失败；数据读取同样不得调用高层 `unrar::read()` 取得完整 `Vec` 后再检查长度。`OpenArchiveDataEx` 在 `RAROpenArchiveEx` 之前就写入 callback 与 user-data，不能等 handle 打开后才注册，否则加密 header 的密码请求会丢失。callback 逐消息处理，`p2` 不得统一当作长度：`UCM_PROCESSDATA` 的 `p1/p2` 是数据指针与字节数，构造 slice 前验证非空且为正；`UCM_CHANGEVOLUME(W)` 的 `p1` 是下一卷名指针、`p2` 是 `RAR_VOL_ASK/RAR_VOL_NOTIFY` 模式值而非长度，单卷策略不读缓冲直接终止并返回 `MultiVolumeUnsupported`；`UCM_NEEDPASSWORD` 的 `p1/p2` 是 ANSI 密码缓冲与字节容量（先清零缓冲、复制最多 `p2-1` 字节并写 NUL，仅作兼容 fallback）；`UCM_NEEDPASSWORDW` 的 `p1/p2` 是宽字符密码缓冲与 `wchar_t` 容量——先把 `p2` 个 `wchar_t` 清零，再复制截断到 `p2-1` 个 `wchar_t` 的平台宽字符密码并写 NUL，中文密码由此分支服务；未知消息 fail-closed 返回终止码并写入类型化错误。宽字符统一使用绑定实际导出的 `wchar_t` 类型（Windows 为 16 位、编码 UTF-16LE；Unix/macOS 为 32 位、编码 Unicode scalar），不得固定为 `u16`；编码/解码经单一平台适配 helper 供密码与 `FileNameW` 共用，并以编译期断言锁定宽度与所选分支一致。callback state 同时持有可选限长 sink、UTF-8 与平台宽字符两份 `Zeroizing` 密码（构造时预编码，callback 内不分配）和类型化错误；sink **最多观察到 `limit + 1` 字节但不得预分配该容量**（生产 limit 为 512 MiB，预分配会在解压开始就申请约 512 MiB，绕过按声明值取得的初始许可与增长协议）：sink 从已许可水位起按 `DecodeBudget` 动态扩容（与 §4.5 单 Vec 受控增量扩容同一合同），收到越界数据块时无需实际保存第 `limit + 1` 字节即可中止并映射 `ResourceLimitExceeded`。读取按 header 顺序推进，命中目标调用 `RARProcessFile(RAR_TEST)`，其余调用 `RAR_SKIP`；禁止 `RAR_EXTRACT`，不得向工作目录或 cache 写出 entry。FFI 边界使用 `catch_unwind`，任何 panic 都写入 state 并转换为终止码，绝不跨 C ABI unwind。单个任务 panic必须在 join 边界转换为类型化错误，不能使后续请求永久卡住。

### 4.4 目录索引缓存

增加进程内 catalog LRU，键为 archive identity + `size/mtime` 指纹 + `entryPrefix`，值为 `{ probe, catalog }` 元数据（加密信息以 probe 为唯一真值源，catalog 不携带加密标记），不包含图片字节或密码。最大 32 个 archive catalog；文件指纹变化、密码失效或 cache 清空时移除对应项。该缓存不写 DB，退出自动释放。

catalog cache 只证明"这份容器元数据曾被解析"，不能证明当前仍持有已验证密码。命中缓存时按缓存的 probe 加密标记复核同一 identity 的 password store；password 不存在则返回 `PasswordRequired`，不得仅凭 catalog hit 返回 `ready`。错误密码、显式 forget、文件指纹变化和 cache 清空同时移除对应 catalog。

### 4.5 资源上限

所有 archive 都视为不可信输入。并发 semaphore 之外增加以下硬限制，避免压缩炸弹、伪造元数据或超长目录耗尽内存：

- 单条目最大解压大小：512 MiB；读取过程中实际输出超过上限立即停止，不能只信 central directory / header 声明值。
- catalog 最大条目数：100,000；单条目规范化路径最大 4,096 UTF-8 bytes；超过任一限制返回 `ResourceLimitExceeded`。条目数与路径限制在 probe/catalog 的原始条目扫描中**逐条目**执行，包含被图片过滤丢弃的非图片条目——图片过滤不得先于限额，否则大量非图片条目或超长路径可绕过上限。
- `read_entry` 使用限长 writer/read loop，最多读取 `limit + 1` bytes 判断越界；不得按不可信 `unpacked_size` 直接 `Vec::with_capacity(unpacked_size as usize)`。
- RAR 的“实际输出”限制由 `unrar_sys` data callback 在每个数据块到达时执行；callback 只复制剩余预算并立即中止，禁止用 `unrar::read()` 先完整分配。RAR listing 的声明大小限制和 callback 的实际输出限制是两条独立防线、两组独立测试。
- 进程级并发解压工作集预算：512 MiB，**约束实际工作集而非许可数量**。主覆盖对象是 `read_entry`——`list/catalog/stat` 没有条目输出，仅走格式 semaphore 与元数据限制；**唯一例外是 7z 的 encoded header 解码**：它发生在 catalog 阶段却会分配 header dictionary + unpack 缓冲（合法边界内可接近 512 MiB），并发多个 7z catalog 会突破进程预算。因此 encoded-header decoder 使用**独立的小上限** `MAX_HEADER_DICT_BYTES = 8 MiB`（dictionary 与声明 unpack size 同限，超限在 open 前预检即拒，不进入解码）——小上限使元数据操作无需取得工作集许可即可保持安全，"预算只作用于 read_entry"的表述据此成立；若后续真实样本证明 8 MiB header 不够，再评估给 encoded-header 路径接入加权许可。三种格式的声明大小总是可得（ZIP central directory / RAR `UnpSize` / 7z entry size），不存在"未知声明"分支。`read_entry` 协议：① 按 `declaredSize.checked_add(entryDictionary)` 预检（`entryDictionary` 仅 7z 非零，按目标条目所属 folder 计——不取全容器最大值），溢出或总和超过 512 MiB 直接 `ResourceLimitExceeded`，不得 `min()` 钳位；② 按声明总和的 MiB 向上取整申请初始许可（诚实任务保持并发）；③ **增长-回退协议**：许可记账分两层——`output_reserved`（已许可输出）与 `held_total = entryDictionary + output_reserved`（总工作集，dictionary 常驻自初始计入；`writerCap = 512 MiB - entryDictionary`（即实现计划 `DecodeBudget::output_cap`，两文档以此处为唯一别名映射）只是输出上限而非总许可）。计费按**请求的 capacity**而非 `len`，采用**单 `Vec` 受控增量扩容**（不做"分块缓冲 + 交付合并"——合并会在旧 chunks 释放前同时持有约 2×total，仍处 budget 生命周期却只按 total 计费）：`LimitedEntryWriter` 每次写入先 `required = len.checked_add(incoming.len())` 预检（溢出或超过 `writerCap` 直接终态拒绝），扩容目标 = `max(required, min(capacity + 1 MiB, writerCap))`——**至少覆盖本次 incoming**（RAR callback 必须一次消费整个 p2 块，incoming 可超 1 MiB），尾块按 `min(1 MiB, writerCap - accumulated)` 精确计费（`writerCap` 不保证 MiB 对齐，整块计费会误拒合法的最后部分 chunk）；扩容前经 `DecodeBudget::try_grow(目标 capacity)`（同步非阻塞，匹配 RAR FFI callback 约束；budget 显式持有 `OwnedSemaphorePermit`，整体 move 进 `spawn_blocking`；`try_grow` 水位单调，倒退请求直接成功）取得许可，随后 **`try_reserve_exact(目标 capacity - len)`**——`additional` 相对当前 `len` 而非 capacity，传 capacity 差在 `len < capacity` 时可能完全不扩容、随后写入触发未计费的隐式扩容绕过预算；不触发几何倍增、无二次合并分配。测试必须含"单次 incoming > 1 MiB"与"已有闲余 capacity 但不足以容纳 incoming"两例回归（闲余用例使用独立 writer 先制造真实 `len < capacity`，并在复制 incoming 前断言显式 reserve 后 capacity 精确达到 required，不能只检查记账水位）。**已知限制**：Rust 分配器允许实际物理分配超过请求值，`try_reserve_exact` 不是精确分配合同——本预算约束的是请求的 capacity（记账值），allocator 超额残差不可由用户态约束、不宣称物理 RSS ≤ 预算；测试断言 `记账 capacity + dictionary ≤ 预算`。追加按前文同一扩容公式执行（`max(required, min(capacity + 1 MiB, writerCap))`，不重复定义），追加量 = 新旧差；失败则 backend 返回类型化 `BudgetRetryRequired`（Service 内部 marker，不透出前端；实现为 `ArchiveAccessError` 上 `#[serde(skip_serializing)]` 变体——serde 变体级语义为"尝试序列化即报错"，任何意外把它带到 IPC 边界的路径都会显式失败），Service 释放全部已持许可、丢弃中间输出、按 `entryDictionary + writerCap = 全预算` 全量重新排队并从头重解压（重试上限 1 次；全量持有下增长不可能再失败，若全量重试后仍返回该 marker 属实现契约违反，终态兜底映射 `ResourceLimitExceeded` 并记 error 日志）。等待全量的任务持有量为零，依赖图无环不死锁。**预算覆盖范围是解码期间的工作集**：`DecodeBudget` 在 bytes 交付上层时释放，交付后的 `Vec` 驻留不在本预算内（单条目 512 MiB 硬上限兜底，`MediaSource -> Vec<u8>` 契约不覆盖 media response 生命周期），不得宣称进程全生命周期峰值不超预算；多个谎报任务的**解码窗口**在时间上被串行化。必须有单任务谎报（声明和通过预检、实际输出越过 `writerCap` 被 writer 拦截）与**双谎报并发**（注入 8 MiB 预算、各声明 1 MiB 实际各输出 6 MiB → 解码期间并发工作集 ≤ 预算、timeout 内不死锁；不用生产级尺寸，避免测试进程真实持有数百 MiB）的 fake backend 回归测试。
- 7z 的 dictionary 边界由本模块自行执行：sevenz-rust 内置内存上限实为 `usize::MAX`（私有常量、不可注入，且 LZMA decoder 分支不做该检查），因此在任何解码之前解析 `folders[].coders[]` 的 LZMA / LZMA2 dictionary 声明——LZMA 要求 properties 长度 ≥ 5，dictionary size 为 `properties[1..5]` 的小端 u32（第 0 字节编码 lc/lp/pb，不得把"前 5 字节"整体当 dictionary），LZMA2 取首字节档位查表——超过 512 MiB 返回 `ResourceLimitExceeded`，不映射为损坏包；未知 coder 的 properties 不猜测。**打开阶段的前置边界**：`SevenZReader::open` 内部先按不可信 `next_header_size` 分配、encoded/encrypted header 路径还会按其声明 unpack size resize 缓冲、header 解析更会按 `num_files` 等计数**立即**创建条目 Vec（几个字节的恶意 header 即可在 catalog 限额检查之前耗尽内存）——这些都发生在本模块能看到 `archive().folders` **之前**，folder 级 dictionary 与 catalog 限额保护不到该路径。三个上限常量命名固定：`MAX_NEXT_HEADER_BYTES = 1 MiB`（next header 声明尺寸）、`MAX_ENCODED_HEADER_BYTES = 8 MiB`（encoded header 解码输出）、`MAX_HEADER_DICT_BYTES = 8 MiB`（header coder dictionary），另有 `MAX_HEADER_PACKED_BYTES = 16 MiB`（**packed header 输入**——`PackInfo.pack_sizes` 之和，是位于 `SIGNATURE_HEADER_SIZE + pack_pos` 的独立 packed streams 总量，不得复用 next-header 上限，否则 COPY 路径的合法 encoded header 会被误拒；`pack_pos` + 各 stream size 用 checked_add 校验不越出文件长度）。实现路线唯一确定：**自研受限 header decoder**（`sevenz_header_precheck.rs`，`lzma-rust = { version = "=0.1.7", default-features = false }`——其默认 feature 就是 encoder，必须关闭，与"生产只留解码"一致——与 `aes`（**`features = ["zeroize"]`**——清除 key schedule，自研 decoder 的临时秘密清零合同）/`cbc` 显式声明为直接依赖，后者在 sevenz-rust 中只是可选依赖，不能隐式依赖传递解析；不做上游 fork——fork 的钳制发生在 open 内部，时序矛盾且维护负担重），解码输出经本模块限长 writer 约束，验收条件为"在危险分配（任何按计数/尺寸驱动的 Vec 分配）发生之前拒绝"。解析分两阶段：**阶段一**解析外层 encoded-header `StreamsInfo`（纯声明、零分配——`numPackStreams ≤ 4`、`numFolders ≤ 4`、每 folder `numCoders ≤ 4`、packed 输入累加 ≤ `MAX_HEADER_PACKED_BYTES`、unpack 累加 ≤ 8 MiB、dictionary ≤ 8 MiB），任一越界即拒绝、不构造 decoder；**阶段二**受限解码内层 header 后**再执行一次有界解析**——内层 `MainStreamsInfo` 自带计数，不得复用外层 4 条流水线上限（会误拒单 folder 多文件的正常 solid 包）：内层 folders/coders/substream 计数各 ≤ 100,000、pack sizes 累加 ≤ 文件长度、`num_files ≤ 100,000`、位图长度 = `num_files` 字节边界。预检流程：先读 32 字节签名头验证 magic 与 start-header CRC32，按 `checked_add(SIGNATURE_HEADER_SIZE + next_header_offset, next_header_size)` 计算绝对区间并确认不越出文件长度（不得从文件尾部猜测）。**有意的兼容性退化**：上游 `Archive::read` 在 start-header 校验失败时会经 `try_to_locale_end_header` 在尾部搜索恢复，本模块收紧为直接拒绝（安全优先），须在 README 声明并有"损坏 start header 被拒绝且不进入尾部扫描"的回归用例。encoded header 的内层计数（`num_files`、substream 计数、empty-stream 位图长度 ≤ 100,000 / 阶段一各上限）由上述受限 decoder 解码后解析并钳制。必须有"encoded-header 超大声明 unpack size"（`header-encoded-oversize.7z`，外层声明即拒）、"header num_files 超限"（`header-numfiles-over.7z`，**合法外层 encoded header + 解码后内层 numFiles=100,001**——覆盖 kEncodedHeader → 受限 decoder → 内层解析的完整路径）、"KDF 成本超限"（`header-kdf-over.7z`，合法外层 + AES cycles 超限——**密钥派生启动前即拒**，`header_kdf_invocations == 0`）与 **folder 级 KDF 载体 `content-kdf-over.7z`**（raw kHeader、header 可见，数据 folder 的 AES cycles 超限，probe 阶段即拒）四个恶意构造性 fixture，以及 `header-copy.7z`/`header-lzma.7z`/**`header-delta-lzma2.7z`/`header-bcj-x86-lzma2.7z`**（DELTA+LZMA2 与 BCJ-X86+LZMA2 双 coder 链，经 `open_checked` → catalog 完整链路验收——Python lzma FORMAT_RAW 原生支持这些 filter chain）四个合法 encoded-header 变体，共 24 个 fixture 进入哈希清单（字节合同见实现计划），测试走 `open_checked` 生产链路并断言错误类型、"合法对照（显式传密码、KDF 计数增加）/恶意不增 KDF"、solid 单 folder 多 substream 回归通过。**AES coder 判定与 KDF 上限**：加密判定一律与 `SevenZMethod::ID_AES256SHA256`（4 字节）比较，不得手写截短 ID；AES properties 解码对齐 7-Zip：`cycles = b0 & 0x3F`（低 6 位），`b0 & 0xC0 == 0` 时 properties 恰好 1 字节，否则 `salt_len = ((b0 >> 7) & 1) + (b1 >> 4)`、`iv_len = ((b0 >> 6) & 1) + (b1 & 0x0F)`、总长 `2 + salt_len + iv_len`（长度不符即 `CorruptArchive`；直接比较 `properties[0]` 会误拒 SevenZWriter 默认带 IV 的正常加密包），`cycles ≤ 24`（特殊值 `0x3F` 接受——该分支的 KDF 是 `salt || password` 截断/零填充到 32 bytes 直接作 key，见实现计划的完整 KDF 合同）在任何密钥派生前校验（encoded header 预检与 folder 级检查两条路径都覆盖），其余拒绝 `ResourceLimitExceeded`——恶意归档不得用一个字节触发约 2^n 次 SHA-256 的 CPU 拒绝服务。**header coder 矩阵**：coder id 以 sevenz-rust `SevenZMethod::ID_*` 字节合同为准；完整支持线性链（COPY/LZMA/LZMA2/DELTA/BCJ 六架构变体/AES）；**BCJ2 显式声明为兼容性退化**（多输入 coder graph，受限解码器不支持，如实 `UnsupportedCodec`）——与损坏 start-header 退化同级，在 README 与验收清单声明。

上限首版固定为后端常量，不新增设置项；后续若真实漫画样本证明 512 MiB 单图不足，再独立设计可配置策略。

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

`image_count` 与加密候选均按当前 `entryPrefix` 视图统计。当前视图有图片时只认加密图片：未加密图片 + 加密普通文件的混合包直接 `ready`，不得为阅读图片索要并不需要的密码。没有图片的加密包以第一个加密普通文件验证：验证成功仍返回 `EmptyArchive` 并缓存密码（不误报密码成功，也不进入无图 archive），验证失败返回 `WrongPassword`。当前视图 `image_count == 0`（含完全空包）一律 `EmptyArchive`；只有当前视图存在图片条目才可能返回 `ready`。

## 6. 打开状态机与 IPC

### 6.1 新命令

新增五个 Tauri command，并继续只由 `src/lib/tauri.ts` 封装：

- `begin_archive_session(sessionId, bootMs) -> u64`（返回生效代次）
- `prepare_archive(descriptor, requestId) -> ArchivePrepareResult`
- `unlock_archive(descriptor, password, requestId) -> ArchivePrepareResult`
- `commit_archive_open(requestId) -> ()`
- `cancel_archive_prepare(requestId) -> ()`

返回结果为带 tag 的结构化枚举：

```text
ready { accessMode: local | streaming | materialized, progressKey: string | null }
passwordRequired
```

命令在 probe、Range 准备或完整物化结束后才返回；等待期间的 `materializing` UI 状态继续由 archive 进度事件驱动，不把一个无人接管的中间结果返回给前端。远程结果的 `progressKey` 是后端生成的 opaque cache key，前端只保存并用于匹配当前 archive 的后台事件，不自行重算。错误使用结构化 `ArchiveAccessError`，不由前端解析字符串。`forget_archive_password` 只保留 Rust 内部方法；前端没有“永久记住/忘记”按钮。

`requestId` 固定为 `{ sessionId: string, sequence: u64 }`。每次 WebView 生命周期生成一个随机 UUID sessionId，并在首次 archive 请求前调用 `begin_archive_session`；sessionId 最长 64 bytes 且必须是 UUID 文本，`bootMs` 是前端模块求值时用 `Date.now()` 捕获的页面代次，任一无效值返回结构化 `InvalidRequest`。Rust 针对单主窗口只保存一个 `currentSession`（含其 `boot_ms`）。相同 session begin 幂等并返回该 session 的 boot；新 session 不再无条件视为 rollover——只有 `bootMs >= current.boot_ms` 的 begin 才原子取消旧 active、删除旧 session 状态并拒绝其迟到 prepare/unlock/commit（迟到 cancel 为幂等 no-op），`bootMs` 严格更旧的 begin 不安装、不取消任何状态，直接返回现有 session 的生效代次，使被销毁 WebView 的迟到 begin 无法反向夺取已建立的新 session。`Date.now()` 非严格单调（系统时钟回拨后新页面 boot 更旧）是已知限制，恢复机制：存活的过期调用方发现返回值大于自身上报 boot 时，换新 UUID、以返回值 + 1 为 boot 重试一次。boot 值只在前端代次之间比较，Rust 不与自身时钟对比，不存在跨时钟偏差；同毫秒并列时后到的 begin 接管——这是为 HMR 同页换代选择的有意语义（先到者胜会杀死同毫秒的页面内换代）。"迟到 begin 无法反夺"的保证以 boot 严格更旧为界：跨 WebView reload 的 boot 必然相差百毫秒以上、已被更旧拒绝覆盖；同毫秒且到达顺序颠倒的理论竞态明确接受（Tauri 同窗口 IPC FIFO 使跨页乱序实际不可达），并以"同 bootMs 后到者接管"合同测试锁定。因此空间不随 WebView reload 数增长。

当前 session 只保存单调 `cancelledThrough`、精确 `lastCommitted: u64 | null` 与至多一个 active request。每次打开递增 sequence；同一候选的 prepare、unlock、commit、取消和候选物化进度都携带同一个 id。新请求注册时原子取消/替换旧 active；前端也必须在发出新 prepare 前先取消旧 id。`cancel_archive_prepare(N)` 幂等推进取消高水位并取消 active.sequence <= N 的未提交请求，所以 cancel 即使先于 register 到达也不会丢失。commit 只接受 Prepared active，成功后保存精确 `lastCommitted=N` 并移除 active；只有同一个 N 的重试直接成功且不重复启动预载，不能把所有 `sequence <= N` 推断为已提交。cancel 已提交 id 为 no-op，旧 Prepared 的迟到 commit 必须拒绝。

请求状态为 `Running -> AwaitingPassword | Prepared -> Committed`，任意未提交状态都可转 `Cancelled`。`prepare/unlock` 返回 `ready` 时只进入 `Prepared`，绝不启动非阻塞后台预载；前端先原子提交导航，再显式调用幂等 `commit_archive_open(requestId)`。只有 `Prepared -> Committed` 成功后，后端才把该请求的可选后台物化 subscriber 加入 Materializer 并启动/提升预载。前端若在本地提交前取消或丢弃迟到回包，则调用 cancel，后台任务不会逃逸。commit IPC 失败不回滚已提交导航：前端保留 requestId，以同一 id 最多重试 3 次（短退避）；每次退避等待结束、发送 commit IPC 前必须复核请求 epoch——已被新 open/取消/退出取代的请求不得再发送 commit，直接转入 cancel 清理，因为后端对已 commit id 的 cancel 是 no-op，迟到 commit 会把已取消的 Prepared 变成无法停止的后台预载。最终失败时 best-effort cancel、清除 commit-pending id 并回收该请求的 progressKey（后台物化已不存在，迟到 key 事件不得再把 UI 推入"后台缓存中"），不能丢弃 id 后让 Prepared 永久泄漏。新打开和退出也会取消该 commit-pending id。

取消检查覆盖：取得全局 cache 准入与格式 semaphore 前、每个 Range/下载 chunk、远端二次 stat 后、第三方同步 backend 返回后、catalog/block/DAO/rename 提交前。同步第三方库调用不能强杀时允许其完成，但结果必须丢弃且不得写入缓存或密码 store。物化 in-flight 去重时，每个交互请求作为独立 subscriber；取消只移除自身，最后一个交互 subscriber 取消且没有已 commit 的后台 subscriber 时才停止共享下载。共享任务的进度向所有活动交互 subscriber 各 fan-out 一份；后台事件使用 `requestId: null` 和 Ready 返回的同一 `progressKey`。

候选 descriptor 未提交期间，前端以独立 `pendingArchiveOpen` 保存候选 identity、`archiveRelPath`、结构化 `requestId`、请求 epoch 与 `opening/materializing` 状态。进度事件使用 serde camelCase 的类型化载荷 `{ requestId, progressKey, relPath, downloaded, totalBytes, phase }`；候选 UI 只接受两个 requestId 字段都相等的事件，当前 archive 的非阻塞后台进度只按已提交 Ready 的 opaque `progressKey` 匹配；不能用 relPath、前端闭包 epoch 或自行派生 cache key 推断事件归属。后台 Materializer subscriber 必须保存 commit 传入的 progressKey，并从 subscriber state 给每一条事件赋值，不能只把参数停留在 Prefetcher API。新打开请求、取消或离开页面都会推进 epoch，原子摘走旧 pending/password/commit-pending id 并在注册新请求前调用后端取消；旧回包与迟到事件必须被丢弃。该 pending 状态只在内存中存在，不写持久化 store。

### 6.2 事务式打开

文件浏览器先构造候选 descriptor，但不修改 `currentDescriptor/currentPath/archiveParent`：

```text
idle
  → probing
  → password-required → unlocking → prepared → UI commit → backend commit → ready
                      ↘ wrong-password → password-required
                      ↘ cancel → idle
  → materializing → prepared → UI commit → backend commit → ready
  → error → idle
```

只有后端返回 `ready` 且 request/epoch 仍有效时，前端才提交导航状态、历史、快捷方式身份和列表加载；提交后立即发送 `commit_archive_open`，后端收到 commit 后才启动可选后台物化。取消、密码错误、网络失败或坏包都留在原目录，不产生半切换状态。

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

`Read` 边界必须用自定义 `RemoteZipIoError` 作为 `std::io::Error` 的 inner source 保存 `RemoteRangeUnavailable/Network/Timeout/Cancelled` 分类；Materializer 侧 Range 供给长度不符以 `MaterializeError::RemoteRangeUnavailable` 类型化上抛、loader 原类恢复，不得经 `Other` 扁平化为 `Io` 而错过 §7.4 的降级触发。限长 writer 用独立 `LimitedEntryIoError` marker 表示越界。`zip_backend::map_zip_io_error` 的映射顺序固定为：先恢复 `RemoteZipIoError`；再把 `LimitedEntryIoError` 映射为 `ResourceLimitExceeded`；再把 ZIP payload 完整性校验产生的 `ErrorKind::InvalidData` 映射为 `CorruptArchive`；最后才映射普通 `Io`。`map_zip_error(ZipError::Io)` 委托同一 helper。所有 entry payload 的 `Read::read`、`read_to_end`、`io::copy`、CRC/MAC 完整性验证和限长 writer 路径都必须经该 helper，因为这些调用直接返回 `std::io::Error`，不能假设都会再次包装为 `ZipError::Io`。自动降级测试必须分别覆盖 catalog/open 阶段和“catalog 成功、读取首个 entry payload 时网络失败”阶段，并穿过真实 `RemoteZipReader -> zip::ZipArchive -> ZipBackend -> ArchiveService`。

固定参数：

- Range block：1 MiB。
- 全局远程 ZIP 块缓存预算：32 MiB。
- LRU key：archive identity + block index。
- 同 key block 请求 in-flight 去重。
- 返回长度和 offset 必须符合现有强 Range 契约，否则判定流式不可用。

块只存在 RAM，不写 SQLite。archive 指纹变化、cache 清空或应用退出时失效。

catalog LRU、Range block LRU、Materializer ready-path/cache-hit 检查和完整物化共享唯一 `ArchiveCacheCoordinator`。Coordinator 用短持有的 `std::sync::Mutex<State>` 原子完成“检查 clearing + 注册 admission”，返回同步 Drop 的 `AdmissionGuard`；所有 archive runtime 与 Materializer 路径必须在任何 catalog/block/DAO/ready 磁盘 cache 查询之前先取得 admission，因此 cache hit 也不能绕过清空闸门。guard Drop 同步减少 active 计数并通知 drain waiter，不在 Drop 中启动 async 工作。

`begin_clear` 在同一 mutex 内置 `clearing=true`、推进 generation 并返回 `ClearGuard`，从这一刻起 runtime 和 Materializer 新 admission 全部返回 `Cancelled`；随后 `wait_drained(timeout)` 等待已有 guard 归零，再清 runtime LRU、磁盘与 DAO。loader 在每个提交点复核 guard generation。`ClearGuard::drop` 同步复位 clearing 并通知等待者，所以错误、timeout 或 panic 路径都不会遗留闸门。禁止串联两个独立 gate，也禁止“先查 ready cache、miss 后才 admission”的顺序。

### 7.3 后台物化与切换

远程 ZIP prepare/probe 成功并返回 `Prepared` 后，必须等待前端 `commit_archive_open`；commit 成功后：

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
- 流式请求超时（`Timeout`）；`Cancelled` 不降级，直接静默终止陈旧请求。

UI 从“正在打开”切换为“正在下载完整压缩包…”，继续显示既有物化进度。完整物化也失败时才返回最终网络/IO 错误。

### 7.5 RAR/CBR/7z

本地文件直接交给路径 backend。远程文件先走完整 Materializer，成功后交给同一个路径 backend。密码只在本地解码阶段使用，不进入 SMB/WebDAV 请求。

UnRAR 只接受路径并按顺序处理条目；7z 尤其 solid archive 的随机单条读取可能需要解码整个 solid block。因此本期不为两者实现伪流式，也不把整包展开到临时目录。

## 8. Materializer 泛化

保留现有状态机，只修改格式假设：

- 格式闸门允许 `cbz/zip/cbr/rar/7z`。
- 最终路径从 `{cacheKey}.zip` 改为 `{cacheKey}.{normalizedExt}`。
- normalizedExt 由 descriptor format 决定，并与 `archiveRelPath` 扩展名双重校验；不一致（descriptor 声称 rar、路径 book.zip 等）在下载前返回稳定错误（`FormatMismatch` 映射 `InvalidRequest`），不得把坏组合交给 backend 报随机错误。
- `.part` 与 `.part.meta` 命名保持 `{cacheKey}.part`，sidecar schema 不增加密码。
- DAO 的 `cache_abs_path` 已是字符串，无需 migration；既有 `.zip` 行继续有效。
- 启动清理、磁盘一致性、远端失效判定、条件删除、容量统计和 LRU 语义不变；原 Materializer 独立清空闸门并入 §7.2 的唯一 `ArchiveCacheCoordinator`，所有 cache hit/miss 都先 admission。
- in-flight 去重扩展为明确 subscriber 模型：交互请求按结构化 requestId 独立取消和接收进度；commit 后的后台 subscriber 保存 Ready 的 opaque progressKey 且不受 UI 取消影响；没有任何 subscriber 时才取消物理下载。现有直接拼 `serde_json::json!` 的进度分支统一替换为类型化 serde payload，交互/后台路径不能漏掉 requestId 或 progressKey。
- 前端 metadata/content 预载过滤扩展到五种格式；预载只下载原始包，不探测或弹出密码。

多卷按两层识别：`.partNN.rar`、`.rNN`、`.7z.NNN` 等明确文件名模式在调用 backend 前拒绝；普通 `.rar/.cbr/.7z` 则由 backend 打开后的 volume/split 元数据识别并立即停止。任一层确认多卷都返回 `MultiVolumeUnsupported`，不得自动扫描、请求或下载相邻卷。

ZIP/CBZ 在构造 catalog 前检查 EOCD 与 ZIP64 locator/EOCD 的 disk number、central-directory start disk 和 per-disk entry count；任一字段表明 multi-disk 即返回 `MultiVolumeUnsupported`。不得依赖 `zip` crate 的通用 unsupported/corrupt 文本来分类。

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
| `ResourceLimitExceeded` | 说明条目或容器超过安全资源上限 |
| `EntryNotFound` | 显示条目已变化或不存在 |
| `RemoteRangeUnavailable` | 内部降级，最终失败前不弹出 |
| `Cancelled` | 静默回原目录或丢弃陈旧结果 |
| `InvalidRequest` | 拒绝非法 session/request 合同并记录非敏感诊断 |
| `Io/Network/Timeout` | 沿用现有媒体源提示与状态码 |

backend 原始错误必须在各自模块映射，不把第三方库字符串直接暴露给前端。media protocol 保留现有 HTTP 状态语义；密码错误不得降级成通用 500 并无限重试。

`FileBrowser` 必须捕获 `openArchive` 全链路的 rejected promise（含 `begin_archive_session` 初始化——它必须位于与 prepare 相同的 try/catch 内）：`Cancelled` 静默清理候选，初始化失败也写入仅内存的 `archiveOpenError` 并允许下一次 open 重试，其余错误同样写入并由 UI 按上表映射；不得从双击/click handler 泄漏未处理 Promise。错误、密码请求和取消都不得修改原导航。至少为 `MultiVolumeUnsupported`、`ResourceLimitExceeded`、`Network` 和 `CorruptArchive` 建立 store/UI 测试。

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

三种 backend 复用同一组语义断言：catalog、read、Range、stat、Unicode、嵌套目录、空包、损坏包、非图片过滤。（“扩展名/格式不一致”不属 backend 合同——`ArchiveInput::Reader` 没有路径与声明格式——归 Service/Materializer 合同，由 §8 双重校验覆盖。）

密码 fixture 矩阵：

- ZIP：ZipCrypto、AES AE-1、AES AE-2。
- RAR：RAR4、RAR5、RAR5 `-hp` 加密文件头（catalog 密码回调的载体）、仅加密非图片条目与空包（probe 兜底/`EmptyArchive` 合同）、`a/note.txt` + `b/page.png` 混合目录（prefix 视图统计）。
- 7z：普通、solid、加密文件名。
- 每类覆盖无密码、正确密码、错误密码、取消、会话复用、文件变化后缓存失效。
- 三种 backend 都必须覆盖六组 probe 合同：① 未加密纯非图片 archive（直接 `EmptyArchive`）；② 仅加密非图片条目的 archive（先 `PasswordRequired`，经首个加密普通文件验证成功后仍 `EmptyArchive` 且密码入库，失败 `WrongPassword`）；③ 真正空包（`EmptyArchive`，不误报密码）；④ header 可列出但内容密码错误（`WrongPassword`）；⑤ "B 目录有图片、A prefix 无图片"的 prefix 视图回归（`image_count` 按视图统计、`entry_count` 全容器）；⑥ 未加密图片 + 加密普通文件的混合包（不弹密码直接 `ready`）。并以注入小上限断言非图片条目数与超长非图片路径同样触发 `ResourceLimitExceeded`（等价覆盖 100,001 条目场景）。

RAR 库不能创建 archive；仓库提交最小测试 fixture，内容只使用自生成色块图片，同时提交可执行生成脚本/命令与 README。ZIP 基线固定为 7-Zip 24.09 的 ZipCrypto，以及 Python ≥ 3.11（双机器环境 3.11.4/3.12 均可执行；**可复现承诺限定为内容锁定——不承诺跨机器字节级再生成**，README 记录首次生成版本仅供诊断，重生成与提交哈希不一致时以已提交产物为准）+ `pyzipper==0.4.0` 通过 `force_wz_aes_version=1/2` 显式生成的 AES AE-1/AE-2；生成脚本负责确定性输入、AE-1/AE-2、multi-disk ZIP，并显式调用/验证固定版本的 7-Zip 生成 ZipCrypto；脚本必须解析 AES extra field，断言 vendor version 分别为 1/2，并校验 AE-2 CRC 为 0。RAR 基线固定为 WinRAR CLI 7.11 的 `rar.exe`，README 记录完整参数，脚本只生成 RAR 输入并验证外部产物。每个 fixture 记录工具版本、完整命令、格式、密码仅测试用途及 SHA-256；哈希清单显式枚举且断言恰好二十四个 archive 文件，不包含脚本、README、输入图片或额外分卷（multipart 附属卷仅生成期校验使用，校验后、哈希前删除；十一个 `dict-*`/`header-*`/`content-*` 构造性 fixture 由 `gen_declared_dict.py` 生成，coder properties 与 header 声明受控，payload 压缩用 Python 标准库 lzma FORMAT_RAW；**可复现承诺限定为内容锁定**——`lzma` 输出随链接的 liblzma 版本变化，跨机器（本机 3.11.4 / racyan 3.12）重生成字节不同属预期，已提交 SHA-256 为真值、不一致时丢弃重生成结果）。不得使用“任选可用工具”或 `ZipWriter` 的单一 AES vendor version 代替三类证据。7z 优先在测试中生成；库无法生成的特定变体使用同样有脚本、版本和哈希的最小 fixture。

### 12.3 单卷与安全

- RAR 分卷、7z 分卷、multi-disk ZIP 都返回 `MultiVolumeUnsupported`。
- descriptor JSON、DB 行、日志、事件、sidecar 和错误文本扫描不得包含测试密码。
- 错误密码不进入 store；正确密码在 drop/clear 后内存容器执行清零逻辑。
- 第一个加密条目完整校验，锁住 ZipCrypto 错误密码误通过防线。
- 已解锁 catalog 命中后清除 password store，再次 prepare 必须返回 `PasswordRequired`。
- 超大声明值、实际解压越界、catalog 条目数和路径长度越界都返回 `ResourceLimitExceeded`，且进程继续可用。RAR 不通过篡改 CRC 保护的 header 构造该测试：合法 fixture + 低 limit 测 listing 声明大小分支；另用仅限测试的 policy 绕过声明值短路，使同一合法 fixture 穿过真实 `RAROpenArchiveEx -> callback -> RARProcessFile(RAR_TEST)` 并在实际输出达到 `limit + 1` 以内中止。测试断言类型化资源上限错误、工作目录/cache 无新增 entry、abort 后下一次正常请求成功；加密 header fixture 在 read 与 catalog 两条路径另行证明 password callback 在 open 前已注册（含中文密码的 `UCM_NEEDPASSWORDW` 分支与错误密码映射）。纯 callback helper 单测不能替代这两个 FFI 集成合同。

### 12.4 远程 ZIP 流式

WebDAV 与 SMB mock 运行同一合同：

- 首个数据请求为包含 EOF 的最后一个 1 MiB block，而非 `0..size` 整包；断言按 block 对齐，不假设 offset 位于末尾 128 KiB。
- catalog 后只请求首图需要的 block。
- Range block cache 命中与并发去重。
- prepare 返回 Streaming 时后台物化尚未启动；只有对应 `commit_archive_open` 才启动，取消或迟到回包不启动；逐字节断言 Ready 的 `progressKey` 与该后台 subscriber 后续每一条 `requestId=null` 事件一致；commit 永久失败取消后该 key 被回收，任何 key 的后续事件不再更新 UI。
- 后台物化启动、取消、续传、完成后新请求切本地。
- Range 被忽略、offset 错、短读、Network 或 Timeout 时自动降级；Cancelled 不降级。
- 远端 size/mtime 变化使 catalog、block、密码 identity 与完整 cache 失效。
- 流式与 cache 清空并发不复活已清数据。
- Range 错误分类必须分别穿过真实 `ZipError::Io` 和 entry payload 直接返回的 `std::io::Error` 边界后仍触发自动降级；`map_zip_io_error` 分别锁定 Remote marker、limit marker、CRC/`InvalidData` 与普通 IO 的映射顺序。
- 取消 prepare 后后端 Range/完整物化停止或仅为其他 subscriber 继续；新 open 在注册新 request 前先取消旧 Prepared，被取消对象必须确实处于 Prepared/commit-pending（测试先让首个 prepare 返回 Ready、阻塞首个 commit IPC 制造该状态，不能以 Running 状态的取消冒充），同一路径立即重开时旧 requestId 的进度、回包和迟到 commit 都不能污染新请求。commit 退避等待期间被取消/取代的请求苏醒后不得再发送陈旧 commit（fake timers 锁定）。session 初始化失败写 `archiveOpenError` 且下一次 open 重试成功。cancel-before-register 由 `cancelledThrough` 拒绝；故意跳号后只允许精确 `lastCommitted` 重试，不能把空洞内旧 id 当作已提交。
- WebView session rollover 会取消旧 active、回收旧 session，并拒绝旧 session 的迟到命令；更旧 `bootMs` 的迟到 begin 不改变已建立 session 的任何状态并返回生效代次（不影响其 Prepared/commit），携带生效值 + 1 的换代 begin 完成时钟回拨恢复；重复 reload 后 registry 大小保持常数。非法/超长 sessionId 被结构化拒绝。
- commit IPC 暂时失败后以同一 requestId 重试成功只启动一次预载；连续 3 次失败后调用 cancel，导航不回滚且 registry 不残留 Prepared。
- Materializer 同 key subscriber 合同：A/B 都先收到基线事件，记录各自计数后取消 A；随后 A 计数不再增长，B 计数增长并收到完成事件。交互 + 已 commit 后台 subscriber 中交互取消不停止物理下载；所有交互 subscriber 都取消且无后台 subscriber 时物理下载停止。后台 subscriber 以显式 progressKey attach（`attach_background(progress_key)`），其产生的全部事件都携带该 key 且 `requestId=null`，证明 key 真正写入 subscriber state。
- 清空开始后新 catalog/block/ready-cache/materialize 路径都被同一个全局 coordinator 拒绝；清理测试必须先 spawn clear、等待 clearing/drain gate 已建立，再释放受控 Range/下载，最后 await clear，避免测试自身死锁。另用注入的短 drain timeout 证明错误返回后 `ClearGuard` 已同步复位、后续 admission 不会死锁。正常清理结束时 runtime、磁盘与 DAO 均为空，闸门随后恢复。
- RemoteZipReader 并发/线程测试使用 multi-thread `#[tokio::test]`，显式捕获并 clone `tokio::runtime::Handle::current()` 给 `spawn_blocking`/OS thread；不得在普通 `#[test]` 中假设存在 runtime。

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

若当前环境无法完成某个平台构建，自动化测试不能代替明确的未验证声明。Windows portable 必须实构建；RAR C++ 内核至少在 Windows CI 构建。CI 需含 Linux `cargo check` 编译守卫，锁定 `wchar_t` 32 位平台的宽字符分支（Windows 运行测试 + Linux 编译测试双覆盖）。macOS/Linux 随 Phase 9 环境补 archive smoke build，但实现不得加入仅 Windows 可用的路径或 ABI 假设。

禁止通过删除既有测试、放宽断言、扩大 timeout 或静默吞错来获得全绿。任何既有测试调整必须说明是接口形态变化还是行为变化；本规格不允许未批准的行为变化。

## 13. 验收清单

### 13.1 本地

- CBZ/ZIP 未加密与 ZipCrypto/AES 包均可浏览、缩略图和阅读。
- CBR/RAR 的 RAR4/RAR5 未加密与加密包均可浏览和阅读。
- 7z 普通/solid、未加密/加密文件名包均可浏览和阅读。
- 错误密码可重试，取消留在原目录，正确密码本次运行内复用，重启后重新询问。
- 大 ZIP 不再产生整包 `Vec<u8>` 副本。
- 超大/恶意条目和目录命中资源上限时给出稳定错误，不造成无界内存增长。

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
4. 类型化错误、密码 store、prepare/unlock/cancel IPC 与密码弹窗。
5. ZIP 全密码支持。
6. RAR/CBR backend。
7. 7z backend。
8. Materializer 与预载五格式泛化。
9. RemoteZipReader、块 LRU、自动降级与后台物化切换。
10. 全量回归、portable 构建、文档与 UnRAR 许可归档。

每一步独立提交并运行对应定向测试。不得顺带重构 Reader、文件浏览器其他交互、缩略图调度或数据库模块。

## 15. 参考资料

- UnRAR 原始许可：<https://raw.githubusercontent.com/muja/unrar.rs/master/unrar_sys/vendor/unrar/license.txt>
- `unrar` 高层 crate 的密码时序与 `UCM_NEEDPASSWORD` 缺陷（本模块不采用的原因，见 §4.3）：<https://github.com/muja/unrar.rs>
- `unrar_sys 0.5.8` 的 `RARSetCallback` / `UCM_PROCESSDATA` 绑定：<https://docs.rs/unrar_sys/0.5.8/unrar_sys/>
- `zip` 加密与格式支持：<https://docs.rs/zip/latest/zip/>
- `ZipArchive::by_*_decrypt`：<https://docs.rs/zip/latest/zip/read/struct.ZipArchive.html>
- `sevenz-rust 0.6.1`：<https://docs.rs/crate/sevenz-rust/0.6.1>
- `sevenz-rust2` 最新版 MSRV 1.93（本模块不采用）：<https://docs.rs/crate/sevenz-rust2/latest/source/Cargo.toml>
