//! RAR backend：`ArchiveBackend` 的 unrar_sys 7.1 低层实现（任务 5）。
//!
//! 禁止引入高层 `unrar` crate——其密码是在 `RAROpenArchiveEx` 返回之后才经
//! `RARSetPassword` 传入，且其内部 callback 不处理 `UCM_NEEDPASSWORD(W)`：
//! 加密文件头（RAR5 `-hp`，header 解密在 open 阶段索要密码）的 catalog 会直接
//! 失败；其 `read()` 也在调用方检查之前返回完整 `Vec`。本 backend 统一经
//! [`crate::source::archive::rar_callback`] 的 pre-open callback 供给密码、
//! 限长 sink 与类型化错误：
//!
//! - **probe/catalog**：`RAR_OM_LIST` + `read_header → RAR_SKIP` 快速扫描，只读
//!   header 的加密 flag 与文件名，不触碰 payload。加密元数据只在 `ArchiveProbe`
//!   一个真值源；catalog 只列目录（`PasswordRequired` 判定权在 Service，任务 7）。
//! - **read**：`RAR_OM_EXTRACT` + `read_header → 命中项 RAR_TEST / 其他项 RAR_SKIP`。
//!   禁用 `RAR_EXTRACT`——`RAR_TEST` 解压+CRC 校验但不写任何文件。
//! - **stat**：同一 header 走查，命中即返回声明 `unp_size`（纯元数据语义，与 ZIP
//!   stat 读 central directory 对齐；对命中项跑 `RAR_TEST` 是全量解码的浪费）。
//! - **类型化错误优先**：`RAROpenArchiveEx` / `RARReadHeaderEx` / `RARProcessFile`
//!   返回后先 `state.error.take()`，有值即作为本操作错误（`BudgetRetryRequired`
//!   原样上抛触发 Service 增长-回退），无值才按 [`map_rar_code`] 翻译原始码。
//! - **多卷三重拒绝**：文件名形态（`.partN.rar` / `.rNN`）→ open 后 `ROADF_VOLUME`
//!   → header split 位，任一命中 `MultiVolumeUnsupported`。
//!
//! RAR4/RAR5 密码 KDF 都消费宽字符密码（vendored `crypt.cpp SetCryptKeys`：
//! `CRYPT_RAR30/50` 吃 `PwdW`），中文密码由 `UCM_NEEDPASSWORDW` 分支正确服务。

use crate::algorithm::mime::is_image;
use crate::algorithm::natural_compare;
use crate::source::archive::backend::{
    ArchiveAccessError, ArchiveBackend, ArchiveCatalog, ArchiveInput, ArchiveLimits, ArchiveProbe,
    DecodeBudget,
};
use crate::source::archive::rar_callback::{
    decode_wide, encode_wide, rar_ffi_callback, LimitedRarSink, RarCallbackState,
};
use crate::source::descriptor::MediaEntry;
use std::os::raw::{c_int, c_uint};
use std::path::Path;

/// read_entry 的声明值预检策略：生产恒 [`DeclaredSizePolicy::Enforce`]；
/// `BypassForFfiTest` 仅供测试绕过这一个前置短路，让真实输出到达 FFI callback。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeclaredSizePolicy {
    /// `unp_size > max_entry_bytes` 即拒（默认）。
    #[default]
    Enforce,
    /// 仅测试：跳过声明值预检，硬上限由 callback sink 判定。
    BypassForFfiTest,
}

/// RAR 后端（生产单例，零值）：调用方可直接 `RarBackend.catalog(..)`
/// （生产限额 = `ArchiveLimits::production()`）。测试注入限额用
/// [`RarBackend::with_limits`] / [`RarBackend::with_test_policy`]。
#[derive(Default)]
pub struct RarBackend;

pub struct LimitedRarBackend {
    limits: ArchiveLimits,
    policy: DeclaredSizePolicy,
}

impl RarBackend {
    /// 测试构造：注入限额（声明值预检保持默认 Enforce）。
    pub fn with_limits(limits: ArchiveLimits) -> LimitedRarBackend {
        LimitedRarBackend { limits, policy: DeclaredSizePolicy::default() }
    }

    /// 测试构造：同时注入限额与声明值策略（`BypassForFfiTest` 用于真实 FFI
    /// callback 输出硬停止用例）。
    pub fn with_test_policy(limits: ArchiveLimits, policy: DeclaredSizePolicy) -> LimitedRarBackend {
        LimitedRarBackend { limits, policy }
    }
}

