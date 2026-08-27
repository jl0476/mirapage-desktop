//! 7z backend：`ArchiveBackend` 的 sevenz-rust 0.6.1 实现（任务 6）。
//!
//! - **唯一 open 入口 [`LimitedSevenZBackend::open_checked`]**：先跑
//!   [`crate::source::archive::sevenz_header_precheck`] 的两阶段有界预检（含受限
//!   encoded-header 解码与 AES KDF 上限），通过后才调用（可注入的）opener——
//!   `SevenZReader::open` 的前置分配路径在预检之后才可达。
//! - **folder 级检查**：open 成功后、任何条目解码之前，逐 folder 解析 coder dictionary
//!   （LZMA props[1..5] 小端 u32——第 0 字节是 lc/lp/pb；LZMA2 props[0] 档位查表）与
//!   AES cycles；超限 `ResourceLimitExceeded`。加密状态按 folder 推导：`has_stream` 条目
//!   依序归属各 folder（stream_map），条目加密 = 所属 folder 链含 AES coder（与
//!   `SevenZMethod::ID_AES256SHA256` 完整 4 字节比较）；solid folder 内全部文件一并视为加密。
//! - **read**：`for_each_entries` 顺序解码（solid 包不跳过目标之前的数据——非目标条目
//!   逐块读尽），命中条目经 `LimitedEntryWriter` 约束输出；闭包错误不穿透 sevenz-rust 的
//!   `maybe_bad_password` 改写（预算/限额 marker 在闭包外恢复）。
//! - 多卷：`.7z.001` 分卷命名拒绝（单卷 backend 合同）。
//! - `ArchiveInput::Reader` → `RemoteRangeUnavailable`（7z 需要整包 seek；远程 7z 经 M3
//!   物化为本地路径，backend 只见 Path）。

use crate::algorithm::mime::is_image;
use crate::algorithm::natural_compare;
use crate::source::archive::backend::{
    ArchiveAccessError, ArchiveBackend, ArchiveCatalog, ArchiveInput, ArchiveLimits,
    ArchiveProbe, BudgetRetryIoError, DecodeBudget, LimitedEntryIoError, LimitedEntryWriter,
    MAX_ENTRY_BYTES,
};
use crate::source::archive::sevenz_header_precheck::PrecheckHooks;
use crate::source::descriptor::MediaEntry;
use sevenz_rust::SevenZReader;
use std::fs::File;
use std::path::Path;
use std::sync::atomic::AtomicUsize;
use std::sync::Arc;

type SevenZOpener = Arc<
    dyn Fn(&Path, sevenz_rust::Password) -> Result<SevenZReader<File>, ArchiveAccessError>
        + Send
        + Sync,
>;

/// backend 注入点：生产 opener = `SevenZReader::open`；测试可注入计数 opener、
/// KDF 计数（经 [`PrecheckHooks`]）与条目解码计数。
#[derive(Clone)]
pub(crate) struct SevenzHooks {
    pub precheck: PrecheckHooks,
    pub opener: SevenZOpener,
    pub entry_decoder_calls: Arc<AtomicUsize>,
}

impl Default for SevenzHooks {
    fn default() -> Self {
        Self {
            precheck: PrecheckHooks::default(),
            opener: Arc::new(|path, password| open_sevenz_reader(path, password)),
            entry_decoder_calls: Arc::new(AtomicUsize::new(0)),
        }
    }
}

/// 7z 后端（生产单例，零值）：调用方可直接 `SevenZBackend.catalog(..)`
/// （生产限额 = `ArchiveLimits::production()`）。测试注入限额用 [`SevenZBackend::with_test_limits`]。
#[derive(Default)]
pub struct SevenZBackend;

pub struct LimitedSevenZBackend {
    limits: ArchiveLimits,
    hooks: SevenzHooks,
}

impl SevenZBackend {
    /// 测试构造：每个用例只缩小自己验证的限额维度（`ArchiveLimits::for_test` 合同）。
    pub fn with_test_limits(limits: ArchiveLimits) -> LimitedSevenZBackend {
        LimitedSevenZBackend {
            limits,
            hooks: SevenzHooks::default(),
        }
    }

    /// 测试构造：注入 opener / KDF 计数 / 条目解码计数（`PrecheckHarness` 载体）。
    #[cfg(test)]
    pub(crate) fn with_hooks(hooks: SevenzHooks) -> LimitedSevenZBackend {
        LimitedSevenZBackend {
            limits: ArchiveLimits::production(),
            hooks,
        }
    }
}

impl LimitedSevenZBackend {
    /// 唯一 open 入口：预检 → 注入 opener（生产 = `SevenZReader::open`）。
    pub(crate) fn open_checked(
        &self,
        input: &ArchiveInput,
        password: Option<&[u8]>,
    ) -> Result<SevenZReader<File>, ArchiveAccessError> {
        open_sevenz_checked(input, password, &self.hooks)
    }
}

/// open 全链路：Path 约束 → 分卷名拒绝 → 两阶段预检 → 注入 opener。
fn open_sevenz_checked(
    input: &ArchiveInput,
    password: Option<&[u8]>,
    hooks: &SevenzHooks,
) -> Result<SevenZReader<File>, ArchiveAccessError> {
    let path = path_of(input)?;
    reject_split_name(path)?;
    crate::source::archive::sevenz_header_precheck::precheck(path, password, &hooks.precheck)?;
    let pw = sevenz_password(password)?;
    (hooks.opener)(path, pw)
}

