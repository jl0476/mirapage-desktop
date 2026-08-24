# RAR / CBR / 7z、全格式密码与远程 ZIP 流式读取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改变现有 Archive descriptor 和上层阅读链路的前提下，为 CBZ/ZIP/CBR/RAR/7z 增加全源、单卷、会话密码支持，并让远程 ZIP/CBZ 可以 Range 流式首开、后台完整物化和失败自动降级。

**架构：** 新增共享 `ArchiveService`，由 `ArchiveMediaSource` 与 session/prepare/unlock/commit/cancel IPC 共用；服务按格式分派 ZIP、RAR、7z backend，并持有会话密码库、目录 catalog LRU、远程 ZIP block LRU、结构化请求状态机和现有 Materializer。Archive runtime 与 Materializer 的 cache hit、loader 和清空统一经过单一 `ArchiveCacheCoordinator` 原子准入。ZIP backend 接受本地文件或 `Read+Seek` reader factory；RAR 通过 `unrar_sys` data callback 在解压过程中执行硬上限；7z 只接受本地路径。远程 ZIP 先通过 `RemoteZipReader` 读取，RAR/7z 继续完整物化。`prepare/unlock` 只产生 Prepared，前端原子提交导航后调用 `commit_archive_open` 才启动可选后台物化。

**技术栈：** Rust 1.75、Tauri 2、Tokio、`zip 2.4.2`、`unrar 0.5.8`、`unrar_sys 0.5.8`、`sevenz-rust 0.6.1`、`zeroize 1.x`、Vue 3、Pinia、Vitest。

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
- 创建：`src-tauri/tests/fixtures/archive/multipart.part1.rar`
- 创建：`src-tauri/tests/fixtures/archive/password-zipcrypto.zip`
- 创建：`src-tauri/tests/fixtures/archive/password-ae1.zip`
- 创建：`src-tauri/tests/fixtures/archive/password-ae2.zip`
- 创建：`src-tauri/tests/fixtures/archive/multidisk.zip`
- 创建：`src-tauri/tests/fixtures/archive/generate.py`
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
unrar = "=0.5.8"
unrar_sys = "=0.5.8" # 直接使用 UnRAR data callback；与 unrar 0.5.8 锁为同版
sevenz-rust = { version = "=0.6.1", features = ["aes256"] }
zeroize = "1"
```

运行：

```bash
cargo update --manifest-path src-tauri/Cargo.toml -p zip --precise 2.4.2
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：依赖解析完成，`Cargo.lock` 出现 `unrar 0.5.8`、`unrar_sys 0.5.8`、`sevenz-rust 0.6.1`，ZIP 保持 2.4.2。

- [ ] **步骤 3：添加最小 RAR/ZIP fixtures 与说明**

`src-tauri/tests/fixtures/archive/README.md` 必须说明九个 fixture 的格式、密码、内容、生成工具和生成日期。`requirements.txt` 是由 `pip-compile --generate-hashes` 生成的完整锁文件，直接依赖固定 `pyzipper==0.4.0`，传递依赖也必须固定版本与哈希。职责固定如下：`generate.py` 生成确定性 PNG/padding 输入、AE-1、AE-2 与 `multidisk.zip`，并解析 local/central AES extra field，断言 vendor version 分别为 1/2、AE-2 CRC 为 0；同一脚本通过显式参数调用已安装的 7-Zip 24.09 生成 ZipCrypto，并验证工具版本和产物可解密。RAR 五个产物由 README 中固定的 WinRAR 7.11 PowerShell 命令生成，脚本只负责生成其输入并在 `--verify` 时校验产物存在、内容与元数据。生成文件后，只对下列九个 archive fixture 取 SHA-256；不得把 README、脚本、输入图片或额外分卷混入清单。README 中不得出现示例哈希、空单元格或待补文字。

固定元数据如下：`plain-rar4.rar`（RAR4 单卷、无密码、`page1.png/page2.png`）、`password-rar4.rar`（RAR4 单卷、密码 `test-pass-中文`、`page1.png`）、`plain-rar5.rar`（RAR5 单卷、无密码、`page1.png/page2.png`）、`password-rar5.rar`（RAR5 单卷、密码 `test-pass-中文`、`page1.png`）、`multipart.part1.rar`（RAR5 分卷、无密码、`page1.png`，另含非图片 `padding.bin` 只用于强制分卷）。`generate.py` 固定生成 4096 bytes 的确定性 `padding.bin`；所有输入均为脚本生成，不含第三方版权内容。RAR 生成工具固定为 WinRAR CLI 7.11，并在 README 原样记录以下命令及 `rar.exe` 的绝对版本输出：

