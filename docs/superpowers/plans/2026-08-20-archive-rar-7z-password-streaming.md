# RAR / CBR / 7z、全格式密码与远程 ZIP 流式读取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改变现有 Archive descriptor 和上层阅读链路的前提下，为 CBZ/ZIP/CBR/RAR/7z 增加全源、单卷、会话密码支持，并让远程 ZIP/CBZ 可以 Range 流式首开、后台完整物化和失败自动降级。

**架构：** 新增共享 `ArchiveService`，由 `ArchiveMediaSource` 与 session/prepare/unlock/commit/cancel IPC 共用；服务按格式分派 ZIP、RAR、7z backend，并持有会话密码库、目录 catalog LRU、远程 ZIP block LRU、结构化请求状态机和现有 Materializer。Archive runtime 与 Materializer 的 cache hit、loader 和清空统一经过单一 `ArchiveCacheCoordinator` 原子准入。ZIP backend 接受本地文件或 `Read+Seek` reader factory；RAR 通过 `unrar_sys` data callback 在解压过程中执行硬上限；7z 只接受本地路径。远程 ZIP 先通过 `RemoteZipReader` 读取，RAR/7z 继续完整物化。`prepare/unlock` 只产生 Prepared，前端原子提交导航后调用 `commit_archive_open` 才启动可选后台物化。

**技术栈：** Rust 1.75、Tauri 2、Tokio、`zip 2.4.2`、`unrar_sys 0.5.8`、`sevenz-rust 0.6.1`、`zeroize 1.x`、Vue 3、Pinia、Vitest。不引入高层 `unrar` crate（原因见任务 5 步骤 4）。

**规格：** `docs/superpowers/specs/2026-08-20-archive-rar-7z-password-streaming-design.md`

---

## 文件结构与职责

### 新建

- `src-tauri/src/source/archive/backend.rs`：统一 catalog、输入源、backend trait、类型化 Archive 错误、资源上限和格式分派。
- `src-tauri/src/source/archive/password.rs`：archive identity、会话密码库、清零语义。
- `src-tauri/src/source/archive/zip_backend.rs`：本地/远程 ZIP、ZipCrypto/AES、catalog/read/stat。
- `src-tauri/src/source/archive/rar_backend.rs`：单卷 RAR4/RAR5、密码、catalog/read/stat。
- `src-tauri/src/source/archive/rar_callback.rs`：UnRAR data callback、限长输出、错误桥与 FFI unwind 防线。
- `src-tauri/src/source/archive/sevenz_backend.rs`：普通/solid 7z、AES、catalog/read/stat。
- `src-tauri/src/source/archive/remote_zip.rs`：1 MiB Range block、32 MiB LRU、singleflight、cache generation、类型化 IO 桥和 `Read+Seek`。
- `src-tauri/src/source/archive/cache_coordinator.rs`：runtime/Materializer 共用的 admission、generation、drain 与 RAII clear guard。
- `src-tauri/src/source/archive/service.rs`：路径解析、probe/unlock、backend 调度、catalog LRU、流式降级和后台物化。
- `src-tauri/src/commands/archive_access.rs`：`prepare_archive` / `unlock_archive` / `commit_archive_open` / `cancel_archive_prepare` Tauri commands。
- `src/components/filebrowser/ArchivePasswordDialog.vue`：受控密码模态框。
- `src/components/filebrowser/ArchivePasswordDialog.test.ts`：键盘、提交、错误和安全文案测试。
- `src-tauri/tests/fixtures/archive/README.md`：fixture 来源、生成命令、密码和 SHA-256。
- `THIRD_PARTY_LICENSES/UNRAR.txt`：UnRAR 完整许可文本。

### 修改

- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`：固定兼容 Rust 1.75 的 archive/password 依赖。
- `src-tauri/src/source/archive/mod.rs`：导出新增 archive 子模块。
- `src-tauri/src/source/archive_impl.rs`：删除格式细节，改为调用 `ArchiveService`。
- `src-tauri/src/source/archive/materializer.rs`：五格式闸门、真实扩展 final path、origin Range 接口。
- `src-tauri/src/source/archive/prefetch.rs`：五格式预载与已打开 ZIP 后台物化入口。
- `src-tauri/src/source/archive/dao.rs`：增加按 key 查询 ready path 的明确 helper，不改 schema。
- `src-tauri/src/source/factory.rs`：构造并暴露共享 Materializer、Prefetcher、ArchiveService。
- `src-tauri/src/source/trait_def.rs`：Archive 类型化错误穿透到 media protocol。
- `src-tauri/src/commands/mod.rs`、`src-tauri/src/lib.rs`：注册 commands 与 managed state。
- `src-tauri/src/commands/archive_cache.rs`：cache 清理协调 Materializer 与 Archive runtime cache，并且测试不再假设 `.zip`。
- `src/lib/tauri.ts`：结构化 session/prepare/unlock/commit/cancel 类型和 IPC 封装。
- `src/stores/fileBrowser.ts`：候选 descriptor、pending 打开 epoch/进度、prepare 后原子提交、密码请求状态。
- `src/stores/fileBrowser.test.ts`：事务式导航、五格式、取消/错误零污染。
- `src/components/filebrowser/FileBrowser.vue`：驱动密码模态框、非阻塞后台缓存文案。
- `src/components/filebrowser/FileBrowser.test.ts`：密码交互、流式/降级 UI。
- `src/locales/zh-CN.ts`、`src/locales/en-US.ts`：Archive 密码与错误文案。
- `.github/workflows/verify.yml`：Rust 1.75 dependency check 与 Windows RAR build 守卫。
- `AGENTS.md`、`DESIGN.md`、`README.md`、`BUILD.md`：状态、格式能力、UnRAR C++ 构建与许可。

---

### 任务 1：依赖、MSRV、许可与 fixture 基线

**文件：**
- 修改：`src-tauri/Cargo.toml`
- 修改：`src-tauri/Cargo.lock`
- 创建：`THIRD_PARTY_LICENSES/UNRAR.txt`
- 创建：`src-tauri/tests/fixtures/archive/README.md`
- 创建：`src-tauri/tests/fixtures/archive/plain-rar4.rar`
- 创建：`src-tauri/tests/fixtures/archive/password-rar4.rar`
- 创建：`src-tauri/tests/fixtures/archive/plain-rar5.rar`
- 创建：`src-tauri/tests/fixtures/archive/password-rar5.rar`
- 创建：`src-tauri/tests/fixtures/archive/encrypted-headers-rar5.rar`
- 创建：`src-tauri/tests/fixtures/archive/password-nonimage-rar4.rar`
- 创建：`src-tauri/tests/fixtures/archive/empty-rar5.rar`
- 创建：`src-tauri/tests/fixtures/archive/mixed-dirs-rar5.rar`
- 创建：`src-tauri/tests/fixtures/archive/dict-oversize-lzma.7z`
- 创建：`src-tauri/tests/fixtures/archive/dict-oversize-lzma2.7z`
- 创建：`src-tauri/tests/fixtures/archive/dict-budget-oversum.7z`
- 创建：`src-tauri/tests/fixtures/archive/header-encoded-oversize.7z`
- 创建：`src-tauri/tests/fixtures/archive/header-numfiles-over.7z`
- 创建：`src-tauri/tests/fixtures/archive/header-copy.7z`
- 创建：`src-tauri/tests/fixtures/archive/header-lzma.7z`
- 创建：`src-tauri/tests/fixtures/archive/header-delta-lzma2.7z`
- 创建：`src-tauri/tests/fixtures/archive/header-bcj-x86-lzma2.7z`
- 创建：`src-tauri/tests/fixtures/archive/header-kdf-over.7z`
- 创建：`src-tauri/tests/fixtures/archive/content-kdf-over.7z`
- 创建：`src-tauri/tests/fixtures/archive/multipart.part1.rar`
- 创建：`src-tauri/tests/fixtures/archive/password-zipcrypto.zip`
- 创建：`src-tauri/tests/fixtures/archive/password-ae1.zip`
- 创建：`src-tauri/tests/fixtures/archive/password-ae2.zip`
- 创建：`src-tauri/tests/fixtures/archive/multidisk.zip`
- 创建：`src-tauri/tests/fixtures/archive/generate.py`
- 创建：`src-tauri/tests/fixtures/archive/gen_declared_dict.py`
- 创建：`src-tauri/tests/fixtures/archive/kat_vectors.json`
- 创建：`src-tauri/tests/fixtures/archive/requirements.in`
- 创建：`src-tauri/tests/fixtures/archive/requirements.txt`

- [ ] **步骤 1：记录依赖前基线**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive
cargo +1.75.0 check --manifest-path src-tauri/Cargo.toml
```

预期：当前 archive 测试 PASS；Rust 1.75 check 若失败，保存原始错误到本任务实现记录，并确认失败发生在新增依赖之前。不得把预存在 MSRV 失败误记为本模块回归。

- [ ] **步骤 2：加入固定依赖**

将 `src-tauri/Cargo.toml` 的 Archive 段改为：

```toml
# Archive readers；版本必须保持 Rust 1.75 可编译。
zip = { version = "=2.4.2", features = ["aes-crypto"] }
unrar_sys = "=0.5.8" # 直接使用 UnRAR 低层 API + data callback；不引入高层 unrar crate（密码时序与 NEEDPASSWORD 缺陷，见任务 5 步骤 4）
# 生产只留解码：lzma-rust 是 sevenz-rust 的必需依赖（解码可用），`compress` 仅打开其
# encoder feature——显式 default-features = false，避免压缩器进入发布二进制。
sevenz-rust = { version = "=0.6.1", default-features = false, features = ["aes256"] }
# 任务 6 header 预检（sevenz_header_precheck.rs）的直接依赖：aes/cbc 在 sevenz-rust 中
# 只是可选依赖，本项目不能隐式依赖传递解析，必须显式声明；lzma-rust 与其传递版本同版锁定，
# 且必须 default-features = false——lzma-rust 0.1.7 的默认 feature 就是 encoder，
# 直接裸引会在生产构建重新启用编码器，与"生产只留解码"冲突。
lzma-rust = { version = "=0.1.7", default-features = false }
aes = { version = "0.8", features = ["zeroize"] } # zeroize feature：清除 AES key schedule（§5.2 密码生命周期约束）
cbc = "0.1"
zeroize = "1"

[dev-dependencies]
# 任务 6 测试用 SevenZWriter 运行时生成 fixture；`compress` 只在测试构建启用。
sevenz-rust = { version = "=0.6.1", default-features = false, features = ["aes256", "compress"] }
```

运行：

```bash
cargo update --manifest-path src-tauri/Cargo.toml -p zip --precise 2.4.2
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：依赖解析完成，`Cargo.lock` 出现 `unrar_sys 0.5.8`、`sevenz-rust 0.6.1`、`lzma-rust 0.1.7`、`aes 0.8.x`、`cbc 0.1.x`，ZIP 保持 2.4.2，且不出现高层 `unrar` crate；`lzma-rust` 只解析出一份（直接依赖与 sevenz-rust 传递依赖同版统一）。**release feature-tree 验证**（`cargo tree` 默认含 dev 边，而 dev-dependencies 的 `compress` 会故意启用 lzma-rust/encoder，必须排除）：

```bash
# 生产图：反向查 lzma-rust，排除 dev 边——预期 encoder 不出现
cargo tree --manifest-path src-tauri/Cargo.toml -e features,no-dev -i lzma-rust
# 测试图（可选对照）：不排除 dev——encoder 应出现，证明 compress 守卫生效
cargo tree --manifest-path src-tauri/Cargo.toml -e features -i lzma-rust
```

生产图若出现 `encoder` feature，检查 sevenz-rust 0.6.1 是否以 `default-features = false` 引入 lzma-rust，并确保本模块 Cargo.toml 的直接依赖同样关闭默认 feature。依赖 spike 不能只跑普通 `cargo check`：任务 6 的红灯测试步骤会实际编译调用 `SevenZWriter` 的 `create_7z` fixture helper，即 dev-dependencies `compress` 的编译守卫；若该步编译失败说明 feature 拆分有误，先修依赖再继续。若 `default-features = false` 误伤解码路径（lzma 解码被锁 feature），回退为生产依赖显式 `features = ["aes256", "compress"]` 并在实现记录中注明。新增直接依赖必须通过 `cargo +1.75.0 check`（MSRV 验证随本任务执行，与 §12.5 一致）。

- [ ] **步骤 3：添加最小 RAR/ZIP fixtures 与说明**

`src-tauri/tests/fixtures/archive/README.md` 必须说明二十四个 fixture 的格式、密码、内容、生成工具和生成日期。`requirements.txt` 是由 `pip-compile --generate-hashes` 生成的完整锁文件，直接依赖固定 `pyzipper==0.4.0`，传递依赖也必须固定版本与哈希。职责固定如下：`generate.py` 生成确定性 PNG/padding/note.txt 输入（含 `a/note.txt` + `b/page.png` 目录结构）、AE-1、AE-2 与 `multidisk.zip`，并解析 local/central AES extra field，断言 vendor version 分别为 1/2、AE-2 CRC 为 0；同一脚本通过显式参数调用已安装的 7-Zip 24.09 生成 ZipCrypto，并验证工具版本和产物可解密；`gen_declared_dict.py` 构造十一个 `dict-*`/`header-*`/`content-*` 构造性 fixture（coder properties 与 header 声明受控，逐个合同见任务 6）。RAR 九个产物由 README 中固定的 WinRAR 7.11 PowerShell 命令生成，脚本只负责生成其输入并在 `--verify` 时校验产物存在、内容与元数据。生成文件后，只对下列二十四个 archive fixture 取 SHA-256；不得把 README、脚本、输入图片或额外分卷混入清单。README 中不得出现示例哈希、空单元格或待补文字。

固定元数据如下：`plain-rar4.rar`（RAR4 单卷、无密码、`page1.png/page2.png`）、`password-rar4.rar`（RAR4 单卷、密码 `test-pass-中文`、`page1.png`）、`plain-rar5.rar`（RAR5 单卷、无密码、`page1.png/page2.png`）、`password-rar5.rar`（RAR5 单卷、密码 `test-pass-中文`、`page1.png`）、`encrypted-headers-rar5.rar`（RAR5 单卷、`-hp` 同时加密文件头与数据、密码 `test-pass-中文`、`page1.png`；catalog 加密 header 集成测试的唯一载体）、`password-nonimage-rar4.rar`（RAR4 单卷、密码 `test-pass-中文`、仅含非图片 `note.txt`；probe 加密非图片兜底验证的载体）、`empty-rar5.rar`（RAR5 单卷、零条目，"先加后删"生成；`EmptyArchive` 合同载体）、`mixed-dirs-rar5.rar`（RAR5 单卷、无密码、`a/note.txt` + `b/page.png`；probe prefix 视图统计的载体）、`multipart.part1.rar`（RAR5 分卷、无密码、`page1.png`，另含非图片 `padding.bin` 只用于强制分卷）。`multipart` 的附属卷（`part2` 起，1 KiB 分卷下约 5-6 个）只在 `--verify` 运行期存在供完整校验，校验后、哈希前删除且不入仓；运行时测试只用 `part1` 的 header 判多卷，不读取其余卷。README 必须记录该删除流程，避免"目录内恰好 N 个 archive 文件"的验收自相矛盾。`generate.py` 固定生成 4096 bytes 的确定性 `padding.bin`；所有输入均为脚本生成，不含第三方版权内容。RAR 生成工具固定为 WinRAR CLI 7.11，并在 README 原样记录以下命令及 `rar.exe` 的绝对版本输出：

```powershell
rar.exe a -idq -ma4 plain-rar4.rar page1.png page2.png
rar.exe a -idq -ma4 -ptest-pass-中文 password-rar4.rar page1.png
rar.exe a -idq -ma5 plain-rar5.rar page1.png page2.png
rar.exe a -idq -ma5 -ptest-pass-中文 password-rar5.rar page1.png
rar.exe a -idq -ma5 -hptest-pass-中文 encrypted-headers-rar5.rar page1.png
rar.exe a -idq -ma4 -ptest-pass-中文 password-nonimage-rar4.rar note.txt
rar.exe a -idq -ma5 empty-rar5.rar note.txt
rar.exe d -idq empty-rar5.rar note.txt
rar.exe a -idq -ma5 mixed-dirs-rar5.rar a\note.txt b\page.png
rar.exe a -idq -ma5 -m0 -v1k multipart.rar page1.png padding.bin
```

ZIP 固定元数据：`password-zipcrypto.zip`、`password-ae1.zip`、`password-ae2.zip` 均包含同一个 `page1.png`，密码 `test-pass-中文`。ZipCrypto 固定用 7-Zip 24.09：`7z.exe a -tzip -mem=ZipCrypto -ptest-pass-中文 password-zipcrypto.zip page1.png`。AE-1/AE-2 固定用 Python **≥ 3.11**（双机器环境：本机 3.11.4、racyan 3.12 均可执行；**可复现承诺限定为"内容锁定"——不承诺跨机器字节级再生成**，README 记录首次生成时的 `python --version` 仅供诊断，重生成结果与提交哈希不一致属预期，丢弃并以已提交产物为准）+ `pyzipper==0.4.0`，`generate.py` 分别调用 `AESZipFile(..., encryption=pyzipper.WZ_AES, encryption_kwargs={"nbits": 256, "force_wz_aes_version": 1})` 与 version 2；不得依赖库的自动选择。`multidisk.zip` 由同一脚本手写最小 EOCD/ZIP64 disk 字段非零结构且不包含相邻分盘文件。README 必须记录 `python --version`、`pip show pyzipper`、`7z i`、完整命令与脚本提交哈希。

生成完成后运行：

```powershell
python --version   # 环境记录（诊断信息）：本机 3.11.4 / racyan 3.12 均可执行；
                   #   fixture 承诺内容锁定（SHA-256 清单为真值），不承诺字节级再生成——
                   #   重生成输出与清单不一致时丢弃，以已提交产物为准，不覆盖清单
python -m pip install pip-tools==7.4.1
python -m piptools compile --generate-hashes --resolver=backtracking --output-file src-tauri/tests/fixtures/archive/requirements.txt src-tauri/tests/fixtures/archive/requirements.in
python -m pip install --require-hashes -r src-tauri/tests/fixtures/archive/requirements.txt
python src-tauri/tests/fixtures/archive/generate.py --verify
# 构造性 fixture 与 KAT 由独立脚本生成：默认模式生成 11 个构造性 7z 并写入 kat_vectors.json；
# --verify-kat 读取 kat_vectors.json、独立复算并逐字段比较，任何漂移以非零退出码失败
#（自动化可证明 KAT 已核对，不依赖人工比对；--print-kat 保留为只打印的诊断模式）
python src-tauri/tests/fixtures/archive/gen_declared_dict.py
python src-tauri/tests/fixtures/archive/gen_declared_dict.py --verify-kat
if ($LASTEXITCODE -ne 0) { throw "KAT verification failed" }
if (-not (Test-Path 'src-tauri/tests/fixtures/archive/kat_vectors.json')) { throw "kat_vectors.json missing" }
# multipart 附属卷（part2 起）仅 --verify 运行期使用；哈希前删除，不入仓
Get-ChildItem 'src-tauri/tests/fixtures/archive/multipart.part*.rar' |
  Where-Object { $_.Name -ne 'multipart.part1.rar' } | Remove-Item
$fixtures = @('plain-rar4.rar','password-rar4.rar','plain-rar5.rar','password-rar5.rar','encrypted-headers-rar5.rar','password-nonimage-rar4.rar','empty-rar5.rar','mixed-dirs-rar5.rar','multipart.part1.rar','password-zipcrypto.zip','password-ae1.zip','password-ae2.zip','multidisk.zip','dict-oversize-lzma.7z','dict-oversize-lzma2.7z','dict-budget-oversum.7z','header-encoded-oversize.7z','header-numfiles-over.7z','header-copy.7z','header-lzma.7z','header-delta-lzma2.7z','header-bcj-x86-lzma2.7z','header-kdf-over.7z','content-kdf-over.7z')
$hashes = $fixtures | ForEach-Object { Get-FileHash -LiteralPath (Join-Path 'src-tauri/tests/fixtures/archive' $_) -Algorithm SHA256 }
if ($hashes.Count -ne 24) { throw "expected exactly 24 fixture hashes" }
$hashes
```

预期：二十四次 `Get-FileHash` 均输出 64 位 SHA-256（11 个构造性 7z 由 `gen_declared_dict.py` 在上一步生成、`--verify-kat` 逐字段校验成功且退出码为 0），README 与实际值一致，fixture 目录内 archive 文件数恰为二十四（`kat_vectors.json` 为元数据不计入）。

- [ ] **步骤 4：归档 UnRAR 许可**

把 <https://raw.githubusercontent.com/muja/unrar.rs/master/unrar_sys/vendor/unrar/license.txt> 的完整原文保存为 `THIRD_PARTY_LICENSES/UNRAR.txt`。运行：

```bash
rg -n "free of charge|cannot be used to develop RAR|freely distributed" THIRD_PARTY_LICENSES/UNRAR.txt
```

预期：三项许可条件均命中。

- [ ] **步骤 5：验证依赖构建**

运行：

```bash
cargo check --manifest-path src-tauri/Cargo.toml
cargo +1.75 check --manifest-path src-tauri/Cargo.toml
```

预期：默认工具链 PASS；Rust 1.75 与步骤 1 基线相比不得新增由 `unrar/sevenz-rust/zeroize` 造成的失败。

- [ ] **步骤 6：Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tests/fixtures/archive THIRD_PARTY_LICENSES/UNRAR.txt
git commit -m "build(archive): 固定 RAR/7z 密码依赖与测试夹具"
```

---

### 任务 2：先锁定现有 ZIP/CBZ 行为

**文件：**
- 修改：`src-tauri/src/source/archive_impl.rs`

- [ ] **步骤 1：补写路径、Unicode、严格 Range 和非图片过滤测试**

在 `archive_impl.rs` 的 tests module 新增：

```rust
#[tokio::test]
async fn zip_contract_nested_unicode_filter_range_and_stat() {
    let path = create_test_cbz(&[
        "章节一/第01页.png",
        "章节一/第02页.jpg",
        "章节一/readme.txt",
        "章节二/第03页.png",
    ]);
    let descriptor = SourceDescriptor::Archive {
        archive_path: path.display().to_string(),
        entry_prefix: "章节一".into(),
        format: ArchiveFormat::Cbz,
        origin: None,
        origin_entry_path: None,
        archive_rel_path: None,
    };
    let source = never_source();
    let entries = source.list_directory(&descriptor, "").await.unwrap();
    assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
               vec!["第01页.png", "第02页.jpg"]);
    let stat = source.stat(&descriptor, "第01页.png").await.unwrap();
    assert_eq!(stat.size, 8);
    assert_eq!(stat.modified_at, None);
    let slice = source.read_file(
        &descriptor,
        "第01页.png",
        Some(ByteRange { offset: 1, length: 3 }),
    ).await.unwrap();
    assert_eq!(slice, vec![b'P', b'N', b'G']);
}

#[tokio::test]
async fn zip_contract_range_overflow_and_end_overrun_fail() {
    let path = create_test_cbz(&["page.png"]);
    let descriptor = archive_descriptor(path, ArchiveFormat::Cbz);
    let source = never_source();
    assert!(source.read_file(
        &descriptor,
        "page.png",
        Some(ByteRange { offset: u64::MAX, length: 1 }),
    ).await.is_err());
    assert!(source.read_file(
        &descriptor,
        "page.png",
        Some(ByteRange { offset: 7, length: 2 }),
    ).await.is_err());
}
```

同时抽出测试 helper：

```rust
fn archive_descriptor(path: PathBuf, format: ArchiveFormat) -> SourceDescriptor {
    SourceDescriptor::Archive {
        archive_path: path.display().to_string(),
        entry_prefix: String::new(),
        format,
        origin: None,
        origin_entry_path: None,
        archive_rel_path: None,
    }
}
```

- [ ] **步骤 2：运行测试验证现有实现通过**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive_impl::tests -- --nocapture
```

预期：新增 ZIP contract 全部 PASS；这组测试是后续路径化重构的行为锁。

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/source/archive_impl.rs
git commit -m "test(archive): 锁定既有 ZIP 读取契约"
```

---

### 任务 3：统一 Archive 类型、错误和会话密码库

**文件：**
- 创建：`src-tauri/src/source/archive/backend.rs`
- 创建：`src-tauri/src/source/archive/password.rs`
- 修改：`src-tauri/src/source/archive/mod.rs`
- 修改：`src-tauri/src/source/trait_def.rs`

- [ ] **步骤 1：为错误序列化和密码生命周期写失败测试**

`backend.rs` tests：

```rust
#[test]
fn access_error_serializes_as_stable_tagged_shape() {
    let value = serde_json::to_value(
        ArchiveAccessError::UnsupportedCodec("PPMd".into()),
    ).unwrap();
    assert_eq!(value, serde_json::json!({
        "kind": "unsupportedCodec",
        "message": "PPMd"
    }));
    assert_eq!(
        serde_json::to_value(ArchiveAccessError::PasswordRequired).unwrap(),
        serde_json::json!({ "kind": "passwordRequired" })
    );
    // 内部 marker 的序列化守卫：skip_serializing 变体一旦被带到 IPC 边界即报错
    assert!(serde_json::to_value(ArchiveAccessError::BudgetRetryRequired).is_err());
}
```

`password.rs` tests：

```rust
#[test]
fn password_store_only_returns_exact_identity_and_can_forget() {
    let store = ArchivePasswordStore::default();
    let a = ArchiveIdentity::new("local:C:/a.cbz", 10, Some(1));
    let changed = ArchiveIdentity::new("local:C:/a.cbz", 11, Some(2));
    store.insert(a.clone(), Zeroizing::new(b"secret".to_vec()));
    let password = store.get(&a).unwrap();
    assert_eq!(password.as_slice(), b"secret");
    assert_eq!(store.get(&changed), None);
    store.forget(&a);
    assert_eq!(store.get(&a), None);
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::backend
cargo test --manifest-path src-tauri/Cargo.toml source::archive::password
```

预期：FAIL，模块或类型尚不存在。

- [ ] **步骤 3：实现统一类型**

`backend.rs` 定义：

