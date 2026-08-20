# RAR / CBR / 7z、全格式密码与远程 ZIP 流式读取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改变现有 Archive descriptor 和上层阅读链路的前提下，为 CBZ/ZIP/CBR/RAR/7z 增加全源、单卷、会话密码支持，并让远程 ZIP/CBZ 可以 Range 流式首开、后台完整物化和失败自动降级。

**架构：** 新增共享 `ArchiveService`，由 `ArchiveMediaSource` 与 prepare/unlock IPC 共用；服务按格式分派 ZIP、RAR、7z backend，并持有会话密码库、目录 catalog LRU、远程 ZIP block LRU 和现有 Materializer。ZIP backend 接受本地文件或 `Read+Seek` reader factory，RAR/7z 只接受本地路径；远程 ZIP 先通过 `RemoteZipReader` 读取，RAR/7z 继续完整物化。

**技术栈：** Rust 1.75、Tauri 2、Tokio、`zip 2.4.2`、`unrar 0.5.8`、`sevenz-rust 0.6.1`、`zeroize 1.x`、Vue 3、Pinia、Vitest。

**规格：** `docs/superpowers/specs/2026-08-20-archive-rar-7z-password-streaming-design.md`

---

## 文件结构与职责

### 新建

- `src-tauri/src/source/archive/backend.rs`：统一 catalog、输入源、backend trait、类型化 Archive 错误和格式分派。
- `src-tauri/src/source/archive/password.rs`：archive identity、会话密码库、清零语义。
- `src-tauri/src/source/archive/zip_backend.rs`：本地/远程 ZIP、ZipCrypto/AES、catalog/read/stat。
- `src-tauri/src/source/archive/rar_backend.rs`：单卷 RAR4/RAR5、密码、catalog/read/stat。
- `src-tauri/src/source/archive/sevenz_backend.rs`：普通/solid 7z、AES、catalog/read/stat。
- `src-tauri/src/source/archive/remote_zip.rs`：1 MiB Range block、32 MiB LRU、singleflight、`Read+Seek`。
- `src-tauri/src/source/archive/service.rs`：路径解析、probe/unlock、backend 调度、catalog LRU、流式降级和后台物化。
- `src-tauri/src/commands/archive_access.rs`：`prepare_archive` / `unlock_archive` Tauri commands。
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
- `src-tauri/src/commands/archive_cache.rs`：cache 清理测试不再假设 `.zip`。
- `src/lib/tauri.ts`：结构化 prepare/unlock 类型和 IPC 封装。
- `src/stores/fileBrowser.ts`：候选 descriptor、prepare 后原子提交、密码请求状态。
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
sevenz-rust = { version = "=0.6.1", features = ["aes256"] }
zeroize = "1"
```

运行：

```bash
cargo update --manifest-path src-tauri/Cargo.toml -p zip --precise 2.4.2
cargo check --manifest-path src-tauri/Cargo.toml
```

预期：依赖解析完成，`Cargo.lock` 出现 `unrar 0.5.8`、`sevenz-rust 0.6.1`，ZIP 保持 2.4.2。

- [ ] **步骤 3：添加最小 RAR fixtures 与说明**

`src-tauri/tests/fixtures/archive/README.md` 必须说明五个 fixture 的格式、密码、内容、生成工具和生成日期。生成文件后，用下述命令取得实际 SHA-256，再把每个 64 位小写哈希连同对应文件名写入 README；README 中不得出现示例哈希、空单元格或待补文字。

固定元数据如下：`plain-rar4.rar`（RAR4 单卷、无密码、`page1.png/page2.png`）、`password-rar4.rar`（RAR4 单卷、密码 `test-pass-中文`、`page1.png`）、`plain-rar5.rar`（RAR5 单卷、无密码、`page1.png/page2.png`）、`password-rar5.rar`（RAR5 单卷、密码 `test-pass-中文`、`page1.png`）、`multipart.part1.rar`（RAR5 分卷、无密码、`page1.png`）。所有图片均为测试生成的 1×1 PNG，不含第三方版权内容；生成工具固定为 WinRAR 命令行，生成日期记录实际执行日期。

生成完成后运行：

```powershell
Get-ChildItem src-tauri/tests/fixtures/archive/*.rar | Get-FileHash -Algorithm SHA256
```

预期：五个文件均输出 64 位 SHA-256，README 与实际值一致。

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
cargo test --manifest-path src-tauri/Cargo.toml source::archive::backend source::archive::password
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
    #[error("压缩包条目不存在: {0}")]
    EntryNotFound(String),
    #[error("远程 Range 不可用: {0}")]
    RemoteRangeUnavailable(String),
    #[error("操作已取消")]
    Cancelled,
    #[error("IO 错误: {0}")]
    Io(String),
    #[error("网络错误: {0}")]
    Network(String),
}

pub trait ArchiveReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ArchiveReadSeek for T {}

pub type ReaderFactory = Arc<
    dyn Fn() -> Result<Box<dyn ArchiveReadSeek>, ArchiveAccessError> + Send + Sync
>;

#[derive(Clone)]
pub enum ArchiveInput {
    Path(PathBuf),
    Reader(ReaderFactory),
}

#[derive(Debug, Clone, PartialEq, Eq)]
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
cargo test --manifest-path src-tauri/Cargo.toml source::archive::backend source::archive::password
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

在 `zip_backend.rs` tests 中用 `zip::ZipWriter` 生成普通、ZipCrypto 和 AES fixture，核心断言：

```rust
#[test]
fn encrypted_zip_requires_password_rejects_wrong_and_reads_correct() {
    let path = create_encrypted_zip("secret", "page.png", PNG_BYTES);
    let backend = ZipBackend;
    let input = ArchiveInput::Path(path);
    assert_eq!(
        backend.catalog(&input, "", None).unwrap_err(),
        ArchiveAccessError::PasswordRequired
    );
    assert_eq!(
        backend.read_entry(&input, "page.png", Some(b"wrong")).unwrap_err(),
        ArchiveAccessError::WrongPassword
    );
    assert_eq!(
        backend.read_entry(&input, "page.png", Some(b"secret")).unwrap(),
        PNG_BYTES
    );
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

`map_zip_error` 必须把 invalid password、unsupported compression、missing file、invalid archive 分别映射到 `WrongPassword`、`UnsupportedCodec`、`EntryNotFound`、`CorruptArchive`。

- [ ] **步骤 4：实现 catalog/read/stat**

`catalog` 遍历 central directory，应用 `entryPrefix`、`is_image` 和自然排序；加密条目在无密码时仍返回 `PasswordRequired`，有密码时完整读取第一个加密图片并校验 CRC/MAC。`read_entry` 只解压目标条目到 `Vec<u8>`；`stat_entry` 读取 central directory 的解压后 size，不解压内容。

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
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::rar_backend
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

- [ ] **步骤 4：实现 UnRAR catalog/read/stat**

使用 `unrar::Archive::new(path)` 或 `Archive::with_password(path, password)`；listing 读取 entry filename、unpacked_size 和 split/volume flag，确认 split 后立即返回 `MultiVolumeUnsupported`。processing 按 `read_header → skip/read` 顺序前进，命中目标时 `read()` 到内存，未命中时 `skip()`；错误分类由错误 code 映射，不比较本地化错误文本。

`catalog` 返回过滤后的图片与 `first_encrypted_entry`；`read_entry`、`stat_entry` 与 ZIP 保持同一语义。所有 entry path 先把 `\` 归一为 `/`，再应用 prefix。

- [ ] **步骤 5：运行 RAR 测试**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::rar_backend -- --nocapture
```

预期：RAR4/RAR5、正确/错误密码、多卷拒绝全部 PASS。

- [ ] **步骤 6：Commit**

```bash
git add src-tauri/src/source/archive/rar_backend.rs src-tauri/src/source/archive/mod.rs
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
               ArchivePrepareResult::Ready { access_mode: ArchiveAccessMode::Local });
    let entries = harness.service.list(&descriptor).await.unwrap();
    assert_eq!(entries[0].name, "page.png");
    assert_eq!(harness.rar.password_seen(), Some(b"secret".to_vec()));
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveAccessMode { Local, Streaming, Materialized }

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ArchivePrepareResult {
    Ready { #[serde(rename = "accessMode")] access_mode: ArchiveAccessMode },
    PasswordRequired,
}
```

`ArchiveService` 持 `Arc<ZipBackend/RarBackend/SevenZBackend>`、`ArchivePasswordStore`、三个 semaphore 和 32 项 catalog LRU。Local identity 使用规范化绝对路径 + `std::fs::metadata` size/mtime。

- [ ] **步骤 4：实现 prepare/unlock/list/read/stat**

`prepare` 用已缓存密码调用 catalog；遇到 `PasswordRequired/WrongPassword` 时清除旧密码并返回 `PasswordRequired`。`unlock` 使用 `Zeroizing<Vec<u8>>`，完整验证首个加密条目后才写 store。`list/read/stat` 按格式取得 backend 和 semaphore，在 `spawn_blocking` 中执行；join panic 映射 `CorruptArchive("backend task panicked")`。

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

`MediaSourceFactory` 增加 `archive_service` 与 `prefetcher` Arc，并提供 accessor。构造顺序固定为：具体远程源 → Materializer → Prefetcher → ArchiveService → ArchiveMediaSource。`lib.rs` manage factory 暴露的同一 service/prefetcher，不再另建 Prefetcher。

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
git add src-tauri/src/source/archive/service.rs src-tauri/src/source/archive/mod.rs src-tauri/src/source/archive_impl.rs src-tauri/src/source/factory.rs src-tauri/src/lib.rs
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
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::materializer::tests::all_supported_extensions source::archive::materializer::tests::legacy_zip_row
```

预期：五格式测试因现有闸门失败；旧 ZIP 命中保持 PASS。

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
cargo test --manifest-path src-tauri/Cargo.toml source::archive::materializer source::archive::prefetch commands::archive_cache -- --nocapture
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

- [ ] **步骤 1：写 Seek、跨块、LRU 和并发去重失败测试**

```rust
#[test]
fn remote_reader_seek_and_cross_block_read_are_exact() {
    let origin = Arc::new(MockRangeOrigin::new(sequence_bytes(3 * BLOCK_SIZE + 17)));
    let cache = Arc::new(RangeBlockCache::new(2 * BLOCK_SIZE));
    let mut reader = RemoteZipReader::new(test_identity(), origin.clone(), cache);
    reader.seek(SeekFrom::Start((BLOCK_SIZE - 3) as u64)).unwrap();
    let mut out = [0u8; 8];
    reader.read_exact(&mut out).unwrap();
    assert_eq!(out.to_vec(), sequence_slice(BLOCK_SIZE - 3, 8));
    assert_eq!(origin.ranges(), vec![(0, BLOCK_SIZE), (BLOCK_SIZE as u64, BLOCK_SIZE)]);
}

#[test]
fn concurrent_same_block_loads_once() {
    let origin = Arc::new(MockRangeOrigin::new(vec![7; BLOCK_SIZE]));
    let cache = Arc::new(RangeBlockCache::new(32 * BLOCK_SIZE));
    let threads = (0..8).map(|_| {
        let origin = origin.clone();
        let cache = cache.clone();
        std::thread::spawn(move || {
            let mut reader = RemoteZipReader::new(test_identity(), origin, cache);
            let mut byte = [0u8; 1];
            reader.read_exact(&mut byte).unwrap();
            byte[0]
        })
    }).collect::<Vec<_>>();
    assert_eq!(threads.into_iter().map(|t| t.join().unwrap()).collect::<Vec<_>>(), vec![7; 8]);
    assert_eq!(origin.call_count(), 1);
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

`RangeBlockCache` 使用 `Mutex<State> + Condvar`；`State` 包含 `HashMap<BlockKey, Arc<Vec<u8>>>`、`VecDeque<BlockKey>` 和 `HashSet<BlockKey>` loading。`get_or_load` 对相同 key 只允许一个 loader，其他线程等待 Condvar；成功或失败都移除 loading 并 `notify_all`。插入后按 LRU 淘汰到 32 个满块以内。

- [ ] **步骤 5：实现 Read+Seek**

`RemoteZipReader` 保存 `position/size/identity/origin/cache/runtime`。`Seek` 对 Start/Current/End 使用 `i128` 计算并拒绝负数/超过 u64；`Read` 按 block 拆分，最后一块请求 `min(BLOCK_SIZE, size-block_start)`。loader 只能在 `spawn_blocking` 线程中用 `runtime.block_on(origin.read_range(...))`。

- [ ] **步骤 6：运行测试与强契约检查**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::remote_zip -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml source::webdav_impl source::smb -- --nocapture
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

- [ ] **步骤 1：写尾部优先、降级和本地切换失败测试**

```rust
#[tokio::test]
async fn remote_zip_prepares_with_tail_range_before_full_materialization() {
    let harness = RemoteServiceHarness::zip();
    let result = harness.service.prepare(&harness.descriptor).await.unwrap();
    assert_eq!(result, ArchivePrepareResult::Ready {
        access_mode: ArchiveAccessMode::Streaming,
    });
    assert!(harness.origin.first_range().offset > harness.origin.size() - 128 * 1024);
    assert_eq!(harness.origin.full_download_count(), 0);
}

#[tokio::test]
async fn broken_range_falls_back_to_materialized_file() {
    let harness = RemoteServiceHarness::zip_with_short_range();
    let result = harness.service.prepare(&harness.descriptor).await.unwrap();
    assert_eq!(result, ArchivePrepareResult::Ready {
        access_mode: ArchiveAccessMode::Materialized,
    });
    assert_eq!(harness.origin.full_download_count(), 1);
}

#[tokio::test]
async fn ready_cache_is_preferred_after_background_download() {
    let harness = RemoteServiceHarness::zip();
    harness.service.prepare(&harness.descriptor).await.unwrap();
    harness.wait_background_ready().await;
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
pub fn prefetch_opened(&self, origin: SourceDescriptor, rel: String) {
    if !self.is_enabled() { return; }
    let mat = self.mat.clone();
    let expected_epoch = mat.current_epoch();
    tokio::spawn(async move {
        let _ = mat.ensure_cached_cancellable(&origin, &rel, expected_epoch).await;
    });
}
```

- [ ] **步骤 4：Service 构造远程 ZIP reader factory**

远程 CBZ/ZIP 先 `stat_origin` 建 identity，再创建 `ReaderFactory`；factory 每次返回共享 block cache 的新 `RemoteZipReader`。`catalog` 或首个加密条目验证成功后返回 Streaming 并调用 `prefetch_opened`。

如果 backend 返回 `RemoteRangeUnavailable/Network`，原位重试一次；第二次仍失败则 `ensure_cached` 后用 Path input 重跑 catalog，成功返回 Materialized。密码类、坏包和 unsupported codec 不触发网络降级。

- [ ] **步骤 5：实现 ready cache 优先**

在 Materializer/DAO 增加无下载的 `ready_path_if_fresh` helper；Service 每次 list/read/stat 先检查 ready cache。命中则 Path input；未命中且 format 是 ZIP/CBZ 才用 RemoteZipReader。命中校验继续包含远端 stat 与磁盘长度，不绕过 M3 一致性规则。

- [ ] **步骤 6：运行远程流式与 M3 回归**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml source::archive::service source::archive::remote_zip source::archive::materializer source::archive::prefetch -- --nocapture
```

预期：尾部 Range 优先、自动降级、后台切本地、清空/取消/断点测试全部 PASS。

- [ ] **步骤 7：Commit**

```bash
git add src-tauri/src/source/archive/service.rs src-tauri/src/source/archive/prefetch.rs src-tauri/src/source/archive/zip_backend.rs src-tauri/src/source/archive/materializer.rs src-tauri/src/source/archive/dao.rs
git commit -m "feat(archive): 远程 ZIP 流式首开并后台物化"
```

---

### 任务 11：prepare/unlock IPC 与结构化前端契约

**文件：**
- 创建：`src-tauri/src/commands/archive_access.rs`
- 修改：`src-tauri/src/commands/mod.rs`
- 修改：`src-tauri/src/lib.rs`
- 修改：`src/lib/tauri.ts`
- 测试：`src/lib/tauri.epoch.test.ts`

- [ ] **步骤 1：写 Rust command inner 测试**

```rust
#[tokio::test]
async fn unlock_only_caches_verified_password() {
    let harness = CommandHarness::encrypted_zip();
    assert_eq!(prepare_archive_inner(&harness.service, harness.descriptor.clone()).await.unwrap(),
               ArchivePrepareResult::PasswordRequired);
    assert_eq!(unlock_archive_inner(
        &harness.service, harness.descriptor.clone(), "wrong".into()
    ).await.unwrap_err(), ArchiveAccessError::WrongPassword);
    assert!(!harness.service.has_password(&harness.identity));
    assert_eq!(unlock_archive_inner(
        &harness.service, harness.descriptor, "secret".into()
    ).await.unwrap(), ArchivePrepareResult::Ready {
        access_mode: ArchiveAccessMode::Local,
    });
    assert!(harness.service.has_password(&harness.identity));
}
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml commands::archive_access
```

预期：FAIL，command 不存在。

- [ ] **步骤 3：实现 commands 并注册**

```rust
#[tauri::command]
pub async fn prepare_archive(
    service: tauri::State<'_, Arc<ArchiveService>>,
    descriptor: SourceDescriptor,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    service.prepare(&descriptor).await
}

#[tauri::command]
pub async fn unlock_archive(
    service: tauri::State<'_, Arc<ArchiveService>>,
    descriptor: SourceDescriptor,
    password: String,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    unlock_archive_inner(service.inner().as_ref(), descriptor, password).await
}

async fn unlock_archive_inner(
    service: &ArchiveService,
    descriptor: SourceDescriptor,
    password: String,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    let bytes = zeroize::Zeroizing::new(password.into_bytes());
    service.unlock(&descriptor, bytes).await
}
```

在 `commands/mod.rs` 导出，在 `generate_handler!` 注册；`factory.archive_service()` 以同一 Arc manage。

- [ ] **步骤 4：写前端 IPC 失败测试**

在 `tauri.epoch.test.ts` 的 mock invoke harness 增加：

```ts
it('prepare/unlock 使用稳定命令名且密码只放 IPC 参数', async () => {
  const descriptor = { type: 'archive', archivePath: 'C:/book.cbz', entryPrefix: '', format: 'cbz' } as const;
  await prepareArchive(descriptor);
  expect(invoke).toHaveBeenCalledWith('prepare_archive', { descriptor });
  await unlockArchive(descriptor, 'secret');
  expect(invoke).toHaveBeenCalledWith('unlock_archive', { descriptor, password: 'secret' });
  expect(JSON.stringify(descriptor)).not.toContain('secret');
});
```

- [ ] **步骤 5：实现 TS 类型与封装**

```ts
export type ArchiveAccessMode = 'local' | 'streaming' | 'materialized';
export type ArchivePrepareResult =
  | { status: 'ready'; accessMode: ArchiveAccessMode }
  | { status: 'passwordRequired' };

export interface ArchiveAccessError {
  kind: 'passwordRequired' | 'wrongPassword' | 'unsupportedCodec'
    | 'multiVolumeUnsupported' | 'corruptArchive' | 'emptyArchive'
    | 'entryNotFound' | 'remoteRangeUnavailable' | 'cancelled'
    | 'io' | 'network';
  message?: string;
}

export function prepareArchive(descriptor: SourceDescriptor): Promise<ArchivePrepareResult> {
  return invoke<ArchivePrepareResult>('prepare_archive', { descriptor });
}

export function unlockArchive(
  descriptor: SourceDescriptor,
  password: string,
): Promise<ArchivePrepareResult> {
  return invoke<ArchivePrepareResult>('unlock_archive', { descriptor, password });
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
git add src-tauri/src/commands/archive_access.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src/lib/tauri.ts src/lib/tauri.epoch.test.ts
git commit -m "feat(archive): 增加结构化准备与解锁 IPC"
```

---

### 任务 12：FileBrowser 事务式打开与密码请求状态

**文件：**
- 修改：`src/stores/fileBrowser.ts`
- 修改：`src/stores/fileBrowser.test.ts`

- [ ] **步骤 1：扩展 tauri mock 并写失败测试**

mock 加入：

```ts
prepareArchive: vi.fn(async () => ({ status: 'ready', accessMode: 'local' as const })),
unlockArchive: vi.fn(async () => ({ status: 'ready', accessMode: 'local' as const })),
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
  pending.resolve({ status: 'ready', accessMode: 'local' });
  await opening;
  expect(fb.currentPath).toBe('');
  expect(fb.currentDescriptor).toMatchObject({ type: 'archive', format: 'cbr' });
});

it('password-required 与 prepare error 不污染原导航', async () => {
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

it('错误密码保留请求，正确密码提交候选导航', async () => {
  const fb = useFileBrowserStore();
  await fb.setRoot('F:/comics');
  vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'passwordRequired' });
  await fb.openArchive(makeEntry('book.cbz', { isArchive: true }));
  vi.mocked(unlockArchive).mockRejectedValueOnce({ kind: 'wrongPassword' });
  await expect(fb.submitArchivePassword('bad')).rejects.toMatchObject({ kind: 'wrongPassword' });
  expect(fb.pendingArchivePassword).not.toBeNull();
  vi.mocked(unlockArchive).mockResolvedValueOnce({ status: 'ready', accessMode: 'local' });
  await fb.submitArchivePassword('secret');
  expect(fb.pendingArchivePassword).toBeNull();
  expect(fb.currentDescriptor?.type).toBe('archive');
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```bash
npx vitest run src/stores/fileBrowser.test.ts
```

预期：FAIL，store 尚未调用 prepare/unlock，也没有 pending 状态。

- [ ] **步骤 3：抽出候选 descriptor 构造**

```ts
interface PendingArchiveOpen {
  descriptor: SourceDescriptor;
  parent: { descriptor: SourceDescriptor; relPath: string };
  entryName: string;
}

const pendingArchivePassword = ref<PendingArchiveOpen | null>(null);
const archiveAccessMode = ref<ArchiveAccessMode | null>(null);

function buildArchiveCandidate(entry: MediaEntry): PendingArchiveOpen {
  // 把现有 Local/WebDAV/SMB descriptor 构造原样移动到此纯函数；不得写任何 ref。
}
```

纯函数必须返回当前实现完全相同的 Local/WebDAV/SMB descriptor 字段。

- [ ] **步骤 4：实现 prepare 后提交**

```ts
function commitArchive(candidate: PendingArchiveOpen, mode: ArchiveAccessMode): void {
  archiveParent.value = candidate.parent;
  currentDescriptor.value = candidate.descriptor;
  currentPath.value = '';
  searchQuery.value = '';
  archiveAccessMode.value = mode;
}

async function openArchive(entry: MediaEntry): Promise<void> {
  archiveProgress.value = null;
  const candidate = buildArchiveCandidate(entry);
  const result = await prepareArchive(candidate.descriptor);
  if (result.status === 'passwordRequired') {
    pendingArchivePassword.value = candidate;
    return;
  }
  commitArchive(candidate, result.accessMode);
  await fetch('');
}
```

`submitArchivePassword` 成功后 commit+fetch；失败不清 pending。`cancelArchivePassword` 清 pending 与错误，不改导航。`exitArchive` 同时清 `archiveAccessMode`。

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

模板挂载 `ArchivePasswordDialog`；取消调用 `fb.cancelArchivePassword()`。`loadingText` 按 `archiveAccessMode` 与 materializer progress 区分阻塞准备、stream fallback；进入 Streaming 后 status bar 显示非阻塞后台百分比。

- [ ] **步骤 6：写父组件交互测试**

```ts
it('双击加密 archive 弹密码框，错误保留，成功后进入', async () => {
  vi.mocked(prepareArchive).mockResolvedValueOnce({ status: 'passwordRequired' });
  vi.mocked(unlockArchive)
    .mockRejectedValueOnce({ kind: 'wrongPassword' })
    .mockResolvedValueOnce({ status: 'ready', accessMode: 'local' });
  const wrapper = await mountFileBrowser();
  await wrapper.get('[data-test="file-row-book.cbr"]').trigger('dblclick');
  expect(wrapper.find('[data-test="archive-password-dialog"]').exists()).toBe(true);
  await submitDialog(wrapper, 'bad');
  expect(wrapper.text()).toContain('密码不正确');
  await submitDialog(wrapper, 'secret');
  expect(wrapper.find('[data-test="archive-password-dialog"]').exists()).toBe(false);
  expect(useFileBrowserStore().currentDescriptor).toMatchObject({ type: 'archive', format: 'cbr' });
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
    let response = map_media_error(MediaSourceError::Archive(
        ArchiveAccessError::PasswordRequired,
    ));
    assert_eq!(response.status(), StatusCode::LOCKED);
    assert_eq!(response.body(), b"archive locked");
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
MediaSourceError::Archive(ArchiveAccessError::Network(_)) => {
    err_response(StatusCode::BAD_GATEWAY, "bad gateway")
}
MediaSourceError::Archive(_) => {
    err_response(StatusCode::UNPROCESSABLE_ENTITY, "archive error")
}
```

响应体不含第三方错误或密码信息。

- [ ] **步骤 3：增加 CI 守卫**

在 `.github/workflows/verify.yml` Rust stable 安装后增加：

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
cargo test --manifest-path src-tauri/Cargo.toml source::archive commands::archive_access media_protocol -- --nocapture
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

逐项对照规格 §13：本地五格式、五格式密码、WebDAV/SMB ZIP Range 首开、后台物化、本地切换、RAR/7z 完整物化、错误分类、多卷拒绝、密码零持久化。任何缺项都回到对应任务补测试和最小实现，不能仅在验收报告中标注完成。

---

## 计划执行完成的证据清单

- 任务 2 的既有 ZIP contract 在重构前后均通过。
- ZIP/CBZ ZipCrypto、AES AE-1/AE-2 正确/错误密码有自动化证据。
- RAR4/RAR5 与 7z 普通/solid/加密有 fixture 或运行时生成测试证据。
- multi-disk ZIP、分卷 RAR、分卷 7z 返回专用错误。
- WebDAV/SMB mock 证明 ZIP 首请求为尾部 Range，未先整包下载。
- Range 失败证明自动降级完整物化；后台完成后证明新请求不再发 Range。
- `.part`、sidecar、断点续传、LRU、cache 清空和旧 `.zip` cache 行不回归。
- 密码未进入 descriptor、DB、日志、事件、sidecar 与错误文本。
- `npm test`、type-check、frontend build、`cargo test`、`cargo build`、Tauri portable build 全部有新鲜输出。