/// 生产 opener（也被测试计数 opener 包装复用）。
pub(crate) fn open_sevenz_reader(
    path: &Path,
    password: sevenz_rust::Password,
) -> Result<SevenZReader<File>, ArchiveAccessError> {
    sevenz_rust::SevenZReader::open(path, password)
        .map_err(|e| map_sevenz_error(e, /* encrypted 未知 */ false, false))
}

impl ArchiveBackend for SevenZBackend {
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        probe_sevenz(input, prefix, password, &ArchiveLimits::production(), &SevenzHooks::default())
    }

    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError> {
        catalog_sevenz(input, prefix, password, &ArchiveLimits::production(), &SevenzHooks::default())
    }

    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        read_entry_sevenz(input, entry, password, budget, &ArchiveLimits::production(), &SevenzHooks::default())
    }

    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError> {
        stat_entry_sevenz(input, entry, password, &ArchiveLimits::production(), &SevenzHooks::default())
    }
}

impl ArchiveBackend for LimitedSevenZBackend {
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        probe_sevenz(input, prefix, password, &self.limits, &self.hooks)
    }

    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError> {
        catalog_sevenz(input, prefix, password, &self.limits, &self.hooks)
    }

    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        read_entry_sevenz(input, entry, password, budget, &self.limits, &self.hooks)
    }

    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError> {
        stat_entry_sevenz(input, entry, password, &self.limits, &self.hooks)
    }
}

// ---------------------------------------------------------------------------
// 输入约束 / 密码 / 错误映射
// ---------------------------------------------------------------------------

fn path_of(input: &ArchiveInput) -> Result<&Path, ArchiveAccessError> {
    match input {
        ArchiveInput::Path(path) => Ok(path.as_path()),
        // 7z 需要整包 seek：远程 7z 经 M3 物化为本地路径，backend 只见 Path
        ArchiveInput::Reader(_) => Err(ArchiveAccessError::RemoteRangeUnavailable(
            "7z backend 只接受本地路径".into(),
        )),
    }
}

/// `.7z.NNN` 分卷命名拒绝（单卷 backend 合同）：匹配任意数字卷号——只认 `.001`
/// 会让 `.7z.002` 及以后漏进解析、被误分类为损坏/IO，而非专用的多卷错误。
fn reject_split_name(path: &Path) -> Result<(), ArchiveAccessError> {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let split = name.rsplit_once(".7z.").is_some_and(|(stem, vol)| {
        !stem.is_empty()
            && !vol.is_empty()
            && vol.bytes().all(|b| b.is_ascii_digit())
    });
    if split {
        return Err(ArchiveAccessError::MultiVolumeUnsupported(name));
    }
    Ok(())
}

fn sevenz_password(password: Option<&[u8]>) -> Result<sevenz_rust::Password, ArchiveAccessError> {
    match password {
        None => Ok(sevenz_rust::Password::empty()),
        Some(bytes) => std::str::from_utf8(bytes)
            .map(sevenz_rust::Password::from)
            .map_err(|_| ArchiveAccessError::WrongPassword),
    }
}

/// sevenz-rust `Error` → `ArchiveAccessError`：PasswordRequired / 错误密码（MaybeBadPassword、
/// 或已供密码的加密流上 checksum/LZMA 失败归一 WrongPassword，与 RAR4 CRC 归一同理）/
/// unsupported method / MaxMemLimited（理论不可达的防御）/ 结构错误 → CorruptArchive。
pub(crate) fn map_sevenz_error(
    e: sevenz_rust::Error,
    encrypted: bool,
    has_password: bool,
) -> ArchiveAccessError {
    use sevenz_rust::Error as E;
    match e {
        E::PasswordRequired => ArchiveAccessError::PasswordRequired,
        E::MaybeBadPassword(_) => ArchiveAccessError::WrongPassword,
        E::ChecksumVerificationFailed | E::NextHeaderCrcMismatch => {
            if encrypted && has_password {
                ArchiveAccessError::WrongPassword
            } else {
                ArchiveAccessError::CorruptArchive(e.to_string())
            }
        }
        E::UnsupportedCompressionMethod(m) => ArchiveAccessError::UnsupportedCodec(m),
        E::Unsupported(m) => ArchiveAccessError::UnsupportedCodec(m.to_string()),
        E::MaxMemLimited { .. } => {
            ArchiveAccessError::ResourceLimitExceeded("sevenz internal memory limit".into())
        }
        E::BadSignature(_)
        | E::UnsupportedVersion { .. }
        | E::BadTerminatedStreamsInfo(_)
        | E::BadTerminatedUnpackInfo
        | E::BadTerminatedPackInfo(_)
        | E::BadTerminatedSubStreamsInfo
        | E::BadTerminatedheader(_)
        | E::ExternalUnsupported
        | E::Other(_) => ArchiveAccessError::CorruptArchive(e.to_string()),
        E::FileOpen(err, _) => ArchiveAccessError::Io(err.to_string()),
        E::Io(io, _) => map_sevenz_io_error(io),
    }
}