```rust
use crate::source::descriptor::{ArchiveFormat, MediaEntry};
use serde::Serialize;
use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ArchiveAccessError {
    #[error("压缩包需要密码")]
    PasswordRequired,
    #[error("密码错误")]
    WrongPassword,
    #[error("不支持的压缩算法: {0}")]
    UnsupportedCodec(String),
    #[error("暂不支持分卷压缩包: {0}")]
    MultiVolumeUnsupported(String),
    #[error("压缩包损坏: {0}")]
    CorruptArchive(String),
    #[error("压缩包中没有可阅读图片")]
    EmptyArchive,
    #[error("压缩包超过安全资源上限: {0}")]
    ResourceLimitExceeded(String),
    // Service 内部增长-回退协议 marker，永不跨 IPC（消费规则见任务 7 步骤 4）。
    // 变体级 skip_serializing 的 serde 官方语义是"尝试序列化该变体即报错"——
    // 任何意外把它带到 IPC 边界的路径都会显式失败而非静默漏字段。
    #[serde(skip_serializing)]
    #[error("工作集许可增长失败（Service 内部重排队 marker）")]
    BudgetRetryRequired,
    #[error("压缩包条目不存在: {0}")]
    EntryNotFound(String),
    #[error("远程 Range 不可用: {0}")]
    RemoteRangeUnavailable(String),
    #[error("操作已取消")]
    Cancelled,
    #[error("archive 请求无效: {0}")]
    InvalidRequest(String),
    #[error("IO 错误: {0}")]
    Io(String),
    #[error("网络错误: {0}")]
    Network(String),
    #[error("操作超时: {0}")]
    Timeout(String),
}

#[derive(Debug, Clone)]
pub struct RemoteZipIoError(pub ArchiveAccessError);

impl std::fmt::Display for RemoteZipIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("remote archive IO failed") // 不把路径或第三方错误重复写入 source 文本
    }
}

impl std::error::Error for RemoteZipIoError {}

#[derive(Debug, Clone)]
pub struct LimitedEntryIoError {
    pub limit: u64,
}

impl std::fmt::Display for LimitedEntryIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "archive entry exceeded {} bytes", self.limit)
    }
}

impl std::error::Error for LimitedEntryIoError {}

/// `LimitedEntryWriter` 增长失败（`try_grow` 返回 false）的 retry marker，与终态
/// `LimitedEntryIoError` 区分；backend 经 `map_zip_io_error` 在边界恢复为
/// `ArchiveAccessError::BudgetRetryRequired`（Service 触发增长-回退）。
#[derive(Debug, Clone)]
pub struct BudgetRetryIoError;

impl std::fmt::Display for BudgetRetryIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("archive entry budget growth failed")
    }
}

impl std::error::Error for BudgetRetryIoError {}

pub trait ArchiveReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ArchiveReadSeek for T {}

pub type ReaderFactory = Arc<
    dyn Fn() -> Result<Box<dyn ArchiveReadSeek>, ArchiveAccessError> + Send + Sync
>;

pub const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_CATALOG_ENTRIES: usize = 100_000;
pub const MAX_ENTRY_PATH_BYTES: usize = 4_096;

#[derive(Clone)]
pub enum ArchiveInput {
    Path(PathBuf),
    Reader(ReaderFactory),
}

#[derive(Debug, Clone)]
pub struct ArchiveCatalog {
    pub entries: Vec<MediaEntry>,
    // 不携带 first_encrypted_entry：加密元数据只存在于 ArchiveProbe 一个真值源。
}

/// probe 只读容器元数据，不返回条目内容（spec §4.2 四操作之一、§5.3 验证规则的载体）。
#[derive(Debug, Clone, Default)]
pub struct ArchiveProbe {
    pub entry_count: usize,
    /// 图片条目总数（含未加密）：image_count == 0 一律 EmptyArchive（spec §9）
    pub image_count: usize,
    /// entry 名（规范化 `/` 路径）→ 所属 folder 的 dictionary 字节数（仅 7z 非空；
    /// solid folder 内多条目共享同值，无 stream 条目不入表）。Service 读取目标条目时
    /// **按条目查询**，不取全容器最大值——无关 folder 的大 dictionary（如另一目录
    /// 400 MiB）不得误拒当前 1 MiB dictionary 的读取。
    pub entry_dictionaries: HashMap<String, u64>,
    /// 第一个加密图片条目（优先验证对象）
    pub first_encrypted_image: Option<String>,
    /// 无加密图片时回退验证的第一个加密普通文件
    pub first_encrypted_file: Option<String>,
}

pub trait ArchiveBackend: Send + Sync {
    /// `prefix` 与 catalog 同语义：`image_count`/`first_encrypted_*` 限定当前视图；
    /// `entry_count` 是**全容器**条目计数（资源限额基线），不受 prefix 影响。
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError>;
    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError>;
    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError>;
    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError>;
}

pub fn backend_kind(format: ArchiveFormat) -> &'static str {
    match format {
        ArchiveFormat::Cbz | ArchiveFormat::Zip => "zip",
        ArchiveFormat::Cbr | ArchiveFormat::Rar => "rar",
        ArchiveFormat::SevenZ => "7z",
    }
}

/// 资源上限集合（spec §4.5），backend 与 Service 共用同一份。
/// 生产值：entry 512 MiB、catalog 100,000 条、路径 4,096 bytes、
/// dictionary 512 MiB、工作集 512 MiB。
#[derive(Debug, Clone)]
pub struct ArchiveLimits {
    pub max_entry_bytes: u64,
    pub max_catalog_entries: usize,
    pub max_entry_path_bytes: usize,
    pub max_dict_bytes: u64,
    pub workspace_budget_bytes: u64,
}

impl ArchiveLimits {
    pub fn production() -> Self {
        Self {
            max_entry_bytes: 512 * 1024 * 1024,
            max_catalog_entries: 100_000,
            max_entry_path_bytes: 4_096,
            max_dict_bytes: 512 * 1024 * 1024,
            workspace_budget_bytes: 512 * 1024 * 1024,
        }
    }

    /// 测试构造的唯一入口：默认与生产值相同，每个用例只缩小自己验证的维度。
    /// Rust 无函数重载——全仓库只允许此签名，不得再出现 `for_test(8)` 形态；
    /// 也不得把无关维度默认设小：那会让用例命中错误分支，断言碰巧通过而失去意义
    ///（如工作集用例的 dict/entry 被截断在先、"应成功"分支反而失败）。
    pub fn for_test() -> Self {
        Self::production()
    }

    pub fn entry_bytes(mut self, v: u64) -> Self { self.max_entry_bytes = v; self }
    pub fn entry_count(mut self, v: usize) -> Self { self.max_catalog_entries = v; self }
    pub fn path_bytes(mut self, v: usize) -> Self { self.max_entry_path_bytes = v; self }
    pub fn dict_bytes(mut self, v: u64) -> Self { self.max_dict_bytes = v; self }
    pub fn budget_bytes(mut self, v: u64) -> Self { self.workspace_budget_bytes = v; self }
}

/// `read_entry` 的工作集预算句柄（Service 构造、backend 消费、整体 move 进
/// `spawn_blocking`）。**显式持有**初始与追加的 `OwnedSemaphorePermit`——许可的
/// RAII 记账以这些字段为真实持有者，drop budget 即统一释放；`try_grow` 同步非阻塞
/// （`try_acquire_many_owned`），匹配 RAR FFI callback 的同步约束。越过 `output_cap`
/// 的终态判断由 writer 自行完成（返回 `ResourceLimitExceeded`），`try_grow` 失败才
/// 触发 `BudgetRetryRequired` 回退路径。permit 粒度 = 1 MiB。
pub struct DecodeBudget {
    pub entry_dict: u64,
    /// 输出上限 = workspace_budget - entry_dict；**不是任务总许可**
    /// （总记账 = entry_dict + output_reserved，按 permit 粒度向上取整）
    pub output_cap: u64,
    output_reserved: u64,
    permits: Vec<tokio::sync::OwnedSemaphorePermit>,
    semaphore: Arc<tokio::sync::Semaphore>,
}

fn permit_count(bytes: u64) -> u32 {
    // 钳位 ≥1：零声明 + 零 dict 的条目也持最小许可（任务 7 "≥ 1 permit" 合同），
    // 谎报输出从 0 水位起首次 try_grow 即走增长路径。
    (((bytes + 1024 * 1024 - 1) / (1024 * 1024)).max(1)) as u32
}

impl DecodeBudget {
    /// Service 生产构造（async：初始许可需等待）：入口即执行声明预检——
    /// `declared.checked_add(entry_dict)` 溢出或超过 workspace_budget 直接 Err
    ///（终态 ResourceLimitExceeded，Service 步骤① 由本构造承载），
    /// 通过后 acquire 初始 permit（ceil(sum / 1 MiB) 个）并持有。
    pub async fn for_limits(
        limits: &ArchiveLimits,
        declared: u64,
        entry_dict: u64,
        semaphore: Arc<tokio::sync::Semaphore>,
    ) -> Result<Self, ArchiveAccessError> {
        let sum = declared
            .checked_add(entry_dict)
            .filter(|v| *v <= limits.workspace_budget_bytes)
            .ok_or_else(|| {
                ArchiveAccessError::ResourceLimitExceeded(
                    "declared + dictionary exceeds workspace budget".into(),
                )
            })?;
        // semaphore 从不显式 close，此分支仅防御 drop 竞态——单元变体，不带诊断串
        let permit = Arc::clone(&semaphore)
            .acquire_many_owned(permit_count(sum))
            .await
            .map_err(|_| ArchiveAccessError::Cancelled)?;
        Ok(Self {
            entry_dict,
            output_cap: limits.workspace_budget_bytes - entry_dict,
            output_reserved: declared,
            permits: vec![permit],
            semaphore,
        })
    }

    /// 同步非阻塞追加：差额 permit 立即并入 `permits` 持有（不持有即释放，记账失真）。
    /// 水位单调：`new_output_reserved <= output_reserved` 直接返回 true——初始水位等于
    /// declared（可能很大），首个小 chunk 的调用不得把水位改小、使字段值脱离已持 permits。
    pub fn try_grow(&mut self, new_output_reserved: u64) -> bool {
        if new_output_reserved <= self.output_reserved {
            return true;
        }
        let held = permit_count(self.entry_dict + self.output_reserved);
        let needed = permit_count(self.entry_dict + new_output_reserved);
        if needed > held {
            match Arc::clone(&self.semaphore).try_acquire_many_owned(needed - held) {
                Ok(permit) => self.permits.push(permit),
                Err(_) => return false,
            }
        }
        self.output_reserved = new_output_reserved;
        true
    }

    /// 测试直连 backend 时使用：1 TiB 虚拟信号量、单个 permit、grow 恒可满足、
    /// 不做预检（Service 生产路径永不构造它；dict/entry 声明值检查独立于 budget）。
    pub fn unbounded() -> Self {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1 << 20));
        let permit = Arc::clone(&semaphore).try_acquire_owned().unwrap();
        Self {
            entry_dict: 0,
            output_cap: u64::MAX,
            output_reserved: 0,
            permits: vec![permit],
            semaphore,
        }
    }
}
```

probe 不随 catalog 隐式处理，且是加密元数据的唯一真值源（`ArchiveCatalog` 不携带加密标记；catalog LRU 的值为 `{ probe, catalog }` 元数据，prepare/unlock/cache-hit 密码检查一律读取缓存的 probe）。probe 的统计范围与 catalog 的 prefix 语义一致：`entry_count` 为**全容器**条目计数（资源限额基线），`image_count`/`first_encrypted_image`/`first_encrypted_file` 只统计当前 `prefix` 视图——否则"B 目录有图片、A prefix 无图片"的包会被误判 Ready 后落入空 catalog。多卷、容器损坏在 probe 阶段即返回对应错误。probe/catalog 的扫描循环必须对**每一个原始条目（含被图片过滤丢弃的非图片条目）**执行三项资源上限：总条目数 ≤ `MAX_CATALOG_ENTRIES`（全容器计数）、规范化路径 ≤ `MAX_ENTRY_PATH_BYTES`、声明解压大小 ≤ `MAX_ENTRY_BYTES`，超限立即 `ResourceLimitExceeded`——不得先过滤图片再限额。service 语义（按优先级固定）：

- `entry_count == 0`（全容器空）→ `EmptyArchive`。
- 当前视图 `image_count > 0`：**只看 `first_encrypted_image`**——存在且无密码 → `PasswordRequired`；为 None → 直接 Ready。加密普通文件（如加密 README）**不阻塞**可读图片，混合包不得被迫索要阅读图片并不需要的密码。
- 当前视图 `image_count == 0`：一律 `EmptyArchive`；存在 `first_encrypted_file` 时先经该文件验证密码（成功写密码库后仍返回 `EmptyArchive`，失败 `WrongPassword`），无加密普通文件直接 `EmptyArchive`——用户得到真实的"当前视图无图"错误，不误报密码。

unlock 的验证条目与上述优先级一致：`image_count > 0` 时 = `first_encrypted_image`，否则 = `first_encrypted_file`，完整读取并校验成功后才写密码库。三种 backend 实现同一合同，"header 可列出但内容密码错误"仍由既有的错误密码用例覆盖（WrongPassword）。

同文件增加 `LimitedEntryWriter`：单一 `Vec<u8>` + **受控增量扩容**（不做"分块缓冲 + 交付合并"——合并会在旧 chunks 释放前同时持有约 2×total，仍处 budget 生命周期却只按 total 计费）。扩容规则（每次 `write` 调用，含 RAR callback 单次整块 `UCM_PROCESSDATA`）：① 先 `required = len.checked_add(incoming.len())`，溢出或超过 `output_cap` 直接终态 marker；② 扩容目标 = `max(required, min(capacity + 1 MiB, output_cap))`——**至少覆盖本次 incoming**（RAR callback 必须一次消费整个 p2 块，incoming 可能远超 1 MiB），闲余时按 1 MiB 步长推进；③ 尾块按 `min(1 MiB, output_cap - accumulated)` 精确计费，不按整 MiB 对齐——`output_cap = workspace_budget - entry_dict` 不保证 MiB 对齐，7z dictionary 常产生 511.5 MiB 一类上限，整块计费会误拒合法的最后一个部分 chunk；④ 每次扩容先 `budget.try_grow(目标 capacity)`，越过 `output_cap` 返回终态 marker、增长失败返回 retry marker（均为携带专用 marker 的 `std::io::Error`——终态 = `LimitedEntryIoError`、retry = `BudgetRetryIoError`——backend 经 `map_zip_io_error` 在边界恢复为 `ResourceLimitExceeded`/`BudgetRetryRequired`）；⑤ 成功后 **`try_reserve_exact(目标 capacity - len)`——`additional` 相对当前 `len` 而非 capacity**（传 `目标 - capacity` 在 `len < capacity` 时可能完全不扩容，随后写入触发未计费的隐式扩容绕过预算）。不触发 Rust 默认几何倍增，也不存在二次合并分配。**已知限制**：Rust 分配器允许实际物理分配超过请求值，`try_reserve_exact` 不是精确分配合同——预算约束的是请求的 capacity（记账值），allocator 超额残差不可由用户态约束、不宣称物理 RSS ≤ 预算；测试断言 `记账 capacity + dictionary ≤ workspace_budget`。任何 backend 都不得按 archive 声明的解压大小直接无界预分配。

`LimitedEntryWriter` 的公开（测试可见）API 固定为：

```rust
impl LimitedEntryWriter {
    /// 以 DecodeBudget 构造（budget 持 output_cap 与许可）；测试用 budget_with_output_cap(cap)
    /// 便捷构造一个 output_cap=cap、许可无限的 budget。
    pub fn with_budget(budget: DecodeBudget) -> Self;
    /// 扩容决策单测步骤：为即将写入的 incoming_len 字节执行①–⑤（计费 + try_reserve_exact），
    /// 成功返回 (预算目标 capacity, Vec 当前真实 capacity)；不复制数据。**fallible 接口**：
    /// ① 的溢出/越限与 ④ 的增长失败分别返回携带 `LimitedEntryIoError`/`BudgetRetryIoError`
    /// marker 的 `io::Error`，⑤ `try_reserve_exact` 失败原样上抛——`write_all` 内部经 `?`
    /// 复用同一错误链，任何调用点都不得 unwrap（不可信归档的越限与许可竞争是常态输入，
    /// panic 会吞掉 Service 重排队协议所需的 marker）。
    pub fn ensure_capacity_for_write(&mut self, incoming_len: usize) -> std::io::Result<(u64, u64)>;
    pub fn current_len(&self) -> usize;
    pub fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()>; // 内部先 ensure（? 传播 marker）再复制
}
```

- [ ] **步骤 4：实现密码库**

`password.rs`：

```rust
use std::collections::HashMap;
use std::sync::RwLock;
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ArchiveIdentity {
    pub location: String,
    pub size: u64,
    pub modified_at: Option<i64>,
}

impl ArchiveIdentity {
    pub fn new(location: impl Into<String>, size: u64, modified_at: Option<i64>) -> Self {
        Self { location: location.into(), size, modified_at }
    }
}

#[derive(Default)]
pub struct ArchivePasswordStore {
    values: RwLock<HashMap<ArchiveIdentity, Zeroizing<Vec<u8>>>>,
}

impl ArchivePasswordStore {
    pub fn insert(&self, id: ArchiveIdentity, password: Zeroizing<Vec<u8>>) {
        self.values.write().unwrap().insert(id, password);
    }

    pub fn get(&self, id: &ArchiveIdentity) -> Option<Zeroizing<Vec<u8>>> {
        self.values
            .read()
            .unwrap()
            .get(id)
            .map(|value| Zeroizing::new(value.to_vec()))
    }

    pub fn forget(&self, id: &ArchiveIdentity) {
        self.values.write().unwrap().remove(id);
    }

    pub fn clear(&self) {
        self.values.write().unwrap().clear();
    }
}
```

- [ ] **步骤 5：让 MediaSourceError 类型化穿透**

在 `trait_def.rs` 增加：

```rust
#[error(transparent)]
Archive(#[from] crate::source::archive::backend::ArchiveAccessError),
```

在 `archive/mod.rs` 导出新模块：

```rust
pub mod backend;
pub mod dao;
pub mod materializer;
pub mod password;
pub mod prefetch;
```

- [ ] **步骤 6：运行测试验证通过**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::backend
cargo test --manifest-path src-tauri/Cargo.toml source::archive::password
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：新增测试 PASS，现有代码只需补齐 `MediaSourceError::Archive` 的穷举 match。

- [ ] **步骤 7：Commit**

```bash
git add src-tauri/src/source/archive/backend.rs src-tauri/src/source/archive/password.rs src-tauri/src/source/archive/mod.rs src-tauri/src/source/trait_def.rs
git commit -m "feat(archive): 建立类型化后端与会话密码库"
```

---

### 任务 4：ZIP 路径化、ZipCrypto/AES 和零行为回归

**文件：**
- 创建：`src-tauri/src/source/archive/zip_backend.rs`
- 修改：`src-tauri/src/source/archive/mod.rs`
- 修改：`src-tauri/src/source/archive_impl.rs`

- [ ] **步骤 1：写 ZIP backend 失败测试**

在 `zip_backend.rs` tests 中用 `zip::ZipWriter` 生成普通 fixture；加密变体读取任务 1 固定的 ZipCrypto、AE-1、AE-2 fixtures，分别执行同一正确/错误密码合同，不能合并成一个泛化 AES case。核心断言：

```rust
#[test]
fn encrypted_zip_catalog_lists_plaintext_and_probe_reports_candidates() {
    // central directory 对内容加密包可无密码列出：catalog 只列目录（单一判定合同，
    // 任务 4 后文），加密候选由 probe 报告；PasswordRequired 的判定权在 Service
    //（任务 7 fake 测试已覆盖），backend 测试不得重新引入"加密条目阻塞列目录"。
    for fixture in ["password-zipcrypto.zip", "password-ae1.zip", "password-ae2.zip"] {
        let input = fixture_input(fixture);
        let catalog = ZipBackend.catalog(&input, "", None).unwrap();
        assert_eq!(catalog.entries.len(), 1);
        let probe = ZipBackend.probe(&input, "", None).unwrap();
        assert_eq!(probe.first_encrypted_image.as_deref(), Some("page1.png"));
        assert_eq!(ZipBackend.read_entry(&input, "page1.png", Some(b"wrong"), &mut DecodeBudget::unbounded()).unwrap_err(),
                   ArchiveAccessError::WrongPassword);
        assert_eq!(ZipBackend.read_entry(
            &input, "page1.png", Some("test-pass-中文".as_bytes()), &mut DecodeBudget::unbounded()
        ).unwrap(), PNG_BYTES);
    }
}

#[test]
fn multidisk_zip_maps_to_dedicated_error() {
    assert!(matches!(
        ZipBackend.catalog(&fixture_input("multidisk.zip"), "", None),
        Err(ArchiveAccessError::MultiVolumeUnsupported(_))
    ));
}

#[test]
fn declared_oversized_entry_and_limited_writer_are_rejected() {
    // 注入 entry 上限 8 bytes：正常 PNG entry 的真实声明大小即触发声明值分支
    //（与 RAR 同款模式，无需谎报构造；谎报合同由任务 7 的 Service 层 fake backend 测试承载）
    let (_guard, z) = create_zip_file(&[("page.png", PNG_BYTES)]);
    let backend = ZipBackend::with_test_limits(ArchiveLimits::for_test().entry_bytes(8));
    assert!(matches!(backend.read_entry(&ArchiveInput::Path(z), "page.png", None, &mut DecodeBudget::unbounded()),
                     Err(ArchiveAccessError::ResourceLimitExceeded(_))));
    let mut writer = LimitedEntryWriter::with_budget(budget_with_output_cap(8));
    // required = 9 > output_cap = 8 → 终态拒绝（write 返回携带 marker 的 io::Error）
    assert!(writer.write_all(&[0; 9]).is_err());
}

#[test]
fn limited_writer_grow_covers_single_large_incoming_and_spare_capacity() {
    // ① 单次 incoming > 1 MiB 步长：全新 writer（len=0）——**先预检再复制**：
    //   ensure_capacity_for_write(incoming_len) 的参数是"即将写入的字节数"，断言预算
    //   目标精确覆盖本次 incoming、Vec 真实 capacity ≥ required（allocator 可超额分配
    //   故不能精确相等），然后才 write_all——复制时隐式扩容的假实现无法通过
    let mut w = LimitedEntryWriter::with_budget(budget_with_output_cap(4 * 1024 * 1024));
    let (budgeted, actual) = w.ensure_capacity_for_write(2 * 1024 * 1024).unwrap();
    assert_eq!(budgeted, 2 * 1024 * 1024);      // 预算目标精确覆盖本次 incoming
    assert!(actual >= 2 * 1024 * 1024);         // Vec 真实 capacity ≥ required
    assert!(w.write_all(&[0u8; 2 * 1024 * 1024]).is_ok());
    assert_eq!(w.current_len(), 2 * 1024 * 1024);

    // ② 真实闲余（len < capacity）：独立 writer，先写 512 KiB → 步长扩容令
    //   capacity=1 MiB、len=512 KiB；再对 768 KiB 预检（required = 1280 KiB > capacity）
    //   ——目标按 required 推进，错误的 `target - capacity` 实现会完全不扩容而被抓住。
    let mut spare = LimitedEntryWriter::with_budget(budget_with_output_cap(4 * 1024 * 1024));
    assert!(spare.write_all(&[0u8; 512 * 1024]).is_ok());
    assert_eq!(spare.current_len(), 512 * 1024); // len < 1 MiB capacity 闲余确实存在
    let (budgeted, actual) = spare.ensure_capacity_for_write(768 * 1024).unwrap();
    assert_eq!(budgeted, 1280 * 1024);           // 预算目标精确 = 512 KiB + 768 KiB
    assert!(actual >= 1280 * 1024);              // Vec 真实 capacity ≥ required
    assert!(spare.write_all(&vec![0u8; 768 * 1024]).is_ok());
    assert_eq!(spare.current_len(), 1280 * 1024);
}

#[test]
fn zip_io_mapping_preserves_remote_retry_limit_crc_and_plain_io_classes() {
    // 五类映射各一条断言（合同顺序：Remote → BudgetRetry → Limited → InvalidData → Io）；
    // marker 直接就地构造，不依赖未定义 helper。漏掉 retry marker downcast 的实现会把
    // 预算竞争误映射为普通 Io，第五条断言即红灯。
    let remote = |e: ArchiveAccessError| std::io::Error::new(ErrorKind::Other, RemoteZipIoError(e));
    assert!(matches!(map_zip_io_error(remote(ArchiveAccessError::Timeout("slow".into()))),
                     ArchiveAccessError::Timeout(_)));
    assert!(matches!(map_zip_io_error(std::io::Error::new(ErrorKind::Other, BudgetRetryIoError)),
                     ArchiveAccessError::BudgetRetryRequired));
    assert!(matches!(map_zip_io_error(std::io::Error::new(ErrorKind::Other, LimitedEntryIoError { limit: 8 })),
                     ArchiveAccessError::ResourceLimitExceeded(_)));
    assert!(matches!(map_zip_io_error(std::io::Error::new(ErrorKind::InvalidData, "CRC mismatch")),
                     ArchiveAccessError::CorruptArchive(_)));
    assert!(matches!(map_zip_io_error(std::io::Error::new(ErrorKind::UnexpectedEof, "short")),
                     ArchiveAccessError::Io(_)));
}

#[test]
fn zip_backend_uses_reader_factory_without_whole_archive_vec() {
    let bytes = create_zip_bytes(&[("page.png", PNG_BYTES)]);
    let opens = Arc::new(AtomicUsize::new(0));
    let input = ArchiveInput::Reader(reader_factory(bytes, opens.clone()));
    let entries = ZipBackend.catalog(&input, "", None).unwrap().entries;
    assert_eq!(entries[0].name, "page.png");
    assert_eq!(opens.load(Ordering::SeqCst), 1);
}

#[test]
fn zip_probe_falls_back_to_encrypted_non_image_and_reports_empty() {
    let (_guard_nonimage, nonimage) = create_encrypted_zip(&[("note.txt", b"secret text")], "test-pass-中文");
    let probe = ZipBackend.probe(&ArchiveInput::Path(nonimage), "", None).unwrap();
    assert_eq!(probe.image_count, 0);
    assert_eq!(probe.first_encrypted_image, None);
    assert_eq!(probe.first_encrypted_file.as_deref(), Some("note.txt"));
    let (_guard_empty, empty) = create_zip_file(&[]);
    assert_eq!(ZipBackend.probe(&ArchiveInput::Path(empty), "", None).unwrap().entry_count, 0);
}

#[test]
fn zip_probe_image_count_and_encrypted_candidates_are_prefix_scoped() {
    // B 目录有图片、A prefix 无图片：probe 必须按当前视图统计，否则误判 Ready 后落入空 catalog
    let (_guard_dirs, mixed_dirs) = create_zip_file(&[("a/note.txt", b"x"), ("b/page.png", PNG_BYTES)]);
    let scoped = ZipBackend.probe(&ArchiveInput::Path(mixed_dirs), "a/", None).unwrap();
    assert_eq!(scoped.entry_count, 2); // 全容器计数（限额基线）
    assert_eq!(scoped.image_count, 0); // 当前视图无图 → service 判 EmptyArchive
    assert_eq!(scoped.first_encrypted_image, None);
    let full = ZipBackend.probe(&ArchiveInput::Path(mixed_dirs), "", None).unwrap();
    assert_eq!(full.image_count, 1);
}

#[test]
fn zip_probe_encrypted_non_image_does_not_block_readable_images() {
    // 混合包：未加密图片 + 加密 README——阅读图片不需要密码，不得弹密码框
    let (_guard_mixed, mixed) = create_mixed_zip(
        &[("page.png", PNG_BYTES)],
        &[("README.txt", b"secret")],
        "test-pass-中文",
    );
    let probe = ZipBackend.probe(&ArchiveInput::Path(mixed), "", None).unwrap();
    assert_eq!(probe.image_count, 1);
    assert_eq!(probe.first_encrypted_image, None);
    assert_eq!(probe.first_encrypted_file.as_deref(), Some("README.txt"));
}

#[test]
fn zip_probe_limits_apply_to_non_image_entries_and_paths() {
    // 注入小上限等价覆盖"100,001 个非图片条目/超长非图片路径"，不必真的生成十万条目
    let backend = ZipBackend::with_test_limits(ArchiveLimits::for_test().entry_count(8).path_bytes(64));
    let entries: Vec<(String, &[u8])> = (0..9).map(|i| (format!("file{i}.txt"), b"x".as_slice())).collect();
    let paths: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (n.as_str(), *b)).collect();
    let (_guard_many, many) = create_zip_file(&paths);
    assert!(matches!(backend.probe(&ArchiveInput::Path(many), "", None),
                     Err(ArchiveAccessError::ResourceLimitExceeded(_))));
    let long_name = format!("{}.txt", "a".repeat(65));
    let (_guard_long, long) = create_zip_file(&[(long_name.as_str(), b"x".as_slice())]);
    assert!(matches!(
        backend.probe(&ArchiveInput::Path(long), "", None),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
}
```

ZIP 测试 helper 集中定义（`zip_backend.rs` tests，zip 2.4.2 实际 API：`ZipWriter::new(Cursor)` 出内存字节、`ZipWriter::create(path)` 出磁盘文件，加密 per-entry options——同一 writer 逐条目切换即可混排明文/加密）：

```rust
/// 内存 ZIP 字节（Reader 路径测试用，无临时文件）
fn create_zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut buf);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            zip.start_file(*name, options).unwrap();
            std::io::Write::write_all(&mut zip, bytes).unwrap();
        }
        zip.finish().unwrap();
    }
    buf.into_inner()
}

/// 磁盘 ZIP 文件（Path 路径测试用）；TempDir guard 由测试持有
fn create_zip_file(entries: &[(&str, &[u8])]) -> (tempfile::TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let out = dir.path().join("t.zip");
    let file = std::fs::File::create(&out).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        zip.start_file(*name, options).unwrap();
        std::io::Write::write_all(&mut zip, bytes).unwrap();
    }
    zip.finish().unwrap();
    (dir, out)
}

/// 全条目 AES-256 加密（内容加密、central directory 明文）
fn create_encrypted_zip(entries: &[(&str, &[u8])], pw: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let out = dir.path().join("t.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&out).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .with_aes_encryption(zip::AesMode::Aes256, pw);
    for (name, bytes) in entries {
        zip.start_file(*name, options).unwrap();
        std::io::Write::write_all(&mut zip, bytes).unwrap();
    }
    zip.finish().unwrap();
    (dir, out)
}

/// 明文条目 + AES 条目混排：同一 writer 逐条目切换 options（混合包合同载体）
fn create_mixed_zip(
    plain: &[(&str, &[u8])],
    encrypted: &[(&str, &[u8])],
    pw: &str,
) -> (tempfile::TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let out = dir.path().join("t.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&out).unwrap());
    let plain_opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let enc_opts = plain_opts.clone()
        .with_aes_encryption(zip::AesMode::Aes256, pw);
    for (name, bytes) in plain {
        zip.start_file(*name, plain_opts).unwrap();
        std::io::Write::write_all(&mut zip, bytes).unwrap();
    }
    for (name, bytes) in encrypted {
        zip.start_file(*name, enc_opts).unwrap();
        std::io::Write::write_all(&mut zip, bytes).unwrap();
    }
    zip.finish().unwrap();
    (dir, out)
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::zip_backend
```

预期：FAIL，`ZipBackend` 不存在。

- [ ] **步骤 3：实现 reader 打开与密码选择**

`zip_backend.rs` 使用一个打开 helper，保证 Path 与 Reader 走同一 ZIP 逻辑：

```rust
fn open_reader(input: &ArchiveInput) -> Result<Box<dyn ArchiveReadSeek>, ArchiveAccessError> {
    match input {
        ArchiveInput::Path(path) => std::fs::File::open(path)
            .map(|f| Box::new(f) as Box<dyn ArchiveReadSeek>)
            .map_err(|e| ArchiveAccessError::Io(e.to_string())),
        ArchiveInput::Reader(factory) => factory(),
    }
}

fn by_name<'a, R: Read + Seek>(
    zip: &'a mut zip::ZipArchive<R>,
    name: &str,
    password: Option<&[u8]>,
) -> Result<zip::read::ZipFile<'a, R>, ArchiveAccessError> {
    match password {
        Some(p) => zip.by_name_decrypt(name, p).map_err(map_zip_error),
        None => zip.by_name(name).map_err(map_zip_error),
    }
}
```

`map_zip_error` 必须把 invalid password、unsupported compression、missing file、invalid archive 分别映射到 `WrongPassword`、`UnsupportedCodec`、`EntryNotFound`、`CorruptArchive`。使用任务 3 已定义的 `RemoteZipIoError`、`LimitedEntryIoError` 与 `BudgetRetryIoError` 三个可 downcast marker，建立唯一 `map_zip_io_error(std::io::Error) -> ArchiveAccessError`；映射顺序固定为：Remote marker 恢复稳定分类 → BudgetRetry marker 恢复 `BudgetRetryRequired` → Limited marker 映射 `ResourceLimitExceeded` → `ErrorKind::InvalidData` 映射 `CorruptArchive`（CRC/MAC）→ 普通 `Io`。`map_zip_error(ZipError::Io(io))` 委托该 helper。helper 和所有调用点必须在本任务建立，不能把 entry payload 的 IO 扁平化为字符串；任务 9 只负责让 `RemoteZipReader` 实际产生 Remote wrapper。