impl ArchiveBackend for RarBackend {
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        probe_rar(input, prefix, password, &ArchiveLimits::production())
    }

    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError> {
        catalog_rar(input, prefix, password, &ArchiveLimits::production())
    }

    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        read_entry_rar(
            input,
            entry,
            password,
            budget,
            &ArchiveLimits::production(),
            DeclaredSizePolicy::Enforce,
        )
    }

    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError> {
        stat_entry_rar(input, entry, password, &ArchiveLimits::production())
    }
}

impl ArchiveBackend for LimitedRarBackend {
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        probe_rar(input, prefix, password, &self.limits)
    }

    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError> {
        catalog_rar(input, prefix, password, &self.limits)
    }

    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        read_entry_rar(input, entry, password, budget, &self.limits, self.policy)
    }

    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError> {
        stat_entry_rar(input, entry, password, &self.limits)
    }
}

// ---------------------------------------------------------------------------
// 输入约束与多卷前置判断（任务 5 步骤 3）
// ---------------------------------------------------------------------------

fn path_of(input: &ArchiveInput) -> Result<&Path, ArchiveAccessError> {
    match input {
        ArchiveInput::Path(path) => Ok(path.as_path()),
        ArchiveInput::Reader(_) => Err(ArchiveAccessError::RemoteRangeUnavailable(
            "RAR backend 只接受本地路径".into(),
        )),
    }
}

/// `.partN.rar`（新式）与 `.rNN`（旧式）分卷命名拒绝。多卷的第二/三重防线在
/// open 后的 `ROADF_VOLUME` 与 header split 位。
fn reject_multipart_name(path: &Path) -> Result<(), ArchiveAccessError> {
    let lower = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let part = lower
        .rsplit_once(".part")
        .and_then(|(_, suffix)| suffix.strip_suffix(".rar"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()));
    let old = path
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|ext| {
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

// ---------------------------------------------------------------------------
// UnRAR 原始码映射（类型化 state.error 之后的兜底表）
// ---------------------------------------------------------------------------

fn map_rar_code(code: c_int) -> ArchiveAccessError {
    use unrar_sys as u;
    match code {
        u::ERAR_MISSING_PASSWORD => ArchiveAccessError::PasswordRequired,
        u::ERAR_BAD_PASSWORD => ArchiveAccessError::WrongPassword,
        u::ERAR_BAD_DATA | u::ERAR_BAD_ARCHIVE | u::ERAR_UNKNOWN_FORMAT => {
            ArchiveAccessError::CorruptArchive(format!("unrar error {code}"))
        }
        u::ERAR_EREFERENCE | u::ERAR_SMALL_BUF | u::ERAR_UNKNOWN => {
            ArchiveAccessError::CorruptArchive(format!("unrar error {code}"))
        }
        u::ERAR_NO_MEMORY => {
            ArchiveAccessError::ResourceLimitExceeded("unrar out of memory".into())
        }
        // EOPEN=容器物理打不开（不存在/权限/锁定），非档案头损坏——归 Io。
        // media:// 层 Io 与 CorruptArchive 同映射 422，状态码零变化（lib.rs:551）。
        u::ERAR_EREAD | u::ERAR_EWRITE | u::ERAR_ECREATE | u::ERAR_ECLOSE | u::ERAR_EOPEN => {
            ArchiveAccessError::Io(format!("unrar error {code}"))
        }
        other => ArchiveAccessError::CorruptArchive(format!("unrar error {other}")),
    }
}

// ---------------------------------------------------------------------------
// 统一低层打开（pre-open callback 合同）
// ---------------------------------------------------------------------------

/// handle 的 RAII 守卫：drop 即 `RARCloseArchive`（错误路径的关闭也走这里或
/// open 内显式关闭——关闭前 state.error 已被 take，drop 路径不吞错误）。
struct RarArchiveGuard {
    handle: *const unrar_sys::Handle,
}

impl Drop for RarArchiveGuard {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: handle 来自 RAROpenArchiveEx，且恰好关闭一次（guard 独占）。
            unsafe { unrar_sys::RARCloseArchive(self.handle) };
        }
    }
}