```powershell
rar.exe a -idq -ma4 plain-rar4.rar page1.png page2.png
rar.exe a -idq -ma4 -ptest-pass-中文 password-rar4.rar page1.png
rar.exe a -idq -ma5 plain-rar5.rar page1.png page2.png
rar.exe a -idq -ma5 -ptest-pass-中文 password-rar5.rar page1.png
rar.exe a -idq -ma5 -m0 -v1k multipart.rar page1.png padding.bin
```

ZIP 固定元数据：`password-zipcrypto.zip`、`password-ae1.zip`、`password-ae2.zip` 均包含同一个 `page1.png`，密码 `test-pass-中文`。ZipCrypto 固定用 7-Zip 24.09：`7z.exe a -tzip -mem=ZipCrypto -ptest-pass-中文 password-zipcrypto.zip page1.png`。AE-1/AE-2 固定用 Python 3.12 + `pyzipper==0.4.0`，`generate.py` 分别调用 `AESZipFile(..., encryption=pyzipper.WZ_AES, encryption_kwargs={"nbits": 256, "force_wz_aes_version": 1})` 与 version 2；不得依赖库的自动选择。`multidisk.zip` 由同一脚本手写最小 EOCD/ZIP64 disk 字段非零结构且不包含相邻分盘文件。README 必须记录 `python --version`、`pip show pyzipper`、`7z i`、完整命令与脚本提交哈希。

生成完成后运行：

```powershell
python -m pip install pip-tools==7.4.1
python -m piptools compile --generate-hashes --resolver=backtracking --output-file src-tauri/tests/fixtures/archive/requirements.txt src-tauri/tests/fixtures/archive/requirements.in
python -m pip install --require-hashes -r src-tauri/tests/fixtures/archive/requirements.txt
python src-tauri/tests/fixtures/archive/generate.py --verify
$fixtures = @('plain-rar4.rar','password-rar4.rar','plain-rar5.rar','password-rar5.rar','multipart.part1.rar','password-zipcrypto.zip','password-ae1.zip','password-ae2.zip','multidisk.zip')
$hashes = $fixtures | ForEach-Object { Get-FileHash -LiteralPath (Join-Path 'src-tauri/tests/fixtures/archive' $_) -Algorithm SHA256 }
if ($hashes.Count -ne 9) { throw "expected exactly 9 fixture hashes" }
$hashes
```

预期：九个文件均输出 64 位 SHA-256，README 与实际值一致。

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
    pub first_encrypted_entry: Option<String>,
}

