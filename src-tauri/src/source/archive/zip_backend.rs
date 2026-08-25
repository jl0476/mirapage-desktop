//! ZIP backend：`ArchiveBackend` 的 zip 2.4.2 实现。
//!
//! 任务 4（ZIP 路径化、ZipCrypto/AES 与零行为回归）：
//! - `ArchiveInput::Path`（本地/物化文件）与 `Reader`（远程 Range 工厂，任务 9 接入）
//!   走**同一** ZIP 逻辑——`open_reader` 单一入口，无整包 `Vec<u8>` 读取。
//! - 密码：ZipCrypto / WinZip AE-1 / AE-2 内容加密由 `zip` crate `aes-crypto` 解；
//!   密码字节语义 UTF-8（`String::as_bytes()`，与 fixtures 契约一致）。central
//!   directory 对内容加密包**无密码可列**——加密元数据只存在于 `probe` 一个真值源，
//!   `catalog` 不做任何密码需求判定（`PasswordRequired` 判定权在 Service，任务 7）。
//! - 多卷：`ZipArchive::new` 前用小型 EOCD/ZIP64 parser 预检 disk number、
//!   central-directory start disk 与 per-disk entry count，命中即
//!   `MultiVolumeUnsupported`，不解析第三方错误字符串。
//! - 资源限额（spec §4.5）：probe/catalog 扫描循环对**每个原始条目（含被过滤的非
//!   图片）**检查条目总数 / 路径字节数 / 声明解压大小；`read_entry` 经
//!   `LimitedEntryWriter` 解压（声明值预检 + writer 双闸）；`stat_entry` 读 central
//!   directory 声明 size 超限即拒。

use crate::algorithm::mime::is_image;
use crate::algorithm::natural_compare;
use crate::source::archive::backend::{
    ArchiveAccessError, ArchiveBackend, ArchiveCatalog, ArchiveInput, ArchiveLimits,
    ArchiveProbe, ArchiveReadSeek, BudgetRetryIoError, DecodeBudget, LimitedEntryIoError,
    LimitedEntryWriter, RemoteZipIoError,
};
use crate::source::descriptor::MediaEntry;
use std::io::{ErrorKind, Read, Seek, SeekFrom};

/// EOCD（End of Central Directory）最小长度与签名（`PK\x05\x06`）
const EOCD_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
const EOCD_MIN_LEN: usize = 22;
/// ZIP64 EOCD 记录（固定部分）长度与签名（`PK\x06\x06`）
const ZIP64_EOCD_SIGNATURE: [u8; 4] = *b"PK\x06\x06";
const ZIP64_EOCD_LEN: usize = 56;
/// ZIP64 EOCD locator 长度与签名（`PK\x06\x07`）
const ZIP64_LOCATOR_SIGNATURE: [u8; 4] = *b"PK\x06\x07";
const ZIP64_LOCATOR_LEN: usize = 20;
/// EOCD comment 最大长度（尾部扫描窗口由此决定）
const MAX_ZIP_COMMENT: usize = 65_535;

/// `read_entry` 解压循环的单次读块
const READ_CHUNK: usize = 64 * 1024;

/// ZIP 后端（生产单例，零值）：`ZipBackend` 同时占据类型与值命名空间，调用方可直接
/// `ZipBackend.catalog(..)`（生产限额 = `ArchiveLimits::production()`）。测试注入限额
/// 用 [`ZipBackend::with_test_limits`]。
pub struct ZipBackend;

/// 携带注入限额的 ZIP 后端实例：与 `ZipBackend` 共享同一实现（free function 内核）。
pub struct LimitedZipBackend {
    limits: ArchiveLimits,
}

impl ZipBackend {
    /// 测试构造：每个用例只缩小自己验证的限额维度（`ArchiveLimits::for_test` 合同）。
    pub fn with_test_limits(limits: ArchiveLimits) -> LimitedZipBackend {
        LimitedZipBackend { limits }
    }
}

impl ArchiveBackend for ZipBackend {
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        probe_zip(input, prefix, password, &ArchiveLimits::production())
    }

    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError> {
        catalog_zip(input, prefix, password, &ArchiveLimits::production())
    }

    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        read_entry_zip(input, entry, password, budget, &ArchiveLimits::production())
    }

    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError> {
        stat_entry_zip(input, entry, password, &ArchiveLimits::production())
    }
}