/// 唯一低层打开入口：先构造包含 callback 与 user-data 的 `OpenArchiveDataEx`，
/// 再调用 `RAROpenArchiveEx`（加密 header 在 open 阶段就索要密码——vendored
/// `dll.cpp` 在 `IsArchive(true)` 内触发 `RequestArcPassword`）。
///
/// dll.cpp 语义：open 失败可能返回 NULL；`IsArchive` 失败则**返回非空 handle 且
/// `open_result != 0`**——open_result 检查必须同时覆盖两种形态。成功后 `flags`
/// 的 `ROADF_VOLUME` 是多卷第二重防线。
fn open_rar(
    path: &Path,
    mode: c_uint,
    state: &mut RarCallbackState,
) -> Result<RarArchiveGuard, ArchiveAccessError> {
    let path_str = path.to_string_lossy();
    // dll.cpp 双平台都优先 ArcNameW（非空即用），两个名字都提供
    let name_wide = encode_wide(&path_str);
    let name_ansi = std::ffi::CString::new(path_str.as_bytes().to_vec())
        .map_err(|_| ArchiveAccessError::InvalidRequest("archive path contains NUL".into()))?;
    let mut data = unrar_sys::OpenArchiveDataEx {
        archive_name: name_ansi.as_ptr(),
        archive_name_w: name_wide.as_ptr(),
        open_mode: mode,
        open_result: 0,
        comment_buffer: std::ptr::null_mut(),
        comment_buffer_size: 0,
        comment_size: 0,
        comment_state: 0,
        flags: 0,
        callback: Some(rar_ffi_callback),
        user_data: state as *mut RarCallbackState as unrar_sys::LPARAM,
        op_flags: 0,
        comment_buffer_w: std::ptr::null_mut(),
        reserved: [0; 25],
    };
    // SAFETY: data / name_wide / name_ansi 在本次调用内有效；state 由调用方保证
    // 存活到 handle 关闭（guard 在 state 之前 drop：同作用域内后声明先释放）。
    let handle = unsafe { unrar_sys::RAROpenArchiveEx(&data) };
    // 类型化错误优先：open 阶段 callback 中止（无密码/换卷/超限）时 state.error
    // 已携带精确分类，UnRAR 只给出通用码
    if let Some(err) = state.take_error() {
        if !handle.is_null() {
            // SAFETY: handle 来自 RAROpenArchiveEx 且尚未关闭。
            unsafe { unrar_sys::RARCloseArchive(handle) };
        }
        return Err(err);
    }
    if data.open_result != 0 {
        let err = map_rar_code(data.open_result as c_int);
        if !handle.is_null() {
            // SAFETY: handle 来自 RAROpenArchiveEx 且尚未关闭。
            unsafe { unrar_sys::RARCloseArchive(handle) };
        }
        return Err(err);
    }
    if handle.is_null() {
        return Err(ArchiveAccessError::CorruptArchive(format!(
            "RAROpenArchiveEx returned null (open_result {})",
            data.open_result
        )));
    }
    if data.flags & unrar_sys::ROADF_VOLUME != 0 {
        // SAFETY: handle 有效且尚未关闭。
        unsafe { unrar_sys::RARCloseArchive(handle) };
        return Err(ArchiveAccessError::MultiVolumeUnsupported(path_str.into_owned()));
    }
    Ok(RarArchiveGuard { handle })
}

// ---------------------------------------------------------------------------
// header 走查
// ---------------------------------------------------------------------------

struct RarHeaderInfo {
    /// 已把 `\` 归一为 `/` 的条目路径
    name: String,
    /// `unp_size` + `unp_size_high` 高低 32 位组合的声明解压大小
    declared_size: u64,
    encrypted: bool,
}