/// writer/限额 marker 的 io 边界恢复（与 zip backend `map_zip_io_error` 同款顺序）。
fn map_sevenz_io_error(e: std::io::Error) -> ArchiveAccessError {
    if e.get_ref().is_some_and(|c| c.is::<BudgetRetryIoError>()) {
        return ArchiveAccessError::BudgetRetryRequired;
    }
    if let Some(limited) = e.get_ref().and_then(|c| c.downcast_ref::<LimitedEntryIoError>()) {
        return ArchiveAccessError::ResourceLimitExceeded(limited.to_string());
    }
    match e.kind() {
        std::io::ErrorKind::InvalidData => ArchiveAccessError::CorruptArchive(e.to_string()),
        _ => ArchiveAccessError::Io(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// folder 级检查：dictionary 上限 + AES cycles + 加密推导
// ---------------------------------------------------------------------------

pub(crate) struct FolderFacts {
    /// folder 链内 LZMA/LZMA2 声明 dictionary 的最大值（无则 0）
    pub dict: u64,
    /// 链内含 AES256SHA256 coder（完整 4 字节 ID 比较）
    pub encrypted: bool,
}

/// open 成功后、任何条目解码之前的 folder 级防线（KDF cycles 检查在派生启动前）。
pub(crate) fn folder_facts(
    archive: &sevenz_rust::Archive,
    limits: &ArchiveLimits,
) -> Result<Vec<FolderFacts>, ArchiveAccessError> {
    use sevenz_rust::SevenZMethod as M;
    let mut facts = Vec::with_capacity(archive.folders.len());
    for folder in &archive.folders {
        let mut dict = 0u64;
        let mut encrypted = false;
        for coder in &folder.coders {
            let id = coder.decompression_method_id();
            if id == M::ID_LZMA {
                // 第 0 字节编码 lc/lp/pb，dictionary 是 properties[1..5] 小端 u32——
                // 把"前 5 字节"当 dict 的实现会算错尺寸（dict-oversize-lzma 用例抓出）
                if coder.properties.len() < 5 {
                    return Err(ArchiveAccessError::CorruptArchive(
                        "LZMA properties 过短".into(),
                    ));
                }
                let p = &coder.properties;
                dict = dict.max(u32::from_le_bytes([p[1], p[2], p[3], p[4]]) as u64);
            } else if id == M::ID_LZMA2 {
                let d = crate::source::archive::sevenz_header_precheck::lzma2_dict_from_props(
                    &coder.properties,
                )?;
                dict = dict.max(d);
            } else if id == M::ID_AES256SHA256 {
                let props = crate::source::archive::sevenz_header_precheck::parse_aes_properties(
                    &coder.properties,
                )?;
                crate::source::archive::sevenz_header_precheck::check_kdf_cycles(props.cycles)?;
                encrypted = true;
            }
            // 未知 coder id 的 properties 不做猜测，交由解码阶段既有错误映射
        }
        if dict > limits.max_dict_bytes {
            return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
                "folder dictionary {dict} exceeds {}",
                limits.max_dict_bytes
            )));
        }
        facts.push(FolderFacts { dict, encrypted });
    }
    Ok(facts)
}

// ---------------------------------------------------------------------------
// probe / catalog / read_entry / stat_entry
// ---------------------------------------------------------------------------

/// 对**每个原始条目（含非图片）**的三项限额检查（不得先过滤图片再限额）。
fn check_raw_entry_limits(
    index: usize,
    name: &str,
    declared_size: u64,
    limits: &ArchiveLimits,
) -> Result<(), ArchiveAccessError> {
    if index >= limits.max_catalog_entries {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "7z entries exceed {}",
            limits.max_catalog_entries
        )));
    }
    if name.len() > limits.max_entry_path_bytes {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "entry path exceeds {} bytes",
            limits.max_entry_path_bytes
        )));
    }
    if declared_size > limits.max_entry_bytes {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "entry declares {declared_size} bytes exceeding {}",
            limits.max_entry_bytes
        )));
    }
    Ok(())
}

fn probe_sevenz(
    input: &ArchiveInput,
    prefix: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
    hooks: &SevenzHooks,
) -> Result<ArchiveProbe, ArchiveAccessError> {
    let mut reader = open_with_folder_checks(input, password, limits, hooks)?;
    let archive = reader.archive();
    let facts = folder_facts(archive, limits)?;
    let mut probe = ArchiveProbe::default();
    for (index, file) in archive.files.iter().enumerate() {
        let name = file.name.replace('\\', "/");
        check_raw_entry_limits(index, &name, file.size, limits)?;
        probe.entry_count += 1;
        // 条目归属：has_stream 条目依序映射 folder（stream_map 已按 num_unpack_sub_streams
        // 分配）；无 stream（空文件/目录）不入 dictionary 表、不视为加密
        let (folder_index, encrypted) = match archive.stream_map.file_folder_index.get(index) {
            Some(Some(fi)) => (*fi, facts.get(*fi).map(|f| f.encrypted).unwrap_or(false)),
            _ => (usize::MAX, false),
        };
        if folder_index != usize::MAX {
            let dict = facts.get(folder_index).map(|f| f.dict).unwrap_or(0);
            probe.entry_dictionaries.insert(name.clone(), dict);
        }
        if !name.starts_with(prefix) {
            continue;
        }
        if is_image(&name) {
            probe.image_count += 1;
            if encrypted && probe.first_encrypted_image.is_none() {
                probe.first_encrypted_image = Some(name.clone());
            }
        } else if encrypted && probe.first_encrypted_file.is_none() {
            probe.first_encrypted_file = Some(name);
        }
    }
    Ok(probe)
}