在调用 `zip::ZipArchive::new` 前用小型 EOCD/ZIP64 parser 检查 disk number、central-directory start disk 与 per-disk entry count；任一字段表明 multi-disk 时直接返回 `MultiVolumeUnsupported`，不得解析第三方错误字符串。

- [ ] **步骤 4：实现 catalog/read/stat**

`probe` 扫描 central directory 的加密标志（flag bit 0）与 AES extra field 产出 `ArchiveProbe`，不读取 payload；统计范围与 catalog 同语义——`entry_count` 全容器计数，`image_count`/加密候选按 `prefix` 视图过滤。`catalog` 只负责列目录：应用 `entryPrefix`、`is_image` 和自然排序，**不做任何密码需求判定**——`PasswordRequired` 由 Service 按 probe 的 image_count 分支规则统一决定（见任务 7），混合包不得在 backend 层被拦截；probe 与 catalog 的扫描循环对**每个原始条目（含被过滤的非图片）**检查总条目数 ≤ `MAX_CATALOG_ENTRIES`（计入全部条目而非仅图片）、规范化路径 ≤ `MAX_ENTRY_PATH_BYTES`、声明解压大小上限，任一超限立即 `ResourceLimitExceeded`——不得先过滤图片再限额。Service 选定验证条目（`image_count > 0` 用 `first_encrypted_image`，否则 `first_encrypted_file`）后调用 `read_entry` 完成验证读取，CRC/MAC 校验发生在 `read_entry` 内部。`read_entry` 经 `LimitedEntryWriter` 解压目标条目（writer 持任务 7 定义的 `DecodeBudget`：越过 `output_reserved` 水位时 `try_grow`，越过 `output_cap` 终态拒绝、增长失败返回 `BudgetRetryRequired`）；`stat_entry` 读取 central directory 的解压后 size，若超过上限直接返回 `ResourceLimitExceeded`。所有 `Read::read`、`read_to_end`、`io::copy`、完整性验证及限长 writer 返回的 `std::io::Error` 都必须 `.map_err(map_zip_io_error)`，不能只处理 `ZipError::Io`。

实现后在 `archive/mod.rs` 加：

```rust
pub mod zip_backend;
```

- [ ] **步骤 5：把既有 ZIP helper 临时委托给 ZipBackend**

在 `archive_impl.rs` 中把 `read_entry_bytes/list_archive_entries` 的 ZIP 分支改为路径输入调用；不要在此任务接 RAR/7z。删除 `read_archive_to_bytes` 与 `tokio::fs::read(&resolved)` 整包读取路径。

- [ ] **步骤 6：运行 ZIP 定向与原有契约测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::zip_backend -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::archive_impl::tests -- --nocapture
```

预期：新密码测试和任务 2 的全部既有 ZIP contract PASS；源码搜索无整包读取：

```bash
rg -n "tokio::fs::read\(&resolved\)|read_archive_to_bytes" src-tauri/src/source/archive_impl.rs
```

预期：0 命中。

- [ ] **步骤 7：Commit**

```bash
git add src-tauri/src/source/archive/zip_backend.rs src-tauri/src/source/archive/mod.rs src-tauri/src/source/archive_impl.rs
git commit -m "refactor(archive): ZIP 改为路径读取并支持密码"
```

---

### 任务 5：RAR/CBR 单卷与密码 backend

**文件：**
- 创建：`src-tauri/src/source/archive/rar_backend.rs`
- 创建：`src-tauri/src/source/archive/rar_callback.rs`
- 修改：`src-tauri/src/source/archive/mod.rs`

- [ ] **步骤 1：写 fixture 驱动失败测试**

```rust
#[test]
fn rar4_rar5_plain_and_password_contract() {
    for name in ["plain-rar4.rar", "plain-rar5.rar"] {
        let input = fixture_input(name);
        let catalog = RarBackend.catalog(&input, "", None).unwrap();
        assert_eq!(catalog.entries.len(), 2);
        assert_eq!(RarBackend.read_entry(&input, "page1.png", None, &mut DecodeBudget::unbounded()).unwrap(), PNG_BYTES);
    }
    for name in ["password-rar4.rar", "password-rar5.rar"] {
        let input = fixture_input(name);
        // `-p` 内容加密的 header 明文可列：catalog 只列目录（单一判定合同），
        // 加密候选由 probe 报告；PasswordRequired 判定权在 Service。
        let catalog = RarBackend.catalog(&input, "", None).unwrap();
        assert_eq!(catalog.entries.len(), 1);
        let probe = RarBackend.probe(&input, "", None).unwrap();
        assert_eq!(probe.first_encrypted_image.as_deref(), Some("page1.png"));
        assert_eq!(RarBackend.read_entry(&input, "page1.png", Some(b"wrong"), &mut DecodeBudget::unbounded()).unwrap_err(),
                   ArchiveAccessError::WrongPassword);
        assert_eq!(RarBackend.read_entry(
            &input, "page1.png", Some("test-pass-中文".as_bytes()), &mut DecodeBudget::unbounded()
        ).unwrap(), PNG_BYTES);
    }
}

#[test]
fn multipart_rar_is_rejected() {
    let input = fixture_input("multipart.part1.rar");
    assert!(matches!(
        RarBackend.catalog(&input, "", None),
        Err(ArchiveAccessError::MultiVolumeUnsupported(_))
    ));
}