pub trait ArchiveBackend: Send + Sync {
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
```

同文件增加 `LimitedEntryWriter`，内部累计实际输出字节；写入会超过 `MAX_ENTRY_BYTES` 时返回携带专用 marker 的 `std::io::Error`，backend 在边界恢复为 `ResourceLimitExceeded`。任何 backend 都不得按 archive 声明的解压大小直接无界预分配。

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
fn encrypted_zip_requires_password_rejects_wrong_and_reads_correct() {
    for fixture in ["password-zipcrypto.zip", "password-ae1.zip", "password-ae2.zip"] {
        let input = fixture_input(fixture);
        assert_eq!(ZipBackend.catalog(&input, "", None).unwrap_err(),
                   ArchiveAccessError::PasswordRequired);
        assert_eq!(ZipBackend.read_entry(&input, "page1.png", Some(b"wrong")).unwrap_err(),
                   ArchiveAccessError::WrongPassword);
        assert_eq!(ZipBackend.read_entry(
            &input, "page1.png", Some("test-pass-中文".as_bytes())
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
    let declared = zip_with_declared_size(MAX_ENTRY_BYTES + 1);
    assert!(matches!(ZipBackend.read_entry(&declared, "page.png", None),
                     Err(ArchiveAccessError::ResourceLimitExceeded(_))));
    let mut writer = LimitedEntryWriter::with_limit(8);
    assert!(writer.write_all(&[0; 9]).is_err());
    assert!(writer.exceeded());
}

#[test]
fn zip_io_mapping_preserves_remote_limit_crc_and_plain_io_classes() {
    assert!(matches!(map_zip_io_error(remote_io(ArchiveAccessError::Timeout("slow".into()))),
                     ArchiveAccessError::Timeout(_)));
    assert!(matches!(map_zip_io_error(limited_entry_io()),
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

`map_zip_error` 必须把 invalid password、unsupported compression、missing file、invalid archive 分别映射到 `WrongPassword`、`UnsupportedCodec`、`EntryNotFound`、`CorruptArchive`。使用任务 2 已定义的 `RemoteZipIoError` 与 `LimitedEntryIoError` 两个可 downcast marker，建立唯一 `map_zip_io_error(std::io::Error) -> ArchiveAccessError`；映射顺序固定为：Remote marker 恢复稳定分类 → Limited marker 映射 `ResourceLimitExceeded` → `ErrorKind::InvalidData` 映射 `CorruptArchive`（CRC/MAC）→ 普通 `Io`。`map_zip_error(ZipError::Io(io))` 委托该 helper。helper 和所有调用点必须在本任务建立，不能把 entry payload 的 IO 扁平化为字符串；任务 9 只负责让 `RemoteZipReader` 实际产生 Remote wrapper。

在调用 `zip::ZipArchive::new` 前用小型 EOCD/ZIP64 parser 检查 disk number、central-directory start disk 与 per-disk entry count；任一字段表明 multi-disk 时直接返回 `MultiVolumeUnsupported`，不得解析第三方错误字符串。

- [ ] **步骤 4：实现 catalog/read/stat**

`catalog` 遍历 central directory，应用 `entryPrefix`、`is_image` 和自然排序；每加入一项检查 `MAX_CATALOG_ENTRIES` 与规范化路径的 `MAX_ENTRY_PATH_BYTES`。加密条目在无密码时仍返回 `PasswordRequired`，有密码时通过 `LimitedEntryWriter` 完整读取第一个加密图片并校验 CRC/MAC。`read_entry` 同样经 `LimitedEntryWriter` 解压目标条目；`stat_entry` 读取 central directory 的解压后 size，若超过上限直接返回 `ResourceLimitExceeded`。所有 `Read::read`、`read_to_end`、`io::copy`、完整性验证及限长 writer 返回的 `std::io::Error` 都必须 `.map_err(map_zip_io_error)`，不能只处理 `ZipError::Io`。

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
        assert_eq!(RarBackend.read_entry(&input, "page1.png", None).unwrap(), PNG_BYTES);
    }
    for name in ["password-rar4.rar", "password-rar5.rar"] {
        let input = fixture_input(name);
        assert_eq!(RarBackend.catalog(&input, "", None).unwrap_err(),
                   ArchiveAccessError::PasswordRequired);
        assert_eq!(RarBackend.read_entry(&input, "page1.png", Some(b"wrong")).unwrap_err(),
                   ArchiveAccessError::WrongPassword);
        assert_eq!(RarBackend.read_entry(
            &input, "page1.png", Some("test-pass-中文".as_bytes())
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
    let backend = RarBackend::with_limits(ArchiveLimits::for_test(8));
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
    assert_eq!(feed_callback_for_test(&mut sink, b"123456789".as_ptr(), 9),
               CallbackControl::Abort);
    assert!(sink.bytes_seen() <= 9);
}

#[test]
fn rar_data_callback_aborts_real_ffi_output_at_hard_limit_and_recovers() {
    // 仅跳过 catalog 声明大小的测试短路，仍使用生产 read_entry -> unrar_sys callback 路径。
    let backend = RarBackend::with_test_policy(ArchiveLimits::for_test(8),
                                               DeclaredSizePolicy::BypassForFfiTest);
    let targets_before = snapshot_rar_write_targets(&backend);
    assert!(matches!(backend.read_entry(
        &fixture_input("plain-rar5.rar"), "page1.png", None
    ), Err(ArchiveAccessError::ResourceLimitExceeded(_))));
    assert_eq!(snapshot_rar_write_targets(&backend), targets_before); // cwd + cache 均无 entry
    assert_eq!(RarBackend::default().read_entry(
        &fixture_input("plain-rar5.rar"), "page1.png", None
    ).unwrap(), PNG_BYTES);
}

#[test]
fn encrypted_header_password_callback_is_registered_before_open() {
    let input = fixture_input("encrypted-headers-rar5.rar");
    assert_eq!(RarBackend::default().read_entry(
        &input, "page1.png", Some("test-pass-中文".as_bytes())
    ).unwrap(), PNG_BYTES);
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

- [ ] **步骤 4：实现 UnRAR catalog 与低层 callback read/stat**

catalog 可使用 `unrar::Archive::new(path)` 或 `Archive::with_password(path, password)`；listing 读取 entry filename、unpacked_size 和 split/volume flag，确认 split 后立即返回 `MultiVolumeUnsupported`。读取 entry 不得调用高层 `unrar::read()`，因为它在调用方检查之前已经返回完整 `Vec`。`rar_callback.rs` 固定使用 `unrar_sys = 0.5.8`：先构造包含 callback、user-data 的 `OpenArchiveDataEx`，再调用 `RAROpenArchiveEx`；不能依赖 open 成功后才调用 `RARSetCallback`，否则加密 header 在 open 阶段请求密码时没有 callback。随后按 `read_header → 命中项 RAR_TEST / 其他项 RAR_SKIP` 顺序前进；禁止使用 `RAR_EXTRACT`，整个读取过程不得向当前工作目录或 cache 目录写出 entry。命中目标时 callback 每次只复制剩余预算，累计达到 `limit + 1` 立即返回 UnRAR abort code。

callback user-data 只指向当前同步调用期间有效的 `RarCallbackState { sink: Option<LimitedRarSink>, password: Option<Zeroizing<Vec<u8>>>, error: Option<ArchiveAccessError> }`；同一 state 同时服务 open 阶段的 header 密码、处理阶段的数据输出和类型化错误桥。关闭 handle 与清理 callback state 覆盖所有错误路径。处理 `UCM_PROCESSDATA` 时先检查 `p1 != 0 && p2 > 0`，满足后才构造 slice；volume/password 分支同样检查空指针、对齐和长度，单卷策略遇到请求下一卷直接终止。`extern "C"` callback 整体包在 `catch_unwind(AssertUnwindSafe(...))` 中，panic 写入 state.error 并转 abort，绝不跨 ABI unwind。保留无 FFI 的 callback 单元测试覆盖 null/zero-length 和预算算法，但资源上限与 header 密码合同必须穿过真实 `RAROpenArchiveEx -> callback -> RARProcessFile(RAR_TEST)` 集成路径。

`catalog` 返回过滤后的图片与 `first_encrypted_entry`；`read_entry`、`stat_entry` 与 ZIP 保持同一语义。所有 entry path 先把 `\` 归一为 `/`，再应用 prefix。

RAR listing 同样执行 catalog 数量、路径长度和 `unpacked_size` 上限检查。`RarBackend` 接受生产默认值为 512 MiB 的 `ArchiveLimits`，测试构造函数可注入 8 bytes 上限。合法 `plain-rar5.rar` + 8-byte limit 负责声明值分支；另一个仅限测试的 `DeclaredSizePolicy::BypassForFfiTest` 绕过这一个前置短路，让同一合法 fixture 的真实输出达到 callback 并映射为 `ResourceLimitExceeded`。测试同时断言工作目录/cache 快照不变、abort 后下一次正常 RAR 请求成功；不得修改 fixture header 或只测纯 `feed_callback_for_test` 来替代 FFI 合同。

- [ ] **步骤 5：运行 RAR 测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::rar_ -- --nocapture
```

预期：RAR4/RAR5、正确/错误密码、加密 header 的 pre-open password callback、多卷拒绝、listing 声明限制、真实 FFI callback 实际输出硬停止、无文件写出与 abort 后恢复全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src-tauri/src/source/archive/rar_backend.rs src-tauri/src/source/archive/rar_callback.rs src-tauri/src/source/archive/mod.rs
git commit -m "feat(archive): 支持单卷 RAR/CBR 与会话密码"
```

---

### 任务 6：7z 普通/solid、密码与单卷 backend

**文件：**
- 创建：`src-tauri/src/source/archive/sevenz_backend.rs`
- 修改：`src-tauri/src/source/archive/mod.rs`

- [ ] **步骤 1：写运行时生成 fixture 的失败测试**

```rust
#[test]
fn sevenz_plain_solid_and_encrypted_contract() {
    let plain = create_7z(false, None);
    let solid = create_7z(true, None);
    let encrypted = create_7z(true, Some("test-pass-中文"));
    for path in [plain, solid] {
        let input = ArchiveInput::Path(path);
        let catalog = SevenZBackend.catalog(&input, "", None).unwrap();
        assert_eq!(catalog.entries.len(), 2);
        assert_eq!(SevenZBackend.read_entry(&input, "page1.png", None).unwrap(), PNG_BYTES);
    }
    let encrypted_input = ArchiveInput::Path(encrypted);
    assert_eq!(SevenZBackend.catalog(&encrypted_input, "", None).unwrap_err(),
               ArchiveAccessError::PasswordRequired);
    assert_eq!(SevenZBackend.read_entry(
        &encrypted_input, "page1.png", Some(b"wrong")
    ).unwrap_err(), ArchiveAccessError::WrongPassword);
    assert_eq!(SevenZBackend.read_entry(
        &encrypted_input, "page1.png", Some("test-pass-中文".as_bytes())
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
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::sevenz_backend
```

预期：FAIL，模块不存在。

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

将 `PasswordRequired`、错误 AES 密码、checksum、unsupported method、missing entry 分别映射到稳定错误。

`archive().files` 建 catalog 时检查数量、路径长度与 entry size；`for_each_entries` 读取命中项时通过 `LimitedEntryWriter`/限长 read loop 约束实际输出。`Error::MaxMemLimited` 以及 dictionary/coder 内存超过 512 MiB 映射为 `ResourceLimitExceeded`。用 test-only 8-byte limit 驱动 writer 越界单测，避免生成 512 MiB fixture。

- [ ] **步骤 4：运行 7z 测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::sevenz_backend -- --nocapture
```

预期：普通、solid、加密、错误密码、分卷拒绝全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/source/archive/sevenz_backend.rs src-tauri/src/source/archive/mod.rs
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

`ArchiveRequestId`、单窗口 session registry 和 `begin_session/prepare_with_request/unlock_with_request/commit_request/cancel_request` 的核心状态机在本任务落地，任务 11 只增加 Tauri/TS IPC 外壳；这样任务 8 的 Materializer subscriber 与任务 10 的 commit-gated prefetch 不会反向依赖后置任务。状态机初版支持本地与完整物化的 Running/AwaitingPassword/Prepared/Cancelled、cancel-before-register、精确幂等 commit 和 session rollover；任务 10 只给 Prepared 增加 streaming prefetch intent。

`ArchiveService` 在本任务就必须持有工厂构造的同一个 `Arc<Materializer>`，不能等远程流式任务才补；在任务 10 接入 `RemoteZipReader` 前，远程 ZIP/CBZ 继续沿用完整物化，确保 `ArchiveMediaSource` 变为 service-only 后既有远程行为不断档。Service 同时持 `Arc<ZipBackend/RarBackend/SevenZBackend>`、`ArchivePasswordStore`、三个格式 semaphore、512 个 1-MiB permit 的加权内存 semaphore、32 项 catalog LRU 和唯一 `Arc<ArchiveCacheCoordinator>`；任务 9 创建 `remote_zip.rs` 后把 block LRU 接入同一 coordinator。Local Ready 的 `progress_key=None`，远程物化/流式 Ready 返回 Materializer 的 opaque cache key。

`ArchiveCacheCoordinator` 使用 `std::sync::Mutex<State>`，state 包含 `clearing`、单调 `generation`、active admission 计数和 `tokio::sync::Notify`。`admit()` 在同一短临界区检查 clearing 并增加 active，返回同步 Drop 的 `AdmissionGuard`；Drop 同步减计数并 notify。`begin_clear()` 原子置 clearing、推进 generation 并返回同步 Drop 的 `ClearGuard`；`wait_drained(timeout)` 是独立 async 方法。所有 catalog、后续 block、Materializer ready cache hit 与下载都必须先 admission，再查 cache；禁止两个串行 gate 和 async Drop。Local identity 使用规范化绝对路径 + `std::fs::metadata` size/mtime。测试构造函数允许注入较小内存预算。

- [ ] **步骤 4：实现 prepare/unlock/list/read/stat**

`prepare` 先取 catalog metadata；若 catalog 标记存在加密条目但同 identity password store 为空，必须返回 `PasswordRequired`，cache hit 不能替代密码证明。遇到 `PasswordRequired/WrongPassword` 时同时清除旧密码和对应 catalog。`unlock` 使用 `Zeroizing<Vec<u8>>`，完整验证首个加密条目后才写 store。`list/read/stat` 按格式取得 backend semaphore，再按声明大小的 MiB 向上取整取得加权内存许可（未知或超过上限按 512 permits）；随后在 `spawn_blocking` 中执行。join panic 映射 `CorruptArchive("backend task panicked")`，两类许可都由 RAII 释放。

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
    for rel in ["a.cbz", "b.zip", "c.cbr", "d.rar", "e.7z"] {
        let (m, dir, _) = temp_materializer(Arc::new(MockOrigin::new(10)));
        let path = m.ensure_cached(&webdav(""), rel).await.unwrap();
        assert_eq!(path.extension().and_then(|v| v.to_str()),
                   std::path::Path::new(rel).extension().and_then(|v| v.to_str()));
        assert!(path.starts_with(dir.path()));
    }
}

#[tokio::test]
async fn legacy_zip_row_keeps_its_recorded_cache_path() {
    let harness = legacy_ready_row("legacy.cbz", "abc.zip", 10);
    let path = harness.materializer.ensure_cached(&harness.origin, "legacy.cbz").await.unwrap();
    assert_eq!(path, harness.cache_root.join("abc.zip"));
    assert_eq!(harness.origin.read_calls.load(Ordering::SeqCst), 0);
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
    let background = with_background.attach_background();
    with_background.cancel(&request).await;
    assert!(matches!(interactive.await.unwrap(), Err(MaterializeError::Cancelled)));
    assert!(!with_background.physical_cancelled());
    with_background.release_download();
    background.await.unwrap().unwrap();

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

预期：五格式测试因现有闸门失败；subscriber 生命周期/进度 fan-out 尚未实现而失败，其中 A/B 都先收到基线事件，取消 A 后 A 的事件数不再增长而 B 继续增长并完成；旧 ZIP 命中保持 PASS。

- [ ] **步骤 3：实现扩展归一与 final path**

```rust
fn archive_extension(rel: &str) -> Result<&'static str, MaterializeError> {
    match ArchiveFormat::from_extension(
        Path::new(rel).extension().and_then(|v| v.to_str()).unwrap_or("")
    ) {
        Some(ArchiveFormat::Cbz) => Ok("cbz"),
        Some(ArchiveFormat::Zip) => Ok("zip"),
        Some(ArchiveFormat::Cbr) => Ok("cbr"),
        Some(ArchiveFormat::Rar) => Ok("rar"),
        Some(ArchiveFormat::SevenZ) => Ok("7z"),
        None => Err(MaterializeError::Other(format!("不支持的 archive 格式: {rel}"))),
    }
}

fn cache_paths(&self, key: &str, ext: &str) -> (PathBuf, PathBuf) {
    let root = self.cache_root.read().unwrap().clone();
    (root.join(format!("{key}.{ext}")), root.join("part").join(format!("{key}.part")))
}
```

DAO 命中始终优先使用行内 `cache_abs_path`，因此旧 `{key}.zip` 不改名、不 migration。

Materializer 的 `ensure_cached`、`ready_path_if_fresh`、subscriber attach 和物理下载都注入任务 7 的同一个 `ArchiveCacheCoordinator`，并在 DAO/磁盘 cache lookup 之前取得 admission guard。in-flight state 区分 `interactive: HashMap<ArchiveRequestId, Subscriber>` 与 `background: HashMap<BackgroundSubscriberId, BackgroundSubscriber { progress_key }>`；每个交互 subscriber 独立完成/取消 channel，进度向活动 requestId 分别 fan-out，后台事件从 subscriber 自身保存的 `progress_key` 发出。只有 interactive 与 background 都为空才取消物理下载。把现有直接构造 `serde_json::json!` 的进度 helper 改为 serde camelCase 的类型化 `ArchiveMaterializeProgress { request_id: Option<ArchiveRequestId>, progress_key: String, ... }` 后统一 emit，避免不同分支漏字段。另加一个 ready row + final file 已存在的测试：clear guard 存活时 `ready_path_if_fresh` 必须返回 Cancelled，证明 cache hit 未绕过 gate。

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
        return Err(MaterializeError::Other(format!(
            "Range 长度不符: offset={offset} expected={length} actual={}", bytes.len()
        )));
    }
    Ok(bytes)
}
```

- [ ] **步骤 4：实现固定块缓存**

`remote_zip.rs` 常量：

```rust
pub const BLOCK_SIZE: usize = 1024 * 1024;
pub const BLOCK_CACHE_BYTES: usize = 32 * 1024 * 1024;
```

`RangeBlockCache` 使用 `Mutex<State> + Condvar`；`State` 包含 `HashMap<BlockKey, Arc<Vec<u8>>>`、`VecDeque<BlockKey>` 和 `HashSet<BlockKey>` loading。`get_or_load` 对相同 key 只允许一个 loader，其他线程等待 Condvar；用 RAII loading guard 保证成功、失败或 unwind 都移除 loading 并 `notify_all`。进入 `get_or_load` 时必须先从唯一 `ArchiveCacheCoordinator` 取得 admission guard，使 cache hit 与 miss 都受 clear gate 约束；每个 loader 捕获 guard generation，插入前发现 generation 已变化则丢弃 bytes 并返回 `Cancelled`。插入后按 LRU 淘汰到 32 个满块以内，cache hit 必须更新顺序。

- [ ] **步骤 5：实现 Read+Seek**

`RemoteZipReader` 保存 `position/size/identity/origin/cache/runtime/generation`。`Seek` 对 Start/Current/End 使用 `i128` 计算并拒绝负数/超过 u64；`Read` 按 block 拆分，最后一块请求 `min(BLOCK_SIZE, size-block_start)`。loader 只能在 `spawn_blocking` 线程中用 `runtime.block_on(origin.read_range(...))`。

使用任务 2 已定义的 `RemoteZipIoError(ArchiveAccessError)` 与 `LimitedEntryIoError` marker；Range/Network/Timeout/Cancelled 通过 `std::io::Error::new(ErrorKind::Other, RemoteZipIoError(err))` 返回。`zip_backend::map_zip_io_error` 的顺序固定为：downcast Remote marker → downcast limit marker 为 `ResourceLimitExceeded` → `ErrorKind::InvalidData` 为 `CorruptArchive`（CRC/MAC）→ 普通 `Io`；`map_zip_error(ZipError::Io)` 委托该 helper。分别写四个映射单测。新增第二个真实边界测试：先成功 catalog，再让首个 entry payload block 返回 Network，断言 `read_entry` 恢复为 `ArchiveAccessError::Network` 并由 Service 自动降级物化；同路径用 Timeout 也降级、Cancelled 不降级。不得按错误文本判断，也不得只测 ZIP open/catalog 阶段。

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
    assert!(matches!(harness.try_ready_cache_hit().await, Err(ArchiveAccessError::Cancelled)));
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
    harness.service.begin_session(session_id).unwrap();
    let request_id = ArchiveRequestId::new(session_id, 1);
    let ready = harness.service.prepare_with_request(
        &harness.descriptor, request_id.clone()
    ).await.unwrap();
    let progress_key = ready.progress_key().unwrap().to_owned();
    assert_eq!(harness.prefetch_start_count(), 0);
    harness.service.commit_request(&request_id).await.unwrap();
    harness.wait_background_ready().await;
    assert!(harness.background_events().iter()
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
    harness.service.begin_session(session_id).unwrap();
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
    harness.service.begin_session(session_id).unwrap();
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
    harness.service.begin_session(session_id).unwrap();
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
    harness.service.begin_session(session_id).unwrap();
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
    harness.begin_session(session_id).unwrap();
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
    harness.begin_session("550e8400-e29b-41d4-a716-446655440000").unwrap();
    let old = ArchiveRequestId::new("550e8400-e29b-41d4-a716-446655440000", 1);
    let opening = harness.spawn_prepare(old.clone());
    harness.wait_download_started().await;
    harness.begin_session("550e8400-e29b-41d4-a716-446655440001").unwrap();
    assert_eq!(opening.await.unwrap().unwrap_err(), ArchiveAccessError::Cancelled);
    assert!(!harness.service.has_session(old.session_id()));
    assert_eq!(harness.service.commit_request(&old).await.unwrap_err(),
               ArchiveAccessError::Cancelled);
}

#[test]
fn begin_session_rejects_non_uuid_or_oversized_ids() {
    let harness = CommandHarness::local_zip();
    assert!(matches!(harness.service.begin_session("session-a"),
                     Err(ArchiveAccessError::InvalidRequest(_))));
    assert!(matches!(harness.service.begin_session(&"a".repeat(65)),
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

复用任务 7 已定义的 `ArchiveRequestId` 与 request registry，并在这里锁定 IPC 可见合同：`RequestState::{Running, AwaitingPassword, Prepared { progress_key, prefetch }, Cancelled}`。应用是单主窗口模型，registry 只接受一个 `current_session`：`begin_archive_session(sessionId)` 校验 UUID 文本且长度不超过 64 bytes，无效值返回 `InvalidRequest`；同 id 重试幂等，不同 id 表示 WebView reload/HMR rollover，在同一 mutex 内取消旧 active、清除旧 `cancelled_through/last_committed` 后安装新 session。此后旧 session 的迟到 prepare/unlock/commit 返回 `Cancelled`，迟到 cancel 幂等 no-op，因此进程存活期间空间仍为常数，不随 reload 累积。

当前 session 只保存单调 `cancelled_through`、精确 `last_committed: Option<u64>` 与 `active: Option<(sequence, RequestState)>`。cancel N 在同一 mutex 内推进取消高水位，并在 active.sequence <= N 时取消该未 commit 项；register 若 `sequence <= cancelled_through` 立即返回 `Cancelled`，若 sequence 更大则原子取消/替换旧 active，保证每个 session 恰有零或一个 active request。commit 只接受 Prepared active；成功后把它的精确 sequence 写入 `last_committed` 并移除 active。只有 `sequence == last_committed` 的重试返回成功且不重复预载，不能用 `<=` 把未实际提交的稀疏 sequence 误判成功。cancel 已提交 id 为 no-op，其他旧 id 均返回 `Cancelled`。

`prepare_with_request`/`unlock_with_request` 在取得全局 cache admission、格式 semaphore、每个 Range/下载 chunk、远端二次 stat 后、同步 backend 返回后以及 catalog/block/password/DAO/rename 提交前检查 flag。Ready 只把 registry 转到 Prepared 并返回 opaque `progress_key`，不调用 `prefetch_opened`。`commit_request` 幂等执行 Prepared -> Committed，届时才注册后台 subscriber；cancel Prepared 必须丢弃预载意图。Materializer in-flight 项维护 request subscriber：取消单个 subscriber 立即让对应 command 返回 `Cancelled`，只有最后一个交互 subscriber 取消且没有 committed 后台 subscriber 时才推进物理下载取消标志。`ArchiveMaterializeProgress` 增加 `request_id: Option<ArchiveRequestId>` 与 `progress_key: String` 并继续 serde camelCase；共享下载向每个活动交互 subscriber 各 emit 一份带其 request id 的事件，后台事件 `requestId=null`。

在 Materializer tests 锁定四个 subscriber 合同：A/B 同 key 取消 A 后 B 完成；interactive + background 时取消 interactive 后物理下载继续；全部 interactive 取消且无 background 时物理下载终止且无 final/DAO；共享进度分别 fan-out 到 A/B 自己的 requestId。测试还断言 cache hit 路径也先取得全局 admission。

```rust
#[tauri::command]
pub fn begin_archive_session(
    service: tauri::State<'_, Arc<ArchiveService>>,
    session_id: String,
) -> Result<(), ArchiveAccessError> {
    service.begin_session(&session_id)
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
  await beginArchiveSession(sessionId);
  expect(invoke).toHaveBeenCalledWith('begin_archive_session', { sessionId });
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

export function beginArchiveSession(sessionId: string): Promise<void> {
  return invoke<void>('begin_archive_session', { sessionId });
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
beginArchiveSession: vi.fn(async () => undefined),
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
  const oldId = fb.pendingArchiveOpen!.requestId;
  fb.cancelArchiveOpen();
  void fb.openArchive(makeEntry('book.cbr', { isArchive: true }));
  const newId = fb.pendingArchiveOpen!.requestId;
  expect(newId).not.toBe(oldId);
  emitArchiveProgress({ requestId: oldId, progressKey: 'old-key', relPath: 'comics/book.cbr', downloaded: 8, totalBytes: 10, phase: 'downloading' });
  expect(fb.archiveProgress).toBeNull();
  emitArchiveProgress({ requestId: newId, progressKey: 'new-key', relPath: 'comics/book.cbr', downloaded: 2, totalBytes: 10, phase: 'downloading' });
  expect(fb.archiveProgress).toEqual({ downloaded: 2, total: 10 });
});

it('新 open 自动取消旧 Prepared，再注册唯一的新 request', async () => {
  const fb = useFileBrowserStore();
  const first = deferred<ArchivePrepareResult>();
  vi.mocked(prepareArchive)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce({ status: 'ready', accessMode: 'local', progressKey: null });
  const openingOld = fb.openArchive(makeEntry('old.cbz', { isArchive: true }));
  await vi.waitFor(() => expect(fb.pendingArchiveOpen).not.toBeNull());
  const oldId = fb.pendingArchiveOpen!.requestId;
  await fb.openArchive(makeEntry('new.cbz', { isArchive: true }));
  expect(cancelArchivePrepare).toHaveBeenCalledWith(oldId);
  expect(vi.mocked(cancelArchivePrepare).mock.invocationCallOrder[0])
    .toBeLessThan(vi.mocked(prepareArchive).mock.invocationCallOrder[1]);
  first.resolve({ status: 'ready', accessMode: 'local', progressKey: null });
  await openingOld;
  expect(fb.currentDescriptor).toMatchObject({ archivePath: expect.stringContaining('new.cbz') });
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

it('commit 永久失败时保留导航但取消 Prepared，后台 key 仍只认 Ready 值', async () => {
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
  emitArchiveProgress({ requestId: null, progressKey: 'client-derived-wrong', relPath: 'book.cbz', downloaded: 8, totalBytes: 10, phase: 'downloading' });
  expect(fb.archiveProgress).toBeNull();
  emitArchiveProgress({ requestId: null, progressKey: 'server-key-42', relPath: 'book.cbz', downloaded: 9, totalBytes: 10, phase: 'downloading' });
  expect(fb.archiveProgress).toEqual({ downloaded: 9, total: 10 });
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
const archiveSessionId = crypto.randomUUID();
let archiveRequestSequence = 0;
let archiveSessionReady: Promise<void> | null = null;

async function ensureArchiveSession(): Promise<void> {
  archiveSessionReady ??= beginArchiveSession(archiveSessionId).catch((cause) => {
    archiveSessionReady = null; // 初始化 IPC 恢复后允许下一次 open 重试
    throw cause;
  });
  await archiveSessionReady;
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
  await ensureArchiveSession();
  if (epoch !== archiveOpenEpoch) return;
  const requestId: ArchiveRequestId = {
    sessionId: archiveSessionId,
    sequence: ++archiveRequestSequence,
  };
  const candidate = { ...buildArchiveCandidate(entry), epoch, requestId };
  pendingArchiveOpen.value = candidate;
  archiveOpening.value = true;
  try {
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
    if (backoffMs[attempt] > 0) await delay(backoffMs[attempt]);
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
  }
}
```

`normalizeArchiveAccessError` 只接受 IPC 结构化 `kind/message` 并把未知值收敛为 `{ kind: 'io' }`，不得解析错误字符串。`submitArchivePassword` 调用 `unlockArchive(candidate.descriptor, password, candidate.requestId)` 并捕获 candidate epoch；成功回包只有 epoch 仍为当前值时才 `commitArchive(..., result.progressKey)`，随后调用同一个 `commitArchiveOpenWithCleanup` 再 fetch；`wrongPassword` 继续向弹窗抛出且不清 pending，其他错误写 `archiveOpenError`。`cancelArchivePassword` 与新的 `cancelArchiveOpen` 都先保存 candidate requestId、推进 `archiveOpenEpoch`、清 pending/opening/progress，再 best-effort 调用 `cancelArchivePrepare(requestId)`；cancel IPC rejection 必须被捕获，不能产生 unhandled promise。`exitArchive` 同样取消 pending 或 `archiveCommitPendingId`，并清 `archiveAccessMode/archiveProgressKey`。commit 最多以同一 id 尝试 3 次；暂时失败后成功依赖后端精确幂等保证只启动一次预载，永久失败则 best-effort cancel Prepared，避免 request 泄漏。新增测试锁定瞬时失败、永久失败以及新 open 在注册新请求前取消旧 Prepared；导航一旦本地提交便不因 commit IPC 失败回滚。

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