fn catalog_sevenz(
    input: &ArchiveInput,
    prefix: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
    hooks: &SevenzHooks,
) -> Result<ArchiveCatalog, ArchiveAccessError> {
    let mut reader = open_with_folder_checks(input, password, limits, hooks)?;
    let archive = reader.archive();
    let mut out = Vec::new();
    for (index, file) in archive.files.iter().enumerate() {
        let name = file.name.replace('\\', "/");
        check_raw_entry_limits(index, &name, file.size, limits)?;
        // 单层约束的实现方式：嵌套压缩包不出现在条目视图（is_image 只放行图片），
        // UI 无额外双击守卫——放行非图片条目前必须先给 openArchive 加层守卫（module3.5.3 spec §2.J）。
        if !name.starts_with(prefix) || !is_image(&name) {
            continue;
        }
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            name.strip_prefix(prefix)
                .map(|s| s.trim_start_matches('/').to_string())
                .unwrap_or_else(|| name.clone())
        };
        // 7z 条目时间戳（FileTime）阅读器不展示，与 ZIP/RAR 同款留 None
        out.push(MediaEntry {
            name: relative.clone(),
            path: relative,
            is_directory: false,
            is_archive: false,
            size: file.size,
            modified_at: None,
        });
    }
    out.sort_by(|a, b| natural_compare(&a.name, &b.name));
    Ok(ArchiveCatalog { entries: out })
}

/// open_checked + folder 级检查的公共前置（probe/catalog/read/stat 共用）。
fn open_with_folder_checks(
    input: &ArchiveInput,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
    hooks: &SevenzHooks,
) -> Result<SevenZReader<File>, ArchiveAccessError> {
    let mut reader = open_sevenz_checked(input, password, hooks)?;
    folder_facts(reader.archive(), limits)?;
    Ok(reader)
}

fn stat_entry_sevenz(
    input: &ArchiveInput,
    entry: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
    hooks: &SevenzHooks,
) -> Result<u64, ArchiveAccessError> {
    let mut reader = open_with_folder_checks(input, password, limits, hooks)?;
    for (index, file) in reader.archive().files.iter().enumerate() {
        let name = file.name.replace('\\', "/");
        if name.len() > limits.max_entry_path_bytes || index >= limits.max_catalog_entries {
            return Err(ArchiveAccessError::ResourceLimitExceeded(
                "entry path/count exceeds limits".into(),
            ));
        }
        if name == entry {
            if file.size > limits.max_entry_bytes {
                return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
                    "entry {entry} declares {} bytes exceeding {}",
                    file.size, limits.max_entry_bytes
                )));
            }
            return Ok(file.size);
        }
    }
    Err(ArchiveAccessError::EntryNotFound(entry.to_string()))
}

fn read_entry_sevenz(
    input: &ArchiveInput,
    entry: &str,
    password: Option<&[u8]>,
    budget: &mut DecodeBudget,
    limits: &ArchiveLimits,
    hooks: &SevenzHooks,
) -> Result<Vec<u8>, ArchiveAccessError> {
    let mut reader = open_with_folder_checks(input, password, limits, hooks)?;
    // 目标条目的加密状态与声明大小（folder 归属推导）
    let target = {
        let archive = reader.archive();
        let facts = folder_facts(archive, limits)?;
        let mut found: Option<(u64, bool)> = None;
        for (index, file) in archive.files.iter().enumerate() {
            let name = file.name.replace('\\', "/");
            check_raw_entry_limits(index, &name, file.size, limits)?;
            if name == entry {
                let encrypted = match archive.stream_map.file_folder_index.get(index) {
                    Some(Some(fi)) => facts.get(*fi).map(|f| f.encrypted).unwrap_or(false),
                    _ => false,
                };
                found = Some((file.size, encrypted));
                break;
            }
        }
        found
    };
    let (declared, encrypted) =
        target.ok_or_else(|| ArchiveAccessError::EntryNotFound(entry.to_string()))?;
    if declared > limits.max_entry_bytes || declared > MAX_ENTRY_BYTES {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "entry {entry} declares {declared} bytes exceeding {}",
            limits.max_entry_bytes
        )));
    }
    let writer_budget = std::mem::replace(budget, DecodeBudget::unbounded());
    let mut writer = LimitedEntryWriter::with_budget(writer_budget);
    if declared > 0 {
        let incoming = usize::try_from(declared).map_err(|_| {
            ArchiveAccessError::ResourceLimitExceeded(format!(
                "entry {entry} declares {declared} bytes"
            ))
        })?;
        writer
            .ensure_capacity_for_write(incoming)
            .map_err(map_sevenz_io_error)?;
    }
    // FnMut 闭包内不能 move writer：经 Option 持有、命中条目读尽后 take() 交付
    let mut writer_slot = Some(writer);
    // 闭包内错误不穿透 sevenz-rust 的 maybe_bad_password 改写（Io 空上下文 →
    // MaybeBadPassword 会把预算 marker 误映射 WrongPassword）——错误闭包外恢复
    let mut writer_failure: Option<std::io::Error> = None;
    let mut read_failure: Option<ArchiveAccessError> = None;
    let mut result: Option<Vec<u8>> = None;
    hooks
        .entry_decoder_calls
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let has_password = password.is_some();
    let for_each_err = reader.for_each_entries(|file, entry_reader| {
        let name = file.name.replace('\\', "/");
        if name != entry {
            // solid 包不得跳过目标之前的数据：非目标条目逐块读尽（folder 流连续）
            let mut chunk = [0u8; 64 * 1024];
            loop {
                match entry_reader.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(e) => {
                        read_failure = Some(classify_entry_read_error(e, encrypted, has_password));
                        return Ok(false);
                    }
                }
            }
            return Ok(true);
        }
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match entry_reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if let Err(e) = writer_slot
                        .as_mut()
                        .expect("命中条目时 writer 必在")
                        .write_all(&chunk[..n])
                    {
                        writer_failure = Some(e);
                        return Ok(false);
                    }
                }
                Err(e) => {
                    read_failure = Some(classify_entry_read_error(e, encrypted, has_password));
                    return Ok(false);
                }
            }
        }
        result = writer_slot.take().map(|w| w.finish());
        Ok(false) // 命中后停止
    });
    if let Err(e) = for_each_err {
        return Err(map_sevenz_error(e, encrypted, has_password));
    }
    if let Some(err) = read_failure {
        return Err(err);
    }
    if let Some(io_err) = writer_failure {
        return Err(map_sevenz_io_error(io_err));
    }
    result.ok_or_else(|| ArchiveAccessError::EntryNotFound(entry.to_string()))
}