#[test]
fn rar_listing_rejects_declared_size_over_limit() {
    let backend = RarBackend::with_limits(ArchiveLimits::for_test().entry_bytes(8));
    assert!(matches!(
        backend.catalog(&fixture_input("plain-rar5.rar"), "", None),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
}

#[test]
fn rar_callback_unit_checks_null_zero_length_and_budget_math() {
    let mut sink = LimitedRarSink::new(8);
    assert_eq!(feed_callback_for_test(&mut sink, std::ptr::null(), 0),
               CallbackControl::Continue);
    // 恰好等于上限（8 字节）：允许完整保存、Continue、无错误——"恰好到限不误判"边界
    assert_eq!(feed_callback_for_test(&mut sink, b"12345678".as_ptr(), 8),
               CallbackControl::Continue);
    assert_eq!(sink.saved_len(), 8);
    assert!(sink.error().is_none());
    // 越界块（累计第 9 字节）：中止——观察到 9 字节（bytes_seen==9）但第 9 字节
    // 不保存（saved_len 仍为 8），state.error 为 ResourceLimitExceeded
    assert_eq!(feed_callback_for_test(&mut sink, b"9".as_ptr(), 1),
               CallbackControl::Abort);
    assert_eq!(sink.bytes_seen(), 9);
    assert_eq!(sink.saved_len(), 8);
    assert!(matches!(sink.error(), Some(ArchiveAccessError::ResourceLimitExceeded(_))));
}

#[test]
fn rar_data_callback_aborts_real_ffi_output_at_hard_limit_and_recovers() {
    // 仅跳过 catalog 声明大小的测试短路，仍使用生产 read_entry -> unrar_sys callback 路径。
    let backend = RarBackend::with_test_policy(ArchiveLimits::for_test().entry_bytes(8),
                                               DeclaredSizePolicy::BypassForFfiTest);
    let targets_before = snapshot_rar_write_targets(&backend);
    assert!(matches!(backend.read_entry(
        &fixture_input("plain-rar5.rar"), "page1.png", None, &mut DecodeBudget::unbounded()
    ), Err(ArchiveAccessError::ResourceLimitExceeded(_))));
    assert_eq!(snapshot_rar_write_targets(&backend), targets_before); // cwd + cache 均无 entry
    assert_eq!(RarBackend::default().read_entry(
        &fixture_input("plain-rar5.rar"), "page1.png", None, &mut DecodeBudget::unbounded()
    ).unwrap(), PNG_BYTES);
}

#[test]
fn encrypted_header_password_callback_is_registered_before_open() {
    let input = fixture_input("encrypted-headers-rar5.rar");
    assert_eq!(RarBackend::default().read_entry(
        &input, "page1.png", Some("test-pass-中文".as_bytes()), &mut DecodeBudget::unbounded()
    ).unwrap(), PNG_BYTES);
}

#[test]
fn encrypted_header_catalog_uses_same_pre_open_callback() {
    let input = fixture_input("encrypted-headers-rar5.rar");
    let backend = RarBackend::default();
    // 无密码首开：NEEDPASSWORD(W) 无密码分支写 PasswordRequired 后中止——
    // 稳定进入密码弹框主流程，不退化为 UnRAR 通用错误
    assert_eq!(backend.catalog(&input, "", None).unwrap_err(),
               ArchiveAccessError::PasswordRequired);
    assert_eq!(backend.probe(&input, "", None).unwrap_err(),
               ArchiveAccessError::PasswordRequired);
    let catalog = backend.catalog(&input, "", Some("test-pass-中文".as_bytes())).unwrap();
    assert!(catalog.entries.iter().any(|e| e.name == "page1.png"));
    assert_eq!(backend.catalog(&input, "", Some(b"wrong")).unwrap_err(),
               ArchiveAccessError::WrongPassword);
}

#[test]
fn rar_probe_falls_back_to_encrypted_non_image_and_reports_empty() {
    let backend = RarBackend::default();
    let probe = backend
        .probe(&fixture_input("password-nonimage-rar4.rar"), "", None).unwrap();
    assert_eq!(probe.image_count, 0);
    assert_eq!(probe.first_encrypted_image, None);
    assert_eq!(probe.first_encrypted_file.as_deref(), Some("note.txt"));
    // prefix 视图统计（与 ZIP/7z 同款回归）：mixed-dirs 含 a/note.txt + b/page.png——
    // a/ 视图无图、全包 1 图；错误实现忽略 prefix 也无法通过
    let scoped = backend.probe(&fixture_input("mixed-dirs-rar5.rar"), "a/", None).unwrap();
    assert_eq!(scoped.entry_count, 2);
    assert_eq!(scoped.image_count, 0);
    let full = backend.probe(&fixture_input("mixed-dirs-rar5.rar"), "", None).unwrap();
    assert_eq!(full.image_count, 1);
    assert_eq!(backend
        .probe(&fixture_input("empty-rar5.rar"), "", None).unwrap().entry_count, 0);
}

#[test]
fn rar_probe_limits_count_every_entry_including_non_images() {
    // 注入总条目上限 1：plain-rar5.rar 含 2 个条目 → 第二个即超限，证明计数不豁免任何条目
    let backend = RarBackend::with_test_policy(
        ArchiveLimits::for_test().entry_count(1), DeclaredSizePolicy::default());
    assert!(matches!(
        backend.probe(&fixture_input("plain-rar5.rar"), "", None),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::rar_
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 Path 强约束与多卷前置判断**

```rust
fn path_of(input: &ArchiveInput) -> Result<&Path, ArchiveAccessError> {
    match input {
        ArchiveInput::Path(path) => Ok(path.as_path()),
        ArchiveInput::Reader(_) => Err(ArchiveAccessError::RemoteRangeUnavailable(
            "RAR backend 只接受本地路径".into(),
        )),
    }
}

fn reject_multipart_name(path: &Path) -> Result<(), ArchiveAccessError> {
    let lower = path.file_name().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
    let part = lower
        .rsplit_once(".part")
        .and_then(|(_, suffix)| suffix.strip_suffix(".rar"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()));
    let old = path.extension().and_then(|v| v.to_str()).is_some_and(|ext| {
        let bytes = ext.as_bytes();
        bytes.len() == 3
            && bytes[0].eq_ignore_ascii_case(&b'r')
            && bytes[1].is_ascii_digit()
            && bytes[2].is_ascii_digit()
    });
    if part || old {
        return Err(ArchiveAccessError::MultiVolumeUnsupported(lower));
    }
    Ok(())
}
```

- [ ] **步骤 4：实现 UnRAR 统一低层打开、catalog 与 callback read/stat**

probe、catalog、read_entry、stat_entry 一律复用 `rar_callback.rs` 的同一个低层打开 helper：先构造包含 callback 与 user-data 的 `OpenArchiveDataEx`，再调用 `RAROpenArchiveEx`；密码、限长 sink 与类型化错误全部经这个 pre-open callback 供给。probe 走同一 helper 的 `read_header → RAR_SKIP` 快速扫描，只读 header 的加密 flag 与文件名产出 `ArchiveProbe`，不触碰 payload；统计范围与 catalog 同语义（`entry_count` 全容器、`image_count`/加密候选按 prefix 视图过滤）。禁止引入高层 `unrar` crate——其密码是在 `RAROpenArchiveEx` 返回之后才经 `RARSetPassword` 传入的，且其内部 callback 只处理 `UCM_CHANGEVOLUMEW` 与 `UCM_PROCESSDATA`、没有任何 `UCM_NEEDPASSWORD(W)` 分支，加密文件头（尤其 RAR5 `-hp`，header 解密阶段就会索要密码）的 catalog 会直接失败；即使低层 `read_entry` 集成测试通过，高层 catalog 仍打不开同一文件。数据读取同样不得调用高层 `unrar::read()`，它在调用方检查之前已经返回完整 `Vec`。

catalog 走同一 helper 的 `read_header → RAR_SKIP` 循环：从 `HeaderDataEx` 读取 `filename_w`（经 `decode_wide` 平台适配 helper 解码，与密码共用同一宽度语义）、`unp_size` + `unp_size_high`（高低 32 位组合）与 `flags` 的 split/volume 位，确认 split 后立即返回 `MultiVolumeUnsupported`。read/stat 走 `read_header → 命中项 RAR_TEST / 其他项 RAR_SKIP` 顺序前进；禁止使用 `RAR_EXTRACT`，整个读取过程不得向当前工作目录或 cache 目录写出 entry。命中目标时 callback 每次只复制剩余预算；**允许恰好写到 `output_cap`**——只有第 `output_cap + 1` 字节实际到达（非空后续数据）才中止并映射终态 `ResourceLimitExceeded`，恰好到限的合法条目正常完成并在读取结束后照常校验 CRC（与下方 callback 合同的 `limit + 1` 语义一致，不把恰好等于上限的条目误判超限）；sink 的许可经任务 7 的 `DecodeBudget` 动态推进——同步 `try_grow` 与 FFI callback 的同步约束一致，失败转 abort code 后映射 `BudgetRetryRequired`。

callback user-data 只指向当前同步调用期间有效的 `RarCallbackState { sink: Option<LimitedRarSink>, password_utf8: Option<Zeroizing<Vec<u8>>>, password_wide: Option<Zeroizing<Vec<unrar_sys::WCHAR>>>, error: Option<ArchiveAccessError> }`；UTF-8 与平台宽字符两份密码在构造 state 时一次性预编码，**密码编码路径**在 callback 内不做任何分配；数据 sink 的扩容允许受控分配——经 `DecodeBudget::try_grow` 计费后 `try_reserve_exact` 精确增量（单 Vec 受控扩容，见任务 4 `LimitedEntryWriter`），分配失败转为类型化中止（终态 `ResourceLimitExceeded` / retry `BudgetRetryRequired`），不预分配全部声明大小（谎报增长正是要防的场景）。宽字符必须使用绑定实际导出的 `unrar_sys::WCHAR`（= libc 的 `wchar_t`：Windows 为 16 位、编码 UTF-16LE；Unix/macOS 为 32 位、编码 Unicode scalar/UTF-32），不得固定为 `u16`——按 `u16` 实现在非 Windows 平台会错误解释缓冲区布局，导致越界或未初始化读取。编码/解码集中在 `rar_callback.rs` 的单一平台适配 helper（`encode_wide`/`decode_wide`：`cfg(windows)` 走 UTF-16LE，`cfg(unix)` 走 u32 scalar），密码与 `filename_w` 解码共用同一 helper，并以 `const` 断言 `size_of::<WCHAR>()` 与所选编码分支一致（Windows=2、Unix=4），不满足即编译失败。同一 state 同时服务 open/读 header 阶段的密码请求、处理阶段的数据输出和类型化错误桥。关闭 handle 与清理 callback state 覆盖所有错误路径。callback 逐消息处理，`p2` 不得统一当作长度，各消息的参数合同固定为：

- `UCM_PROCESSDATA`：`p1` = 数据指针，`p2` = 字节数。先检查 `p1 != 0 && p2 > 0` 再构造 slice、复制剩余预算，返回 1；累计达到 `limit + 1` 时返回 -1 终止。
- `UCM_CHANGEVOLUME` / `UCM_CHANGEVOLUMEW`：`p1` = 下一卷文件名指针，`p2` = `RAR_VOL_ASK`/`RAR_VOL_NOTIFY` 模式值，不是长度。单卷策略不读取任何缓冲，直接返回 -1 终止并写入 `MultiVolumeUnsupported`。
- `UCM_NEEDPASSWORD`（ANSI）：`p1` = 密码缓冲指针，`p2` = 缓冲字节容量。**state 无密码时先写入 `ArchiveAccessError::PasswordRequired` 再返回 -1**——否则 `state.error` 为空、调用方只能映射 UnRAR 通用错误，加密 header 首次打开（`probe(None)`）无法稳定进入密码弹框主流程；有密码时先把整个缓冲清零，再复制 UTF-8 密码最多 `p2 - 1` 字节并写 NUL 结尾，返回 1。此分支仅是旧调用的兼容 fallback，非 ASCII 密码不保证正确。
- `UCM_NEEDPASSWORDW`：`p1` = 宽字符密码缓冲指针，`p2` = 容量（`wchar_t` 个数，平台宽度见上）。**无密码分支与 ANSI 同款：先写 `PasswordRequired` 再返回 -1**；有密码时先把 `p2` 个 `wchar_t` 全部清零，再把 `encode_wide` 预编码的密码截断到 `p2 - 1` 个 `wchar_t` 复制并写 NUL 结尾，返回 1。中文密码必须由此分支正确服务——fixture 密码 `test-pass-中文` 是该主验证路径。两个分支的 `PasswordRequired` 语义由集成测试锁定：`probe(fixture_input("encrypted-headers-rar5.rar"), "", None) == Err(PasswordRequired)` 与 `catalog(..., None) == Err(PasswordRequired)`，外加任务 7 Service 层 `prepare(None)` 返回 `PasswordRequired` 的 fake 断言。
- 其他消息（含未来新增的 `UCM_LARGEDICT` 等）：fail-closed，返回 -1 终止并写入类型化错误，不静默返回 0。

所有指针分支先做 null 与容量检查；`extern "C"` callback 整体包在 `catch_unwind(AssertUnwindSafe(...))` 中，panic 写入 state.error 并转 abort，绝不跨 ABI unwind。**类型化错误优先于 UnRAR 原始返回码**——callback 返回 -1 主动中止后，UnRAR 只给调用方一个通用失败码；若先映射该码，`BudgetRetryRequired`（预算重试协议）与 `ResourceLimitExceeded` 都会退化成普通 RAR/损坏错误。规则写死：**每次 `RAROpenArchiveEx`、`RARReadHeaderEx` 与 `RARProcessFile(RAR_TEST)` 返回后，先 `state.error.take()`——有值即作为本操作的返回错误（`BudgetRetryRequired` 原样上抛给 Service 触发增长-回退，`ResourceLimitExceeded`/`MultiVolumeUnsupported` 等原样透出）；仅当 state 无错误时才按既有映射表翻译原始 UnRAR 返回码**。关闭 handle 前同样先 take 再清理，防止 drop 路径吞掉错误。保留无 FFI 的 callback 单元测试覆盖 null/zero-length、宽字符截断与预算算法，但资源上限、header 密码合同（read 与 catalog 双路）与**错误优先级**必须穿过真实 `RAROpenArchiveEx -> callback -> RARProcessFile(RAR_TEST)` 集成路径——其中 `BudgetRetryRequired` 至少一条恢复测试：注入许可受限的 harness，第一次 `read_entry` 经真实 callback 触发增长失败、断言返回的是 `BudgetRetryRequired`（而非 UnRAR 通用错误），Service 释放重排队后同一 fixture 第二次读取成功（真实数据完整返回）。宽字符平台分支的编译完整性由任务 14 的 Linux `cargo check` CI 守卫锁定（Windows 运行测试 + Linux 编译测试，满足规格"不加入 ABI 假设"要求）。

`catalog` 只返回过滤后的图片条目（加密元数据在 `ArchiveProbe`，catalog 不再携带）；`read_entry`、`stat_entry` 与 ZIP 保持同一语义。所有 entry path 先把 `\` 归一为 `/`，再应用 prefix。

RAR 的 probe 与 listing 对**每个原始条目（含非图片）**执行总条目数、规范化路径长度和 `unpacked_size` 三项上限检查，任一超限 `ResourceLimitExceeded`，不得先过滤图片再限额。`RarBackend` 接受生产默认值为 512 MiB 的 `ArchiveLimits`，测试构造函数可注入 8 bytes 上限。合法 `plain-rar5.rar` + 8-byte limit 负责声明值分支；另一个仅限测试的 `DeclaredSizePolicy::BypassForFfiTest` 绕过这一个前置短路，让同一合法 fixture 的真实输出达到 callback 并映射为 `ResourceLimitExceeded`。测试同时断言工作目录/cache 快照不变、abort 后下一次正常 RAR 请求成功；不得修改 fixture header 或只测纯 `feed_callback_for_test` 来替代 FFI 合同。

- [ ] **步骤 5：运行 RAR 测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::rar_ -- --nocapture
```

预期：RAR4/RAR5、正确/错误密码、加密 header 在 read 与 catalog 双路的 pre-open password callback（含中文密码的 `UCM_NEEDPASSWORDW` 分支与错误密码的 `WrongPassword` 映射）、多卷拒绝、listing 声明限制、probe 兜底（加密非图片/空包）与 prefix 视图统计（mixed-dirs）、真实 FFI callback 实际输出硬停止、**callback 错误优先级（类型化 state.error 先于 UnRAR 原始码，含 BudgetRetryRequired 穿过真实 callback 的释放-重排队恢复测试）**、无文件写出与 abort 后恢复全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src-tauri/src/source/archive/rar_backend.rs src-tauri/src/source/archive/rar_callback.rs src-tauri/src/source/archive/mod.rs
git commit -m "feat(archive): 支持单卷 RAR/CBR 与会话密码"
```

---

### 任务 6：7z 普通/solid、密码与单卷 backend

**文件：**
- 创建：`src-tauri/src/source/archive/sevenz_backend.rs`
- 创建：`src-tauri/src/source/archive/sevenz_header_precheck.rs`
- 修改：`src-tauri/src/source/archive/mod.rs`
- 修改：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`（预检直接依赖，见任务 1 补充）

- [ ] **步骤 1：写运行时生成 fixture 的失败测试**

```rust
#[test]
fn sevenz_precheck_rejects_oversized_encoded_header_and_numfiles_before_open() {
    // 走生产链路 open_checked（SevenZBackend 唯一的 open 入口，内部先 precheck 再调
    // 注入的计数 opener），不是只调 precheck——否则 open_call_count 恒为 0，测试恒真。
    let harness = PrecheckHarness::with_counting_opener();
    // 合法 fixture 对照：预检通过、open 恰好被调用一次（证明计数器与链路本身工作）
    let (_guard_ok, ok) = create_7z(false, None);
    assert!(harness.open_checked(&ok).is_ok());
    assert_eq!(harness.open_call_count(), 1);
    // 恶意 fixture：在 SevenZReader::open 之前（含 header 解码路径）拒绝
    assert!(matches!(
        harness.open_checked(&fixture_input("header-encoded-oversize.7z")),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
    assert!(matches!(
        harness.open_checked(&fixture_input("header-numfiles-over.7z")),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
    assert_eq!(harness.open_call_count(), 1); // 两个恶意包都没有再触发 open
}

#[test]
fn sevenz_solid_folder_with_many_files_passes_precheck() {
    // 内层计数不得复用外层 4 条流水线上限：单个 solid folder 含 6 个文件（> 4）的正常包
    // 必须通过预检——否则会拒绝正常的 solid 漫画包。用 solid 专用 helper（push_source_path
    // 同一 pack/folder，create_7z_with_files 是逐条目 non-solid，证明不了本合同）
    let (_guard, path) = create_solid_7z_with_files(
        &["p0.png", "p1.png", "p2.png", "p3.png", "p4.png", "p5.png"], None, false);
    let harness = PrecheckHarness::with_counting_opener();
    assert!(harness.open_checked(&path).is_ok());
    assert_eq!(harness.open_call_count(), 1);
    // 打开后的 archive 验证（sevenz-rust 0.6.1 公开 API；SubStreamsInfo 公开字段只有
    // unpack_sizes/has_crc/crcs——没有 num_unpack_streams）：单 folder + 6 个数据
    // substream 以 unpack_sizes.len() == 6 证明
    let reader = sevenz_rust::SevenZReader::open(&path, sevenz_rust::Password::empty()).unwrap();
    assert_eq!(reader.archive().folders.len(), 1);
    let sizes = reader.archive()
        .substreams_info
        .as_ref()
        .map(|s| &s.unpack_sizes)
        .expect("solid folder 必有 substreams_info");
    assert_eq!(sizes.len(), 1);
    assert_eq!(sizes[0].len(), 6);
}

#[test]
fn sevenz_precheck_rejects_corrupt_start_header_without_tail_scan() {
    // 有意兼容性退化的回归：上游会 try_to_locale_end_header 尾部搜索，本模块直接拒绝。
    // 在内存中翻转固定 fixture 的 start-header CRC 字节后落盘（不改 24 个哈希清单）；
    // 同样走生产 open_checked 链路（注入计数 opener），不直接调 precheck
    let corrupted = flip_start_header_crc(&fixture_input("header-encoded-oversize.7z"));
    let harness = PrecheckHarness::with_counting_opener();
    assert!(matches!(
        harness.open_checked(&corrupted),
        Err(ArchiveAccessError::CorruptArchive(_))
    ));
    assert_eq!(harness.open_call_count(), 0);
    assert_eq!(harness.bytes_scanned_total(), 32); // 仅签名头 32 字节；计数合同＝预检总读取量，尾部扫描会使其远大于 32
}

#[test]
fn sevenz_plain_solid_and_encrypted_contract() {
    let (_guard_plain, plain) = create_7z(false, None);
    let (_guard_solid, solid) = create_7z(true, None);
    let (_guard_encrypted, encrypted) = create_7z(true, Some("test-pass-中文"));
    for path in [plain, solid] {
        let input = ArchiveInput::Path(path);
        let catalog = SevenZBackend.catalog(&input, "", None).unwrap();
        assert_eq!(catalog.entries.len(), 2);
        assert_eq!(SevenZBackend.read_entry(&input, "page1.png", None, &mut DecodeBudget::unbounded()).unwrap(), PNG_BYTES);
    }
    let encrypted_input = ArchiveInput::Path(encrypted);
    assert_eq!(SevenZBackend.catalog(&encrypted_input, "", None).unwrap_err(),
               ArchiveAccessError::PasswordRequired);
    assert_eq!(SevenZBackend.read_entry(
        &encrypted_input, "page1.png", Some(b"wrong"), &mut DecodeBudget::unbounded()
    ).unwrap_err(), ArchiveAccessError::WrongPassword);
    assert_eq!(SevenZBackend.read_entry(
        &encrypted_input, "page1.png", Some("test-pass-中文".as_bytes()), &mut DecodeBudget::unbounded()
    ).unwrap(), PNG_BYTES);
}

#[test]
fn split_7z_filename_is_rejected_without_opening_neighbor_parts() {
    let path = tempdir().unwrap().path().join("book.7z.001");
    assert!(matches!(
        SevenZBackend.catalog(&ArchiveInput::Path(path), "", None),
        Err(ArchiveAccessError::MultiVolumeUnsupported(_))
    ));
}

#[test]
fn sevenz_probe_falls_back_to_encrypted_non_image_and_reports_empty() {
    // SevenZWriter 默认 set_encrypt_header(true)（docs 明示）——fallback fixture 必须显式关闭
    // header 加密（内容加密、header 可见），否则无密码 probe 在看到 note.txt 前就 PasswordRequired。
    let (_guard_nonimage, nonimage) = create_7z_content_encrypted_only_file("note.txt", "test-pass-中文");
    let probe = SevenZBackend.probe(&ArchiveInput::Path(nonimage), "", None).unwrap();
    assert_eq!(probe.image_count, 0);
    assert!(probe.first_encrypted_file.is_some());
    // 对照：header 加密变体（保持默认 set_encrypt_header(true)）无密码 probe 直接 PasswordRequired
    let (_guard_header, header_encrypted) = create_7z_header_encrypted_only_file("note.txt", "test-pass-中文");
    assert!(matches!(
        SevenZBackend.probe(&ArchiveInput::Path(header_encrypted), "", None),
        Err(ArchiveAccessError::PasswordRequired)
    ));
    let (_guard_empty, empty) = create_7z_empty();
    assert_eq!(SevenZBackend.probe(&ArchiveInput::Path(empty), "", None).unwrap().entry_count, 0);
}

#[test]
fn sevenz_probe_image_count_is_prefix_scoped() {
    // 与 ZIP 同款回归：a/note.txt + b/page.png——a/ 视图无图、全包 1 图
    let (_guard_dirs, dirs) = create_7z_with_files(&["a/note.txt", "b/page.png"], None, false);
    let scoped = SevenZBackend.probe(&ArchiveInput::Path(dirs.clone()), "a/", None).unwrap();
    assert_eq!(scoped.entry_count, 2);
    assert_eq!(scoped.image_count, 0);
    let full = SevenZBackend.probe(&ArchiveInput::Path(dirs), "", None).unwrap();
    assert_eq!(full.image_count, 1);
}

#[test]
fn sevenz_dictionary_limit_rejects_oversized_coder_before_decoding() {
    // 构造性 fixture（gen_declared_dict.py 生成，coder properties 完全受控）：
    // LZMA 变体 properties = [0x5D, dict LE32] —— 第 0 字节（lc/lp/pb）非零，
    // 把"前 5 字节"当 dict 的错误实现会算出错误尺寸而被本用例抓出
    for fixture in ["dict-oversize-lzma.7z", "dict-oversize-lzma2.7z"] {
        assert!(matches!(
            SevenZBackend.read_entry(&fixture_input(fixture), "page.png", None, &mut DecodeBudget::unbounded()),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }
    // 注入小上限等价覆盖：正常小包在 64 KiB dict 上限下同样被拒（LZMA2 最小档即 256 KiB）
    let (_guard_normal, normal) = create_7z_with_files(&["page.png"], None, false);
    assert!(matches!(
        SevenZBackend::with_test_limits(ArchiveLimits::for_test().dict_bytes(64 * 1024))
            .read_entry(&ArchiveInput::Path(normal), "page.png", None, &mut DecodeBudget::unbounded()),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
}

#[tokio::test]
async fn sevenz_workspace_budget_rejects_oversized_sum_instead_of_clamping() {
    // 注入 6 MiB 预算：dict 4 MiB + 声明输出 3 MiB = 7 MiB > 6 → DecodeBudget::for_limits
    // 构造即拒绝（Service 声明预检步骤①由该构造承载），不得 min() 钳到预算内放行
    let limits = ArchiveLimits::for_test().budget_bytes(6 * 1024 * 1024);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(6));
    assert!(DecodeBudget::for_limits(&limits, 3 * 1024 * 1024, 4 * 1024 * 1024, semaphore.clone())
        .await.is_err());
    // 预算 8 MiB 时同一组（和 7 ≤ 8）构造通过；writer 输出上限 = 8 - 4 = 4 MiB ≥ 3 MiB → 读取成功
    let bigger = ArchiveLimits::for_test().budget_bytes(8 * 1024 * 1024);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(8));
    let mut budget = DecodeBudget::for_limits(
        &bigger, 3 * 1024 * 1024, 4 * 1024 * 1024, semaphore).await.unwrap();
    assert!(SevenZBackend::default()
        .read_entry(&fixture_input("dict-budget-oversum.7z"), "page.png", None, &mut budget)
        .is_ok());
}

// 谎报声明（header 写小、实际解出更大）的合同测试在 Service 层用可控 fake backend 锁定
//（fake 直接解耦"声明大小"与"实际输出字节数"，见任务 7）：真实 7z 需要手写谎报
// substream sizes 并自证 sevenz-rust 不按声明截断 reader、不先报 CRC 错误——构造合同
// 成本高且库行为未证，不作为 fixture 承载。

#[test]
fn sevenz_probe_limits_apply_to_non_image_entries_and_paths() {
    // 与 ZIP 同款注入小上限合同：9 个非图片条目或超长路径名都不得等图片过滤后才报错
    let backend = SevenZBackend::with_test_limits(
        ArchiveLimits::for_test().entry_count(8).path_bytes(64));
    let (_guard_many, many) = create_7z_with_files(
        &["file0.txt", "file1.txt", "file2.txt", "file3.txt", "file4.txt",
          "file5.txt", "file6.txt", "file7.txt", "file8.txt"], None, false);
    assert!(matches!(backend.probe(&ArchiveInput::Path(many), "", None),
                     Err(ArchiveAccessError::ResourceLimitExceeded(_))));
    let long_name = format!("{}.txt", "a".repeat(65));
    let (_guard_long, long) = create_7z_with_files(&[long_name.as_str()], None, false);
    assert!(matches!(backend.probe(&ArchiveInput::Path(long), "", None),
                     Err(ArchiveAccessError::ResourceLimitExceeded(_))));
}
```

测试 helper 集中定义（`sevenz_backend.rs` tests，全部按 sevenz-rust 0.6.1 **实际公开 API**：写入用 `push_archive_entry(SevenZArchiveEntry, Option<R>)` + `SevenZArchiveEntry::from_path`（无 `push_entry` 这样的逐条目密码参数）；密码经 `set_content_methods` 注入 `AesEncoderOptions::new(pw.into())`——参数是 `Password` 类型（官方示例 `"password".into()`），不是 `String`——官方顺序 AES 在前、LZMA2 在后；solid 经 `push_source_path`、non-solid 逐条目 push。所有 helper 返回 `(TempDir, PathBuf)`：guard 由测试持有，路径在测试作用域有效、测试结束自动回收——既避免 `dir.path()` 借用在 helper 返回时连产物一起销毁，也避免 `into_path()` 每次运行永久泄漏临时目录）：

```rust
fn create_7z(solid: bool, password: Option<&str>) -> (tempfile::TempDir, PathBuf) {
    let dir = tempdir().unwrap();
    let sources = dir.path().join("sources");
    std::fs::create_dir_all(&sources).unwrap();
    std::fs::write(sources.join("page1.png"), PNG_BYTES).unwrap();
    std::fs::write(sources.join("page2.png"), PNG_BYTES).unwrap();
    let out = dir.path().join("t.7z");
    let mut writer = sevenz_rust::SevenZWriter::create(&out).unwrap();
    writer.set_encrypt_header(password.is_some()); // 加密变体 header+内容都加密（主合同断言依赖）
    if let Some(pw) = password {
        writer.set_content_methods(vec![
            sevenz_rust::AesEncoderOptions::new(pw.into()).into(),
            sevenz_rust::lzma::LZMA2Options::with_preset(9).into(),
        ]);
    }
    if solid {
        // solid 路径：整个 sources 目录进同一 pack/folder（README "Solid compression" 用法）
        writer.push_source_path(&sources, |_| true).unwrap();
    } else {
        // non-solid 路径：逐条目独立 folder
        for name in ["page1.png", "page2.png"] {
            let src = sources.join(name);
            writer.push_archive_entry(
                sevenz_rust::SevenZArchiveEntry::from_path(&src, name.to_string()),
                Some(std::fs::File::open(&src).unwrap()),
            ).unwrap();
        }
    }
    writer.finish().unwrap();
    (dir, out)
}

fn create_solid_7z_with_files<S: AsRef<str>>(
    names: &[S],
    password: Option<&str>,
    encrypt_header: bool,
) -> (tempfile::TempDir, PathBuf) {
    // solid 变体：全部文件经 push_source_path 压进同一 pack/folder（create_7z 的 solid 路径
    // 同款），用于验证单 folder 多 substream 不受外层 4 项上限约束
    let dir = tempdir().unwrap();
    let sources = dir.path().join("sources");
    std::fs::create_dir_all(&sources).unwrap();
    for name in names {
        let name = name.as_ref();
        let content: &[u8] = if name.ends_with(".png") { PNG_BYTES } else { b"test text" };
        std::fs::write(sources.join(name), content).unwrap();
    }
    let out = dir.path().join("t.7z");
    let mut writer = sevenz_rust::SevenZWriter::create(&out).unwrap();
    writer.set_encrypt_header(encrypt_header);
    if let Some(pw) = password {
        writer.set_content_methods(vec![
            sevenz_rust::AesEncoderOptions::new(pw.into()).into(),
            sevenz_rust::lzma::LZMA2Options::with_preset(9).into(),
        ]);
    }
    writer.push_source_path(&sources, |_| true).unwrap();
    writer.finish().unwrap();
    (dir, out)
}

fn create_7z_with_files<S: AsRef<str>>(
    names: &[S],
    password: Option<&str>,
    encrypt_header: bool,
) -> (tempfile::TempDir, PathBuf) {
    // non-solid 变体：逐条目独立 folder
    let dir = tempdir().unwrap();
    let sources = dir.path().join("sources");
    std::fs::create_dir_all(&sources).unwrap();
    for name in names {
        let name = name.as_ref();
        let content: &[u8] = if name.ends_with(".png") { PNG_BYTES } else { b"test text" };
        let target = sources.join(name); // 还原子目录结构（a/note.txt 等）
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, content).unwrap();
    }
    let out = dir.path().join("t.7z");
    let mut writer = sevenz_rust::SevenZWriter::create(&out).unwrap();
    writer.set_encrypt_header(encrypt_header); // 加密语义显式声明，不依赖默认值
    if let Some(pw) = password {
        writer.set_content_methods(vec![
            sevenz_rust::AesEncoderOptions::new(pw.into()).into(),
            sevenz_rust::lzma::LZMA2Options::with_preset(9).into(),
        ]);
    }
    for name in names {
        let name = name.as_ref();
        let src = sources.join(name);
        writer.push_archive_entry(
            sevenz_rust::SevenZArchiveEntry::from_path(&src, name.to_string()),
            Some(std::fs::File::open(&src).unwrap()),
        ).unwrap();
    }
    writer.finish().unwrap();
    (dir, out)
}

fn create_7z_content_encrypted_only_file(name: &str, pw: &str) -> (tempfile::TempDir, PathBuf) {
    create_7z_with_files(&[name], Some(pw), false) // 内容加密、header 可见
}

fn create_7z_header_encrypted_only_file(name: &str, pw: &str) -> (tempfile::TempDir, PathBuf) {
    create_7z_with_files(&[name], Some(pw), true) // header + 内容都加密（默认值语义）
}

fn create_7z_empty() -> (tempfile::TempDir, PathBuf) {
    create_7z_with_files(&[] as &[&str], None, false) // 空切片显式元素类型
}

/// 预检测试 harness（`sevenz_header_precheck.rs` tests）——计数器只统计**本模块可观测的边界**，
/// 不声称能统计依赖库（sevenz-rust）内部的 KDF：
/// - open_checked(path) / open_checked_with_password(path, pw: &str)：SevenZBackend 唯一
///   open 入口——内部先跑两阶段预检（密码经参数或 harness 默认传入），通过后调用注入的 opener。
/// - probe_with_password(path, prefix: &str, pw: &str)：folder 级 KDF 防线的 probe 入口。
/// - with_counting_opener：注入计数 opener；open_call_count 返回 opener 被调用次数。
/// - header_kdf_invocations：自研 header decoder 的 `derive_key` 被注入计数实现替换后的
///   **真实调用次数**（自研路径有注入点）。
/// - entry_decoder_calls：本模块调用 sevenz-rust 条目解码入口（`for_each_entries`/
///   entry decoder）的次数——folder 级防线的断言语义是"超限拒绝发生在该调用**之前**"，
///   不直接观测库内 KDF。
/// - bytes_scanned_total：预检的总读取字节数（断言"未做尾部扫描"）。
/// flip_start_header_crc：读入文件、翻转签名头 start-header CRC 的一个字节后写临时文件返回路径。
```

`dict-*`/`header-*`/`content-*` 十一个构造性 fixture 无法经 `SevenZWriter` 生成（encoder 不暴露 dictionary 大小、header 声明与 AES properties 控制），由 `gen_declared_dict.py`（**Python ≥ 3.11，双机器环境（本机 3.11.4 / racyan 3.12）均可执行；可复现承诺限定为"内容锁定"——已提交的 SHA-256 清单是真值，`lzma` 压缩输出随链接的 liblzma 版本变化、跨机器重生成字节不同属预期，不承诺字节级再生成；重生成结果与清单不一致时丢弃、以已提交产物为准，不得部分覆盖**；仅标准库 `zlib.crc32` 与 `lzma`，无三方依赖）从零构造最小 7z。**生成方案唯一固定**：`dict-*` 三个与 `content-kdf-over.7z` 为 raw `kHeader`（非 encoded）——手写 32 字节签名头 + 属性流，coder/AES properties 受控；`header-*` 七个为 `kEncodedHeader` 形态——外层 StreamsInfo 手写字节，packed payload 用 **Python 标准库 `lzma.LZMACompressor(format=FORMAT_RAW, filters=[...])`**（LZMA2/LZMA1/DELTA+LZMA2/BCJ-X86+LZMA2 按各 fixture 合同选定 filter 链；KDF fixture 的 AES coder properties 由脚本手写）压缩或拼装内层属性流字节（脚本记录 filter properties 字节、每段 CRC32 与完整字节布局）。逐个合同：

- `dict-oversize-lzma.7z`（raw kHeader）：单 LZMA coder，properties = `[0x5D, dict LE32]`（dict 声明 > 512 MiB；第 0 字节 lc/lp/pb 非零，读错 `[1..5]` 偏移的实现会算错尺寸被用例抓出），packed stream 为占位字节（测试在解码前拒绝，无需有效数据）。
- `dict-oversize-lzma2.7z`（raw kHeader）：单 LZMA2 coder，properties 首字节档位声明 dict > 512 MiB，占位 packed stream 同上。
- `dict-budget-oversum.7z`（raw kHeader）：LZMA2 coder 声明 dict 4 MiB，单 entry 声明大小 = 实际 payload = 3 MiB 真实重复字节数据，header/substream/CRC 全部正确（预算内用例需要真实解码成功）。
- `header-encoded-oversize.7z`（kEncodedHeader）：外层 StreamsInfo 声明单 pack stream（coder = LZMA2）、**声明 unpack size = 16 MiB > `MAX_ENCODED_HEADER_BYTES`（8 MiB）**，packed 数据为占位字节（防线靠外层声明值触发，无需真实压缩数据）；start-header 与 kEncodedHeader 各段 CRC 全部正确。预期：预检解析外层 StreamsInfo 即拒绝 `ResourceLimitExceeded`，不构造 decoder。
- `header-numfiles-over.7z`（kEncodedHeader）：外层 StreamsInfo 全部合法（单 pack stream LZMA2、unpack size ≤ 8 MiB、dictionary ≤ 8 MiB、CRC 正确），**内层属性流（解码后）的 `kFilesInfo` 携带 `numFiles = 100_001` > `MAX_CATALOG_ENTRIES`**——内层属性流字节由脚本手写后经上述 FORMAT_RAW+FILTER_LZMA2 压缩为 packed payload，其余字段最小占位。预期：阶段一通过（外层合法）、受限解码成功、阶段二解析到内层 numFiles 即拒绝——实现若在解码后把数据直接交给上游不安全解析，本 fixture 会令其 OOM/失败，测试抓出。

- `header-copy.7z`（kEncodedHeader，合法）：外层 coder = COPY（id 取 `SevenZMethod::ID_COPY` 字节合同），内层属性流原样存放（Python 侧无需压缩），全部计数合法、CRC 正确。验收：预检通过、`open_call_count == 1`、catalog 结果正确。
- `header-lzma.7z`（kEncodedHeader，合法）：外层 coder = LZMA（id 取 `SevenZMethod::ID_LZMA` 字节合同），packed payload 用 Python `lzma.LZMACompressor(format=FORMAT_RAW, filters=[{"id": FILTER_LZMA1, "preset": 6, "dict_size": 1 << 20}])` 压缩内层属性流（filter properties 记录于脚本），全部计数合法、CRC 正确。验收同上。
- `header-delta-lzma2.7z`（kEncodedHeader，合法）：外层 coder 链 = DELTA + LZMA2（bind pair 顺序与 7z 规范一致），payload 用 Python `lzma.LZMACompressor(format=FORMAT_RAW, filters=[{"id": FILTER_DELTA, "dist": 1}, {"id": FILTER_LZMA2, "preset": 6}])` 生成，全部计数合法、CRC 正确。验收走 `open_checked` → catalog 完整链路。
- `header-bcj-x86-lzma2.7z`（kEncodedHeader，合法）：外层 coder 链 = BCJ-X86 + LZMA2，payload 用 Python `lzma.LZMACompressor(format=FORMAT_RAW, filters=[{"id": FILTER_X86}, {"id": FILTER_LZMA2, "preset": 6}])` 生成，全部计数合法、CRC 正确。验收同上；其余 BCJ 架构由 `gen_declared_dict.py` 内嵌已知向量的单测覆盖反变换函数（不新增 fixture）。

脚本提交仓库并记录 Python 版本、脚本 SHA-256，十一个产物进入 fixture 哈希清单；脚本另产出 `src-tauri/tests/fixtures/archive/kat_vectors.json`（KAT 测试元数据，随脚本提交但不计入 24 个 archive fixture 的数量与哈希断言）。

另需把 KDF 防线测试加入步骤 1（与另两个防线测试同款 harness 形态）：

```rust
#[test]
fn sevenz_precheck_rejects_oversized_kdf_cycles_before_derivation() {
    // 合法加密对照：SevenZWriter 实际产出的 AES properties 高位非零（默认带 IV），
    // 经 & 0x3F 提取后放行——显式传密码打开，验证自研 header derive_key 被真实调用
    //（快照比较；entry 路径的库内 KDF 不在本计数范围，见 harness 合同）
    let (_guard_ok, ok) = create_7z(true, Some("test-pass-中文"));
    let probe_harness = PrecheckHarness::with_counting_opener();
    let kdf_before = probe_harness.header_kdf_invocations();
    assert!(probe_harness.open_checked_with_password(&ok, "test-pass-中文").is_ok());
    assert!(probe_harness.header_kdf_invocations() > kdf_before); // 合法包确实走了派生
    // 恶意 fixture：用全新 harness（计数从零），断言本次调用没有增加派生计数
    let harness = PrecheckHarness::with_counting_opener();
    assert!(matches!(
        harness.open_checked_with_password(&fixture_input("header-kdf-over.7z"), "any"),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
    assert_eq!(harness.header_kdf_invocations(), 0); // 自研 header 派生从未启动
}

#[test]
fn sevenz_folder_kdf_guard_rejects_before_entry_derivation() {
    // folder 级路径（raw kHeader、header 可见）：数据 folder 的 AES cycles 超限，
    // probe 阶段即拒——断言语义是"拒绝发生在本模块调用条目解码入口之前"，
    // 不直接观测 sevenz-rust 库内 KDF（无注入点）
    let harness = PrecheckHarness::with_counting_opener();
    assert!(matches!(
        harness.probe_with_password(&fixture_input("content-kdf-over.7z"), "", "any"),
        Err(ArchiveAccessError::ResourceLimitExceeded(_))
    ));
    assert_eq!(harness.entry_decoder_calls(), 0);
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::sevenz
```

预期：FAIL，`sevenz_backend` 与 `sevenz_header_precheck` 模块均不存在（`source::archive::sevenz` 前缀覆盖两者）。若 `create_7z` helper 的 `SevenZWriter` 调用在此步编译失败，说明任务 1 的 dev-dependencies `compress` feature 未生效，先修依赖再继续——本红灯步骤即 writer 的编译守卫。

- [ ] **步骤 3：实现 SevenZReader 操作**

以 `SevenZReader::open(path, Password)` 打开；`archive().files` 生成 catalog/stat；`for_each_entries` 顺序解码并在命中条目后读取完整数据、返回 `Ok(false)` 停止。solid 包不得跳过目标之前的数据。

密码构造：

```rust
fn sevenz_password(password: Option<&[u8]>) -> Result<sevenz_rust::Password, ArchiveAccessError> {
    match password {
        None => Ok(sevenz_rust::Password::empty()),
        Some(bytes) => std::str::from_utf8(bytes)
            .map(sevenz_rust::Password::from)
            .map_err(|_| ArchiveAccessError::WrongPassword),
    }
}
```

将 `PasswordRequired`、错误 AES 密码、checksum、unsupported method、missing entry 分别映射到稳定错误。`create_7z`（主合同测试用）保持 SevenZWriter 默认 `set_encrypt_header(true)`——header 与内容都加密，`catalog(None)` 的 `PasswordRequired` 断言依赖该默认值，不得顺手关闭；内容加密、header 可见的 fixture 一律用显式 `set_encrypt_header(false)` 的专用 helper（见 fallback 测试），两类变体的边界由测试名钉死。

`archive().files` 建 probe/catalog 时对**每个原始条目（含非图片）**检查总条目数、规范化路径长度与声明 entry size，任一超限 `ResourceLimitExceeded`，不得先过滤图片再限额；`for_each_entries` 读取命中项时通过 `LimitedEntryWriter`/限长 read loop 约束实际输出（同样接任务 7 的 `DecodeBudget`：水位 `try_grow`、`output_cap` 终态、失败 `BudgetRetryRequired`）。

sevenz-rust 0.6.1 的 `SevenZReader` 把内部 `MAX_MEM_LIMIT_KB` 固定为 `usize::MAX / 1024`（私有常量，无公开 API 可注入），且 LZMA decoder 分支不执行该内存检查——`Error::MaxMemLimited` 实际不可能触发。此外 **open 阶段本身就有前置分配路径**：`SevenZReader::open` 先按不可信 `next_header_size` 创建 Vec；encoded/encrypted header 还会先构造 decoder 并按其声明 unpack size resize 输出缓冲——这些都发生在本模块能看到 `archive().folders` **之前**，folder 级 dictionary 检查与 catalog 限额保护不到。因此 7z 的内存边界分两层：

1. **打开前预检（本任务新增）**：backend 在调用 `SevenZReader::open` 前执行自研的有界预检（实现路径见下），钳制三类数值，常量命名与 spec §4.5 逐字一致：`MAX_NEXT_HEADER_BYTES = 1 MiB`、`MAX_ENCODED_HEADER_BYTES = 8 MiB`、`MAX_HEADER_DICT_BYTES = 8 MiB`，另有 packed header 输入上限 `MAX_HEADER_PACKED_BYTES = 16 MiB`（见阶段一）。
   - **定位**：先读 32 字节签名头，验证 magic 与 start-header CRC32；按规范用 `checked_add(SIGNATURE_HEADER_SIZE + next_header_offset, next_header_size)` 计算绝对区间——**不得"从文件尾部猜测"**——并确认 offset+size 不越出文件长度，否则按 `CorruptArchive` 拒绝。**有意的兼容性退化**（须在 README 与实现记录中声明）：上游 `Archive::read` 在 start-header 校验失败时会调用 `try_to_locale_end_header` 在尾部范围内搜索恢复，本模块收紧为直接拒绝——安全优先于损坏包恢复；回归验收加入"损坏 start header（CRC 不匹配）被拒绝且不进入尾部扫描"的用例，若未来真实样本证明需要恢复，再单独设计有界扫描策略。
   - **header 计数——两阶段有界解析**：encoded header 自身先携带外层 `StreamsInfo`（PackInfo/UnpackInfo/Folders），预检必须先解析它才能建立 decoder——若解析时先按 `numPackStreams`/`numFolders`/`numCoders` 分配，仍会在解码内层 header 前 OOM。因此预检分两阶段，**每类结构的数值上限精确固定**（不留"对应结构上限"的未定义条件）：**阶段一（外层 encoded-header StreamsInfo，纯声明解析、零分配——逐个数值读入并比对，任何 Vec 分配之前完成）**：`numPackStreams ≤ 4`、`numFolders ≤ 4`、每 folder `numCoders ≤ 4`（外层只是 header 解码流水线，几条足够）、packed header 输入（`PackInfo.pack_sizes` 之和）≤ **`MAX_HEADER_PACKED_BYTES = 16 MiB`——这是位于 `SIGNATURE_HEADER_SIZE + pack_pos` 的独立 packed streams 总量，不是 next-header 描述块自身，不得复用 `MAX_NEXT_HEADER_BYTES`（COPY coder 的 packed 尺寸等于解码后尺寸，8 MiB 级 header 配 1 MiB 上限会把合法 encoded header 直接拒掉）**；`pack_pos` 与各 stream size 用 `checked_add` 校验绝对区间不越出文件长度（与定位步骤同款检查）；unpack sizes 累加 ≤ `MAX_ENCODED_HEADER_BYTES`、coder dictionary ≤ `MAX_HEADER_DICT_BYTES`、CRC/digest 与位图长度 ≤ 对应计数上限；任一越界即拒绝。**阶段二（内层 header，受限解码后解析）**：用阶段一验证过的参数构造受限解码器（输出经本模块 `LimitedEntryWriter` 约束），对解码结果**再执行一次有界解析**——内层 `MainStreamsInfo` 自带 pack/folder/coder/substream 计数，不得复用外层 4 条流水线上限（那会拒绝单个 solid folder 含 5 张以上图片的正常包）：内层总 folders/total coders/substream 计数各自按 `min(MAX_CATALOG_ENTRIES, header 解码输出长度所能编码的合理上界)` 限制（folders/coders/substream ≤ 100,000，pack sizes 累加 ≤ 文件长度——内层 StreamsInfo 描述的是数据区，以实际文件大小为天然上界）；`num_files ≤ 100,000`、empty-stream 位图长度 = `num_files` 向上取整到字节边界。

**header coder 兼容矩阵**：coder id 一律以 sevenz-rust 0.6.1 `SevenZMethod::ID_*` 常量的字节合同为准（不在文档手抄十六进制，防止再次抄错）。**完整支持线性 coder 链**：COPY、LZMA、LZMA2、DELTA、BCJ（x86/ARM/ARMT/PPC/SPARC/IA64 六个架构变体，按 coder 链顺序逐级反变换，实现于 `sevenz_header_precheck.rs`）与 AES-CBC（经 `aes`/`cbc`，链位遵守规范）；**BCJ2 之外不做缩减**——BCJ2 是多输入 coder graph（需要 binder/pack stream 重排），本模块的受限解码器不支持，遇到 BCJ2 如实返回 `UnsupportedCodec`，这是**显式声明的兼容性退化**（与损坏 start-header 退化同级：设计稿、README 与验收清单三处声明；上游能开 BCJ2 header 的包在本模块被拒并提示不支持）。矩阵内的合法 encoded-header 变体验收：`header-copy.7z`（COPY，内层原样无需压缩）、`header-lzma.7z`（LZMA，Python `FILTER_LZMA1` 压缩）、**`header-delta-lzma2.7z`（DELTA+LZMA2 双 coder 链，Python `lzma.LZMACompressor(format=FORMAT_RAW, filters=[{"id": FILTER_DELTA, "dist": 1}, {"id": FILTER_LZMA2, "preset": 6}])`）与 `header-bcj-x86-lzma2.7z`（BCJ-X86+LZMA2，filters `[{"id": FILTER_X86}, {"id": FILTER_LZMA2, "preset": 6}]`）**——Python 3.11/3.12 `lzma` FORMAT_RAW 原生支持 DELTA/X86/IA64/ARM/ARMTHUMB/POWERPC/SPARC custom filter chain，此前"无法生成参考实现"的说法不成立；四个 fixture 都走 `open_checked` → catalog 的**完整链路**断言（预检通过、`open_call_count == 1`、catalog 结果正确），覆盖 StreamsInfo 解析、coder properties、bind pair、链顺序、decoder 组装与输出限制；其余 BCJ 架构（ARM/ARMT/PPC/SPARC/IA64）用已知向量单测反变换函数补齐（`gen_declared_dict.py` 内嵌预期向量，不再新增 fixture）。**实现路线唯一确定：自研受限 header decoder**（不做 sevenz-rust fork——fork 的钳制发生在 `SevenZReader::open` 内部，时序矛盾且维护负担重）：新建 `src-tauri/src/source/archive/sevenz_header_precheck.rs`，`mod.rs` 导出该模块；直接依赖 `lzma-rust = { version = "=0.1.7", default-features = false }`（与 sevenz-rust 0.6.1 的传递依赖同版；**必须关闭默认 feature——其默认 feature 就是 encoder，裸引会在生产构建重新启用编码器**），**`aes = { version = "0.8", features = ["zeroize"] }`（zeroize feature 清除 key schedule，见 §5.2 生命周期约束）、`cbc = "0.1"` 显式声明为直接依赖**——sevenz-rust 只以可选依赖形式引入它们，本项目不能隐式依赖传递解析；三者均 MIT/Apache 双许可。两阶段都通过后才调用 `SevenZReader::open`。**验收条件：在危险分配（任何按计数/尺寸驱动的 `Vec::with_capacity/resize`）发生之前拒绝**——不关心拒绝点相对 open 调用的先后来兜底，直接以分配为界。
   - **fixture**：恶意防线夹具 `header-encoded-oversize.7z`（外层声明超限即拒）、`header-numfiles-over.7z`（合法外层 + 内层 numFiles 超限）、`header-kdf-over.7z`（合法外层 + AES cycles 超限，KDF 未启动即拒）与 `content-kdf-over.7z`（raw kHeader、header 可见，**数据 folder** 的 AES cycles 超限——folder 级防线载体）+ 合法变体 `header-copy.7z`/`header-lzma.7z`/`header-delta-lzma2.7z`/`header-bcj-x86-lzma2.7z`，共 **7 个 `header-*` + 1 个 `content-*`**，全部由 `gen_declared_dict.py` 产出并进入任务 1 的固定清单（与 3 个 `dict-*` 合计 11 个构造性 fixture、总数 24 个；文件列表、`$fixtures` 数组、哈希计数断言、README 已同步）。另加"损坏 start header（CRC 不匹配）被拒绝"用例：可由测试在内存中翻转固定 fixture 的 start-header CRC 字节后落盘（不改清单），断言直接拒绝、不进入尾部扫描（计数合同：`bytes_scanned_total()` 统计预检总读取量，断言 32——尾部扫描会使其远大于 32）。
2. **folder 级检查**：`SevenZReader::open` 成功后、任何条目解码之前，遍历 `archive().folders[].coders[]`（`decompression_method_id()` 与 `properties` 公开可读）逐 folder 解析 dictionary——LZMA 变体要求 `properties.len() >= 5`，dictionary 为 `u32::from_le_bytes(properties[1..5])` 小端：**第 0 字节编码 lc/lp/pb，不得把"前 5 字节"整体解释为 dictionary**（与官方 decoder 源码一致）；LZMA2 变体取 `properties[0]` 档位查表。folder dictionary 超过 `MAX_DICT_BYTES`（生产 512 MiB、可注入小值）立即返回 `ResourceLimitExceeded`，不进入解码；未知 coder id 的 properties 不做猜测，交由解码阶段既有错误映射。解析结果按 file→folder 归属（与加密推导同一条映射链）填入 `probe.entry_dictionaries`：Service 读取目标条目时按条目查询所属 folder 的 dictionary，不取全容器最大值——无关 folder 的大 dictionary 不得误拒当前读取；solid folder 内多条目共享同值。

`Error::MaxMemLimited` 仍映射 `ResourceLimitExceeded` 作为理论不可达的防御。用 test-only 8-byte limit 驱动 writer 越界单测，避免生成 512 MiB fixture。

7z 条目的加密状态不由 `files` 直接携带，按 folder 推导：遍历 `files` 时维护 folder 游标——`has_stream == true` 的条目依序归属各 folder（每 folder 的 unpack stream 数来自 `SubstreamsInfo`），`has_stream == false`（空文件/目录条目）无 stream、不视为加密；条目加密 = 所属 folder 的 coder 链包含 AES coder——**判定一律与 `SevenZMethod::ID_AES256SHA256` 比较（4 字节 `06 F1 07 01`），不得手写截短 ID**（写成 `F10701` 三字节会漏判加密条目，使 `first_encrypted_image/file` 为空、错误返回 Ready）。solid folder 中映射到该 folder 的全部文件一并视为加密。`first_encrypted_image` / `first_encrypted_file` 由此推导填写——content-encrypted、header 可见 fixture 的核心断言依赖这条链路。

**AES KDF 成本上限（两条路径都要覆盖）**：AES coder 的 properties 编码（对齐 7-Zip `7zAes.cpp`）为——`cycles = b0 & 0x3F`（低 6 位轮数指数）；若 `b0 & 0xC0 == 0`，properties **必须恰好 1 字节**；否则读取第二字节 `b1`，`salt_len = ((b0 >> 7) & 1) + (b1 >> 4)`、`iv_len = ((b0 >> 6) & 1) + (b1 & 0x0F)`，properties 总长度 = `2 + salt_len + iv_len`——长度与编码不符即 `CorruptArchive`（注意：**不是**统一的 `2 + …` 也不存在"高位值 × 4"——按错误公式实现，`b0 = 0x20` 的恶意 fixture 会被错判 `CorruptArchive` 而非预期的 `ResourceLimitExceeded`）。密钥派生执行约 2^cycles 次 SHA-256——恶意归档可用一个字节造成 CPU 拒绝服务。规则：**长度校验通过后，在任何密钥派生启动之前校验 `cycles ≤ 24`（特殊值 `0x3F` 接受——见下方 KDF 合同的 0x3F 分支），其余拒绝 `ResourceLimitExceeded`**——不得直接比较 `properties[0]`：高两位非零的正常加密包（SevenZWriter 默认带 IV）会被误拒。校验点在 **encoded header 预检阶段**（header coder 链含 AES 时，`sevenz_header_precheck.rs` 解析 properties 后、构造 decoder 前）与 **folder 级检查阶段**（数据 folder 的 AES properties，解密任何条目前——probe 阶段即拒，不进 read）。

**自研 AES decoder 的 KDF 与解密合同**（`sevenz_header_precheck.rs` 实现，对齐 7-Zip `7zAes.cpp` 的 `CKeyInfo::CalcKey`；`derive_key` 为独立函数以支持注入计数测试）：

- 密码字节：**所有权写法**——`let password_utf16le = Zeroizing::new(sevenz_rust::Password::from(pw).to_vec());`（即 **UTF-16LE 编码**，与 sevenz-rust 条目路径一致，中文密码依赖此编码）。不得直接用 `Password::from(pw).as_slice()`——那只是借用内部缓冲，既不满足清零约束也会遇到临时值生命周期问题；KDF 全程只保留这一份 `Zeroizing` 副本，不再持有未清零的同内容拷贝。
- `cycles == 0x3F` 分支：取 `salt || password`，**截断或零填充到 32 bytes** 后直接作为 key（salt 可以存在；不是"无 salt 约定"）。单次 SHA-256 都不执行——但仍是合法分支，必须放行。
- 其他 `cycles ≤ 24`——**单一 SHA-256 context**（不是逐轮 digest 链）：初始化一个 hasher，**每个 counter 都重新写入完整的 `salt || password_utf16le || counter_le64`**（salt 与 password 必须在循环体内、不是只在循环前写一次），对 counter = 0..2^cycles-1 依次追加，**全部 update 完成后只 finalize 一次**得到 32-byte key。前一轮没有独立 digest、不参与下一轮输入——按"每轮取输出喂下一轮"或"salt/password 只写一次"实现都会生成完全错误的密钥。伪代码写死：

```rust
fn derive_key(salt: &[u8], password_utf16le: &Zeroizing<Vec<u8>>, cycles: u8)
    -> Zeroizing<[u8; 32]>
{
    if cycles == 0x3F {
        let mut key = Zeroizing::new([0u8; 32]);
        let material = salt.iter().chain(password_utf16le.iter()); // salt || password
        for (i, b) in material.take(32).enumerate() { key[i] = *b; } // 截断/零填充到 32B
        return key;
    }
    let mut hasher = Sha256::new();               // 唯一 context
    for counter in 0u64..(1u64 << cycles) {
        hasher.update(salt);                      // 每个 counter 都重写 salt
        hasher.update(password_utf16le);          // 与 password——只写一次是错误实现
        hasher.update(counter.to_le_bytes());     // 再追加 counter，不 finalize
    }
    let digest = hasher.finalize();               // 只 finalize 一次
    Zeroizing::new(digest.into())
}
```

- IV：`iv`（`iv_len` 字节）**右侧补零到 16 bytes** 作为 CBC 初始向量。
- 解密：AES-256-CBC——**密文必须 16 字节对齐（packed 尺寸 % 16 == 0），非对齐返回 `CorruptArchive`**；按 16-byte block 解密，末块可能以零字节形式存在，**解密后按 coder 声明的 unpack size 截取输出，不做 PKCS#7 unpadding**（不得使用 `cbc` crate 的 `decrypt_vec` 等 PKCS#7 API——7z 不使用该填充）。
- **临时秘密清零**（遵守 §5.2 密码生命周期约束，错误/取消/正常返回都经 RAII 清理）：UTF-16LE 密码副本（`Zeroizing<Vec<u8>>`，见所有权写法）、`derive_key` 返回值（`Zeroizing<[u8; 32]>`）、以及 0x3F 分支的拼接 material 全部用 `Zeroizing`/`Zeroize` 包裹；**Cargo 中 `aes = { version = "0.8", features = ["zeroize"] }`** 显式启用 key schedule 清零（`aes` 0.8 默认不启用该 feature）。工作缓冲经单一 hasher 循环内分段 update（见伪代码）**从不物化为完整缓冲**，hasher 自身按 `sha2` 的常规栈生命周期释放。
- **known-answer test——可独立复核的字面量向量**（实现者无需自行补设计；向量独立于本伪代码推导，来源 7-Zip 24.09 `7zAes.cpp` 的 `CKeyInfo::CalcKey`，由 `gen_declared_dict.py` 附带的 `--print-kat` 用 Python `hashlib.sha256` 独立实现上述算法生成、与 7-Zip 实测输出双重核对后提交）：

  ①`salt = b"SALT1234"`（8B）、`password = "test-pass-中文"`（10 ASCII + 2 中文 BMP 字符 → **UTF-16LE 24B**——`--verify-kat` 显式断言编码后长度 == 24，长度不符即失败，防止元数据与真值漂移）、`cycles = 19`：
  期望 key 十六进制由 KAT 文件给出（`src-tauri/tests/fixtures/archive/kat_vectors.json` 随脚本提交，含输入、期望 key、来源版本与生成命令——**实现者断言前先跑 `--verify-kat`（逐字段自动比对，非零退出即失败），不再依赖人工打印比对**。该文件是测试元数据，**计入仓库交付但不计入 24 个 archive fixture 的数量与哈希断言**——`$fixtures` 数组与 `-ne 24` 不包含它）；
  ②`cycles = 0x3F`、`salt = b"SALT1234"`、同一密码：期望 key = `salt || password` 截断到 32B 的字面值（可直接从输入推出，测试中内联断言）。
  Rust 单测断言 `derive_key` 输出逐字节等于向量；两组向量同时验证"每 counter 重写 salt||password、单一 context、只 finalize 一次"的精确字节序列——链式 digest 或 salt 只写一次的实现都会对不上。

恶意与合法输入测试（两条路径各一组）：

- `header-kdf-over.7z`（encoded-header 路径）：合法外层 encoded header + AES coder properties 的 `b0 = 0x20`（cycles=0x20>24、高位 0）——断言 KDF/decoder 未启动即拒。
- `content-kdf-over.7z`（folder 级路径，**raw kHeader**、header 可见）：单数据 folder 的 AES coder properties `b0 = 0x20`，其余字段最小合法——断言 probe 阶段返回 `ResourceLimitExceeded`、条目 KDF/decoder 调用数为 0（fake/计数 harness）。
- **高位非零的合法用例**：`b0` 高位非零（如 `0x41` = cycles 1 + IV 标志（`(b0>>6)&1`）、`0x80` = cycles 0 + salt 标志（`(b0>>7)&1`），或 SevenZWriter 实际产出带 IV 的默认包）必须通过提取 `& 0x3F` 后放行——防止实现退化为直接比较 `properties[0]`；用 `create_7z(true, Some("test-pass-中文"))` 的真实加密包作对照（其 properties 高位即非零）。

两个恶意 fixture 均由 `gen_declared_dict.py` 产出（AES properties 字节手写）。

- [ ] **步骤 4：运行 7z 测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::sevenz -- --nocapture
```

预期（`source::archive::sevenz` 前缀同时覆盖 `sevenz_backend` 与 `sevenz_header_precheck` 两个模块——只跑 backend 会漏掉全部预检/KAT 测试）：普通、solid、加密、错误密码、probe 兜底（加密非图片/空包）与 header 加密对照、prefix 视图统计、dictionary 上限解码前拒绝（含 `[1..5]` 偏移合同）、**header 预检三连（encoded-oversize / numfiles-over 在 open 前拒绝且 open_call_count==0、损坏 start header 拒绝且不做尾部扫描）**、**KDF 双防线（header-kdf-over 恶意拒绝且 header_kdf_invocations==0 + 合法加密对照派生计数增加、content-kdf-over 在 entry_decoder_calls==0 前拒绝）与两组 KAT（中文密码 cycles=19 向量、0x3F 截断分支向量）**、工作集预算超和拒绝而非钳位、分卷拒绝全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/archive/sevenz_backend.rs src-tauri/src/source/archive/sevenz_header_precheck.rs src-tauri/src/source/archive/mod.rs src-tauri/tests/fixtures/archive/kat_vectors.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(archive): 支持单卷 7z 与 AES 密码"
```

---

### 任务 7：共享 ArchiveService 与 ArchiveMediaSource 接线

**文件：**
- 创建：`src-tauri/src/source/archive/service.rs`
- 创建：`src-tauri/src/source/archive/cache_coordinator.rs`
- 修改：`src-tauri/src/source/archive/mod.rs`
- 修改：`src-tauri/src/source/archive_impl.rs`
- 修改：`src-tauri/src/source/factory.rs`
- 修改：`src-tauri/src/lib.rs`

- [ ] **步骤 1：写格式分派、并发和 password-required 失败测试**

`service.rs` tests 使用 fake backend 计数：

```rust
#[tokio::test]
async fn service_dispatches_formats_and_reuses_verified_password() {
    let harness = ServiceHarness::new();
    let descriptor = harness.local_descriptor("encrypted.cbr", ArchiveFormat::Cbr);
    harness.rar.require_password("page.png", b"secret");
    assert_eq!(harness.service.prepare(&descriptor).await.unwrap(),
               ArchivePrepareResult::PasswordRequired);
    assert_eq!(harness.service.unlock(
        &descriptor,
        zeroize::Zeroizing::new(b"wrong".to_vec()),
    ).await.unwrap_err(),
               ArchiveAccessError::WrongPassword);
    assert_eq!(harness.service.unlock(
        &descriptor,
        zeroize::Zeroizing::new(b"secret".to_vec()),
    ).await.unwrap(),
               ArchivePrepareResult::Ready {
                   access_mode: ArchiveAccessMode::Local,
                   progress_key: None,
               });
    let entries = harness.service.list(&descriptor).await.unwrap();
    assert_eq!(entries[0].name, "page.png");
    assert_eq!(harness.rar.password_seen(), Some(b"secret".to_vec()));
}

#[tokio::test]
async fn cached_encrypted_catalog_never_replaces_password_proof() {
    let harness = ServiceHarness::new();
    let descriptor = harness.local_descriptor("encrypted.cbz", ArchiveFormat::Cbz);
    harness.service.unlock(&descriptor, Zeroizing::new(b"secret".to_vec())).await.unwrap();
    harness.service.list(&descriptor).await.unwrap(); // populate catalog LRU
    harness.service.forget_password_for_test(&descriptor).await.unwrap();
    assert_eq!(harness.service.prepare(&descriptor).await.unwrap(),
               ArchivePrepareResult::PasswordRequired);
}

#[tokio::test]
async fn weighted_memory_budget_serializes_large_decodes() {
    let harness = ServiceHarness::with_memory_budget_mib(8);
    harness.zip.set_declared_size_mib(8);
    let first = harness.spawn_read(harness.zip_a.clone(), "page.png");
    let second = harness.spawn_read(harness.zip_b.clone(), "page.png");
    harness.zip.wait_until_first_started().await;
    assert_eq!(harness.zip.started_count(), 1);
    harness.zip.release_first();
    let (a, b) = tokio::join!(first, second);
    a.unwrap().unwrap();
    b.unwrap().unwrap();
    assert_eq!(harness.zip.max_concurrent(), 1);
}

#[tokio::test]
async fn lying_declared_size_is_capped_by_remaining_budget() {
    // fake SevenZ backend 承载非零 dict 合同（entry_dict 仅 7z 非零——用 zip fake 注入
    // 非零 dict 会违反格式合同、让 output_cap 计算失去意义）：声明 1 MiB、实际输出
    // 5 MiB、entry_dict 4 MiB、注入预算 8 MiB——声明和 5 ≤ 8 通过预检，实际输出越过
    // output_cap = 8 - 4 = 4 MiB 被终态拦截
    let harness = ServiceHarness::with_memory_budget_mib(8);
    harness.sevenz.set_lying_entry("page.png", 1, 5, 4); // (name, 声明 MiB, 实际输出 MiB, dict MiB)
    assert!(matches!(
        harness.spawn_read(harness.sevenz_a.clone(), "page.png")
            .await.unwrap().unwrap_err(),
        ArchiveAccessError::ResourceLimitExceeded(_)
    ));
}

#[tokio::test]
async fn concurrent_lying_reads_serialize_within_process_budget() {
    // 双谎报并发（dict=0，格式无关），注入 8 MiB 预算、各声明 1 MiB、实际各输出 6 MiB——
    // 不用生产级尺寸：join! 会真实持有先完成任务的返回 Vec，400 MiB 级会令 CI/开发机
    // OOM；小尺寸同样证明增长、回退、串行与 timeout 合同。后到者增长失败回退全量排队
    // （等待者持有量为零，无死锁），两任务的**解码窗口**在时间上串行化；timeout 包裹
    // join 锁定"不死锁"，两次读取按串行合同都成功（各 6 ≤ output_cap 8）。峰值计数只
    // 统计 backend 解码期间的活跃输出（max_concurrent_actual_bytes）——第一个任务返回
    // 的 Vec 已脱离许可、由单条目硬上限兜底，不在本预算断言范围（收窄合同见任务 7）。
    let harness = ServiceHarness::with_memory_budget_mib(8);
    harness.zip.set_lying_entry("a.png", 1, 6, 0); // (name, 声明 MiB, 实际输出 MiB, dict MiB)
    harness.zip.set_lying_entry("b.png", 1, 6, 0);
    let first = harness.spawn_read(harness.zip_a.clone(), "a.png");
    let second = harness.spawn_read(harness.zip_b.clone(), "b.png");
    harness.zip.wait_until_both_started().await;
    harness.zip.release_all();
    let (a, b) = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        async { tokio::join!(first, second) },
    ).await.expect("增长-回退协议死锁：join 未在超时内完成");
    a.unwrap().unwrap();
    b.unwrap().unwrap();
    assert!(harness.zip.max_concurrent_actual_bytes() <= 8 * 1024 * 1024);
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::service
```

预期：FAIL，service 不存在。

- [ ] **步骤 3：实现结果类型与本地解析**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequestId {
    pub session_id: String,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveAccessMode { Local, Streaming, Materialized }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ArchivePrepareResult {
    Ready {
        #[serde(rename = "accessMode")]
        access_mode: ArchiveAccessMode,
        #[serde(rename = "progressKey")]
        progress_key: Option<String>,
    },
    PasswordRequired,
}
```

`ArchiveRequestId`、单窗口 session registry 和 `begin_session/prepare_with_request/unlock_with_request/commit_request/cancel_request` 的核心状态机在本任务落地，任务 11 只增加 Tauri/TS IPC 外壳；这样任务 8 的 Materializer subscriber 与任务 10 的 commit-gated prefetch 不会反向依赖后置任务。状态机初版支持本地与完整物化的 Running/AwaitingPassword/Prepared/Cancelled、cancel-before-register、精确幂等 commit 和 session rollover——`begin_session(session_id, boot_ms)` 按 WebView 页面 boot 代次接受换代、拒绝更旧 boot 的迟到 begin（规则与动机见任务 11 步骤 3）；任务 10 只给 Prepared 增加 streaming prefetch intent。

`ArchiveService` 在本任务就必须持有工厂构造的同一个 `Arc<Materializer>`，不能等远程流式任务才补；在任务 10 接入 `RemoteZipReader` 前，远程 ZIP/CBZ 继续沿用完整物化，确保 `ArchiveMediaSource` 变为 service-only 后既有远程行为不断档。Service 同时持 `Arc<ZipBackend/RarBackend/SevenZBackend>`、`ArchivePasswordStore`、三个格式 semaphore、512 个 1-MiB permit 的加权内存 semaphore、32 项 catalog LRU（值为 `{ probe, catalog }` 元数据，加密信息以 probe 为唯一真值源）和唯一 `Arc<ArchiveCacheCoordinator>`；任务 9 创建 `remote_zip.rs` 后把 block LRU 接入同一 coordinator。Local Ready 的 `progress_key=None`，远程物化/流式 Ready 返回 Materializer 的 opaque cache key。

service 的 prepare/unlock 统一走 backend `probe(input, descriptor.entryPrefix, password)`，加密元数据只有 probe 一个真值源，统计范围即当前 prefix 视图：`entry_count == 0`（全容器空）映射 `EmptyArchive`；当前视图 `image_count == 0` 同样映射 `EmptyArchive`——存在 `first_encrypted_file` 时先经该文件验证密码（成功写 `ArchivePasswordStore` 后仍返回 `EmptyArchive`，失败 `WrongPassword`），无加密普通文件则直接 `EmptyArchive`；当前视图 `image_count > 0` 时**只看 `first_encrypted_image`**——Some 且无密码 → `PasswordRequired`，None（含混合包：未加密图片 + 加密 README）→ 直接 Ready，加密普通文件不阻塞可读图片、不得为阅读图片索要并不需要的密码。unlock 的验证条目按同一优先级：`image_count > 0` 用 `first_encrypted_image`，否则用 `first_encrypted_file`，完整读取并校验成功才写密码库。fake backend 测试必须覆盖五个分支：纯加密 TXT 包先 `PasswordRequired`、经 `note.txt` 验证成功后返回 `EmptyArchive` 且密码入库；未加密纯 TXT 包直接 `EmptyArchive`；空包 `EmptyArchive` 不误报密码；混合包（未加密图片 + 加密 README）无密码直接 Ready；正常加密图片包 `PasswordRequired` → unlock Ready。

`ArchiveCacheCoordinator` 使用 `std::sync::Mutex<State>`，state 包含 `clearing`、单调 `generation`、active admission 计数和 `tokio::sync::Notify`。`admit()` 在同一短临界区检查 clearing 并增加 active，返回同步 Drop 的 `AdmissionGuard`；Drop 同步减计数并 notify。`begin_clear()` 原子置 clearing、推进 generation 并返回同步 Drop 的 `ClearGuard`；`wait_drained(timeout)` 是独立 async 方法。所有 catalog、后续 block、Materializer ready cache hit 与下载都必须先 admission，再查 cache；禁止两个串行 gate 和 async Drop。Local identity 使用规范化绝对路径 + `std::fs::metadata` size/mtime。测试构造函数允许注入较小内存预算。

- [ ] **步骤 4：实现 prepare/unlock/list/read/stat**

`prepare` 先取 catalog LRU 缓存的 `{ probe, catalog }`；`PasswordRequired` 的判定只看当前 prefix 视图的加密候选——`image_count > 0` 时仅 `first_encrypted_image` 视为需要密码，`image_count == 0` 时才看 `first_encrypted_file`（空图包的验证流程）；候选存在而同 identity password store 为空必须返回 `PasswordRequired`，cache hit 不能替代密码证明——密码检查一律读取缓存的 probe，不得从 catalog 条目标记二次推导。遇到 `PasswordRequired/WrongPassword` 时同时清除旧密码和对应 catalog 项。`unlock` 使用 `Zeroizing<Vec<u8>>`，按同一优先级的 probe 验证条目完整验证后才写 store。

工作集许可**只作用于 `read_entry`**：`list/catalog/stat` 没有目标条目输出（list 无法查询 entry_dict/declaredSize，stat 只读元数据不构造结果 `Vec`），仅走格式 semaphore 与各自的元数据限制（条目数/路径/声明值扫描），不得套用加权算法无意义地串行化元数据操作。`read_entry` 按以下协议取得与增长许可：

1. **声明预检**：按 `declaredSize.checked_add(entry_dict)` 计算（`entry_dict` 按目标条目名从缓存的 `probe.entry_dictionaries` 查询，仅 7z 非零，solid folder 内多条目共享同值）；三种格式声明大小总是可得（ZIP central directory / RAR `UnpSize` / 7z entry size，`stat_entry -> Result<u64>` 即此合同）。溢出或总和超过 `workspace_budget` 直接 `ResourceLimitExceeded`——**不得用 `min()` 钳位**（钳位只限许可数，实际占用仍会突破）。
2. **初始许可**：按声明总和的 MiB 向上取整申请（≥ 1 permit），诚实任务保持高并发。
3. **增长-回退协议（防谎报突破进程预算 + 防死锁）**：许可记账分两层——`output_reserved`（已许可的输出字节）与 `held_total = entry_dict + output_reserved`（任务总工作集；dictionary 常驻部分自初始申请就计入，`output_cap = workspace_budget - entry_dict` 只是**输出**上限而非总许可）。`LimitedEntryWriter` 维护 `output_reserved` 水位，实际输出逼近水位时以**同步非阻塞** `try_acquire` 追加。扩容目标必须覆盖本次 incoming（RAR callback 单次整块可超 1 MiB）：`required = len + incoming.len()` 先 checked_add 预检，目标 = `max(required, min(capacity + 1 MiB, output_cap))`，尾块按剩余量精确计费，**追加量 = `new_output_reserved - old_output_reserved`**；追加失败（预算被并发任务占用）则 backend 以类型化 `BudgetRetryRequired` 中止（见下），Service **释放全部已持许可、丢弃中间输出、按 `held_total 全量 = entry_dict + output_cap = workspace_budget` 重新排队并从头重解压**（重试上限 1 次：全量持有下增长不可能再失败）。任意时刻"等待许可的任务"持有量为零（回退后）或持有全量——依赖图无环，不会出现多任务各持部分许可互等的死锁；谎报任务的最终记账不超过 `workspace_budget`，两个各声明 1 MiB、实际各输出 400 MiB 的任务不可能同时各占 400 MiB 突破进程预算（后到者回退排队）。

backend 接口为此扩展：`read_entry` 增加参数 `budget: &mut DecodeBudget`——Service 在调用前构造，内含 `entry_dict`、`output_cap` 与许可控制器句柄的 `try_grow(new_output_reserved) -> bool`（同步非阻塞：内部 `Semaphore::try_acquire` 差量）。三种 backend 的接入方式：ZIP 的 `LimitedEntryWriter` 与 7z 的限长 read loop 在每次越过 `output_reserved` 水位时调 `try_grow`，失败即返回 `ArchiveAccessError::BudgetRetryRequired`；RAR 在 FFI callback 的 sink 内做同一检查（callback 是同步 `extern "C"`，`try_grow` 的非阻塞设计与该约束一致，失败转 UnRAR abort code 后映射 `BudgetRetryRequired`）。`BudgetRetryRequired` 是 Service 内部协议 marker：仅用于触发"释放→全量→重解压"，永不 serialize 到 IPC/前端；真实输出越过 `output_cap` 仍返回终态 `ResourceLimitExceeded`，两者不得混淆。变体定义在 `ArchiveAccessError` 上并标 `#[serde(skip_serializing)]`（serde 变体官方语义：尝试序列化即报错——任何意外把它带到 IPC 边界的路径在测试中显式失败，任务 3 步骤 1 有守卫断言）。Service 是唯一消费点：`read_entry` 返回它时立即 drop budget 释放全部许可、丢弃中间输出、按前述全量重新排队重解压；全量持有下增长不可能再失败，若全量重试后仍返回 `BudgetRetryRequired` 属实现契约违反，终态兜底映射 `ResourceLimitExceeded` 并 log error，保证任何路径都不会把它带到序列化边界。计费一律按**请求的 capacity**而非 `len`：`LimitedEntryWriter` 用单 `Vec` 受控增量扩容（扩容目标覆盖本次 incoming 且只请求 `目标 capacity - len` 的精确增量、尾块按剩余量计费，不做"分块 + 交付合并"——合并会在 budget 生命周期内同时持有约 2×total 却只按 total 计费）；**已知限制**：allocator 允许实际物理分配超过请求值，`try_reserve_exact` 不是精确分配合同——预算约束请求值，超额残差不可由用户态约束，测试断言 `记账 capacity + dictionary ≤ workspace_budget` 而非物理 RSS。

随后 budget 整体 move 进 `spawn_blocking` 执行；join panic 映射 `CorruptArchive("backend task panicked")`。**预算的覆盖范围是解码期间的工作集**：budget（及其 permits）在 `read_entry` 返回、bytes 交付上层时释放，交付后的 `Vec` 驻留内存**不在本预算内**——由单条目 512 MiB 硬上限与上层消费节奏兜底（`MediaSource -> Vec<u8>` 现有契约），不得宣称"进程全生命周期峰值 ≤ 预算"。fake backend 测试（Service 层）必须覆盖：单任务谎报（声明 1 MiB 实际 5 MiB、dict 4 MiB、注入预算 8 MiB → 声明和通过预检，实际输出越过 `output_cap = 4 MiB` 被 writer 拦截）；**双谎报并发**（注入预算 8 MiB、各声明 1 MiB、实际各输出 6 MiB、dict 0 → 断言两任务的**解码窗口**在时间上被串行化，解码期间并发工作集 ≤ 预算、timeout 内不死锁；**不用生产级尺寸**——join! 会真实持有先完成任务的返回 Vec，400 MiB 级会令 CI/开发机 OOM，小尺寸同样证明增长、回退、串行合同。第一个完成任务的返回 Vec 已脱离许可、不在断言范围——计数只统计 backend 活跃输出，不得把交付后的驻留算作假通过）。

提供 `cache_coordinator()`、`clear_runtime_caches_while_gated(generation)` 与 loader 提交前 generation 复核。清 LRU 只能在 `ClearGuard` 存活且 active admission 已排空后执行；任何 return/panic 路径由同步 Drop 恢复 gate。该流程不清 password store，手动清磁盘 cache 不应强制用户重新输入密码；但会清 catalog，使下次访问重新解析并继续用同 identity 的已验证密码。

- [ ] **步骤 5：ArchiveMediaSource 变为薄适配器**

构造改为：

```rust
pub struct ArchiveMediaSource {
    service: Arc<crate::source::archive::service::ArchiveService>,
}

impl ArchiveMediaSource {
    pub fn new(service: Arc<crate::source::archive::service::ArchiveService>) -> Self {
        Self { service }
    }
}
```

五个 `MediaSource` 方法分别调用 service；Range 在 `service.read` 返回单条完整 bytes 后沿用 checked_add + 严格越界切片。

- [ ] **步骤 6：Factory 构造共享实例**

`MediaSourceFactory` 增加 `cache_coordinator`、`archive_service` 与 `prefetcher` Arc，并提供 accessor。构造顺序固定为：具体远程源 → ArchiveCacheCoordinator → Materializer(coordinator) → Prefetcher → ArchiveService(materializer, coordinator) → ArchiveMediaSource。`lib.rs` manage factory 暴露的同一 service/prefetcher，不再另建 Materializer 或 Prefetcher。

- [ ] **步骤 7：运行格式全链路测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::service -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::archive_impl::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：三格式 service contract 与全部既有 ZIP contract PASS。

- [ ] **步骤 8：Commit**

```bash
git add src-tauri/src/source/archive/service.rs src-tauri/src/source/archive/cache_coordinator.rs src-tauri/src/source/archive/mod.rs src-tauri/src/source/archive_impl.rs src-tauri/src/source/factory.rs src-tauri/src/lib.rs
git commit -m "refactor(archive): 统一服务接管五格式读取"
```

---

### 任务 8：Materializer 与预载泛化到五格式

**文件：**
- 修改：`src-tauri/src/source/archive/materializer.rs`
- 修改：`src-tauri/src/source/archive/prefetch.rs`
- 修改：`src-tauri/src/source/archive/dao.rs`
- 修改：`src-tauri/src/commands/archive_cache.rs`
- 修改：`src/components/filebrowser/FileBrowser.vue`
- 修改：`src/components/filebrowser/FileBrowser.test.ts`

- [ ] **步骤 1：写真实扩展、旧 ZIP 命中和五格式闸门失败测试**

在 materializer tests 增加：

```rust
#[tokio::test]
async fn all_supported_extensions_materialize_to_real_extension() {
    for (format, rel) in [
        (ArchiveFormat::Cbz, "a.cbz"), (ArchiveFormat::Zip, "b.zip"),
        (ArchiveFormat::Cbr, "c.cbr"), (ArchiveFormat::Rar, "d.rar"),
        (ArchiveFormat::SevenZ, "e.7z"),
    ] {
        let (m, dir, _) = temp_materializer(Arc::new(MockOrigin::new(10)));
        let path = m.ensure_cached(&webdav(""), rel, format).await.unwrap();
        assert_eq!(path.extension().and_then(|v| v.to_str()),
                   std::path::Path::new(rel).extension().and_then(|v| v.to_str()));
        assert!(path.starts_with(dir.path()));
    }
}

#[tokio::test]
async fn descriptor_format_mismatch_is_rejected_before_download() {
    // mock 与 descriptor 分开绑定：temp_materializer 第三个返回值是 Db，不能当
    // descriptor 传；descriptor 一律来自 webdav("")，零下载断言读 mock.read_calls
    let mock = StdArc::new(MockOrigin::new(10));
    let (m, _, _) = temp_materializer(mock.clone());
    for (format, rel) in [(ArchiveFormat::Rar, "book.zip"), (ArchiveFormat::SevenZ, "a.cbz")] {
        // unwrap_err() 后已是 MaterializeError，pattern 不得再包一层 Err(...)
        assert!(matches!(
            m.ensure_cached(&webdav(""), rel, format).await.unwrap_err(),
            MaterializeError::FormatMismatch { .. }
        ));
    }
    assert_eq!(mock.read_calls.load(Ordering::SeqCst), 0); // 下载前即稳定拒绝
}

/// legacy 行专用 harness：descriptor（传给 `ensure_cached` 的 `SourceDescriptor`）与
/// mock（零下载断言的 `MockOrigin`）在生产接口中就是分离的两个参数，字段必须分开，
/// 不得靠测试包装/Deref 把一个当另一个用。cache_root 用 `Path::join` 而非字符串拼接。
struct LegacyRowHarness {
    descriptor: SourceDescriptor,
    mock: StdArc<MockOrigin>,
    materializer: Materializer,
    cache_root: PathBuf,
    /// TempDir 是 RAII guard——必须由 harness 持有，目录删除发生在测试结束 Drop 时
    /// 而非 helper 返回时；只存 PathBuf 延长不了目录生命周期，预置的 legacy 文件
    /// 会在返回瞬间被删，命中断言全部失效（对齐任务 6 helper 的「guard 由测试持有」约定）
    _cache_dir: tempfile::TempDir,
}

fn legacy_ready_row(rel: &str, legacy_name: &str, size: u64) -> LegacyRowHarness {
    let mock = StdArc::new(MockOrigin::new(size));
    let (materializer, dir, db) = temp_materializer(mock.clone());
    let descriptor = webdav("");
    let cache_root = dir.path().to_path_buf();
    let final_path = cache_root.join(legacy_name);
    std::fs::write(&final_path, vec![7u8; size as usize]).unwrap();
    // 预置 ready 行：cache_key 走生产规则，cache_abs_path 指向旧命名的 {legacy_name}；
    // size/mtime 与 MockOrigin 的 stat 默认值一致，确保命中判定不被 is_stale 抢先否决
    let conn = db.conn();
    crate::source::archive::dao::upsert(&conn, &crate::source::archive::dao::NewCacheRow {
        cache_key: cache_key(&descriptor, rel),
        origin_kind: "webdav".into(),
        archive_rel_path: rel.into(),
        origin_size: size as i64,
        origin_mtime: Some(1000),
        cache_abs_path: final_path.to_string_lossy().into_owned(),
        byte_size: size as i64,
    }).unwrap();
    LegacyRowHarness { descriptor, mock, materializer, cache_root, _cache_dir: dir }
}

#[tokio::test]
async fn legacy_zip_row_keeps_its_recorded_cache_path() {
    let harness = legacy_ready_row("legacy.cbz", "abc.zip", 10);
    let path = harness.materializer
        .ensure_cached(&harness.descriptor, "legacy.cbz", ArchiveFormat::Cbz).await.unwrap();
    assert_eq!(path, harness.cache_root.join("abc.zip"));
    assert_eq!(harness.mock.read_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn shared_download_keeps_independent_subscriber_lifetimes_and_progress() {
    let harness = blocking_materializer();
    let a = ArchiveRequestId::new("session-a", 1);
    let b = ArchiveRequestId::new("session-b", 1);
    let load_a = harness.spawn_interactive(a.clone());
    let load_b = harness.spawn_interactive(b.clone());
    harness.wait_physical_download_started().await;
    harness.emit_progress(1, 10);
    harness.wait_until_each_received(&[&a, &b], 1).await;
    let a_count_at_cancel = harness.progress_for(&a).len();
    let b_count_at_cancel = harness.progress_for(&b).len();
    harness.cancel(&a).await;
    assert!(matches!(load_a.await.unwrap(), Err(MaterializeError::Cancelled)));
    assert_eq!(harness.physical_download_count(), 1);
    harness.emit_progress(5, 10);
    harness.release_download();
    load_b.await.unwrap().unwrap();
    assert_eq!(harness.progress_for(&a).len(), a_count_at_cancel);
    assert!(harness.progress_for(&b).len() > b_count_at_cancel);
    assert_eq!(harness.progress_for(&b).last().unwrap().phase, "ready");
}

#[tokio::test]
async fn background_subscriber_survives_interactive_cancel_but_all_interactive_cancel_stops() {
    let with_background = blocking_materializer();
    let request = ArchiveRequestId::new("session-a", 2);
    let interactive = with_background.spawn_interactive(request.clone());
    let background = with_background.attach_background("bg-key-opaque-7");
    with_background.cancel(&request).await;
    assert!(matches!(interactive.await.unwrap(), Err(MaterializeError::Cancelled)));
    assert!(!with_background.physical_cancelled());
    with_background.release_download();
    background.await.unwrap().unwrap();
    // 后台 subscriber 的每一条事件都携带 attach 时保存的 progressKey，且 requestId=null
    let events = with_background.background_events();
    assert!(!events.is_empty());
    assert!(events.iter().all(|e| e.request_id.is_none() && e.progress_key == "bg-key-opaque-7"));

    let only_interactive = blocking_materializer();
    let a = only_interactive.spawn_interactive(ArchiveRequestId::new("session-a", 3));
    let b = only_interactive.spawn_interactive(ArchiveRequestId::new("session-b", 3));
    only_interactive.cancel_all_interactive().await;
    assert!(only_interactive.physical_cancelled());
    assert!(a.await.unwrap().is_err() && b.await.unwrap().is_err());
    assert!(!only_interactive.has_final_file_or_ready_row());
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::materializer::tests -- --nocapture
```

预期：五格式测试因现有闸门失败；subscriber 生命周期/进度 fan-out 与后台事件 progressKey 契约（`attach_background(progress_key)` 把 opaque key 写入 subscriber state，每条后台事件从该 state 取 key 且 `requestId=null`）尚未实现而失败，其中 A/B 都先收到基线事件，取消 A 后 A 的事件数不再增长而 B 继续增长并完成；旧 ZIP 命中保持 PASS。

- [ ] **步骤 3：实现扩展归一与 final path**

```rust
fn validated_archive_extension(
    format: ArchiveFormat,
    rel: &str,
) -> Result<&'static str, MaterializeError> {
    let path_ext = Path::new(rel).extension().and_then(|v| v.to_str()).unwrap_or("");
    if ArchiveFormat::from_extension(path_ext) != Some(format) {
        // spec §8 双重校验：descriptor 声明格式与路径扩展名不一致时在下载前稳定拒绝，
        // 不把坏组合交给 backend 报随机错误（descriptor 声称 rar、路径 book.zip 等）。
        return Err(MaterializeError::FormatMismatch {
            declared: format,
            rel_path: rel.to_owned(),
        });
    }
    Ok(match format {
        ArchiveFormat::Cbz => "cbz",
        ArchiveFormat::Zip => "zip",
        ArchiveFormat::Cbr => "cbr",
        ArchiveFormat::Rar => "rar",
        ArchiveFormat::SevenZ => "7z",
    })
}

fn cache_paths(&self, key: &str, ext: &str) -> (PathBuf, PathBuf) {
    let root = self.cache_root.read().unwrap().clone();
    (root.join(format!("{key}.{ext}")), root.join("part").join(format!("{key}.part")))
}
```

`MaterializeError` 增加 `FormatMismatch { declared: ArchiveFormat, rel_path: String }` 变体（沿用现有 thiserror 风格，消息不含凭据）；`archive_impl`/service 边界把它映射为 `ArchiveAccessError::InvalidRequest`，不得透传为 `Other` 字符串。`ensure_cached`、`ready_path_if_fresh` 与预载入口统一增加 descriptor `format` 参数（调用方从 `descriptor.format` 取），先经 `validated_archive_extension` 双重校验再进入下载/命中路径；不支持的扩展名（`from_extension` 为 None）同样映射 `FormatMismatch`。

DAO 命中始终优先使用行内 `cache_abs_path`，因此旧 `{key}.zip` 不改名、不 migration。

Materializer 的 `ensure_cached`、`ready_path_if_fresh`、subscriber attach 和物理下载都注入任务 7 的同一个 `ArchiveCacheCoordinator`，并在 DAO/磁盘 cache lookup 之前取得 admission guard。in-flight state 区分 `interactive: HashMap<ArchiveRequestId, Subscriber>` 与 `background: HashMap<BackgroundSubscriberId, BackgroundSubscriber { progress_key }>`；每个交互 subscriber 独立完成/取消 channel，进度向活动 requestId 分别 fan-out，后台事件从 subscriber 自身保存的 `progress_key` 发出。只有 interactive 与 background 都为空才取消物理下载。把现有直接构造 `serde_json::json!` 的进度 helper 改为 serde camelCase 的类型化 `ArchiveMaterializeProgress { request_id: Option<ArchiveRequestId>, progress_key: String, phase: String, downloaded: u64, total_bytes: u64, rel_path: String }` 后统一 emit，避免不同分支漏字段（phase 沿用现有 emit_progress 的值域，终态为 `"ready"`——下方任务 10 测试据此断言）。另加一个 ready row + final file 已存在的测试：clear guard 存活时 `ready_path_if_fresh` 必须返回 Cancelled，证明 cache hit 未绕过 gate。

`MaterializeError` 增加单元变体 `Cancelled`（不携带诊断串；现有枚举只有 `Network/NotFound/Io/Other`，任务 9 另加 `RemoteRangeUnavailable`）：取消 generation 命中、clear gate 拒绝 admission、交互 subscriber 全部撤离且无已 commit 后台 subscriber——三种终止统一返回它——退化为 `Other("cancelled")` 会同时破坏「Service 不降级、静默取消」的类型判定（任务 10 白名单外）与 subscriber 测试的变体匹配。两个转换边界随之补臂：`From<MaterializeError> for MediaSourceError` 映射 `MediaSourceError::Other("cancelled")`（MediaSource 层无取消概念，该 From 本是兼容垫片，取消语义只在 Archive 层承载）；Service 与任务 9 loader 把 `MaterializeError::Cancelled` 映射为 `ArchiveAccessError::Cancelled`（loader 臂表见任务 9 步骤 5，Service 对它不触发网络降级）。取消路径测试由三处既有用例承载：subscriber 取消断言 `Err(MaterializeError::Cancelled)`（本任务上方两测）、clear guard 存活时 `ready_path_if_fresh` 返回 `Cancelled`、任务 9 真实 reader 边界的「Cancelled 不降级」用例。

- [ ] **步骤 4：扩展预载过滤**

FileBrowser details content preload 的扩展判断改为：

```ts
const REMOTE_ARCHIVE_EXTS = new Set(['cbz', 'zip', 'cbr', 'rar', '7z']);
if (!REMOTE_ARCHIVE_EXTS.has(ext)) return;
```

更新对应组件测试：`.cbr` 从“不预载”改为调用 `notifyArchiveWindow`，并为 `.7z` 增加一例。

- [ ] **步骤 5：运行 M3 全套回归**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::materializer -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::archive::prefetch -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml commands::archive_cache -- --nocapture
npx vitest run src/components/filebrowser/FileBrowser.test.ts
```

预期：全部 PASS；`.part`、sidecar、断点续传、LRU、清空闸门原断言不放宽。

- [ ] **步骤 6：Commit**

```bash
git add src-tauri/src/source/archive/materializer.rs src-tauri/src/source/archive/prefetch.rs src-tauri/src/source/archive/dao.rs src-tauri/src/commands/archive_cache.rs src/components/filebrowser/FileBrowser.vue src/components/filebrowser/FileBrowser.test.ts
git commit -m "feat(archive): 物化与预载扩展到五种格式"
```

---

### 任务 9：远程 ZIP Range reader、块 LRU 与 singleflight

**文件：**
- 创建：`src-tauri/src/source/archive/remote_zip.rs`
- 修改：`src-tauri/src/source/archive/mod.rs`
- 修改：`src-tauri/src/source/archive/materializer.rs`
- 修改：`src-tauri/src/source/archive/zip_backend.rs`
- 修改：`src-tauri/src/source/archive/service.rs`

- [ ] **步骤 1：写 Seek、跨块、LRU 和并发去重失败测试**

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_reader_seek_and_cross_block_read_are_exact() {
    let runtime = tokio::runtime::Handle::current();
    let origin = Arc::new(MockRangeOrigin::new(sequence_bytes(3 * BLOCK_SIZE + 17)));
    let cache = Arc::new(RangeBlockCache::new(2 * BLOCK_SIZE));
    let mut reader = RemoteZipReader::new(test_identity(), origin.clone(), cache, runtime);
    reader.seek(SeekFrom::Start((BLOCK_SIZE - 3) as u64)).unwrap();
    let mut out = [0u8; 8];
    reader.read_exact(&mut out).unwrap();
    assert_eq!(out.to_vec(), sequence_slice(BLOCK_SIZE - 3, 8));
    assert_eq!(origin.ranges(), vec![(0, BLOCK_SIZE), (BLOCK_SIZE as u64, BLOCK_SIZE)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_same_block_loads_once() {
    let runtime = tokio::runtime::Handle::current();
    let origin = Arc::new(MockRangeOrigin::new(vec![7; BLOCK_SIZE]));
    let cache = Arc::new(RangeBlockCache::new(32 * BLOCK_SIZE));
    let threads = (0..8).map(|_| {
        let origin = origin.clone();
        let cache = cache.clone();
        let runtime = runtime.clone();
        std::thread::spawn(move || {
            let mut reader = RemoteZipReader::new(test_identity(), origin, cache, runtime);
            let mut byte = [0u8; 1];
            reader.read_exact(&mut byte).unwrap();
            byte[0]
        })
    }).collect::<Vec<_>>();
    assert_eq!(threads.into_iter().map(|t| t.join().unwrap()).collect::<Vec<_>>(), vec![7; 8]);
    assert_eq!(origin.call_count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn typed_range_error_survives_io_and_zip_boundaries() {
    let runtime = tokio::runtime::Handle::current();
    let origin = Arc::new(MockRangeOrigin::failing(ArchiveAccessError::Network("offline".into())));
    let input = ArchiveInput::Reader(remote_reader_factory(origin, runtime));
    assert!(matches!(ZipBackend.catalog(&input, "", None),
                     Err(ArchiveAccessError::Network(_))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clear_generation_prevents_late_loader_reinsert() {
    let harness = BlockingRangeHarness::new();
    let load = harness.spawn_block_load();
    harness.wait_loader_started();
    let clear_guard = harness.coordinator.begin_clear().unwrap();
    harness.release_loader();
    assert!(matches!(load.join().unwrap(), Err(ArchiveAccessError::Cancelled)));
    harness.coordinator.wait_drained(TEST_TIMEOUT).await.unwrap();
    harness.runtime.clear_runtime_caches_while_gated(clear_guard.generation());
    assert_eq!(harness.runtime.block_cache_len(), 0);
    assert!(matches!(harness.try_start_loader(), Err(ArchiveAccessError::Cancelled)));
    drop(clear_guard);
    assert!(harness.try_start_loader().is_ok());
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::remote_zip
```

预期：FAIL，模块不存在。

- [ ] **步骤 3：给 Materializer 增加 origin Range 接口**

```rust
pub async fn read_origin_range(
    &self,
    origin: &SourceDescriptor,
    rel: &str,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, MaterializeError> {
    let source = self.origin_source(origin)?;
    let bytes = source.read_file(origin, rel, Some(ByteRange { offset, length })).await?;
    if bytes.len() as u64 != length {
        // 短 Range 必须类型化：Service 只对 RemoteRangeUnavailable/Network/Timeout 走
        // "原位重试一次 → 物化降级"（任务 10），Other 会退化成 Io 而错过降级路径
        return Err(MaterializeError::RemoteRangeUnavailable(format!(
            "Range 长度不符: offset={offset} expected={length} actual={}", bytes.len()
        )));
    }
    Ok(bytes)
}
```

`MaterializeError` 同步增加 `RemoteRangeUnavailable(String)` 变体（thiserror 风格与现有变体一致，spec §7.4「返回 offset 或长度违反强契约」降级触发的类型化载体）：loader 边界（步骤 5）把它恢复为 `ArchiveAccessError::RemoteRangeUnavailable`，不得经 `Other` 扁平化。`From<MaterializeError> for MediaSourceError` 补一臂映射 `MediaSourceError::Network`（MediaSource 层无 Range 概念，按远端供给失败归类、消息原样保留）；`From<MediaSourceError>` 方向没有 Range 来源，不改。

- [ ] **步骤 4：实现固定块缓存**

`remote_zip.rs` 常量：

```rust
pub const BLOCK_SIZE: usize = 1024 * 1024;
pub const BLOCK_CACHE_BYTES: usize = 32 * 1024 * 1024;
```

`RangeBlockCache` 使用 `Mutex<State> + Condvar`；`State` 包含 `HashMap<BlockKey, Arc<Vec<u8>>>`、`VecDeque<BlockKey>` 和 `HashSet<BlockKey>` loading。`get_or_load` 对相同 key 只允许一个 loader，其他线程等待 Condvar；用 RAII loading guard 保证成功、失败或 unwind 都移除 loading 并 `notify_all`。进入 `get_or_load` 时必须先从唯一 `ArchiveCacheCoordinator` 取得 admission guard，使 cache hit 与 miss 都受 clear gate 约束；每个 loader 捕获 guard generation，插入前发现 generation 已变化则丢弃 bytes 并返回 `Cancelled`。插入后按 LRU 淘汰到 32 个满块以内，cache hit 必须更新顺序。

- [ ] **步骤 5：实现 Read+Seek**

`RemoteZipReader` 保存 `position/size/identity/origin/cache/runtime/generation`。`Seek` 对 Start/Current/End 使用 `i128` 计算并拒绝负数/超过 u64；`Read` 按 block 拆分，最后一块请求 `min(BLOCK_SIZE, size-block_start)`。loader 只能在 `spawn_blocking` 线程中用 `runtime.block_on(origin.read_range(...))`。

使用任务 3 已定义的 `RemoteZipIoError(ArchiveAccessError)`、`LimitedEntryIoError` 与 `BudgetRetryIoError` marker；loader 先把 `origin.read_range` 的 `MaterializeError` 映射为 `ArchiveAccessError`——`RemoteRangeUnavailable → RemoteRangeUnavailable`（短 Range 是降级触发，不得落入 Io）、`Network → Network`、`Cancelled → Cancelled`，其余 → `Io`——Range/Network/Timeout/Cancelled 再通过 `std::io::Error::new(ErrorKind::Other, RemoteZipIoError(err))` 返回。`zip_backend::map_zip_io_error` 的顺序固定为：downcast Remote marker → downcast BudgetRetry marker 恢复 `BudgetRetryRequired` → downcast limit marker 为 `ResourceLimitExceeded` → `ErrorKind::InvalidData` 为 `CorruptArchive`（CRC/MAC）→ 普通 `Io`；`map_zip_error(ZipError::Io)` 委托该 helper。分别写五个映射单测（含 BudgetRetry marker → `BudgetRetryRequired` 一例）。新增第二个真实边界测试：先成功 catalog，再让首个 entry payload block 返回 Network，断言 `read_entry` 恢复为 `ArchiveAccessError::Network` 并由 Service 自动降级物化；同路径用 Timeout 也降级、Cancelled 不降级。不得按错误文本判断，也不得只测 ZIP open/catalog 阶段。

- [ ] **步骤 6：运行测试与强契约检查**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::remote_zip -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::webdav_impl -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::smb -- --nocapture
```

预期：Seek、跨块、LRU、singleflight PASS；SMB/WebDAV Range 原测试无回归。

- [ ] **步骤 7：Commit**

```bash
git add src-tauri/src/source/archive/remote_zip.rs src-tauri/src/source/archive/mod.rs src-tauri/src/source/archive/materializer.rs
git commit -m "feat(archive): 增加远程 ZIP Range reader"
```

---

### 任务 10：远程 ZIP 流式准备、自动降级与后台物化

**文件：**
- 修改：`src-tauri/src/source/archive/service.rs`
- 修改：`src-tauri/src/source/archive/prefetch.rs`
- 修改：`src-tauri/src/source/archive/zip_backend.rs`
- 修改：`src-tauri/src/commands/archive_cache.rs`
- 修改：`src-tauri/src/lib.rs`

- [ ] **步骤 1：写尾部优先、降级和本地切换失败测试**

```rust
#[tokio::test]
async fn remote_zip_prepares_with_tail_range_before_full_materialization() {
    let harness = RemoteServiceHarness::zip();
    let result = harness.service.prepare(&harness.descriptor).await.unwrap();
    assert_eq!(result, ArchivePrepareResult::Ready {
        access_mode: ArchiveAccessMode::Streaming,
        progress_key: Some(harness.expected_progress_key()),
    });
    let first = harness.origin.first_range();
    let expected_offset = ((harness.origin.size() - 1) / BLOCK_SIZE as u64) * BLOCK_SIZE as u64;
    assert_eq!(first.offset, expected_offset);
    assert_eq!(first.length, harness.origin.size() - expected_offset);
    assert_eq!(harness.origin.full_download_count(), 0);
    assert_eq!(harness.prefetch_start_count(), 0); // prepare 不能逃逸后台任务
}

#[tokio::test]
async fn broken_range_falls_back_to_materialized_file() {
    // 必须使用真实 RemoteZipReader + ZipBackend，不允许 fake backend 直接返回目标错误。
    let harness = RemoteServiceHarness::real_zip_with_short_range();
    let result = harness.service.prepare(&harness.descriptor).await.unwrap();
    assert_eq!(result, ArchivePrepareResult::Ready {
        access_mode: ArchiveAccessMode::Materialized,
        progress_key: Some(harness.expected_progress_key()),
    });
    assert_eq!(harness.origin.full_download_count(), 1);
}

#[tokio::test]
async fn clear_during_range_load_does_not_repopulate_runtime_or_disk_cache() {
    let harness = RemoteServiceHarness::blocking_zip();
    let opening = harness.spawn_prepare();
    harness.wait_range_started().await;
    let clearing = harness.spawn_clear_archive_cache();
    harness.wait_until_global_clear_gate_is_closed().await;
    // spec 验收：关闸后新 catalog / block / ready-cache / materialize 四条准入路径都要被
    // gate 拒绝；进行中的 opening 是关闸前启动的旧请求，覆盖不到另外三条新路径——
    // 三个调用各自发起新准入（全新 catalog 尝试 / 全新 block 加载 / 全新物化），
    // 漏掉 admission guard 的实现会在此重插缓存而被抓住
    assert!(matches!(harness.try_ready_cache_hit().await, Err(ArchiveAccessError::Cancelled)));
    assert!(matches!(harness.try_catalog().await, Err(ArchiveAccessError::Cancelled)));
    assert!(matches!(harness.try_block_load().await, Err(ArchiveAccessError::Cancelled)));
    assert!(matches!(harness.try_materialize().await, Err(ArchiveAccessError::Cancelled)));
    harness.release_range();
    clearing.await.unwrap().unwrap();
    assert!(matches!(opening.await.unwrap(), Err(ArchiveAccessError::Cancelled)));
    assert_eq!(harness.service.catalog_cache_len(), 0);
    assert_eq!(harness.service.block_cache_len(), 0);
    assert_eq!(archive_cache_usage(&harness.db).unwrap().count, 0);
}

#[tokio::test]
async fn clear_timeout_drops_gate_and_does_not_deadlock_followup_admission() {
    let harness = RemoteServiceHarness::blocking_zip_with_clear_timeout(TEST_SHORT_TIMEOUT);
    let opening = harness.spawn_prepare();
    harness.wait_range_started().await;
    let err = harness.clear_archive_cache().await.unwrap_err();
    assert!(matches!(err, ArchiveCacheError::DrainTimeout));
    assert!(harness.coordinator.try_admit().is_ok()); // ClearGuard 已同步复位
    harness.release_range();
    let _ = opening.await;
}

#[tokio::test]
async fn ready_cache_is_preferred_after_background_download() {
    let harness = RemoteServiceHarness::zip();
    let session_id = "550e8400-e29b-41d4-a716-446655440010";
    harness.service.begin_session(session_id, 1_000).unwrap();
    let request_id = ArchiveRequestId::new(session_id, 1);
    let ready = harness.service.prepare_with_request(
        &harness.descriptor, request_id.clone()
    ).await.unwrap();
    let progress_key = ready.progress_key().unwrap().to_owned();
    assert_eq!(harness.prefetch_start_count(), 0);
    harness.service.commit_request(&request_id).await.unwrap();
    harness.wait_background_ready().await;
    // Iterator::all 对空集合恒真：先证明后台确实发出事件（且含 "ready" 终态，
    // 沿用现有 emit_progress 的 phase 值域），再逐条比较 progress_key——
    // 零事件时此处必须红灯而非假通过
    let events = harness.background_events();
    assert!(!events.is_empty(), "后台 subscriber 必须收到事件");
    assert!(events.iter().any(|e| e.phase == "ready"), "必须存在 ready 终态事件");
    assert!(events.iter()
        .all(|event| event.progress_key.as_bytes() == progress_key.as_bytes()));
    harness.origin.clear_range_calls();
    let bytes = harness.service.read(&harness.descriptor, "page1.png").await.unwrap();
    assert_eq!(bytes, PNG_BYTES);
    assert_eq!(harness.origin.range_call_count(), 0);
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::service::tests::remote_zip
```

预期：FAIL，远程 ZIP 仍强制完整物化。

- [ ] **步骤 3：Prefetcher 增加已打开 archive 后台入口**

```rust
pub fn prefetch_committed(&self, origin: SourceDescriptor, rel: String, progress_key: String) {
    if !self.is_enabled() { return; }
    let mat = self.mat.clone();
    let expected_epoch = mat.current_epoch();
    tokio::spawn(async move {
        let _ = mat.ensure_cached_background(
            &origin, &rel, expected_epoch, progress_key,
        ).await;
    });
}
```

- [ ] **步骤 4：Service 构造远程 ZIP reader factory**

远程 CBZ/ZIP 先取得全局 cache admission，再 `stat_origin` 建 identity、检查 ready cache并创建 `ReaderFactory`；factory 每次返回共享 block cache 的新 `RemoteZipReader`。`catalog` 或首个加密条目验证成功后返回 `Ready { Streaming, progressKey }` 并在任务 7 的 request registry 保存 Prepared 的预载意图，绝不直接调用 prefetch。只有同一核心状态机的 `commit_request` 才调用 `prefetch_committed`；它必须把同一个 `progress_key` 传给 `ensure_cached_background`，由后台 subscriber 保存并用于每一条事件。测试逐字节比较 Ready key 与该 subscriber 的所有后台事件 key；任务 11 仅把 commit 暴露为 IPC。

如果 backend 返回 `RemoteRangeUnavailable/Network/Timeout`，原位重试一次；第二次仍失败则 `ensure_cached` 后用 Path input 重跑 catalog，成功返回 Materialized。`Cancelled`、密码类、坏包和 unsupported codec 不触发网络降级。

- [ ] **步骤 5：实现 ready cache 优先**

在 Materializer/DAO 增加无下载的 `ready_path_if_fresh` helper；Service 每次 list/read/stat 必须先从唯一 `ArchiveCacheCoordinator` 取得 admission，再检查 ready cache。命中则 Path input；未命中且 format 是 ZIP/CBZ 才用 RemoteZipReader。命中校验继续包含远端 stat 与磁盘长度，不绕过 M3 一致性规则。测试专门让 ready 磁盘文件和 DAO 已存在，再关闭 clear gate，断言命中仍返回 `Cancelled` 而不是穿透。

把 `clear_archive_cache_impl` 签名扩展为同时接收 `&ArchiveService`，并从 Service/Materializer 断言取得的是同一个 coordinator Arc。清理顺序固定为：`let clear_guard = coordinator.begin_clear()` → `coordinator.wait_drained(timeout)` → `service.clear_runtime_caches_while_gated(clear_guard.generation())` → 删除磁盘与 DAO → drop clear_guard。`ClearGuard` 的 Drop 必须同步复位 gate，不实现 async Drop；超时、删除失败或 unwind 都走同一复位语义。测试不能在旧 Range 未释放时直接 await clear：先 spawn clear，等待 gate 已关闭并验证 catalog/block/ready-hit/materialize 四条新路径均被拒，再释放旧 loader，最后 await clear，断言三类 cache 均为空。Tauri command 从 managed state 取得与 factory 相同的 `Arc<ArchiveService>`，不得另建实例。

- [ ] **步骤 6：运行远程流式与 M3 回归**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::service -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::archive::remote_zip -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::archive::materializer -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::archive::prefetch -- --nocapture
```

预期：尾部 Range 优先、自动降级、后台切本地、清空/取消/断点测试全部 PASS。

- [ ] **步骤 7：Commit**

```bash
git add src-tauri/src/source/archive/service.rs src-tauri/src/source/archive/prefetch.rs src-tauri/src/source/archive/zip_backend.rs src-tauri/src/source/archive/materializer.rs src-tauri/src/source/archive/dao.rs src-tauri/src/commands/archive_cache.rs src-tauri/src/lib.rs
git commit -m "feat(archive): 远程 ZIP 流式首开并后台物化"
```

---

### 任务 11：session/prepare/unlock/commit/cancel IPC 与结构化请求状态机

**文件：**
- 创建：`src-tauri/src/commands/archive_access.rs`
- 修改：`src-tauri/src/commands/mod.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src-tauri/src/source/archive/service.rs`
- 修改：`src-tauri/src/source/archive/materializer.rs`
- 修改：`src/lib/tauri.ts`
- 测试：`src/lib/tauri.epoch.test.ts`

- [ ] **步骤 1：写 Rust command inner 测试**

```rust
#[tokio::test]
async fn unlock_only_caches_verified_password() {
    let harness = CommandHarness::encrypted_zip();
    let session_id = "550e8400-e29b-41d4-a716-446655440020";
    harness.service.begin_session(session_id, 1_000).unwrap();
    let request_id = ArchiveRequestId::new(session_id, 1);
    assert_eq!(prepare_archive_inner(
        &harness.service, harness.descriptor.clone(), request_id.clone()
    ).await.unwrap(),
               ArchivePrepareResult::PasswordRequired);
    assert_eq!(unlock_archive_inner(
        &harness.service, harness.descriptor.clone(), "wrong".into(), request_id.clone()
    ).await.unwrap_err(), ArchiveAccessError::WrongPassword);
    assert!(!harness.service.has_password(&harness.identity));
    assert_eq!(unlock_archive_inner(
        &harness.service, harness.descriptor, "secret".into(), request_id.clone()
    ).await.unwrap(), ArchivePrepareResult::Ready {
        access_mode: ArchiveAccessMode::Local,
        progress_key: None,
    });
    assert!(harness.service.has_password(&harness.identity));
    commit_archive_open_inner(&harness.service, request_id).await.unwrap();
}

#[tokio::test]
async fn cancel_request_stops_forced_materialization_without_committing() {
    let harness = CommandHarness::blocking_remote_rar();
    let session_id = "550e8400-e29b-41d4-a716-446655440021";
    harness.service.begin_session(session_id, 1_000).unwrap();
    let request_id = ArchiveRequestId::new(session_id, 2);
    let opening = harness.spawn_prepare(request_id.clone());
    harness.wait_download_started().await;
    cancel_archive_prepare_inner(&harness.service, request_id).await;
    assert_eq!(opening.await.unwrap().unwrap_err(), ArchiveAccessError::Cancelled);
    assert!(!harness.has_ready_row_or_final_file());
}

#[tokio::test]
async fn cancel_before_register_is_observed_by_monotonic_high_water() {
    let harness = CommandHarness::remote_rar();
    let session_id = "550e8400-e29b-41d4-a716-446655440022";
    harness.service.begin_session(session_id, 1_000).unwrap();
    let cancelled = ArchiveRequestId::new(session_id, 7);
    cancel_archive_prepare_inner(&harness.service, cancelled.clone()).await;
    assert_eq!(prepare_archive_inner(
        &harness.service, harness.descriptor.clone(), cancelled
    ).await.unwrap_err(), ArchiveAccessError::Cancelled);
    assert_eq!(harness.service.cancelled_through(session_id), Some(7));
    assert!(harness.service.prepare_with_request(
        &harness.descriptor, ArchiveRequestId::new(session_id, 8)
    ).await.is_ok());
}

#[tokio::test]
async fn prepare_does_not_prefetch_until_commit() {
    let harness = CommandHarness::streaming_remote_zip();
    let session_id = "550e8400-e29b-41d4-a716-446655440023";
    harness.service.begin_session(session_id, 1_000).unwrap();
    let request_id = ArchiveRequestId::new(session_id, 1);
    let ready = prepare_archive_inner(
        &harness.service, harness.descriptor, request_id.clone()
    ).await.unwrap();
    let progress_key = match ready {
        ArchivePrepareResult::Ready { access_mode: ArchiveAccessMode::Streaming, progress_key: Some(key) } => key,
        other => panic!("unexpected result: {other:?}"),
    };
    assert_eq!(harness.prefetch_start_count(), 0);
    commit_archive_open_inner(&harness.service, request_id.clone()).await.unwrap();
    commit_archive_open_inner(&harness.service, request_id).await.unwrap(); // idempotent
    assert_eq!(harness.prefetch_start_count(), 1);
    assert_eq!(harness.last_background_progress_key(), Some(progress_key));
}

#[tokio::test]
async fn newer_request_cancels_old_prepared_and_sparse_commit_is_rejected() {
    let harness = CommandHarness::streaming_remote_zip();
    let session_id = "550e8400-e29b-41d4-a716-446655440024";
    harness.service.begin_session(session_id, 1_000).unwrap();
    let old = ArchiveRequestId::new(session_id, 1);
    let new = ArchiveRequestId::new(session_id, 3); // 故意留 sequence=2 空洞
    harness.service.prepare_with_request(&harness.descriptor, old.clone()).await.unwrap();
    harness.service.prepare_with_request(&harness.descriptor, new.clone()).await.unwrap();
    assert_eq!(harness.service.request_state(&old), None);
    harness.service.commit_request(&new).await.unwrap();
    harness.service.commit_request(&new).await.unwrap(); // 只对精确 last_committed 幂等
    assert_eq!(harness.prefetch_start_count(), 1);
    assert_eq!(harness.service.commit_request(&old).await.unwrap_err(),
               ArchiveAccessError::Cancelled);
}

#[tokio::test]
async fn session_rollover_cancels_and_reclaims_previous_webview_state() {
    let harness = CommandHarness::blocking_remote_rar();
    harness.service.begin_session("550e8400-e29b-41d4-a716-446655440000", 1_000).unwrap();
    let old = ArchiveRequestId::new("550e8400-e29b-41d4-a716-446655440000", 1);
    let opening = harness.spawn_prepare(old.clone());
    harness.wait_download_started().await;
    // 新 WebView 的 boot 更新（2_000 > 1_000），rollover 生效
    harness.service.begin_session("550e8400-e29b-41d4-a716-446655440001", 2_000).unwrap();
    assert_eq!(opening.await.unwrap().unwrap_err(), ArchiveAccessError::Cancelled);
    assert!(!harness.service.has_session(old.session_id()));
    assert_eq!(harness.service.commit_request(&old).await.unwrap_err(),
               ArchiveAccessError::Cancelled);
}

#[tokio::test]
async fn stale_boot_begin_cannot_rollover_established_session() {
    let harness = CommandHarness::local_zip();
    let new_session = "550e8400-e29b-41d4-a716-446655440031";
    assert_eq!(harness.service.begin_session(new_session, 2_000).unwrap(), 2_000);
    let request = ArchiveRequestId::new(new_session, 1);
    harness.service.prepare_with_request(&harness.descriptor, request.clone()).await.unwrap();
    // 旧 WebView 的迟到 begin（boot 更旧）不安装、不取消任何状态，返回当前生效代次
    assert_eq!(
        harness.service.begin_session("550e8400-e29b-41d4-a716-446655440030", 1_000).unwrap(),
        2_000
    );
    assert!(matches!(
        harness.service.request_state(&request),
        Some(RequestState::Prepared { .. })
    ));
    // 回拨恢复路径：携带生效值 + 1 的新 id 换代成功，旧 session 请求转为 Cancelled
    assert_eq!(
        harness.service.begin_session("550e8400-e29b-41d4-a716-446655440032", 2_001).unwrap(),
        2_001
    );
    assert_eq!(harness.service.commit_request(&request).await.unwrap_err(),
               ArchiveAccessError::Cancelled);
}

#[test]
fn equal_boot_later_begin_wins_as_documented_hmr_semantics() {
    let harness = CommandHarness::local_zip();
    harness.service.begin_session("550e8400-e29b-41d4-a716-446655440040", 1_000).unwrap();
    // 同 bootMs 后到者接管是为 HMR 同页换代选择的有意语义（先到者胜会杀死同毫秒的
    // 页面内换代）。"迟到 begin 无法反夺"的保证以 boot 严格更旧为界：跨 WebView
    // reload 的 boot 必然相差百毫秒以上、已被更旧拒绝覆盖；同毫秒且到达顺序颠倒的
    // 理论竞态明确接受（Tauri 同窗口 IPC FIFO 使跨页乱序实际不可达）。
    assert_eq!(
        harness.service.begin_session("550e8400-e29b-41d4-a716-446655440041", 1_000).unwrap(),
        1_000
    );
    assert!(!harness.service.has_session("550e8400-e29b-41d4-a716-446655440040"));
}

#[test]
fn begin_session_rejects_non_uuid_or_oversized_ids() {
    let harness = CommandHarness::local_zip();
    assert!(matches!(harness.service.begin_session("session-a", 1_000),
                     Err(ArchiveAccessError::InvalidRequest(_))));
    assert!(matches!(harness.service.begin_session(&"a".repeat(65), 1_000),
                     Err(ArchiveAccessError::InvalidRequest(_))));
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml commands::archive_access
```

预期：FAIL，command 不存在。

- [ ] **步骤 3：实现 commands 并注册**

复用任务 7 已定义的 `ArchiveRequestId` 与 request registry，并在这里锁定 IPC 可见合同：`RequestState::{Running, AwaitingPassword, Prepared { progress_key, prefetch }, Cancelled}`。应用是单主窗口模型，registry 只接受一个 `current_session`：`begin_archive_session(sessionId, bootMs) -> u64`（返回生效代次）校验 UUID 文本且长度不超过 64 bytes、`bootMs` 为 u64 毫秒值，任一无效返回 `InvalidRequest`。不同 id 不再无条件视为 rollover：只有 `bootMs >= current.boot_ms` 的 begin 才在同一 mutex 内取消旧 active、清除旧 `cancelled_through/last_committed` 后安装新 session 并记录其 boot_ms，返回新 boot；`bootMs` 严格更旧的 begin 不安装、不取消任何状态，直接返回现有 session 的 boot_ms——被销毁 WebView 的迟到 begin 不得反向夺取新 session。返回生效代次同时服务恢复路径：仍然存活的调用方（系统时钟回拨后重载是 `Date.now()` 非严格单调的已知场景）发现返回值大于自己上报的 boot 时，换新 UUID、以 `返回值 + 1` 为 boot 重试一次（见任务 12 `ensureArchiveSession`）。boot 值只在前端之间比较（Rust 不与自身时钟对比，无跨时钟偏差）；同毫秒并列按 IPC 到达顺序（FIFO）后者生效，覆盖 HMR 同页换代。同 id 重试幂等并返回该 session 的 boot。此后旧 session 的迟到 prepare/unlock/commit 返回 `Cancelled`，迟到 cancel 幂等 no-op，因此进程存活期间空间仍为常数，不随 reload 累积。

当前 session 只保存单调 `cancelled_through`、精确 `last_committed: Option<u64>` 与 `active: Option<(sequence, RequestState)>`。cancel N 在同一 mutex 内推进取消高水位，并在 active.sequence <= N 时取消该未 commit 项；register 若 `sequence <= cancelled_through` 立即返回 `Cancelled`，若 sequence 更大则原子取消/替换旧 active，保证每个 session 恰有零或一个 active request。commit 只接受 Prepared active；成功后把它的精确 sequence 写入 `last_committed` 并移除 active。只有 `sequence == last_committed` 的重试返回成功且不重复预载，不能用 `<=` 把未实际提交的稀疏 sequence 误判成功。cancel 已提交 id 为 no-op，其他旧 id 均返回 `Cancelled`。

`prepare_with_request`/`unlock_with_request` 在取得全局 cache admission、格式 semaphore、每个 Range/下载 chunk、远端二次 stat 后、同步 backend 返回后以及 catalog/block/password/DAO/rename 提交前检查 flag。Ready 只把 registry 转到 Prepared 并返回 opaque `progress_key`，不调用 `prefetch_opened`。`commit_request` 幂等执行 Prepared -> Committed，届时才注册后台 subscriber；cancel Prepared 必须丢弃预载意图。Materializer in-flight 项维护 request subscriber：取消单个 subscriber 立即让对应 command 返回 `Cancelled`，只有最后一个交互 subscriber 取消且没有 committed 后台 subscriber 时才推进物理下载取消标志。`ArchiveMaterializeProgress` 增加 `request_id: Option<ArchiveRequestId>` 与 `progress_key: String` 并继续 serde camelCase；共享下载向每个活动交互 subscriber 各 emit 一份带其 request id 的事件，后台事件 `requestId=null`。

在 Materializer tests 锁定四个 subscriber 合同：A/B 同 key 取消 A 后 B 完成；interactive + background 时取消 interactive 后物理下载继续；全部 interactive 取消且无 background 时物理下载终止且无 final/DAO；共享进度分别 fan-out 到 A/B 自己的 requestId。测试还断言 cache hit 路径也先取得全局 admission。

```rust
#[tauri::command]
pub fn begin_archive_session(
    service: tauri::State<'_, Arc<ArchiveService>>,
    session_id: String,
    boot_ms: u64,
) -> Result<u64, ArchiveAccessError> {
    service.begin_session(&session_id, boot_ms)
}

#[tauri::command]
pub async fn prepare_archive(
    service: tauri::State<'_, Arc<ArchiveService>>,
    descriptor: SourceDescriptor,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    prepare_archive_inner(service.inner().as_ref(), descriptor, request_id).await
}

async fn prepare_archive_inner(
    service: &ArchiveService,
    descriptor: SourceDescriptor,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    service.prepare_with_request(&descriptor, request_id).await
}

#[tauri::command]
pub async fn unlock_archive(
    service: tauri::State<'_, Arc<ArchiveService>>,
    descriptor: SourceDescriptor,
    password: String,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    unlock_archive_inner(service.inner().as_ref(), descriptor, password, request_id).await
}

async fn unlock_archive_inner(
    service: &ArchiveService,
    descriptor: SourceDescriptor,
    password: String,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    let bytes = zeroize::Zeroizing::new(password.into_bytes());
    service.unlock_with_request(&descriptor, bytes, request_id).await
}

#[tauri::command]
pub async fn commit_archive_open(
    service: tauri::State<'_, Arc<ArchiveService>>,
    request_id: ArchiveRequestId,
) -> Result<(), ArchiveAccessError> {
    commit_archive_open_inner(service.inner().as_ref(), request_id).await
}

async fn commit_archive_open_inner(
    service: &ArchiveService,
    request_id: ArchiveRequestId,
) -> Result<(), ArchiveAccessError> {
    service.commit_request(&request_id).await
}

#[tauri::command]
pub async fn cancel_archive_prepare(
    service: tauri::State<'_, Arc<ArchiveService>>,
    request_id: ArchiveRequestId,
) {
    cancel_archive_prepare_inner(service.inner().as_ref(), request_id).await;
}

async fn cancel_archive_prepare_inner(service: &ArchiveService, request_id: ArchiveRequestId) {
    service.cancel_request(&request_id).await;
}

```

在 `commands/mod.rs` 导出，在 `generate_handler!` 注册五个命令；`factory.archive_service()` 以同一 Arc manage。Running guard 只在错误/取消时清理；Ready 必须保留 Prepared 到 commit/cancel。cancel 与 commit 都幂等，且不记录 request id 之外的 descriptor/password。

- [ ] **步骤 4：写前端 IPC 失败测试**

在 `tauri.epoch.test.ts` 的 mock invoke harness 增加：

```ts
it('session/prepare/unlock/commit/cancel 使用稳定命令名且密码只放 IPC 参数', async () => {
  const descriptor = { type: 'archive', archivePath: 'C:/book.cbz', entryPrefix: '', format: 'cbz' } as const;
  const sessionId = '550e8400-e29b-41d4-a716-446655440000';
  const requestId = { sessionId, sequence: 1 };
  await beginArchiveSession(sessionId, 1724000000000);
  expect(invoke).toHaveBeenCalledWith('begin_archive_session', { sessionId, bootMs: 1724000000000 });
  await prepareArchive(descriptor, requestId);
  expect(invoke).toHaveBeenCalledWith('prepare_archive', { descriptor, requestId });
  await unlockArchive(descriptor, 'secret', requestId);
  expect(invoke).toHaveBeenCalledWith('unlock_archive', { descriptor, password: 'secret', requestId });
  await commitArchiveOpen(requestId);
  expect(invoke).toHaveBeenCalledWith('commit_archive_open', { requestId });
  await cancelArchivePrepare(requestId);
  expect(invoke).toHaveBeenCalledWith('cancel_archive_prepare', { requestId });
  expect(JSON.stringify(descriptor)).not.toContain('secret');
});
```

- [ ] **步骤 5：实现 TS 类型与封装**

```ts
export type ArchiveAccessMode = 'local' | 'streaming' | 'materialized';
export interface ArchiveRequestId { sessionId: string; sequence: number }
export type ArchivePrepareResult =
  | { status: 'ready'; accessMode: ArchiveAccessMode; progressKey: string | null }
  | { status: 'passwordRequired' };

export interface ArchiveAccessError {
  kind: 'passwordRequired' | 'wrongPassword' | 'unsupportedCodec'
    | 'multiVolumeUnsupported' | 'corruptArchive' | 'emptyArchive'
    | 'resourceLimitExceeded'
    | 'entryNotFound' | 'remoteRangeUnavailable' | 'cancelled' | 'invalidRequest'
    | 'io' | 'network' | 'timeout';
  message?: string;
}

export function beginArchiveSession(sessionId: string, bootMs: number): Promise<number> {
  return invoke<number>('begin_archive_session', { sessionId, bootMs });
}

export function prepareArchive(
  descriptor: SourceDescriptor,
  requestId: ArchiveRequestId,
): Promise<ArchivePrepareResult> {
  return invoke<ArchivePrepareResult>('prepare_archive', { descriptor, requestId });
}

export function unlockArchive(
  descriptor: SourceDescriptor,
  password: string,
  requestId: ArchiveRequestId,
): Promise<ArchivePrepareResult> {
  return invoke<ArchivePrepareResult>('unlock_archive', { descriptor, password, requestId });
}

export function commitArchiveOpen(requestId: ArchiveRequestId): Promise<void> {
  return invoke<void>('commit_archive_open', { requestId });
}

export function cancelArchivePrepare(requestId: ArchiveRequestId): Promise<void> {
  return invoke<void>('cancel_archive_prepare', { requestId });
}
```

- [ ] **步骤 6：运行双端测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml commands::archive_access
npx vitest run src/lib/tauri.epoch.test.ts
npm run type-check
```

预期：全部 PASS。

- [ ] **步骤 7：Commit**

```bash
git add src-tauri/src/commands/archive_access.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/source/archive/service.rs src-tauri/src/source/archive/materializer.rs src/lib/tauri.ts src/lib/tauri.epoch.test.ts
git commit -m "feat(archive): 增加可取消的结构化准备与解锁 IPC"
```

---

### 任务 12：FileBrowser 事务式打开与密码请求状态

**文件：**
- 修改：`src/stores/fileBrowser.ts`
- 修改：`src/stores/fileBrowser.test.ts`

- [ ] **步骤 1：扩展 tauri mock 并写失败测试**

mock 加入：

```ts
beginArchiveSession: vi.fn((sessionId: string, bootMs: number) => Promise.resolve(bootMs)), // 数字返回契约：正常安装返回自身 boot
prepareArchive: vi.fn(async () => ({ status: 'ready', accessMode: 'local' as const, progressKey: null })),
unlockArchive: vi.fn(async () => ({ status: 'ready', accessMode: 'local' as const, progressKey: null })),
commitArchiveOpen: vi.fn(async () => undefined),
cancelArchivePrepare: vi.fn(async () => undefined),
```

新增测试：

```ts
it('prepare ready 后才原子提交 archive 导航', async () => {
  const fb = useFileBrowserStore();
  await fb.setRoot('F:/comics');
  await fb.navigate('sub');
  const pending = deferred<ArchivePrepareResult>();
  vi.mocked(prepareArchive).mockReturnValueOnce(pending.promise);
  const opening = fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
  expect(fb.currentPath).toBe('sub');
  expect(fb.currentDescriptor).toBeNull();
  pending.resolve({ status: 'ready', accessMode: 'local', progressKey: null });
  await opening;
  expect(fb.currentPath).toBe('');
  expect(fb.currentDescriptor).toMatchObject({ type: 'archive', format: 'cbr' });
  expect(commitArchiveOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: expect.any(String), sequence: 1 }));
});

it('password-required 不污染原导航', async () => {
  const fb = useFileBrowserStore();
  await fb.setRoot('F:/comics');
  await fb.navigate('sub');
  vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'passwordRequired' });
  await fb.openArchive(makeEntry('book.7z', { isArchive: true }));
  expect(fb.pendingArchivePassword?.descriptor.format).toBe('7z');
  expect(fb.currentPath).toBe('sub');
  expect(fb.currentDescriptor).toBeNull();
  fb.cancelArchivePassword();
  expect(fb.pendingArchivePassword).toBeNull();
  expect(fb.currentPath).toBe('sub');
});

it.each([
  'multiVolumeUnsupported',
  'resourceLimitExceeded',
  'network',
  'corruptArchive',
] as const)('prepare %s 进入结构化错误状态且不污染原导航', async (kind) => {
  const fb = useFileBrowserStore();
  await fb.setRoot('F:/comics');
  await fb.navigate('sub');
  vi.mocked(prepareArchive).mockRejectedValueOnce({ kind });
  await fb.openArchive(makeEntry('book.7z', { isArchive: true }));
  expect(fb.archiveOpenError).toMatchObject({ kind });
  expect(fb.currentPath).toBe('sub');
  expect(fb.currentDescriptor).toBeNull();
  expect(fb.archiveOpening).toBe(false);
});

it('错误密码保留请求，正确密码提交候选导航', async () => {
  const fb = useFileBrowserStore();
  await fb.setRoot('F:/comics');
  vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'passwordRequired' });
  await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
  vi.mocked(unlockArchive).mockRejectedValueOnce({ kind: 'wrongPassword' });
  await expect(fb.submitArchivePassword('bad')).rejects.toMatchObject({ kind: 'wrongPassword' });
  expect(fb.pendingArchivePassword).not.toBeNull();
  vi.mocked(unlockArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
  await fb.submitArchivePassword('secret');
  expect(fb.pendingArchivePassword).toBeNull();
  expect(fb.currentDescriptor?.type).toBe('archive');
});

it('候选未提交时消费物化进度，取消后丢弃迟到回包与事件', async () => {
  const fb = useFileBrowserStore();
  await fb.openDescriptorAt(webdavRoot(), 'comics');
  const pending = deferred<ArchivePrepareResult>();
  vi.mocked(prepareArchive).mockReturnValueOnce(pending.promise);
  const opening = fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
  expect(fb.archiveOpening).toBe(true);
  await vi.waitFor(() => expect(fb.pendingArchiveOpen).not.toBeNull());
  const oldRequestId = fb.pendingArchiveOpen!.requestId;
  emitArchiveProgress({ requestId: oldRequestId, progressKey: 'candidate-key', relPath: 'comics/book.cbr', downloaded: 4, totalBytes: 10, phase: 'downloading' });
  expect(fb.archiveProgress).toEqual({ downloaded: 4, total: 10 });
  fb.cancelArchiveOpen();
  expect(cancelArchivePrepare).toHaveBeenCalledWith(oldRequestId);
  pending.resolve({ status: 'ready', accessMode: 'materialized', progressKey: 'opaque-old-key' });
  await opening;
  emitArchiveProgress({ requestId: oldRequestId, progressKey: 'opaque-old-key', relPath: 'comics/book.cbr', downloaded: 10, totalBytes: 10, phase: 'ready' });
  expect(fb.currentDescriptor).toMatchObject({ type: 'webdav' });
  expect(fb.archiveProgress).toBeNull();
  expect(fb.archiveOpening).toBe(false);
  expect(commitArchiveOpen).not.toHaveBeenCalled();
});

it('取消后立即重开同一路径时只接受新 requestId 的进度', async () => {
  const fb = useFileBrowserStore();
  await fb.openDescriptorAt(webdavRoot(), 'comics');
  vi.mocked(prepareArchive).mockReturnValue(new Promise(() => {}));
  void fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
  await vi.waitFor(() => expect(fb.pendingArchiveOpen).not.toBeNull());
  const oldId = fb.pendingArchiveOpen!.requestId;
  fb.cancelArchiveOpen();
  void fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
  await vi.waitFor(() => expect(fb.pendingArchiveOpen?.requestId).not.toBe(oldId));
  const newId = fb.pendingArchiveOpen!.requestId;
  expect(newId).not.toBe(oldId);
  emitArchiveProgress({ requestId: oldId, progressKey: 'old-key', relPath: 'comics/book.cbr', downloaded: 8, totalBytes: 10, phase: 'downloading' });
  expect(fb.archiveProgress).toBeNull();
  emitArchiveProgress({ requestId: newId, progressKey: 'new-key', relPath: 'comics/book.cbr', downloaded: 2, totalBytes: 10, phase: 'downloading' });
  expect(fb.archiveProgress).toEqual({ downloaded: 2, total: 10 });
});

it('新 open 取消 commit-pending 的旧 Prepared，再注册唯一的新 request', async () => {
  const fb = useFileBrowserStore();
  const firstCommit = deferred<void>();
  vi.mocked(prepareArchive)
    .mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null })
    .mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
  vi.mocked(commitArchiveOpen).mockReturnValueOnce(firstCommit.promise);
  const openingOld = fb.openArchive(makeEntry('old.cbz', { isArchive: true }));
  // 旧请求已 Ready：本地导航已提交、commit IPC 挂起 → Prepared/commit-pending 确实存在
  await vi.waitFor(() => expect(fb.archiveCommitPendingId).not.toBeNull());
  const oldId = fb.archiveCommitPendingId!;
  const openingNew = fb.openArchive(makeEntry('new.cbz', { isArchive: true }));
  await vi.waitFor(() => expect(vi.mocked(prepareArchive).mock.calls.length).toBe(2));
  // 新 open 先 cancel 该 commit-pending id，cancel 完成后才注册第二个 prepare
  expect(cancelArchivePrepare).toHaveBeenCalledWith(oldId);
  expect(vi.mocked(cancelArchivePrepare).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(prepareArchive).mock.invocationCallOrder[1]);
  firstCommit.resolve(); // 迟到的旧 commit 回包不得污染新导航
  await Promise.all([openingOld, openingNew]);
  expect(fb.currentDescriptor).toMatchObject({ archivePath: expect.stringContaining('new.cbz') });
  expect(fb.archiveCommitPendingId).toBeNull(); // 新请求自己的 commit 已成功清位
});