impl ArchiveBackend for LimitedZipBackend {
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        probe_zip(input, prefix, password, &self.limits)
    }

    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError> {
        catalog_zip(input, prefix, password, &self.limits)
    }

    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        read_entry_zip(input, entry, password, budget, &self.limits)
    }

    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError> {
        stat_entry_zip(input, entry, password, &self.limits)
    }
}

// ---------------------------------------------------------------------------
// 打开与错误映射（任务 4 步骤 3 合同）
// ---------------------------------------------------------------------------

fn open_reader(input: &ArchiveInput) -> Result<Box<dyn ArchiveReadSeek>, ArchiveAccessError> {
    match input {
        ArchiveInput::Path(path) => std::fs::File::open(path)
            .map(|f| Box::new(f) as Box<dyn ArchiveReadSeek>)
            .map_err(|e| ArchiveAccessError::Io(e.to_string())),
        ArchiveInput::Reader(factory) => factory(),
    }
}

/// 唯一的 io::Error 边界映射。五臂顺序固定（任务 4 合同）：
/// Remote marker 恢复稳定分类 → BudgetRetry marker 恢复 `BudgetRetryRequired`
/// → Limited marker 映射 `ResourceLimitExceeded` → `ErrorKind::InvalidData` 映射
/// `CorruptArchive`（CRC/MAC 校验失败）→ 普通 `Io`。
fn map_zip_io_error(e: std::io::Error) -> ArchiveAccessError {
    if let Some(remote) = e.get_ref().and_then(|c| c.downcast_ref::<RemoteZipIoError>()) {
        return remote.0.clone();
    }
    if e.get_ref().is_some_and(|c| c.is::<BudgetRetryIoError>()) {
        return ArchiveAccessError::BudgetRetryRequired;
    }
    if let Some(limited) = e.get_ref().and_then(|c| c.downcast_ref::<LimitedEntryIoError>()) {
        return ArchiveAccessError::ResourceLimitExceeded(limited.to_string());
    }
    match e.kind() {
        ErrorKind::InvalidData => ArchiveAccessError::CorruptArchive(e.to_string()),
        _ => ArchiveAccessError::Io(e.to_string()),
    }
}

/// `ZipError` → `ArchiveAccessError`：invalid password / unsupported compression
/// （含 `PASSWORD_REQUIRED` 特例）/ missing file / invalid archive 分别映射
/// `WrongPassword` / `UnsupportedCodec`（或 `PasswordRequired`）/ `EntryNotFound`
/// / `CorruptArchive`；`ZipError::Io` 委托 [`map_zip_io_error`]。
fn map_zip_error(e: zip::result::ZipError) -> ArchiveAccessError {
    use zip::result::ZipError;
    match e {
        ZipError::Io(io) => map_zip_io_error(io),
        ZipError::InvalidArchive(msg) => ArchiveAccessError::CorruptArchive(msg.to_string()),
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) => {
            ArchiveAccessError::PasswordRequired
        }
        ZipError::UnsupportedArchive(msg) => ArchiveAccessError::UnsupportedCodec(msg.to_string()),
        ZipError::FileNotFound => ArchiveAccessError::EntryNotFound(String::new()),
        ZipError::InvalidPassword => ArchiveAccessError::WrongPassword,
        // ZipError 标记 #[non_exhaustive]：未来变体保守归入 CorruptArchive
        _ => ArchiveAccessError::CorruptArchive(e.to_string()),
    }
}

/// 按名取条目：有密码走 `by_name_decrypt`（AE-1/AE-2/ZipCrypto 的密码校验发生在
/// 此处——AES 2 字节验证值 / ZipCrypto 12 字节头 check byte），无密码走 `by_name`。
/// `FileNotFound` 携带条目名映射 `EntryNotFound`（其余经 [`map_zip_error`]）。
/// 注：zip 2.4.2 的 `ZipFile` 只借生命周期（内部持有 `&mut R`），无 Reader 泛型参数。
fn by_name<'a, R: Read + Seek>(
    zip: &'a mut zip::ZipArchive<R>,
    name: &str,
    password: Option<&[u8]>,
) -> Result<zip::read::ZipFile<'a>, ArchiveAccessError> {
    match password {
        Some(p) => zip.by_name_decrypt(name, p),
        None => zip.by_name(name),
    }
    .map_err(|e| match e {
        zip::result::ZipError::FileNotFound => {
            ArchiveAccessError::EntryNotFound(name.to_string())
        }
        other => map_zip_error(other),
    })
}