/// `RARReadHeaderEx` 一个条目。END_ARCHIVE 返回 `Ok(None)`；split 位命中即
/// `MultiVolumeUnsupported`（第三重防线）；错误先 `state.error.take()`。
fn read_header(
    guard: &RarArchiveGuard,
    state: &mut RarCallbackState,
) -> Result<Option<RarHeaderInfo>, ArchiveAccessError> {
    let mut header = unrar_sys::HeaderDataEx::default();
    // SAFETY: header 在本次调用内有效；unrar 经 *const 指针写回（unrar_sys 绑定签名）。
    let rc = unsafe { unrar_sys::RARReadHeaderEx(guard.handle, &mut header) };
    if let Some(err) = state.take_error() {
        return Err(err);
    }
    if rc == unrar_sys::ERAR_END_ARCHIVE {
        return Ok(None);
    }
    if rc != unrar_sys::ERAR_SUCCESS {
        return Err(map_rar_code(rc));
    }
    let name = decode_wide(&header.filename_w).replace('\\', "/");
    if header.flags & (unrar_sys::RHDF_SPLITBEFORE | unrar_sys::RHDF_SPLITAFTER) != 0 {
        return Err(ArchiveAccessError::MultiVolumeUnsupported(name));
    }
    let declared_size = ((header.unp_size_high as u64) << 32) | header.unp_size as u64;
    let encrypted = header.flags & unrar_sys::RHDF_ENCRYPTED != 0;
    Ok(Some(RarHeaderInfo { name, declared_size, encrypted }))
}