it('commit 暂时失败时用同一 id 重试且只启动一次预载', async () => {
  const fb = useFileBrowserStore();
  vi.mocked(commitArchiveOpen)
    .mockRejectedValueOnce(new Error('ipc unavailable'))
    .mockResolvedValueOnce(undefined);
  await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
  expect(commitArchiveOpen).toHaveBeenCalledTimes(2);
  expect(vi.mocked(commitArchiveOpen).mock.calls[0][0])
    .toEqual(vi.mocked(commitArchiveOpen).mock.calls[1][0]);
  expect(cancelArchivePrepare).not.toHaveBeenCalled();
});

it('commit 永久失败时保留导航、取消 Prepared 并回收后台 key', async () => {
  const fb = useFileBrowserStore();
  vi.mocked(prepareArchive).mockResolvedValueOnce({
    status: 'ready', accessMode: 'streaming', progressKey: 'server-key-42',
  });
  vi.mocked(commitArchiveOpen).mockRejectedValue(new Error('ipc unavailable'));
  await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
  expect(fb.currentDescriptor).toMatchObject({ type: 'archive' });
  expect(commitArchiveOpen).toHaveBeenCalledTimes(3);
  expect(cancelArchivePrepare).toHaveBeenCalledWith(
    vi.mocked(commitArchiveOpen).mock.calls[2][0],
  );
  // 后台物化已被取消：key 回收，UI 不进入"后台缓存中"，任何 key 的迟到事件都不再更新进度
  expect(fb.archiveProgressKey).toBeNull();
  for (const key of ['client-derived-wrong', 'server-key-42']) {
    emitArchiveProgress({ requestId: null, progressKey: key, relPath: 'book.cbz', downloaded: 8, totalBytes: 10, phase: 'downloading' });
    expect(fb.archiveProgress).toBeNull();
  }
});