// ---------------------------------------------------------------------------
// EOCD/ZIP64 多卷预检（`ZipArchive::new` 之前）
// ---------------------------------------------------------------------------

fn u16_le(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_le(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u64_le(b: &[u8], at: usize) -> u64 {
    let mut v = [0u8; 8];
    v.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(v)
}

fn multi_volume(detail: impl Into<String>) -> ArchiveAccessError {
    ArchiveAccessError::MultiVolumeUnsupported(detail.into())
}

/// EOCD/ZIP64 多卷预检：disk number、central-directory start disk、per-disk entry
/// count 任一字段表明 multi-disk 即 `MultiVolumeUnsupported`。解析不出 EOCD（畸形
/// 输入）时放行，由 `ZipArchive::new` 的错误经 [`map_zip_error`] 分类。
fn check_multidisk<R: Read + Seek + ?Sized>(reader: &mut R) -> Result<(), ArchiveAccessError> {
    let len = reader.seek(SeekFrom::End(0)).map_err(map_zip_io_error)?;
    if len < EOCD_MIN_LEN as u64 {
        return Ok(());
    }
    // 尾部窗口：EOCD(22) + comment(≤64 KiB) + locator(20) + z64 EOCD 固定部分(56)
    let tail_len = (len as usize).min(EOCD_MIN_LEN + MAX_ZIP_COMMENT + ZIP64_LOCATOR_LEN + ZIP64_EOCD_LEN);
    reader
        .seek(SeekFrom::Start(len - tail_len as u64))
        .map_err(map_zip_io_error)?;
    let mut tail = vec![0u8; tail_len];
    reader.read_exact(&mut tail).map_err(map_zip_io_error)?;

    // 自尾向前找 EOCD，且 comment 长度必须精确闭合到文件尾（排除 comment 内容里的伪签名）
    let Some(rel) = (0..tail.len().saturating_sub(EOCD_MIN_LEN - 1))
        .rev()
        .find(|&i| {
            &tail[i..i + 4] == EOCD_SIGNATURE
                && i + EOCD_MIN_LEN + u16_le(&tail, i + 20) as usize == tail.len()
        })
    else {
        return Ok(());
    };
    let disk = u16_le(&tail, rel + 4);
    let cd_disk = u16_le(&tail, rel + 6);
    let disk_entries = u16_le(&tail, rel + 8);
    let total_entries = u16_le(&tail, rel + 10);
    let cd_offset = u32_le(&tail, rel + 16);
    let sentinel = disk == 0xFFFF
        || cd_disk == 0xFFFF
        || disk_entries == 0xFFFF
        || total_entries == 0xFFFF
        || cd_offset == 0xFFFF_FFFF;
    if !sentinel {
        if disk != 0 {
            return Err(multi_volume(format!("EOCD disk number {disk}")));
        }
        if cd_disk != 0 {
            return Err(multi_volume(format!(
                "central directory starts on disk {cd_disk}"
            )));
        }
        if disk_entries != total_entries {
            return Err(multi_volume(format!(
                "entries split across disks: {disk_entries} on this disk / {total_entries} total"
            )));
        }
        return Ok(());
    }

    // 0xFFFF 哨兵 → ZIP64：locator 紧邻 EOCD 之前
    if rel < ZIP64_LOCATOR_LEN {
        return Ok(()); // locator 不完整，交给 ZipArchive::new 分类
    }
    let locator = &tail[rel - ZIP64_LOCATOR_LEN..rel];
    if locator[..4] != ZIP64_LOCATOR_SIGNATURE {
        return Ok(());
    }
    let z64_disk = u32_le(locator, 4);
    let z64_offset = u64_le(locator, 8);
    let total_disks = u32_le(locator, 16);
    if z64_disk != 0 {
        return Err(multi_volume(format!(
            "ZIP64 EOCD lives on disk {z64_disk}"
        )));
    }
    if total_disks > 1 {
        return Err(multi_volume(format!("archive spans {total_disks} disks")));
    }
    let Some(z64_end) = z64_offset.checked_add(ZIP64_EOCD_LEN as u64) else {
        return Ok(());
    };
    if z64_end > len {
        return Ok(());
    }
    reader
        .seek(SeekFrom::Start(z64_offset))
        .map_err(map_zip_io_error)?;
    let mut z64 = [0u8; ZIP64_EOCD_LEN];
    reader.read_exact(&mut z64).map_err(map_zip_io_error)?;
    if z64[..4] != ZIP64_EOCD_SIGNATURE {
        return Ok(());
    }
    let disk = u32_le(&z64, 16);
    let cd_disk = u32_le(&z64, 20);
    let disk_entries = u64_le(&z64, 24);
    let total_entries = u64_le(&z64, 32);
    if disk != 0 {
        return Err(multi_volume(format!("ZIP64 disk number {disk}")));
    }
    if cd_disk != 0 {
        return Err(multi_volume(format!(
            "central directory starts on disk {cd_disk} (ZIP64)"
        )));
    }
    if disk_entries != total_entries {
        return Err(multi_volume(format!(
            "entries split across disks (ZIP64): {disk_entries} on this disk / {total_entries} total"
        )));
    }
    Ok(())
}

type ZipReaderArchive = zip::ZipArchive<Box<dyn ArchiveReadSeek>>;

/// 单一打开入口：open_reader（Path/Reader 同逻辑）→ 多卷预检 → `ZipArchive::new`。
fn open_archive(input: &ArchiveInput) -> Result<ZipReaderArchive, ArchiveAccessError> {
    let mut reader = open_reader(input)?;
    check_multidisk(reader.as_mut())?;
    zip::ZipArchive::new(reader).map_err(map_zip_error)
}

// ---------------------------------------------------------------------------
// probe / catalog / read_entry / stat_entry
// ---------------------------------------------------------------------------

/// 对**每个原始条目**（含被 prefix/图片过滤掉的非图片条目）执行资源限额：
/// 总条目数（`index >= max` 即超——计数计入全部条目而非仅图片）、规范化路径字节数、
/// 声明解压大小。任一超限立即 `ResourceLimitExceeded`，不得先过滤再限额。
fn check_raw_entry_limits(
    index: usize,
    name: &str,
    declared_size: u64,
    limits: &ArchiveLimits,
) -> Result<(), ArchiveAccessError> {
    if index >= limits.max_catalog_entries {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "zip entries exceed {}",
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

/// probe：只扫 central directory（`by_index_raw`，不读 payload、不触发密码校验）。
/// ZIP 的 central directory 恒为明文，`password` 不参与（trait 签名保留）。
fn probe_zip(
    input: &ArchiveInput,
    prefix: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
) -> Result<ArchiveProbe, ArchiveAccessError> {
    let _ = password;
    let mut archive = open_archive(input)?;
    let mut probe = ArchiveProbe::default();
    for i in 0..archive.len() {
        let (name, declared, encrypted) = {
            let entry = archive.by_index_raw(i).map_err(map_zip_error)?;
            (
                entry.name().to_string(),
                entry.size(),
                entry.encrypted(),
            )
        };
        check_raw_entry_limits(i, &name, declared, limits)?;
        // entry_count：全容器计数（资源限额基线），不受 prefix 影响
        probe.entry_count += 1;
        if !name.starts_with(prefix) {
            continue;
        }
        if is_image(&name) {
            probe.image_count += 1;
            if encrypted && probe.first_encrypted_image.is_none() {
                probe.first_encrypted_image = Some(name);
            }
        } else if encrypted && probe.first_encrypted_file.is_none() {
            probe.first_encrypted_file = Some(name);
        }
    }
    Ok(probe)
}

/// catalog：只列目录——`entryPrefix` + `is_image` + 自然排序（与 M3 `list_archive_entries`
/// 同语义，任务 2 特征测试锁定）。**不做任何密码需求判定**：加密图片照常列出。
fn catalog_zip(
    input: &ArchiveInput,
    prefix: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
) -> Result<ArchiveCatalog, ArchiveAccessError> {
    let _ = password;
    let mut archive = open_archive(input)?;
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let (name, declared) = {
            let entry = archive.by_index_raw(i).map_err(map_zip_error)?;
            (entry.name().to_string(), entry.size())
        };
        check_raw_entry_limits(i, &name, declared, limits)?;
        if !name.starts_with(prefix) {
            continue;
        }
        if !is_image(&name) {
            continue;
        }
        // entry 路径相对于 entry_prefix（M3 同款剥离语义）
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            name.strip_prefix(prefix)
                .map(|s| s.trim_start_matches('/').to_string())
                .unwrap_or_else(|| name.clone())
        };
        // ZIP 内 DOS 时间戳精度低（2-sec）且 `DateTime` 无 timestamp() 方法；
        // 漫画阅读器场景 archive 条目 modified_at 不展示（M3 同款决策），留 None。
        out.push(MediaEntry {
            name: relative.clone(),
            path: relative,
            is_directory: false,
            is_archive: false,
            size: declared,
            modified_at: None,
        });
    }
    out.sort_by(|a, b| natural_compare(&a.name, &b.name));
    Ok(ArchiveCatalog { entries: out })
}

/// read_entry：密码校验 + CRC/MAC 完整性校验发生在 `zip` crate 读取路径内
/// （`by_name_decrypt` 的密码验证；EOF 处 Crc32Reader/AES HMAC——错误经
/// [`map_zip_io_error`] 映射 `CorruptArchive`）。解压经 `LimitedEntryWriter`：
/// 声明值预检（`limits.max_entry_bytes`）→ 整段 ensure（声明大小一次覆盖，分块
/// 写入全落既有 capacity）→ 64 KiB 分块循环。budget 被**消费**（writer 持有并
/// 在交付时释放许可；调用方槽位以 unbounded 占位补齐）。
fn read_entry_zip(
    input: &ArchiveInput,
    entry: &str,
    password: Option<&[u8]>,
    budget: &mut DecodeBudget,
    limits: &ArchiveLimits,
) -> Result<Vec<u8>, ArchiveAccessError> {
    let mut archive = open_archive(input)?;
    let mut file = by_name(&mut archive, entry, password)?;
    let declared = file.size();
    if declared > limits.max_entry_bytes {
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
            .map_err(map_zip_io_error)?;
    }
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        let n = file.read(&mut chunk).map_err(map_zip_io_error)?;
        if n == 0 {
            break;
        }
        writer.write_all(&chunk[..n]).map_err(map_zip_io_error)?;
    }
    Ok(writer.finish())
}

/// stat_entry：读 central directory 声明的解压后 size（明文元数据，无密码参与），
/// 超过 `limits.max_entry_bytes` 直接 `ResourceLimitExceeded`。
fn stat_entry_zip(
    input: &ArchiveInput,
    entry: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
) -> Result<u64, ArchiveAccessError> {
    let _ = password;
    let mut archive = open_archive(input)?;
    let index = archive
        .index_for_name(entry)
        .ok_or_else(|| ArchiveAccessError::EntryNotFound(entry.to_string()))?;
    let size = {
        let file = archive.by_index_raw(index).map_err(map_zip_error)?;
        file.size()
    };
    if size > limits.max_entry_bytes {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "entry {entry} declares {size} bytes exceeding {}",
            limits.max_entry_bytes
        )));
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::archive::backend::{budget_with_output_cap, ReaderFactory};
    use std::io::ErrorKind;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tempfile::tempdir;

    /// fixture 生成脚本 `tests/fixtures/archive/generate.py::make_png(1)` 的确定性输出
    /// （1244 bytes；README「内容锁定」承诺——fixtures 内 page1.png 的真值字节）。
    const PNG_BYTES: &[u8] = &[
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        0, 0, 0, 16, 0, 0, 0, 24, 8, 2, 0, 0, 0, 124, 194, 234,
        91, 0, 0, 4, 163, 73, 68, 65, 84, 120, 1, 1, 152, 4, 103, 251,
        0, 37, 5, 67, 53, 8, 74, 69, 11, 81, 85, 14, 88, 101, 17, 95,
        117, 20, 102, 133, 23, 109, 149, 26, 116, 165, 29, 123, 181, 32, 130, 197,
        35, 137, 213, 38, 144, 229, 41, 151, 245, 44, 158, 5, 47, 165, 21, 50,
        172, 0, 39, 16, 80, 55, 19, 87, 71, 22, 94, 87, 25, 101, 103, 28,
        108, 119, 31, 115, 135, 34, 122, 151, 37, 129, 167, 40, 136, 183, 43, 143,
        199, 46, 150, 215, 49, 157, 231, 52, 164, 247, 55, 171, 7, 58, 178, 23,
        61, 185, 0, 41, 27, 93, 57, 30, 100, 73, 33, 107, 89, 36, 114, 105,
        39, 121, 121, 42, 128, 137, 45, 135, 153, 48, 142, 169, 51, 149, 185, 54,
        156, 201, 57, 163, 217, 60, 170, 233, 63, 177, 249, 66, 184, 9, 69, 191,
        25, 72, 198, 0, 43, 38, 106, 59, 41, 113, 75, 44, 120, 91, 47, 127,
        107, 50, 134, 123, 53, 141, 139, 56, 148, 155, 59, 155, 171, 62, 162, 187,
        65, 169, 203, 68, 176, 219, 71, 183, 235, 74, 190, 251, 77, 197, 11, 80,
        204, 27, 83, 211, 0, 45, 49, 119, 61, 52, 126, 77, 55, 133, 93, 58,
        140, 109, 61, 147, 125, 64, 154, 141, 67, 161, 157, 70, 168, 173, 73, 175,
        189, 76, 182, 205, 79, 189, 221, 82, 196, 237, 85, 203, 253, 88, 210, 13,
        91, 217, 29, 94, 224, 0, 47, 60, 132, 63, 63, 139, 79, 66, 146, 95,
        69, 153, 111, 72, 160, 127, 75, 167, 143, 78, 174, 159, 81, 181, 175, 84,
        188, 191, 87, 195, 207, 90, 202, 223, 93, 209, 239, 96, 216, 255, 99, 223,
        15, 102, 230, 31, 105, 237, 0, 49, 71, 145, 65, 74, 152, 81, 77, 159,
        97, 80, 166, 113, 83, 173, 129, 86, 180, 145, 89, 187, 161, 92, 194, 177,
        95, 201, 193, 98, 208, 209, 101, 215, 225, 104, 222, 241, 107, 229, 1, 110,
        236, 17, 113, 243, 33, 116, 250, 0, 51, 82, 158, 67, 85, 165, 83, 88,
        172, 99, 91, 179, 115, 94, 186, 131, 97, 193, 147, 100, 200, 163, 103, 207,
        179, 106, 214, 195, 109, 221, 211, 112, 228, 227, 115, 235, 243, 118, 242, 3,
        121, 249, 19, 124, 0, 35, 127, 7, 0, 53, 93, 171, 69, 96, 178, 85,
        99, 185, 101, 102, 192, 117, 105, 199, 133, 108, 206, 149, 111, 213, 165, 114,
        220, 181, 117, 227, 197, 120, 234, 213, 123, 241, 229, 126, 248, 245, 129, 255,
        5, 132, 6, 21, 135, 13, 37, 138, 20, 0, 55, 104, 184, 71, 107, 191,
        87, 110, 198, 103, 113, 205, 119, 116, 212, 135, 119, 219, 151, 122, 226, 167,
        125, 233, 183, 128, 240, 199, 131, 247, 215, 134, 254, 231, 137, 5, 247, 140,
        12, 7, 143, 19, 23, 146, 26, 39, 149, 33, 0, 57, 115, 197, 73, 118,
        204, 89, 121, 211, 105, 124, 218, 121, 127, 225, 137, 130, 232, 153, 133, 239,
        169, 136, 246, 185, 139, 253, 201, 142, 4, 217, 145, 11, 233, 148, 18, 249,
        151, 25, 9, 154, 32, 25, 157, 39, 41, 160, 46, 0, 59, 126, 210, 75,
        129, 217, 91, 132, 224, 107, 135, 231, 123, 138, 238, 139, 141, 245, 155, 144,
        252, 171, 147, 3, 187, 150, 10, 203, 153, 17, 219, 156, 24, 235, 159, 31,
        251, 162, 38, 11, 165, 45, 27, 168, 52, 43, 171, 59, 0, 61, 137, 223,
        77, 140, 230, 93, 143, 237, 109, 146, 244, 125, 149, 251, 141, 152, 2, 157,
        155, 9, 173, 158, 16, 189, 161, 23, 205, 164, 30, 221, 167, 37, 237, 170,
        44, 253, 173, 51, 13, 176, 58, 29, 179, 65, 45, 182, 72, 0, 63, 148,
        236, 79, 151, 243, 95, 154, 250, 111, 157, 1, 127, 160, 8, 143, 163, 15,
        159, 166, 22, 175, 169, 29, 191, 172, 36, 207, 175, 43, 223, 178, 50, 239,
        181, 57, 255, 184, 64, 15, 187, 71, 31, 190, 78, 47, 193, 85, 0, 65,
        159, 249, 81, 162, 0, 97, 165, 7, 113, 168, 14, 129, 171, 21, 145, 174,
        28, 161, 177, 35, 177, 180, 42, 193, 183, 49, 209, 186, 56, 225, 189, 63,
        241, 192, 70, 1, 195, 77, 17, 198, 84, 33, 201, 91, 49, 204, 98, 0,
        67, 170, 6, 83, 173, 13, 99, 176, 20, 115, 179, 27, 131, 182, 34, 147,
        185, 41, 163, 188, 48, 179, 191, 55, 195, 194, 62, 211, 197, 69, 227, 200,
        76, 243, 203, 83, 3, 206, 90, 19, 209, 97, 35, 212, 104, 51, 215, 111,
        0, 69, 181, 19, 85, 184, 26, 101, 187, 33, 117, 190, 40, 133, 193, 47,
        149, 196, 54, 165, 199, 61, 181, 202, 68, 197, 205, 75, 213, 208, 82, 229,
        211, 89, 245, 214, 96, 5, 217, 103, 21, 220, 110, 37, 223, 117, 53, 226,
        124, 0, 71, 192, 32, 87, 195, 39, 103, 198, 46, 119, 201, 53, 135, 204,
        60, 151, 207, 67, 167, 210, 74, 183, 213, 81, 199, 216, 88, 215, 219, 95,
        231, 222, 102, 247, 225, 109, 7, 228, 116, 23, 231, 123, 39, 234, 130, 55,
        237, 137, 0, 73, 203, 45, 89, 206, 52, 105, 209, 59, 121, 212, 66, 137,
        215, 73, 153, 218, 80, 169, 221, 87, 185, 224, 94, 201, 227, 101, 217, 230,
        108, 233, 233, 115, 249, 236, 122, 9, 239, 129, 25, 242, 136, 41, 245, 143,
        57, 248, 150, 0, 75, 214, 58, 91, 217, 65, 107, 220, 72, 123, 223, 79,
        139, 226, 86, 155, 229, 93, 171, 232, 100, 187, 235, 107, 203, 238, 114, 219,
        241, 121, 235, 244, 128, 251, 247, 135, 11, 250, 142, 27, 253, 149, 43, 0,
        156, 59, 3, 163, 0, 77, 225, 71, 93, 228, 78, 109, 231, 85, 125, 234,
        92, 141, 237, 99, 157, 240, 106, 173, 243, 113, 189, 246, 120, 205, 249, 127,
        221, 252, 134, 237, 255, 141, 253, 2, 148, 13, 5, 155, 29, 8, 162, 45,
        11, 169, 61, 14, 176, 0, 79, 236, 84, 95, 239, 91, 111, 242, 98, 127,
        245, 105, 143, 248, 112, 159, 251, 119, 175, 254, 126, 191, 1, 133, 207, 4,
        140, 223, 7, 147, 239, 10, 154, 255, 13, 161, 15, 16, 168, 31, 19, 175,
        47, 22, 182, 63, 25, 189, 0, 81, 247, 97, 97, 250, 104, 113, 253, 111,
        129, 0, 118, 145, 3, 125, 161, 6, 132, 177, 9, 139, 193, 12, 146, 209,
        15, 153, 225, 18, 160, 241, 21, 167, 1, 24, 174, 17, 27, 181, 33, 30,
        188, 49, 33, 195, 65, 36, 202, 0, 83, 2, 110, 99, 5, 117, 115, 8,
        124, 131, 11, 131, 147, 14, 138, 163, 17, 145, 179, 20, 152, 195, 23, 159,
        211, 26, 166, 227, 29, 173, 243, 32, 180, 3, 35, 187, 19, 38, 194, 35,
        41, 201, 51, 44, 208, 67, 47, 215, 23, 69, 60, 159, 50, 210, 84, 12,
        0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];

    /// 解析 fixtures 目录下的归档产物为 Path 输入（CARGO_MANIFEST_DIR = src-tauri）
    fn fixture_input(name: &str) -> ArchiveInput {
        ArchiveInput::Path(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("archive")
                .join(name),
        )
    }

    /// 可重开的 Reader 工厂：每次 open 计数（Reader 路径不整包读入、重开次数可断言）
    fn reader_factory(bytes: Vec<u8>, opens: Arc<AtomicUsize>) -> ReaderFactory {
        Arc::new(move || {
            opens.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(std::io::Cursor::new(bytes.clone()))
                as Box<dyn ArchiveReadSeek>)
        })
    }

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
        let enc_opts = plain_opts
            .clone()
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
        let scoped = ZipBackend.probe(&ArchiveInput::Path(mixed_dirs.clone()), "a/", None).unwrap();
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
}