/// 前进到下一个 header（非命中项的 `RAR_SKIP`；OM_LIST 下等价 SeekToNext）。
fn process_skip(
    guard: &RarArchiveGuard,
    state: &mut RarCallbackState,
) -> Result<(), ArchiveAccessError> {
    // SAFETY: RAR_SKIP 不解压不写文件；dest 参数为 null。
    let rc = unsafe {
        unrar_sys::RARProcessFile(
            guard.handle,
            unrar_sys::RAR_SKIP,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if let Some(err) = state.take_error() {
        return Err(err);
    }
    if rc != unrar_sys::ERAR_SUCCESS {
        return Err(map_rar_code(rc));
    }
    Ok(())
}

/// probe/catalog 走查对**每个原始条目（含非图片）**的三项上限检查（任务 5 步骤 4：
/// 不得先过滤图片再限额）。read/stat 走查复用计数与路径两项；声明值只对目标条目
/// 预检（policy 门控）——非目标条目仅 SKIP，不消费其声明大小。
fn check_raw_entry_limits(
    index: usize,
    name: &str,
    declared_size: Option<u64>,
    limits: &ArchiveLimits,
) -> Result<(), ArchiveAccessError> {
    if index >= limits.max_catalog_entries {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "rar entries exceed {}",
            limits.max_catalog_entries
        )));
    }
    if name.len() > limits.max_entry_path_bytes {
        return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
            "entry path exceeds {} bytes",
            limits.max_entry_path_bytes
        )));
    }
    if let Some(size) = declared_size {
        if size > limits.max_entry_bytes {
            return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
                "entry declares {size} bytes exceeding {}",
                limits.max_entry_bytes
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// probe / catalog
// ---------------------------------------------------------------------------

/// `RAR_OM_LIST` 快速扫描（`read_header → RAR_SKIP`），统计范围与 catalog 同语义：
/// `entry_count` 全容器、`image_count`/加密候选按 prefix 视图过滤。
fn probe_rar(
    input: &ArchiveInput,
    prefix: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
) -> Result<ArchiveProbe, ArchiveAccessError> {
    let path = path_of(input)?;
    reject_multipart_name(path)?;
    let mut state = RarCallbackState::new(password);
    let guard = open_rar(path, unrar_sys::RAR_OM_LIST, &mut state)?;
    let mut probe = ArchiveProbe::default();
    let mut index = 0usize;
    while let Some(header) = read_header(&guard, &mut state)? {
        check_raw_entry_limits(index, &header.name, Some(header.declared_size), limits)?;
        index += 1;
        probe.entry_count += 1;
        if header.name.starts_with(prefix) {
            if is_image(&header.name) {
                probe.image_count += 1;
                if header.encrypted && probe.first_encrypted_image.is_none() {
                    probe.first_encrypted_image = Some(header.name.clone());
                }
            } else if header.encrypted && probe.first_encrypted_file.is_none() {
                probe.first_encrypted_file = Some(header.name.clone());
            }
        }
        process_skip(&guard, &mut state)?;
    }
    Ok(probe)
}

/// catalog 只列目录：图片条目 + 自然排序（与 ZIP 同语义）。加密元数据不在此
/// （单一判定合同：`PasswordRequired` 判定权在 Service）。
fn catalog_rar(
    input: &ArchiveInput,
    prefix: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
) -> Result<ArchiveCatalog, ArchiveAccessError> {
    let path = path_of(input)?;
    reject_multipart_name(path)?;
    let mut state = RarCallbackState::new(password);
    let guard = open_rar(path, unrar_sys::RAR_OM_LIST, &mut state)?;
    let mut out = Vec::new();
    let mut index = 0usize;
    while let Some(header) = read_header(&guard, &mut state)? {
        check_raw_entry_limits(index, &header.name, Some(header.declared_size), limits)?;
        index += 1;
        if header.name.starts_with(prefix) && is_image(&header.name) {
            let relative = if prefix.is_empty() {
                header.name.clone()
            } else {
                header
                    .name
                    .strip_prefix(prefix)
                    .map(|s| s.trim_start_matches('/').to_string())
                    .unwrap_or_else(|| header.name.clone())
            };
            // RAR 条目时间戳（DosFileTime）精度低且阅读器不展示，与 ZIP 同款留 None
            out.push(MediaEntry {
                name: relative.clone(),
                path: relative,
                is_directory: false,
                is_archive: false,
                size: header.declared_size,
                modified_at: None,
            });
        }
        process_skip(&guard, &mut state)?;
    }
    out.sort_by(|a, b| natural_compare(&a.name, &b.name));
    Ok(ArchiveCatalog { entries: out })
}

// ---------------------------------------------------------------------------
// read / stat
// ---------------------------------------------------------------------------

/// read_entry：`RAR_OM_EXTRACT` + 命中项 `RAR_TEST`（解压到 callback、CRC 校验、
/// 不写任何文件）。数据经 [`LimitedRarSink`]（hard_limit = 条目上限与
/// `budget.output_cap` 较小者）：允许恰好写到上限，仅第 +1 字节到达才终止；
/// `try_grow` 失败转 abort 后由 state.error 携带 `BudgetRetryRequired` 上抛。
fn read_entry_rar(
    input: &ArchiveInput,
    entry: &str,
    password: Option<&[u8]>,
    budget: &mut DecodeBudget,
    limits: &ArchiveLimits,
    policy: DeclaredSizePolicy,
) -> Result<Vec<u8>, ArchiveAccessError> {
    let path = path_of(input)?;
    reject_multipart_name(path)?;
    let mut state = RarCallbackState::new(password);
    let guard = open_rar(path, unrar_sys::RAR_OM_EXTRACT, &mut state)?;
    let mut index = 0usize;
    while let Some(header) = read_header(&guard, &mut state)? {
        check_raw_entry_limits(index, &header.name, None, limits)?;
        index += 1;
        if header.name == entry {
            // 声明值前置短路（BypassForFfiTest 绕过——真实输出到达 callback 由
            // sink 硬上限判定，覆盖「谎报头部的增长」场景）
            if policy == DeclaredSizePolicy::Enforce && header.declared_size > limits.max_entry_bytes
            {
                return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
                    "entry {entry} declares {} bytes exceeding {}",
                    header.declared_size, limits.max_entry_bytes
                )));
            }
            let hard_limit = limits.max_entry_bytes.min(budget.output_cap);
            let real_budget = std::mem::replace(budget, DecodeBudget::unbounded());
            state.sink = Some(LimitedRarSink::with_budget(hard_limit, real_budget));
            // SAFETY: RAR_TEST 解压+校验但不写文件；dest 参数为 null。
            let rc = unsafe {
                unrar_sys::RARProcessFile(
                    guard.handle,
                    unrar_sys::RAR_TEST,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            };
            // 类型化错误优先于原始码（BudgetRetryRequired/ResourceLimitExceeded 等
            // 没有 UnRAR 码等价物，先映射原始码会退化成通用 RAR/损坏错误）
            if let Some(err) = state.take_error() {
                state.sink = None; // drop writer → 释放预算许可
                return Err(err);
            }
            if rc != unrar_sys::ERAR_SUCCESS {
                // RAR4 无 PswCheck：错密码只能以 CRC 失败（ERAR_BAD_DATA）呈现
                //（vendored extract.cpp:893 注释自认无法区分）——目标条目已加密且
                // 已供密码时归一为 WrongPassword；RAR5 的 ERAR_BAD_PASSWORD 直接命中
                let err = if rc == unrar_sys::ERAR_BAD_DATA && header.encrypted && password.is_some()
                {
                    ArchiveAccessError::WrongPassword
                } else {
                    map_rar_code(rc)
                };
                state.sink = None;
                return Err(err);
            }
            let sink = state.sink.take().expect("sink set before RARProcessFile");
            return Ok(sink.finish());
        }
        process_skip(&guard, &mut state)?;
    }
    Err(ArchiveAccessError::EntryNotFound(entry.to_string()))
}