it('session 初始化失败写入 archiveOpenError 且下一次 open 重试', async () => {
  const fb = useFileBrowserStore();
  vi.mocked(beginArchiveSession).mockRejectedValueOnce(new Error('ipc unavailable'));
  await fb.openArchive(makeEntry('book.cbz', { isArchive: true })); // openArchive 自身不得 reject
  expect(fb.archiveOpenError).toMatchObject({ kind: 'io' }); // 未结构化的 IPC 错误收敛为 io
  expect(prepareArchive).not.toHaveBeenCalled();
  expect(fb.archiveOpening).toBe(false);
  expect(fb.pendingArchiveOpen).toBeNull();
  vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
  await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
  expect(fb.archiveOpenError).toBeNull();
  expect(fb.currentDescriptor?.type).toBe('archive');
});

it('时钟回拨恢复后 prepare 携带换代后的 sessionId', async () => {
  const fb = useFileBrowserStore();
  const resumedUuid = '0e2f9a55-1234-4c56-9abc-def012345678';
  const randomSpy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(resumedUuid);
  const futureBoot = Date.now() + 60_000;
  vi.mocked(beginArchiveSession)
    .mockResolvedValueOnce(futureBoot)      // 第一次 begin 返回更大生效代次 → 本页过期
    .mockResolvedValueOnce(futureBoot + 1); // 换代 begin 成功
  vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
  await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
  expect(beginArchiveSession).toHaveBeenNthCalledWith(2, resumedUuid, futureBoot + 1);
  // requestId 必须取换代后的最终 session id，而不是模块加载时的旧 UUID
  expect(vi.mocked(prepareArchive).mock.calls[0][1].sessionId).toBe(resumedUuid);
  expect(fb.currentDescriptor?.type).toBe('archive'); // 最终成功，不是静默 Cancelled
  randomSpy.mockRestore();
});