/// 条目读取 io 错误分类：加密流 + 已供密码下，LZMA/CRC 垃圾多半是错密码。
fn classify_entry_read_error(
    e: std::io::Error,
    encrypted: bool,
    has_password: bool,
) -> ArchiveAccessError {
    // sevenz-rust 把 ChecksumVerificationFailed 包进 io::Error 的 payload
    if e.get_ref().is_some_and(|c| {
        c.downcast_ref::<sevenz_rust::Error>()
            .is_some_and(|se| matches!(se, sevenz_rust::Error::ChecksumVerificationFailed))
    }) {
        if encrypted && has_password {
            return ArchiveAccessError::WrongPassword;
        }
        return ArchiveAccessError::CorruptArchive(e.to_string());
    }
    if encrypted && has_password {
        return ArchiveAccessError::WrongPassword;
    }
    map_sevenz_io_error(e)
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::source::archive::backend::ArchiveBackend as _;
    use crate::source::archive::backend::{
        ArchiveAccessError, ArchiveInput, ArchiveLimits, DecodeBudget,
    };
    use crate::source::archive::sevenz_backend::SevenZBackend;
    use std::path::PathBuf;
    use std::sync::Arc;
    use tempfile::tempdir;

    /// fixture 生成脚本 `tests/fixtures/archive/generate.py::make_png(1)` 的确定性输出
    /// （1244 bytes；与 zip/rar backend 测试共用同一真值——README「内容锁定」承诺）。
    const PNG_BYTES: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 16, 0, 0, 0, 24,
        8, 2, 0, 0, 0, 124, 194, 234, 91, 0, 0, 4, 163, 73, 68, 65, 84, 120, 1, 1, 152, 4, 103,
        251, 0, 37, 5, 67, 53, 8, 74, 69, 11, 81, 85, 14, 88, 101, 17, 95, 117, 20, 102, 133, 23,
        109, 149, 26, 116, 165, 29, 123, 181, 32, 130, 197, 35, 137, 213, 38, 144, 229, 41, 151,
        245, 44, 158, 5, 47, 165, 21, 50, 172, 0, 39, 16, 80, 55, 19, 87, 71, 22, 94, 87, 25, 101,
        103, 28, 108, 119, 31, 115, 135, 34, 122, 151, 37, 129, 167, 40, 136, 183, 43, 143, 199,
        46, 150, 215, 49, 157, 231, 52, 164, 247, 55, 171, 7, 58, 178, 23, 61, 185, 0, 41, 27, 93,
        57, 30, 100, 73, 33, 107, 89, 36, 114, 105, 39, 121, 121, 42, 128, 137, 45, 135, 153, 48,
        142, 169, 51, 149, 185, 54, 156, 201, 57, 163, 217, 60, 170, 233, 63, 177, 249, 66, 184,
        9, 69, 191, 25, 72, 198, 0, 43, 38, 106, 59, 41, 113, 75, 44, 120, 91, 47, 127, 107, 50,
        134, 123, 53, 141, 139, 56, 148, 155, 59, 155, 171, 62, 162, 187, 65, 169, 203, 68, 176,
        219, 71, 183, 235, 74, 190, 251, 77, 197, 11, 80, 204, 27, 83, 211, 0, 45, 49, 119, 61,
        52, 126, 77, 55, 133, 93, 58, 140, 109, 61, 147, 125, 64, 154, 141, 67, 161, 157, 70, 168,
        173, 73, 175, 189, 76, 182, 205, 79, 189, 221, 82, 196, 237, 85, 203, 253, 88, 210, 13,
        91, 217, 29, 94, 224, 0, 47, 60, 132, 63, 63, 139, 79, 66, 146, 95, 69, 153, 111, 72, 160,
        127, 75, 167, 143, 78, 174, 159, 81, 181, 175, 84, 188, 191, 87, 195, 207, 90, 202, 223,
        93, 209, 239, 96, 216, 255, 99, 223, 15, 102, 230, 31, 105, 237, 0, 49, 71, 145, 65, 74,
        152, 81, 77, 159, 97, 80, 166, 113, 83, 173, 129, 86, 180, 145, 89, 187, 161, 92, 194,
        177, 95, 201, 193, 98, 208, 209, 101, 215, 225, 104, 222, 241, 107, 229, 1, 110, 236, 17,
        113, 243, 33, 116, 250, 0, 51, 82, 158, 67, 85, 165, 83, 88, 172, 99, 91, 179, 115, 94,
        186, 131, 97, 193, 147, 100, 200, 163, 103, 207, 179, 106, 214, 195, 109, 221, 211, 112,
        228, 227, 115, 235, 243, 118, 242, 3, 121, 249, 19, 124, 0, 35, 127, 7, 0, 53, 93, 171,
        69, 96, 178, 85, 99, 185, 101, 102, 192, 117, 105, 199, 133, 108, 206, 149, 111, 213,
        165, 114, 220, 181, 117, 227, 197, 120, 234, 213, 123, 241, 229, 126, 248, 245, 129, 255,
        5, 132, 6, 21, 135, 13, 37, 138, 20, 0, 55, 104, 184, 71, 107, 191, 87, 110, 198, 103,
        113, 205, 119, 116, 212, 135, 119, 219, 151, 122, 226, 167, 125, 233, 183, 128, 240, 199,
        131, 247, 215, 134, 254, 231, 137, 5, 247, 140, 12, 7, 143, 19, 23, 146, 26, 39, 149, 33,
        0, 57, 115, 197, 73, 118, 204, 89, 121, 211, 105, 124, 218, 121, 127, 225, 137, 130, 232,
        153, 133, 239, 169, 136, 246, 185, 139, 253, 201, 142, 4, 217, 145, 11, 233, 148, 18,
        249, 151, 25, 9, 154, 32, 25, 157, 39, 41, 160, 46, 0, 59, 126, 210, 75, 129, 217, 91,
        132, 224, 107, 135, 231, 123, 138, 238, 139, 141, 245, 155, 144, 252, 171, 147, 3, 187,
        150, 10, 203, 153, 17, 219, 156, 24, 235, 159, 31, 251, 162, 38, 11, 165, 45, 27, 168,
        52, 43, 171, 59, 0, 61, 137, 223, 77, 140, 230, 93, 143, 237, 109, 146, 244, 125, 149,
        251, 141, 152, 2, 157, 155, 9, 173, 158, 16, 189, 161, 23, 205, 164, 30, 221, 167, 37,
        237, 170, 44, 253, 173, 51, 13, 176, 58, 29, 179, 65, 45, 182, 72, 0, 63, 148, 236, 79,
        151, 243, 95, 154, 250, 111, 157, 1, 127, 160, 8, 143, 163, 15, 159, 166, 22, 175, 169,
        29, 191, 172, 36, 207, 175, 43, 223, 178, 50, 239, 181, 57, 255, 184, 64, 15, 187, 71,
        31, 190, 78, 47, 193, 85, 0, 65, 159, 249, 81, 162, 0, 97, 165, 7, 113, 168, 14, 129,
        171, 21, 145, 174, 28, 161, 177, 35, 177, 180, 42, 193, 183, 49, 209, 186, 56, 225, 189,
        63, 241, 192, 70, 1, 195, 77, 17, 198, 84, 33, 201, 91, 49, 204, 98, 0, 67, 170, 6, 83,
        173, 13, 99, 176, 20, 115, 179, 27, 131, 182, 34, 147, 185, 41, 163, 188, 48, 179, 191,
        55, 195, 194, 62, 211, 197, 69, 227, 200, 76, 243, 203, 83, 3, 206, 90, 19, 209, 97, 35,
        212, 104, 51, 215, 111, 0, 69, 181, 19, 85, 184, 26, 101, 187, 33, 117, 190, 40, 133,
        193, 47, 149, 196, 54, 165, 199, 61, 181, 202, 68, 197, 205, 75, 213, 208, 82, 229, 211,
        89, 245, 214, 96, 5, 217, 103, 21, 220, 110, 37, 223, 117, 53, 226, 124, 0, 71, 192, 32,
        87, 195, 39, 103, 198, 46, 119, 201, 53, 135, 204, 60, 151, 207, 67, 167, 210, 74, 183,
        213, 81, 199, 216, 88, 215, 219, 95, 231, 222, 102, 247, 225, 109, 7, 228, 116, 23, 231,
        123, 39, 234, 130, 55, 237, 137, 0, 73, 203, 45, 89, 206, 52, 105, 209, 59, 121, 212, 66,
        137, 215, 73, 153, 218, 80, 169, 221, 87, 185, 224, 94, 201, 227, 101, 217, 230, 108,
        233, 233, 115, 249, 236, 122, 9, 239, 129, 25, 242, 136, 41, 245, 143, 57, 248, 150, 0,
        75, 214, 58, 91, 217, 65, 107, 220, 72, 123, 223, 79, 139, 226, 86, 155, 229, 93, 171,
        232, 100, 187, 235, 107, 203, 238, 114, 219, 241, 121, 235, 244, 128, 251, 247, 135, 11,
        250, 142, 27, 253, 149, 43, 0, 156, 59, 3, 163, 0, 77, 225, 71, 93, 228, 78, 109, 231,
        85, 125, 234, 92, 141, 237, 99, 157, 240, 106, 173, 243, 113, 189, 246, 120, 205, 249,
        127, 221, 252, 134, 237, 255, 141, 253, 2, 148, 13, 5, 155, 29, 8, 162, 45, 11, 169, 61,
        14, 176, 0, 79, 236, 84, 95, 239, 91, 111, 242, 98, 127, 245, 105, 143, 248, 112, 159,
        251, 119, 175, 254, 126, 191, 1, 133, 207, 4, 140, 223, 7, 147, 239, 10, 154, 255, 13,
        161, 15, 16, 168, 31, 19, 175, 47, 22, 182, 63, 25, 189, 0, 81, 247, 97, 97, 250, 104,
        113, 253, 111, 129, 0, 118, 145, 3, 125, 161, 6, 132, 177, 9, 139, 193, 12, 146, 209, 15,
        153, 225, 18, 160, 241, 21, 167, 1, 24, 174, 17, 27, 181, 33, 30, 188, 49, 33, 195, 65,
        36, 202, 0, 83, 2, 110, 99, 5, 117, 115, 8, 124, 131, 11, 131, 147, 14, 138, 163, 17,
        145, 179, 20, 152, 195, 23, 159, 211, 26, 166, 227, 29, 173, 243, 32, 180, 3, 35, 187,
        19, 38, 194, 35, 41, 201, 51, 44, 208, 67, 47, 215, 23, 69, 60, 159, 50, 210, 84, 12, 0,
        0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    fn fixture_input(name: &str) -> ArchiveInput {
        ArchiveInput::Path(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("archive")
                .join(name),
        )
    }

    pub(crate) fn create_7z(solid: bool, password: Option<&str>) -> (tempfile::TempDir, PathBuf) {
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
                writer
                    .push_archive_entry(
                        sevenz_rust::SevenZArchiveEntry::from_path(&src, name.to_string()),
                        Some(std::fs::File::open(&src).unwrap()),
                    )
                    .unwrap();
            }
        }
        writer.finish().unwrap();
        (dir, out)
    }

    pub(crate) fn create_solid_7z_with_files<S: AsRef<str>>(
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
            writer
                .push_archive_entry(
                    sevenz_rust::SevenZArchiveEntry::from_path(&src, name.to_string()),
                    Some(std::fs::File::open(&src).unwrap()),
                )
                .unwrap();
        }
        writer.finish().unwrap();
        (dir, out)
    }

    fn create_7z_content_encrypted_only_file(name: &str, pw: &str) -> (tempfile::TempDir, PathBuf) {
        create_7z_with_files(&[name], Some(pw), false) // 内容加密、header 可见
    }

    fn create_7z_header_encrypted_only_file(name: &str, pw: &str) -> (tempfile::TempDir, PathBuf) {
        // header + 内容都加密（默认值语义）。SevenZWriter 的 header 加密只在 encoded 路径
        // 生效——单条目小 header 会走「压缩不划算 → raw header」回退（write_encoded_header
        // 的 compress_size + 20 >= size 分支），因此附带填充条目把 header 顶过编码阈值，
        // 使无密码 probe 在预检阶段即 PasswordRequired（对照断言的合同载体）。
        let filler: Vec<String> = (0..64).map(|i| format!("pad/{i:04}.bin")).collect();
        let mut names: Vec<&str> = vec![name];
        names.extend(filler.iter().map(String::as_str));
        create_7z_with_files(&names, Some(pw), true)
    }

    fn create_7z_empty() -> (tempfile::TempDir, PathBuf) {
        create_7z_with_files(&[] as &[&str], None, false) // 空切片显式元素类型
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
            assert_eq!(
                SevenZBackend
                    .read_entry(&input, "page1.png", None, &mut DecodeBudget::unbounded())
                    .unwrap(),
                PNG_BYTES
            );
        }
        let encrypted_input = ArchiveInput::Path(encrypted);
        assert_eq!(
            SevenZBackend.catalog(&encrypted_input, "", None).unwrap_err(),
            ArchiveAccessError::PasswordRequired
        );
        assert_eq!(
            SevenZBackend
                .read_entry(
                    &encrypted_input,
                    "page1.png",
                    Some(b"wrong"),
                    &mut DecodeBudget::unbounded()
                )
                .unwrap_err(),
            ArchiveAccessError::WrongPassword
        );
        assert_eq!(
            SevenZBackend
                .read_entry(
                    &encrypted_input,
                    "page1.png",
                    Some("test-pass-中文".as_bytes()),
                    &mut DecodeBudget::unbounded()
                )
                .unwrap(),
            PNG_BYTES
        );
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
    fn split_7z_any_numeric_volume_suffix_is_rejected() {
        // 只认 .001 会让 .002 及以后漏进解析、被误分类为损坏/IO——完整数字卷号模式
        let dir = tempdir().unwrap();
        for name in ["book.7z.002", "book.7z.010", "book.7z.999", "大写.7z.003"] {
            let path = dir.path().join(name);
            assert!(
                matches!(
                    SevenZBackend.catalog(&ArchiveInput::Path(path), "", None),
                    Err(ArchiveAccessError::MultiVolumeUnsupported(_))
                ),
                "{name} 应按多卷拒绝"
            );
        }
        // 对照：非数字后缀不是分卷（进入正常解析，按损坏/不存在分类）
        let not_split = dir.path().join("book.7z.backup");
        assert!(
            !matches!(
                SevenZBackend.catalog(&ArchiveInput::Path(not_split), "", None),
                Err(ArchiveAccessError::MultiVolumeUnsupported(_))
            ),
            ".backup 后缀不应按多卷拒绝"
        );
    }

    #[test]
    fn sevenz_probe_falls_back_to_encrypted_non_image_and_reports_empty() {
        // SevenZWriter 默认 set_encrypt_header(true)（docs 明示）——fallback fixture 必须显式关闭
        // header 加密（内容加密、header 可见），否则无密码 probe 在看到 note.txt 前就 PasswordRequired。
        let (_guard_nonimage, nonimage) =
            create_7z_content_encrypted_only_file("note.txt", "test-pass-中文");
        let probe = SevenZBackend
            .probe(&ArchiveInput::Path(nonimage), "", None)
            .unwrap();
        assert_eq!(probe.image_count, 0);
        assert!(probe.first_encrypted_file.is_some());
        // 对照：header 加密变体（保持默认 set_encrypt_header(true)）无密码 probe 直接 PasswordRequired
        let (_guard_header, header_encrypted) =
            create_7z_header_encrypted_only_file("note.txt", "test-pass-中文");
        assert!(matches!(
            SevenZBackend.probe(&ArchiveInput::Path(header_encrypted), "", None),
            Err(ArchiveAccessError::PasswordRequired)
        ));
        let (_guard_empty, empty) = create_7z_empty();
        assert_eq!(
            SevenZBackend
                .probe(&ArchiveInput::Path(empty), "", None)
                .unwrap()
                .entry_count,
            0
        );
    }

    #[test]
    fn sevenz_probe_image_count_is_prefix_scoped() {
        // 与 ZIP 同款回归：a/note.txt + b/page.png——a/ 视图无图、全包 1 图
        let (_guard_dirs, dirs) = create_7z_with_files(&["a/note.txt", "b/page.png"], None, false);
        let scoped = SevenZBackend
            .probe(&ArchiveInput::Path(dirs.clone()), "a/", None)
            .unwrap();
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
                SevenZBackend.read_entry(
                    &fixture_input(fixture),
                    "page.png",
                    None,
                    &mut DecodeBudget::unbounded()
                ),
                Err(ArchiveAccessError::ResourceLimitExceeded(_))
            ));
        }
        // 注入小上限等价覆盖：正常小包在 64 KiB dict 上限下同样被拒（LZMA2 最小档即 256 KiB）
        let (_guard_normal, normal) = create_7z_with_files(&["page.png"], None, false);
        assert!(matches!(
            SevenZBackend::with_test_limits(ArchiveLimits::for_test().dict_bytes(64 * 1024))
                .read_entry(
                    &ArchiveInput::Path(normal),
                    "page.png",
                    None,
                    &mut DecodeBudget::unbounded()
                ),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }

    #[tokio::test]
    async fn sevenz_workspace_budget_rejects_oversized_sum_instead_of_clamping() {
        // 注入 6 MiB 预算：dict 4 MiB + 声明输出 3 MiB = 7 MiB > 6 → DecodeBudget::for_limits
        // 构造即拒绝（Service 声明预检步骤①由该构造承载），不得 min() 钳到预算内放行
        let limits = ArchiveLimits::for_test().budget_bytes(6 * 1024 * 1024);
        let semaphore = Arc::new(tokio::sync::Semaphore::new(6));
        assert!(DecodeBudget::for_limits(
            &limits,
            3 * 1024 * 1024,
            4 * 1024 * 1024,
            semaphore
        )
        .await
        .is_err());
        // 预算 8 MiB 时同一组（和 7 ≤ 8）构造通过；writer 输出上限 = 8 - 4 = 4 MiB ≥ 3 MiB → 读取成功
        let bigger = ArchiveLimits::for_test().budget_bytes(8 * 1024 * 1024);
        let semaphore = Arc::new(tokio::sync::Semaphore::new(8));
        let mut budget =
            DecodeBudget::for_limits(&bigger, 3 * 1024 * 1024, 4 * 1024 * 1024, semaphore)
                .await
                .unwrap();
        assert!(SevenZBackend::default()
            .read_entry(
                &fixture_input("dict-budget-oversum.7z"),
                "page.png",
                None,
                &mut budget
            )
            .is_ok());
    }

    #[test]
    fn sevenz_probe_limits_apply_to_non_image_entries_and_paths() {
        // 与 ZIP 同款注入小上限合同：9 个非图片条目或超长路径名都不得等图片过滤后才报错
        let backend =
            SevenZBackend::with_test_limits(ArchiveLimits::for_test().entry_count(8).path_bytes(64));
        let (_guard_many, many) = create_7z_with_files(
            &[
                "file0.txt", "file1.txt", "file2.txt", "file3.txt", "file4.txt", "file5.txt",
                "file6.txt", "file7.txt", "file8.txt",
            ],
            None,
            false,
        );
        assert!(matches!(
            backend.probe(&ArchiveInput::Path(many), "", None),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
        let long_name = format!("{}.txt", "a".repeat(65));
        let (_guard_long, long) = create_7z_with_files(&[long_name.as_str()], None, false);
        assert!(matches!(
            backend.probe(&ArchiveInput::Path(long), "", None),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }

    #[test]
    fn sevenz_reader_input_is_rejected_with_remote_range_unavailable() {
        let factory: crate::source::archive::backend::ReaderFactory =
            Arc::new(|| unreachable!("7z 不应触碰 Reader"));
        assert!(matches!(
            SevenZBackend.probe(&ArchiveInput::Reader(factory), "", None),
            Err(ArchiveAccessError::RemoteRangeUnavailable(_))
        ));
    }

    #[test]
    fn sevenz_stat_and_prefix_catalog_match_names() {
        let (_guard, path) = create_7z_with_files(&["a/note.txt", "b/page.png"], None, false);
        let input = ArchiveInput::Path(path);
        assert_eq!(
            SevenZBackend.stat_entry(&input, "b/page.png", None).unwrap(),
            PNG_BYTES.len() as u64
        );
        assert!(matches!(
            SevenZBackend.stat_entry(&input, "missing.png", None),
            Err(ArchiveAccessError::EntryNotFound(_))
        ));
        let scoped = SevenZBackend.catalog(&input, "b/", None).unwrap();
        assert_eq!(scoped.entries.len(), 1);
        assert_eq!(scoped.entries[0].name, "page.png");
        // 声明值超限（注入小上限）
        let limited = SevenZBackend::with_test_limits(ArchiveLimits::for_test().entry_bytes(8));
        assert!(matches!(
            limited.stat_entry(&input, "b/page.png", None),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }

    #[test]
    fn sevenz_probe_reports_entry_dictionaries_per_folder() {
        // entry_dictionaries 按 file→folder 归属填表（solid folder 内多条目共享同值）
        let (_guard, path) =
            create_solid_7z_with_files(&["p0.png", "p1.png", "p2.png"], None, false);
        let probe = SevenZBackend
            .probe(&ArchiveInput::Path(path), "", None)
            .unwrap();
        assert_eq!(probe.entry_dictionaries.len(), 3);
        let dicts: Vec<u64> = probe.entry_dictionaries.values().copied().collect();
        assert!(dicts.iter().all(|d| *d == dicts[0]));
    }
}