/// stat_entry：`RAR_OM_LIST` header 走查命中即返回声明 `unp_size`（纯元数据，
/// 与 ZIP stat 同语义）；声明值超限直接 `ResourceLimitExceeded`。
fn stat_entry_rar(
    input: &ArchiveInput,
    entry: &str,
    password: Option<&[u8]>,
    limits: &ArchiveLimits,
) -> Result<u64, ArchiveAccessError> {
    let path = path_of(input)?;
    reject_multipart_name(path)?;
    let mut state = RarCallbackState::new(password);
    let guard = open_rar(path, unrar_sys::RAR_OM_LIST, &mut state)?;
    let mut index = 0usize;
    while let Some(header) = read_header(&guard, &mut state)? {
        check_raw_entry_limits(index, &header.name, None, limits)?;
        index += 1;
        if header.name == entry {
            if header.declared_size > limits.max_entry_bytes {
                return Err(ArchiveAccessError::ResourceLimitExceeded(format!(
                    "entry {entry} declares {} bytes exceeding {}",
                    header.declared_size, limits.max_entry_bytes
                )));
            }
            return Ok(header.declared_size);
        }
        process_skip(&guard, &mut state)?;
    }
    Err(ArchiveAccessError::EntryNotFound(entry.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::archive::backend::ReaderFactory;
    use std::sync::Arc;
    use unrar_sys as u;

    /// fixture 生成脚本 `tests/fixtures/archive/generate.py::make_png(1)` 的确定性输出
    /// （1244 bytes；与 zip_backend 测试共用同一真值——README「内容锁定」承诺）。
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

    /// 解析 fixtures 目录下的 RAR 产物为 Path 输入（CARGO_MANIFEST_DIR = src-tauri）
    fn fixture_input(name: &str) -> ArchiveInput {
        ArchiveInput::Path(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("archive")
                .join(name),
        )
    }

    /// 工作目录快照：RAR_TEST 不写文件，abort 前后快照必须一致。backend 不接触
    /// archive-cache（M3 物化在 source 层完成、backend 只见本地路径），可写面即 cwd。
    fn snapshot_rar_write_targets(_backend: &LimitedRarBackend) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(".")
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn rar4_rar5_plain_and_password_contract() {
        for name in ["plain-rar4.rar", "plain-rar5.rar"] {
            let input = fixture_input(name);
            let catalog = RarBackend.catalog(&input, "", None).unwrap();
            assert_eq!(catalog.entries.len(), 2);
            assert_eq!(
                RarBackend.read_entry(&input, "page1.png", None, &mut DecodeBudget::unbounded())
                    .unwrap(),
                PNG_BYTES
            );
        }
        for name in ["password-rar4.rar", "password-rar5.rar"] {
            let input = fixture_input(name);
            // `-p` 内容加密的 header 明文可列：catalog 只列目录（单一判定合同），
            // 加密候选由 probe 报告；PasswordRequired 判定权在 Service。
            let catalog = RarBackend.catalog(&input, "", None).unwrap();
            assert_eq!(catalog.entries.len(), 1);
            let probe = RarBackend.probe(&input, "", None).unwrap();
            assert_eq!(probe.first_encrypted_image.as_deref(), Some("page1.png"));
            assert_eq!(
                RarBackend
                    .read_entry(&input, "page1.png", Some(b"wrong"), &mut DecodeBudget::unbounded())
                    .unwrap_err(),
                ArchiveAccessError::WrongPassword
            );
            assert_eq!(
                RarBackend
                    .read_entry(
                        &input,
                        "page1.png",
                        Some("test-pass-中文".as_bytes()),
                        &mut DecodeBudget::unbounded()
                    )
                    .unwrap(),
                PNG_BYTES
            );
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
    fn rar_data_callback_aborts_real_ffi_output_at_hard_limit_and_recovers() {
        // 仅跳过 catalog 声明大小的测试短路，仍使用生产 read_entry -> unrar_sys callback 路径。
        let backend = RarBackend::with_test_policy(
            ArchiveLimits::for_test().entry_bytes(8),
            DeclaredSizePolicy::BypassForFfiTest,
        );
        let targets_before = snapshot_rar_write_targets(&backend);
        assert!(matches!(
            backend.read_entry(
                &fixture_input("plain-rar5.rar"),
                "page1.png",
                None,
                &mut DecodeBudget::unbounded()
            ),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
        assert_eq!(snapshot_rar_write_targets(&backend), targets_before); // cwd 无新 entry
        assert_eq!(
            RarBackend
                .read_entry(
                    &fixture_input("plain-rar5.rar"),
                    "page1.png",
                    None,
                    &mut DecodeBudget::unbounded()
                )
                .unwrap(),
            PNG_BYTES
        );
    }

    #[test]
    fn encrypted_header_password_callback_is_registered_before_open() {
        let input = fixture_input("encrypted-headers-rar5.rar");
        assert_eq!(
            RarBackend
                .read_entry(
                    &input,
                    "page1.png",
                    Some("test-pass-中文".as_bytes()),
                    &mut DecodeBudget::unbounded()
                )
                .unwrap(),
            PNG_BYTES
        );
    }

    #[test]
    fn encrypted_header_catalog_uses_same_pre_open_callback() {
        let input = fixture_input("encrypted-headers-rar5.rar");
        let backend = RarBackend::default();
        // 无密码首开：NEEDPASSWORD(W) 无密码分支写 PasswordRequired 后中止——
        // 稳定进入密码弹框主流程，不退化为 UnRAR 通用错误
        assert_eq!(
            backend.catalog(&input, "", None).unwrap_err(),
            ArchiveAccessError::PasswordRequired
        );
        assert_eq!(
            backend.probe(&input, "", None).unwrap_err(),
            ArchiveAccessError::PasswordRequired
        );
        let catalog = backend
            .catalog(&input, "", Some("test-pass-中文".as_bytes()))
            .unwrap();
        assert!(catalog.entries.iter().any(|e| e.name == "page1.png"));
        assert_eq!(
            backend.catalog(&input, "", Some(b"wrong")).unwrap_err(),
            ArchiveAccessError::WrongPassword
        );
    }

    #[test]
    fn rar_probe_falls_back_to_encrypted_non_image_and_reports_empty() {
        let backend = RarBackend::default();
        let probe = backend
            .probe(&fixture_input("password-nonimage-rar4.rar"), "", None)
            .unwrap();
        assert_eq!(probe.image_count, 0);
        assert_eq!(probe.first_encrypted_image, None);
        assert_eq!(probe.first_encrypted_file.as_deref(), Some("note.txt"));
        // prefix 视图统计（与 ZIP/7z 同款回归）：mixed-dirs 含 a/note.txt + b/page.png——
        // a/ 视图无图、全包 1 图；错误实现忽略 prefix 也无法通过
        let scoped = backend
            .probe(&fixture_input("mixed-dirs-rar5.rar"), "a/", None)
            .unwrap();
        assert_eq!(scoped.entry_count, 2);
        assert_eq!(scoped.image_count, 0);
        let full = backend.probe(&fixture_input("mixed-dirs-rar5.rar"), "", None).unwrap();
        assert_eq!(full.image_count, 1);
        assert_eq!(
            backend
                .probe(&fixture_input("empty-rar5.rar"), "", None)
                .unwrap()
                .entry_count,
            0
        );
    }

    #[test]
    fn rar_probe_limits_count_every_entry_including_non_images() {
        // 注入总条目上限 1：plain-rar5.rar 含 2 个条目 → 第二个即超限，证明计数不豁免任何条目
        let backend = RarBackend::with_test_policy(
            ArchiveLimits::for_test().entry_count(1),
            DeclaredSizePolicy::default(),
        );
        assert!(matches!(
            backend.probe(&fixture_input("plain-rar5.rar"), "", None),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }

    #[tokio::test]
    async fn rar_budget_retry_flows_through_real_ffi_callback_and_recovers() {
        // 类型化错误优先于原始码的 BudgetRetryRequired 分支：dict=1MiB + 初始 permit
        // 恰好 1 个（信号量无闲余）→ 首个 UCM_PROCESSDATA 块扩容到 1MiB 输出水位需要
        // 第 2 个 permit → try_grow 失败 → callback abort → state.error 携带
        // BudgetRetryRequired 上抛（而非 UnRAR 通用错误）
        let limits = ArchiveLimits::for_test();
        let backend = RarBackend::with_test_policy(limits.clone(), DeclaredSizePolicy::Enforce);
        let mut budget = DecodeBudget::for_limits(
            &limits,
            0,
            1024 * 1024,
            Arc::new(tokio::sync::Semaphore::new(1)),
        )
        .await
        .unwrap();
        assert!(matches!(
            backend.read_entry(
                &fixture_input("plain-rar5.rar"),
                "page1.png",
                None,
                &mut budget
            ),
            Err(ArchiveAccessError::BudgetRetryRequired)
        ));
        // Service 释放重排队后（新预算、许可充足）：同一 fixture 第二次读取成功
        let mut fresh = DecodeBudget::for_limits(
            &limits,
            0,
            1024 * 1024,
            Arc::new(tokio::sync::Semaphore::new(4)),
        )
        .await
        .unwrap();
        assert_eq!(
            backend
                .read_entry(
                    &fixture_input("plain-rar5.rar"),
                    "page1.png",
                    None,
                    &mut fresh
                )
                .unwrap(),
            PNG_BYTES
        );
    }

    #[test]
    fn rar_stat_and_prefix_catalog_match_normalized_names() {
        let backend = RarBackend::default();
        // mixed-dirs 由 rar.exe 创建（'\' 分隔存储）：所有 entry path 归一为 '/'
        assert_eq!(
            backend
                .stat_entry(&fixture_input("mixed-dirs-rar5.rar"), "b/page.png", None)
                .unwrap(),
            PNG_BYTES.len() as u64
        );
        let scoped = backend
            .catalog(&fixture_input("mixed-dirs-rar5.rar"), "b/", None)
            .unwrap();
        assert_eq!(scoped.entries.len(), 1);
        assert_eq!(scoped.entries[0].name, "page.png");
        // 未命中条目
        assert!(matches!(
            backend.stat_entry(&fixture_input("mixed-dirs-rar5.rar"), "missing.png", None),
            Err(ArchiveAccessError::EntryNotFound(_))
        ));
        // stat 声明值超限
        let limited = RarBackend::with_limits(ArchiveLimits::for_test().entry_bytes(8));
        assert!(matches!(
            limited.stat_entry(&fixture_input("plain-rar5.rar"), "page1.png", None),
            Err(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }

    #[test]
    fn rar_reader_input_is_rejected_with_remote_range_unavailable() {
        let factory: ReaderFactory = Arc::new(|| unreachable!("RAR 不应触碰 Reader"));
        assert!(matches!(
            RarBackend.probe(&ArchiveInput::Reader(factory), "", None),
            Err(ArchiveAccessError::RemoteRangeUnavailable(_))
        ));
    }

    /// module3.5.3 任务 D：map_rar_code 整表特征锁——分类漂移在此红灯而非生产环境。
    /// EOPEN=容器打不开（unrar dll.cpp FMF_OPENSHARED 失败：不存在/权限/锁定），归 Io；
    /// 密码类已被 typed callback 路径截胡，本表只见裸码兜底。
    #[test]
    fn map_rar_code_full_table_classification() {
        use crate::source::archive::backend::ArchiveAccessError;
        let corrupt = [
            u::ERAR_BAD_DATA,
            u::ERAR_BAD_ARCHIVE,
            u::ERAR_UNKNOWN_FORMAT,
            u::ERAR_EREFERENCE,
            u::ERAR_SMALL_BUF,
            u::ERAR_UNKNOWN,
        ];
        for c in corrupt {
            assert!(
                matches!(super::map_rar_code(c), ArchiveAccessError::CorruptArchive(_)),
                "code {c} 应归 CorruptArchive",
            );
        }
        let io = [
            u::ERAR_EREAD,
            u::ERAR_EWRITE,
            u::ERAR_ECREATE,
            u::ERAR_ECLOSE,
            u::ERAR_EOPEN,
        ];
        for c in io {
            assert!(
                matches!(super::map_rar_code(c), ArchiveAccessError::Io(_)),
                "code {c} 应归 Io",
            );
        }
        assert!(matches!(
            super::map_rar_code(u::ERAR_MISSING_PASSWORD),
            ArchiveAccessError::PasswordRequired
        ));
        assert!(matches!(
            super::map_rar_code(u::ERAR_BAD_PASSWORD),
            ArchiveAccessError::WrongPassword
        ));
        assert!(matches!(
            super::map_rar_code(u::ERAR_NO_MEMORY),
            ArchiveAccessError::ResourceLimitExceeded(_)
        ));
    }
}