it('commit 退避等待中被取消后不再发送陈旧 commit', async () => {
  vi.useFakeTimers();
  try {
    const fb = useFileBrowserStore();
    vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
    vi.mocked(commitArchiveOpen).mockRejectedValueOnce(new Error('ipc unavailable'));
    const opening = fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
    await vi.advanceTimersByTimeAsync(0); // 第一次 commit 已失败，任务进入 25ms 退避
    expect(commitArchiveOpen).toHaveBeenCalledTimes(1);
    const pendingId = fb.archiveCommitPendingId!;
    fb.cancelArchiveOpen(); // 退避窗口内用户取消：epoch 前进、cancel 已发出
    await vi.advanceTimersByTimeAsync(25); // 旧任务苏醒：epoch 已失效 → 不再发 commit，转入 cancel 清理
    expect(commitArchiveOpen).toHaveBeenCalledTimes(1);
    expect(cancelArchivePrepare).toHaveBeenCalledWith(pendingId);
    await opening;
    expect(fb.archiveCommitPendingId).toBeNull();
    expect(fb.archiveOpenError).toBeNull(); // 取消不显示错误
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
npx vitest run src/stores/fileBrowser.test.ts
```

预期：FAIL，store 尚未调用 prepare/unlock/cancel，也没有 requestId、pending 与结构化错误状态。

- [ ] **步骤 3：抽出候选 descriptor 构造**

```ts
interface ArchiveCandidate {
  descriptor: SourceDescriptor;
  parent: { descriptor: SourceDescriptor; relPath: string };
  entryName: string;
}

interface PendingArchiveOpen extends ArchiveCandidate {
  epoch: number;
  requestId: ArchiveRequestId;
}

const pendingArchivePassword = ref<PendingArchiveOpen | null>(null);
const pendingArchiveOpen = ref<PendingArchiveOpen | null>(null);
const archiveOpening = ref(false);
const archiveAccessMode = ref<ArchiveAccessMode | null>(null);
const archiveProgressKey = ref<string | null>(null);
const archiveOpenError = ref<ArchiveAccessError | null>(null);
const archiveCommitPendingId = ref<ArchiveRequestId | null>(null);
let archiveOpenEpoch = 0;
let archiveSessionId = crypto.randomUUID();
let archiveBootMs = Date.now(); // 页面代次：模块求值时捕获一次，随 begin 上报防旧 WebView 迟到 begin 反夺
let archiveRequestSequence = 0;
let archiveSessionReady: Promise<void> | null = null;

async function ensureArchiveSession(): Promise<void> {
  archiveSessionReady ??= ensureArchiveSessionOnce().catch((cause) => {
    archiveSessionReady = null; // 初始化 IPC 恢复后允许下一次 open 重试
    throw cause;
  });
  await archiveSessionReady;
}

async function ensureArchiveSessionOnce(): Promise<void> {
  let effectiveBootMs = await beginArchiveSession(archiveSessionId, archiveBootMs);
  if (effectiveBootMs > archiveBootMs) {
    // 本页面 boot 已过期（Date.now() 非严格单调：时钟回拨后重载等已知场景）。
    // 换新 UUID、以生效代次 + 1 重试一次——恢复路径，不会与正常 reload 的死者 begin 竞争。
    archiveBootMs = effectiveBootMs + 1;
    archiveSessionId = crypto.randomUUID();
    effectiveBootMs = await beginArchiveSession(archiveSessionId, archiveBootMs);
    if (effectiveBootMs > archiveBootMs) {
      throw { kind: 'invalidRequest', message: 'archive session generation conflict' };
    }
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, ms));

function buildArchiveCandidate(entry: MediaEntry): ArchiveCandidate {
  // 把现有 Local/WebDAV/SMB descriptor 构造原样移动到此纯函数；不得写任何 ref。
}
```

纯函数必须返回当前实现完全相同的 Local/WebDAV/SMB descriptor 字段。

- [ ] **步骤 4：实现 prepare 后提交**

```ts
function commitArchive(
  candidate: PendingArchiveOpen,
  mode: ArchiveAccessMode,
  progressKey: string | null,
): void {
  archiveParent.value = candidate.parent;
  currentDescriptor.value = candidate.descriptor;
  currentPath.value = '';
  searchQuery.value = '';
  archiveAccessMode.value = mode;
  archiveProgressKey.value = progressKey;
}

async function openArchive(entry: MediaEntry): Promise<void> {
  archiveProgress.value = null;
  archiveOpenError.value = null;
  const epoch = ++archiveOpenEpoch;
  // 同步摘走旧 id；先完成 best-effort cancel，才允许新 request 注册。
  const supersededId = pendingArchiveOpen.value?.requestId
    ?? pendingArchivePassword.value?.requestId
    ?? archiveCommitPendingId.value;
  pendingArchiveOpen.value = null;
  pendingArchivePassword.value = null;
  archiveCommitPendingId.value = null;
  if (supersededId) {
    await cancelArchivePrepare(supersededId).catch((cause) =>
      recordArchiveDiagnostic('cancelSupersededArchive', cause));
  }
  if (epoch !== archiveOpenEpoch) return;
  archiveOpening.value = true;
  try {
    // session 初始化必须最先发生，且与 prepare 同处一个 try：begin IPC 失败要落入
    // archiveOpenError（经 archiveSessionReady 重置后，下一次 open 重试），不得从
    // 双击/click handler 泄漏 rejection。回拨恢复可能在此替换 archiveSessionId
    //（换新 UUID），requestId 必须在恢复之后用最终 session id 构造——顺序颠倒会让
    // prepare 携带已作废的旧 UUID，被 Rust 当作旧 session 的迟到请求拒绝。
    await ensureArchiveSession();
    if (epoch !== archiveOpenEpoch) return;
    const requestId: ArchiveRequestId = {
      sessionId: archiveSessionId,
      sequence: ++archiveRequestSequence,
    };
    const candidate = { ...buildArchiveCandidate(entry), epoch, requestId };
    pendingArchiveOpen.value = candidate;
    const result = await prepareArchive(candidate.descriptor, requestId);
    if (epoch !== archiveOpenEpoch) return;
    if (result.status === 'passwordRequired') {
      pendingArchivePassword.value = candidate;
      return;
    }
    commitArchive(candidate, result.accessMode, result.progressKey);
    // 先提交本地导航，再用同一 id 做有界幂等握手；失败不回滚导航。
    archiveCommitPendingId.value = requestId;
    await commitArchiveOpenWithCleanup(requestId, epoch);
    await fetch('');
  } catch (cause) {
    if (epoch !== archiveOpenEpoch) return;
    const error = normalizeArchiveAccessError(cause);
    if (error.kind !== 'cancelled') archiveOpenError.value = error;
  } finally {
    if (epoch === archiveOpenEpoch) {
      pendingArchiveOpen.value = null;
      archiveOpening.value = false;
    }
  }
}

async function commitArchiveOpenWithCleanup(
  requestId: ArchiveRequestId,
  epoch: number,
): Promise<void> {
  const backoffMs = [0, 25, 75] as const;
  for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
    if (epoch !== archiveOpenEpoch) break;
    if (backoffMs[attempt] > 0) {
      await delay(backoffMs[attempt]);
      // 退避苏醒后必须复核 epoch：等待期间的新 open/取消/退出已 cancel 该 id，
      // 而后端对已 commit id 的 cancel 是 no-op——迟到 commit 会把已取消的 Prepared
      // 变成无法停止的后台预载。失效请求直接跳出循环进入 cancel 清理。
      if (epoch !== archiveOpenEpoch) break;
    }
    try {
      await commitArchiveOpen(requestId);
      if (sameArchiveRequestId(archiveCommitPendingId.value, requestId)) {
        archiveCommitPendingId.value = null;
      }
      return;
    } catch (cause) {
      recordArchiveDiagnostic('commitArchiveOpen', cause);
    }
  }
  await cancelArchivePrepare(requestId).catch((cause) =>
    recordArchiveDiagnostic('cancelUncommittedArchive', cause));
  if (sameArchiveRequestId(archiveCommitPendingId.value, requestId)) {
    archiveCommitPendingId.value = null;
    // 后台物化已取消：回收 progressKey，迟到 key 事件不再把 UI 推入"后台缓存中"。
    archiveProgressKey.value = null;
  }
}
```

`normalizeArchiveAccessError` 只接受 IPC 结构化 `kind/message` 并把未知值收敛为 `{ kind: 'io' }`，不得解析错误字符串。`submitArchivePassword` 调用 `unlockArchive(candidate.descriptor, password, candidate.requestId)` 并捕获 candidate epoch；成功回包只有 epoch 仍为当前值时才 `commitArchive(..., result.progressKey)`，随后调用同一个 `commitArchiveOpenWithCleanup` 再 fetch；`wrongPassword` 继续向弹窗抛出且不清 pending，其他错误写 `archiveOpenError`。`cancelArchivePassword` 与新的 `cancelArchiveOpen` 都先保存 candidate requestId、推进 `archiveOpenEpoch`、清 pending/opening/progress，再 best-effort 调用 `cancelArchivePrepare(requestId)`；cancel IPC rejection 必须被捕获，不能产生 unhandled promise。`exitArchive` 同样取消 pending 或 `archiveCommitPendingId`，并清 `archiveAccessMode/archiveProgressKey`。commit 最多以同一 id 尝试 3 次，且每次退避等待结束、发送 commit IPC 之前都必须复核 epoch（失效请求不得再发送 commit，直接转入 cancel 清理）；暂时失败后成功依赖后端精确幂等保证只启动一次预载，永久失败则 best-effort cancel Prepared 并同步回收该请求的 `archiveProgressKey`（后台物化已不存在，UI 不显示"后台缓存中"，任何 key 的迟到事件不再被接受），避免 request 泄漏。新增测试锁定：瞬时失败、永久失败、新 open 先取消 commit-pending 的旧 Prepared 再注册新请求、session 初始化失败（begin IPC reject 写 `archiveOpenError`、`prepareArchive` 不被调用、下一次 open 重试成功、openArchive 本身不 reject）、退避等待期间被取消的请求苏醒后不再发送陈旧 commit（fake timers 锁定该竞态）。导航一旦本地提交便不因 commit IPC 失败回滚。

把 `ArchiveProgressPayload` 扩展为 `requestId: ArchiveRequestId | null` 和 `progressKey: string`。提供 `sameArchiveRequestId(a,b)` 比较 `sessionId + sequence`，候选监听只接受与 pending requestId 两字段相等的事件；不得用对象引用相等、relPath 或闭包 epoch替代后端关联 id。同一路径取消后立即重开的旧事件必须被拒绝。已经进入 Streaming 后的后台预载事件固定 `requestId=null`，只以 Ready 保存的 opaque `archiveProgressKey` 匹配，不由前端派生 cacheKey，也不与候选进度共用分支。

Pinia setup store 的最终 `return` 对象必须显式加入 `pendingArchiveOpen`、`pendingArchivePassword`、`archiveCommitPendingId`、`archiveOpening`、`archiveAccessMode`、`archiveProgressKey`、`archiveOpenError`、`archiveProgress`、`openArchive`、`submitArchivePassword`、`cancelArchivePassword`、`cancelArchiveOpen`、`exitArchive` 和 `startArchiveProgressListener`。Task 13 组件测试通过这些公开成员访问状态；遗漏任一项应由 `npm run type-check` 失败阻止提交。

- [ ] **步骤 5：五格式扩展测试 helper**

把 `makeEntries` 的 `isArchive` 改为：

```ts
isArchive: /\.(cbz|zip|cbr|rar|7z)$/i.test(n),
```

为五种扩展各断言一次 `format`。

- [ ] **步骤 6：运行 store 全文件**

运行：

```bash
npx vitest run src/stores/fileBrowser.test.ts
npm run type-check
```

预期：新事务测试和所有既有导航/进度测试 PASS。

- [ ] **步骤 7：Commit**

```bash
git add src/stores/fileBrowser.ts src/stores/fileBrowser.test.ts
git commit -m "feat(filebrowser): 压缩包准备成功后原子进入"
```

---

### 任务 13：密码模态框、错误文案与流式进度 UI

**文件：**
- 创建：`src/components/filebrowser/ArchivePasswordDialog.vue`
- 创建：`src/components/filebrowser/ArchivePasswordDialog.test.ts`
- 修改：`src/components/filebrowser/FileBrowser.vue`
- 修改：`src/components/filebrowser/FileBrowser.test.ts`
- 修改：`src/locales/zh-CN.ts`
- 修改：`src/locales/en-US.ts`

- [ ] **步骤 1：写受控组件失败测试**

```ts
it('Enter 提交、Esc 取消、提交中禁用且不回显错误密码', async () => {
  const wrapper = mount(ArchivePasswordDialog, {
    props: { show: true, archiveName: 'book.cbr', busy: false, errorKind: null },
    global: { plugins: [testI18n()] },
  });
  const input = wrapper.get('[data-test="archive-password-input"]');
  await input.setValue('secret');
  await input.trigger('keydown.enter');
  expect(wrapper.emitted('submit')).toEqual([['secret']]);
  await wrapper.trigger('keydown.esc');
  expect(wrapper.emitted('cancel')).toHaveLength(1);
  await wrapper.setProps({ busy: true, errorKind: 'wrongPassword' });
  expect(wrapper.get('[data-test="archive-password-submit"]').attributes('disabled')).toBeDefined();
  expect(wrapper.text()).not.toContain('secret');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
npx vitest run src/components/filebrowser/ArchivePasswordDialog.test.ts
```

预期：FAIL，组件不存在。

- [ ] **步骤 3：实现模态框**

Props/Emits：

```ts
interface Props {
  show: boolean;
  archiveName: string;
  busy: boolean;
  errorKind: ArchiveAccessError['kind'] | null;
}

const emit = defineEmits<{
  (e: 'submit', password: string): void;
  (e: 'cancel'): void;
}>();
```

组件本地持有 `password` 与 `visible`；show 从 false→true 时清空；wrongPassword 后清空并 focus；Teleport z-index 高于现有菜单；点击遮罩和 Esc 只在非 busy 时取消。

- [ ] **步骤 4：补双语文案**

在 `fileBrowser.archive` namespace 增加同构 key：

```ts
passwordTitle: '压缩包需要密码',
passwordHint: '密码仅在本次运行期间保留',
showPassword: '显示密码',
wrongPassword: '密码不正确，请重试',
unsupportedCodec: '不支持的压缩算法：{message}',
multiVolumeUnsupported: '暂不支持分卷压缩包',
corruptArchive: '压缩包已损坏或内容不完整',
emptyArchive: '压缩包中没有可阅读图片',
resourceLimitExceeded: '压缩包条目或目录超过安全资源上限',
network: '无法从远程位置读取压缩包',
timeout: '读取压缩包超时，请重试',
io: '打开压缩包时发生文件读写错误',
backgroundCaching: '后台缓存 {percent}%',
streamFallback: '流式读取不可用，正在下载完整压缩包…',
```

英文文件添加完全相同 key 集的英文值。

- [ ] **步骤 5：FileBrowser 接线**

父组件状态：

```ts
const archivePasswordBusy = ref(false);
const archivePasswordError = ref<ArchiveAccessError['kind'] | null>(null);

async function onArchivePasswordSubmit(password: string): Promise<void> {
  archivePasswordBusy.value = true;
  archivePasswordError.value = null;
  try {
    await fb.submitArchivePassword(password);
  } catch (error) {
    const kind = (error as Partial<ArchiveAccessError>)?.kind;
    archivePasswordError.value = kind ?? 'io';
  } finally {
    archivePasswordBusy.value = false;
  }
}
```

模板挂载 `ArchivePasswordDialog`；取消调用 `fb.cancelArchivePassword()`。加载提示的显示条件改为 `fb.loading || fb.archiveOpening`，不能只依赖 list fetch 的 `fb.loading`。`loadingText` 在 `pendingArchiveOpen` 存在时按 materializer progress 区分“正在打开”“正在下载完整压缩包”，进入 Streaming 后 status bar 显示非阻塞后台百分比。候选阶段的取消按钮调用 `fb.cancelArchiveOpen()`，不会提交 descriptor。`fb.archiveOpenError` 通过稳定 kind 映射为页面内可关闭错误提示；双击 handler 不再自行 await/rethrow store promise，因此 rejected prepare 不会成为 unhandled promise。新打开请求先清旧错误，取消不显示错误。

- [ ] **步骤 6：写父组件交互测试**

```ts
it('双击加密 archive 弹密码框，错误保留，成功后进入', async () => {
  vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'passwordRequired' });
  vi.mocked(unlockArchive)
    .mockRejectedValueOnce({ kind: 'wrongPassword' })
    .mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
  const wrapper = await mountFileBrowser();
  await wrapper.get('[data-test="file-row-book.cbr"]').trigger('dblclick');
  expect(wrapper.find('[data-test="archive-password-dialog"]').exists()).toBe(true);
  await submitDialog(wrapper, 'bad');
  expect(wrapper.text()).toContain('密码不正确');
  await submitDialog(wrapper, 'secret');
  expect(wrapper.find('[data-test="archive-password-dialog"]').exists()).toBe(false);
  expect(useFileBrowserStore().currentDescriptor).toMatchObject({ type: 'archive', format: 'cbr' });
});

it('远程 RAR 在候选物化阶段显示进度且取消后留在原目录', async () => {
  const pending = deferred<ArchivePrepareResult>();
  vi.mocked(prepareArchive).mockReturnValueOnce(pending.promise);
  const wrapper = await mountRemoteFileBrowser('comics');
  await wrapper.get('[data-test="file-row-book.cbr"]').trigger('dblclick');
  const requestId = useFileBrowserStore().pendingArchiveOpen!.requestId;
  emitArchiveProgress({ requestId, progressKey: 'opaque-rar-key', relPath: 'comics/book.cbr', downloaded: 5 * 1048576, totalBytes: 10 * 1048576, phase: 'downloading' });
  await nextTick();
  expect(wrapper.text()).toContain('5.0');
  await wrapper.get('[data-test="archive-open-cancel"]').trigger('click');
  pending.resolve({ status: 'ready', accessMode: 'materialized', progressKey: 'opaque-rar-key' });
  await flushPromises();
  expect(useFileBrowserStore().currentPath).toBe('comics');
});

it.each([
  ['multiVolumeUnsupported', '暂不支持分卷压缩包'],
  ['resourceLimitExceeded', '超过安全资源上限'],
  ['network', '无法从远程位置读取'],
  ['corruptArchive', '压缩包已损坏'],
] as const)('prepare %s 显示结构化错误且不产生未处理 rejection', async (kind, text) => {
  vi.mocked(prepareArchive).mockRejectedValueOnce({ kind });
  const wrapper = await mountFileBrowser();
  await wrapper.get('[data-test="file-row-book.7z"]').trigger('dblclick');
  await flushPromises();
  expect(wrapper.get('[data-test="archive-open-error"]').text()).toContain(text);
  expect(useFileBrowserStore().currentDescriptor).toBeNull();
});
```

- [ ] **步骤 7：运行 UI、i18n 与类型检查**

运行：

```bash
npx vitest run src/components/filebrowser/ArchivePasswordDialog.test.ts src/components/filebrowser/FileBrowser.test.ts
npm test -- --run src/locales
npm run type-check
```

预期：组件/父级/i18n 全 PASS，locale key 无差异。

- [ ] **步骤 8：Commit**

```bash
git add src/components/filebrowser/ArchivePasswordDialog.vue src/components/filebrowser/ArchivePasswordDialog.test.ts src/components/filebrowser/FileBrowser.vue src/components/filebrowser/FileBrowser.test.ts src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(filebrowser): 增加压缩包会话密码交互"
```

---

### 任务 14：media 错误、安全守卫、CI、文档与全量验收

**文件：**
- 修改：`src-tauri/src/lib.rs`
- 修改：`.github/workflows/verify.yml`
- 修改：`DESIGN.md`
- 修改：`README.md`
- 修改：`BUILD.md`
- 修改：`AGENTS.md`
- 测试：`src-tauri/src/source/archive/service.rs`

- [ ] **步骤 1：写密码泄漏与 media 映射失败测试**

```rust
#[tokio::test]
async fn password_never_appears_in_descriptor_error_or_debug_output() {
    let descriptor = encrypted_test_descriptor();
    let service = test_service();
    let err = service.unlock(
        &descriptor,
        zeroize::Zeroizing::new(b"DO-NOT-LEAK".to_vec()),
    ).await.unwrap_err();
    assert!(!serde_json::to_string(&descriptor).unwrap().contains("DO-NOT-LEAK"));
    assert!(!format!("{err:?}").contains("DO-NOT-LEAK"));
    assert!(!err.to_string().contains("DO-NOT-LEAK"));
}

#[test]
fn archive_password_error_maps_to_locked_response_without_detail() {
    let response = error_to_status(MediaSourceError::Archive(
        ArchiveAccessError::PasswordRequired,
    ));
    assert_eq!(response.status(), StatusCode::LOCKED);
    assert_eq!(response.body(), b"archive locked");
}

#[test]
fn archive_resource_limit_maps_to_payload_too_large() {
    let response = error_to_status(MediaSourceError::Archive(
        ArchiveAccessError::ResourceLimitExceeded("entry > 512 MiB".into()),
    ));
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(response.body(), b"archive resource limit");
}
```

- [ ] **步骤 2：实现 media 错误映射**

在 `lib.rs` 的 media error match 中加入：

```rust
MediaSourceError::Archive(ArchiveAccessError::PasswordRequired)
| MediaSourceError::Archive(ArchiveAccessError::WrongPassword) => {
    err_response(StatusCode::LOCKED, "archive locked")
}
MediaSourceError::Archive(ArchiveAccessError::EntryNotFound(_)) => {
    err_response(StatusCode::NOT_FOUND, "not found")
}
MediaSourceError::Archive(ArchiveAccessError::ResourceLimitExceeded(_)) => {
    err_response(StatusCode::PAYLOAD_TOO_LARGE, "archive resource limit")
}
MediaSourceError::Archive(ArchiveAccessError::Network(_)) => {
    err_response(StatusCode::BAD_GATEWAY, "bad gateway")
}
MediaSourceError::Archive(_) => {
    err_response(StatusCode::UNPROCESSABLE_ENTITY, "archive error")
}
```

响应体不含第三方错误或密码信息。

- [ ] **步骤 3：增加 CI 守卫**

在 `.github/workflows/verify.yml` 现有 stable `cargo check` / `cargo test` 步骤全部完成之后追加 MSRV 步骤，避免安装 1.75 改变后续现有命令的默认 toolchain：

```yaml
      - name: Install Rust 1.75 for MSRV archive check
        uses: dtolnay/rust-toolchain@master
        with:
          toolchain: '1.75.0'

      - name: Archive dependencies keep Rust 1.75 MSRV
        run: cargo +1.75.0 check --manifest-path src-tauri/Cargo.toml
```

若任务 1 已用 `cargo +1.75.0 check` 证明整个仓库受既有依赖的更高 MSRV 阻塞，则在 `src-tauri/archive-msrv-smoke/` 建立独立 smoke crate，并把 CI 命令改为检查该 manifest。smoke crate 必须实际编译调用 zip/unrar/sevenz/password API，且测试断言依赖版本和关键类型可用，不能是空 crate。

另为 RAR 宽字符平台分支增加 Linux 编译守卫：在 `verify.yml` 增加 ubuntu-latest job 运行 `cargo check --manifest-path src-tauri/Cargo.toml`（runner 自带 g++，`unrar_sys` 的 C++ 内核可直接编译）。Windows runner 编译不到 `cfg(unix)` 下 `wchar_t` 32 位的 `encode_wide`/`decode_wide` 分支，该 job 是规格"不加入 ABI 假设"要求的最低验证；macOS 编译随 Phase 9 环境补齐。

- [ ] **步骤 4：更新文档**

`README.md` Phase 3 改为五格式完成；`DESIGN.md` §16.1 标记交付能力与限制；`BUILD.md` 增加 Windows C++ Build Tools 作为 UnRAR 编译要求，并链接 `THIRD_PARTY_LICENSES/UNRAR.txt`；`AGENTS.md` 当前状态表同步更新 Phase 3，避免后续代理继续把 RAR/7z 当占位。所有位置明确：仅单卷、密码仅会话内存、远程 ZIP/CBZ 流式优先、RAR/CBR/7z 先完整物化。

- [ ] **步骤 5：运行定向安全与格式测试**

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml commands::archive_access -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml media_protocol -- --nocapture
```

预期：所有 Archive、密码、安全、Range、Materializer 测试 PASS，0 failure。

- [ ] **步骤 6：运行前端全量**

```bash
npm test
npm run type-check
npm run build
```

预期：Vitest 0 failure、type-check 0 error、Vite build exit 0。

- [ ] **步骤 7：运行 Rust 全量与 portable 构建**

```bash
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
npm run tauri -- build --no-bundle
```

预期：Cargo 全量 0 failure；Windows portable 构建 exit 0，生成可启动 exe。

- [ ] **步骤 8：源码安全扫描与变更范围检查**

```bash
rg -n "password.*log|log.*password|password.*emit|emit.*password" src src-tauri/src
git diff --check
git status --short
```

预期：安全扫描没有记录/事件携带 Archive 密码的命中；diff check 无错误；状态中只有本计划文件范围内的预期改动。工作开始前已存在的用户改动必须保持归属，不得顺带提交。

- [ ] **步骤 9：更新设计状态并 Commit**

```bash
git add .github/workflows/verify.yml AGENTS.md DESIGN.md README.md BUILD.md src-tauri/src/lib.rs src-tauri/src/source/archive/service.rs
git commit -m "docs(archive): 完成五格式能力与分发说明"
```

- [ ] **步骤 10：提交前最终审查**

逐项对照规格 §13：本地五格式、五格式密码、WebDAV/SMB ZIP Range 首开、后台物化、本地切换、RAR/7z 完整物化、错误分类、多卷拒绝、密码零持久化、资源上限、catalog/password cache 不变量、清空 cache 不复活、pending 打开进度与取消竞态。任何缺项都回到对应任务补测试和最小实现，不能仅在验收报告中标注完成。

---

## 计划执行完成的证据清单

- 任务 2 的既有 ZIP contract 在重构前后均通过。
- ZIP/CBZ ZipCrypto、AES AE-1/AE-2 正确/错误密码有自动化证据。
- RAR4/RAR5 与 7z 普通/solid/加密有 fixture 或运行时生成测试证据。
- multi-disk ZIP、分卷 RAR、分卷 7z 返回专用错误。
- WebDAV/SMB mock 证明 ZIP 首请求为尾部 Range，未先整包下载。
- Range 失败证明自动降级完整物化；后台完成后证明新请求不再发 Range。
- RemoteRangeUnavailable/Network/Timeout 分别穿过真实 `RemoteZipReader -> ZipBackend` 的 entry payload `std::io::Error` 与 `ZipError::Io` 边界后仍保留类型并降级；Cancelled 明确不降级。
- `.part`、sidecar、断点续传、LRU、cache 清空和旧 `.zip` cache 行不回归。
- cache 清空由唯一全局 coordinator 在所有 cache lookup 前原子封锁准入；旧 block/materializer loader 不重插，ready cache hit 不穿透，catalog/block/磁盘/DAO 均保持为空，失败/timeout 后 RAII gate 可恢复。
- prepare Ready 不启动后台物化；前端提交导航后的 `commit_archive_open` 才启动，且 Ready `progressKey` 与后台事件一致。
- Materializer 同 key 的交互/后台 subscriber 具备独立取消、物理下载寿命与 per-request 进度 fan-out 证据。
- RAR 实际输出由 `unrar_sys` data callback 在硬上限处停止，不经高层完整 `Vec`；listing 限制与 callback 限制为独立测试。
- 已缓存的加密 catalog 在 password store 清除后不能返回 ready，必须重新要求密码。
- 单条目、catalog 数量、路径长度、7z dictionary 与进程级解压预算均有越界测试，且越界后服务继续可用。
- 远程 RAR/7z 候选物化期间有进度和取消 UI，迟到 prepare/event 不提交导航。
- 密码未进入 descriptor、DB、日志、事件、sidecar 与错误文本。
- `npm test`、type-check、frontend build、`cargo test`、`cargo build`、Tauri portable build 全部有新鲜输出。
