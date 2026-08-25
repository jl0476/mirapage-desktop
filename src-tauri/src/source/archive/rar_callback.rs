//! UnRAR 低层 FFI callback 合同（任务 5）。
//!
//! 三类消息的参数语义（unrar 7.1 vendored 源码验证）：
//! - `UCM_PROCESSDATA`：`p1` = 解压数据指针，`p2` = 字节数（`rdwrfn.cpp UnpWrite`）。
//! - `UCM_CHANGEVOLUME(W)`：`p1` = 下一卷文件名指针，`p2` = `RAR_VOL_ASK`/`RAR_VOL_NOTIFY`
//!   模式值（**不是长度**）。单卷策略不读取任何缓冲，直接终止。
//! - `UCM_NEEDPASSWORD(W)`：`p1` = 密码缓冲指针，`p2` = 缓冲容量（ANSI 按字节、
//!   W 按 `wchar_t` 个数，vendored 值 MAXPASSWORD=512）。unrar 先问 W 分支，
//!   返回 -1 或空密码时**再问 ANSI 分支兜底**（`arcread.cpp RequestArcPassword` /
//!   `extract.cpp ExtrDllGetPassword`）——无密码时两个分支都要先写
//!   `PasswordRequired` 再返回 -1，否则 unrar 只报 ERAR_MISSING_PASSWORD(22)，
//!   调用方无法区分「没给密码」与「给了错密码」。
//!
//! 宽字符一律用 `unrar_sys::WCHAR`（= libc `wchar_t`），平台编码经
//! [`encode_wide`]/[`decode_wide`] 单一适配，并以 const 断言锁定宽度假设。

use crate::source::archive::backend::{
    ArchiveAccessError, BudgetRetryIoError, DecodeBudget, LimitedEntryIoError, LimitedEntryWriter,
};
use std::os::raw::c_int;
use unrar_sys::{LPARAM, UINT, WCHAR};

// ---------------------------------------------------------------------------
// 平台宽字符适配（密码与 filename_w 共用同一宽度语义）
// ---------------------------------------------------------------------------

/// Windows：wchar_t = 16 位，unrar 内部即 UTF-16LE。
#[cfg(windows)]
const _: () = assert!(
    std::mem::size_of::<WCHAR>() == 2,
    "Windows wchar_t 必须 16 位（UTF-16LE）"
);
/// Unix/macOS：wchar_t = 32 位，unrar 内部即 Unicode scalar（UTF-32）。
#[cfg(not(windows))]
const _: () = assert!(
    std::mem::size_of::<WCHAR>() == 4,
    "Unix wchar_t 必须 32 位（UTF-32 scalar）"
);

/// 字符串 → NUL 结尾的宽字符向量（含结尾 NUL，供指针复制时去掉）。
/// 密码预编码与归档名走同一实现。
#[cfg(windows)]
pub fn encode_wide(s: &str) -> Vec<WCHAR> {
    s.encode_utf16()
        .map(|u| u as WCHAR)
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(not(windows))]
pub fn encode_wide(s: &str) -> Vec<WCHAR> {
    s.chars()
        .map(|c| c as u32 as WCHAR)
        .chain(std::iter::once(0))
        .collect()
}

/// NUL 结尾的宽字符缓冲 → String（`HeaderDataEx::filename_w` 解码）。
#[cfg(windows)]
pub fn decode_wide(w: &[WCHAR]) -> String {
    let units: Vec<u16> = w.iter().take_while(|&&c| c != 0).map(|&c| c as u16).collect();
    String::from_utf16_lossy(&units)
}

#[cfg(not(windows))]
pub fn decode_wide(w: &[WCHAR]) -> String {
    w.iter()
        .take_while(|&&c| c != 0)
        .map(|&c| char::from_u32(c as u32).unwrap_or('\u{FFFD}'))
        .collect()
}

// ---------------------------------------------------------------------------
// 受限 sink：UCM_PROCESSDATA 的字节计费与「恰好到限」边界
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackControl {
    /// 返回给 unrar 的 1：继续处理
    Continue,
    /// 返回给 unrar 的 -1：立即中止
    Abort,
}

/// UCM_PROCESSDATA 的数据落点：`LimitedEntryWriter` 的 RAR 版门面。
///
/// 硬上限（`hard_limit` = backend 条目上限与 `budget.output_cap` 的较小者）由本类型
/// 亲自执行——**允许恰好写到上限**，仅当第 `hard_limit + 1` 字节实际到达才终止且
/// 不保存该块（`bytes_seen` 仍累计，供测试观察）。写入侧复用任务 4 的
/// `LimitedEntryWriter`（`try_grow` 计费 + `try_reserve_exact` 精确增量），
/// 增长失败经 marker 映射 `BudgetRetryRequired`（Service 增长-回退协议）。
pub struct LimitedRarSink {
    writer: LimitedEntryWriter,
    hard_limit: u64,
    bytes_seen: u64,
    error: Option<ArchiveAccessError>,
}

impl LimitedRarSink {
    /// 生产构造：`hard_limit` 与 budget 一起移入（writer 持有 budget 并在交付时释放许可）。
    pub fn with_budget(hard_limit: u64, budget: DecodeBudget) -> Self {
        Self {
            writer: LimitedEntryWriter::with_budget(budget),
            hard_limit,
            bytes_seen: 0,
            error: None,
        }
    }

    /// 测试便捷构造（许可近似无限的 unbounded budget，硬上限即 hard_limit）。
    #[cfg(test)]
    pub fn new(hard_limit: u64) -> Self {
        Self::with_budget(hard_limit, DecodeBudget::unbounded())
    }

    /// 以 UCM_PROCESSDATA 的原始参数喂块：`p1` = 数据指针，`p2` = 字节数。
    /// null 指针 / 非正长度直接 Continue（unrar 不会发空块，防御性合同）。
    pub fn feed_raw(&mut self, p1: LPARAM, p2: LPARAM) -> CallbackControl {
        if p1 == 0 || p2 <= 0 {
            return CallbackControl::Continue;
        }
        // SAFETY: unrar 保证 p1..p1+p2 是可读的解压输出缓冲。
        let data = unsafe { std::slice::from_raw_parts(p1 as *const u8, p2 as usize) };
        self.feed(data)
    }

    /// 单块喂入：先判「恰好到限」边界，再经 writer 计费写入。
    pub fn feed(&mut self, data: &[u8]) -> CallbackControl {
        self.bytes_seen = self.bytes_seen.saturating_add(data.len() as u64);
        if self.bytes_seen > self.hard_limit {
            // 第 hard_limit+1 字节实际到达：观察到但不保存（本块不进 writer）
            self.error.get_or_insert_with(|| {
                ArchiveAccessError::ResourceLimitExceeded(format!(
                    "rar entry output exceeds {} bytes",
                    self.hard_limit
                ))
            });
            return CallbackControl::Abort;
        }
        match self.writer.write_all(data) {
            Ok(()) => CallbackControl::Continue,
            Err(e) => {
                self.error.get_or_insert(map_rar_sink_io_error(e));
                CallbackControl::Abort
            }
        }
    }

    pub fn saved_len(&self) -> usize {
        self.writer.current_len()
    }

    pub fn bytes_seen(&self) -> u64 {
        self.bytes_seen
    }

    pub fn error(&self) -> Option<&ArchiveAccessError> {
        self.error.as_ref()
    }

    /// 交付缓冲（backend `read_entry` 返回载荷；预算许可随 writer 一并释放）。
    pub fn finish(self) -> Vec<u8> {
        self.writer.finish()
    }
}

fn map_rar_sink_io_error(e: std::io::Error) -> ArchiveAccessError {
    if e.get_ref().is_some_and(|c| c.is::<BudgetRetryIoError>()) {
        return ArchiveAccessError::BudgetRetryRequired;
    }
    if let Some(limited) = e.get_ref().and_then(|c| c.downcast_ref::<LimitedEntryIoError>()) {
        return ArchiveAccessError::ResourceLimitExceeded(limited.to_string());
    }
    // try_reserve_exact 分配失败等：终态资源错误（不可重试）
    ArchiveAccessError::ResourceLimitExceeded(e.to_string())
}

// ---------------------------------------------------------------------------
// callback state：同一 state 服务 open/header 密码请求 + 数据输出 + 类型化错误桥
// ---------------------------------------------------------------------------

pub struct RarCallbackState {
    pub sink: Option<LimitedRarSink>,
    /// UTF-8 密码（UCM_NEEDPASSWORD ANSI 分支用）
    pub password_utf8: Option<zeroize::Zeroizing<Vec<u8>>>,
    /// 平台宽字符密码（UCM_NEEDPASSWORDW 分支用；RAR4/RAR5 KDF 都吃宽形式）
    pub password_wide: Option<zeroize::Zeroizing<Vec<WCHAR>>>,
    pub error: Option<ArchiveAccessError>,
}

impl RarCallbackState {
    /// 构造时一次性预编码两份密码——callback 内的密码分支不做任何分配。
    pub fn new(password: Option<&[u8]>) -> Self {
        match password {
            Some(bytes) => Self {
                sink: None,
                password_utf8: Some(zeroize::Zeroizing::new(bytes.to_vec())),
                password_wide: Some(zeroize::Zeroizing::new(encode_wide(
                    &String::from_utf8_lossy(bytes),
                ))),
                error: None,
            },
            None => Self {
                sink: None,
                password_utf8: None,
                password_wide: None,
                error: None,
            },
        }
    }

    /// 类型化错误优先于 UnRAR 原始码的取出口（open/read header/process 三检查点）。
    pub fn take_error(&mut self) -> Option<ArchiveAccessError> {
        self.error.take()
    }
}

// ---------------------------------------------------------------------------
// callback 主体
// ---------------------------------------------------------------------------

/// `extern "C"` callback：整体包在 `catch_unwind` 中，panic 写入 state.error 并转
/// abort，绝不跨 ABI unwind。注册时机在 `RAROpenArchiveEx` 之前（加密 header 在
/// open 阶段就会索要密码）。
pub extern "C" fn rar_ffi_callback(msg: UINT, user_data: LPARAM, p1: LPARAM, p2: LPARAM) -> c_int {
    if user_data == 0 {
        return -1; // 无 state 可写，只能 fail-closed
    }
    // SAFETY: user_data 由 open_rar 传入，指向当前同步调用栈上存活的 state。
    let state = unsafe { &mut *(user_data as *mut RarCallbackState) };
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch_rar_message(state, msg, p1, p2)
    }));
    match outcome {
        Ok(CallbackControl::Continue) => 1,
        Ok(CallbackControl::Abort) => -1,
        Err(_payload) => {
            state
                .error
                .get_or_insert(ArchiveAccessError::Io("rar callback panicked".into()));
            -1
        }
    }
}

fn dispatch_rar_message(
    state: &mut RarCallbackState,
    msg: UINT,
    p1: LPARAM,
    p2: LPARAM,
) -> CallbackControl {
    use unrar_sys as u;
    match msg {
        u::UCM_PROCESSDATA => dispatch_process_data(state, p1, p2),
        u::UCM_CHANGEVOLUME | u::UCM_CHANGEVOLUMEW => {
            // p1 = 下一卷文件名指针，p2 = RAR_VOL_ASK/RAR_VOL_NOTIFY（非长度）。
            // 单卷策略：不读取任何缓冲，直接终止。
            state
                .error
                .get_or_insert_with(|| ArchiveAccessError::MultiVolumeUnsupported(
                    "rar volume change requested".into(),
                ));
            CallbackControl::Abort
        }
        u::UCM_NEEDPASSWORD => dispatch_need_password_ansi(state, p1, p2),
        u::UCM_NEEDPASSWORDW => dispatch_need_password_wide(state, p1, p2),
        // 其他消息（含未来新增的 UCM_LARGEDICT 等）：fail-closed，不静默返回 0
        other => {
            state
                .error
                .get_or_insert_with(|| ArchiveAccessError::Io(format!(
                    "unrar callback message {other} unsupported"
                )));
            CallbackControl::Abort
        }
    }
}

fn dispatch_process_data(state: &mut RarCallbackState, p1: LPARAM, p2: LPARAM) -> CallbackControl {
    if p1 == 0 || p2 <= 0 {
        return CallbackControl::Continue;
    }
    let Some(sink) = state.sink.as_mut() else {
        state
            .error
            .get_or_insert_with(|| ArchiveAccessError::InvalidRequest(
                "ucm_processdata without data sink".into(),
            ));
        return CallbackControl::Abort;
    };
    let control = sink.feed_raw(p1, p2);
    if control == CallbackControl::Abort {
        if let Some(e) = sink.error.take() {
            state.error.get_or_insert(e);
        }
    }
    control
}

fn dispatch_need_password_ansi(
    state: &mut RarCallbackState,
    p1: LPARAM,
    p2: LPARAM,
) -> CallbackControl {
    let Some(password) = state.password_utf8.as_ref() else {
        // 无密码：先写 PasswordRequired 再返回 -1（unrar 随后可能再问 W 或直接报
        // ERAR_MISSING_PASSWORD——state 里的类型化错误优先于该通用码）
        state
            .error
            .get_or_insert(ArchiveAccessError::PasswordRequired);
        return CallbackControl::Abort;
    };
    if p1 == 0 || p2 <= 0 {
        state
            .error
            .get_or_insert_with(|| ArchiveAccessError::InvalidRequest(
                "unrar ansi password buffer invalid".into(),
            ));
        return CallbackControl::Abort;
    }
    // SAFETY: p1..p1+p2 是 unrar 提供的密码缓冲（字节容量 p2）。
    let dst = unsafe { std::slice::from_raw_parts_mut(p1 as *mut u8, p2 as usize) };
    copy_password_bytes(dst, password);
    CallbackControl::Continue
}

fn dispatch_need_password_wide(
    state: &mut RarCallbackState,
    p1: LPARAM,
    p2: LPARAM,
) -> CallbackControl {
    let Some(password) = state.password_wide.as_ref() else {
        // 与 ANSI 分支同款：先写 PasswordRequired 再 -1，保证「无密码首开」稳定
        // 进入密码弹框主流程，而不是退化为 UnRAR 通用错误
        state
            .error
            .get_or_insert(ArchiveAccessError::PasswordRequired);
        return CallbackControl::Abort;
    };
    if p1 == 0 || p2 <= 0 {
        state
            .error
            .get_or_insert_with(|| ArchiveAccessError::InvalidRequest(
                "unrar wide password buffer invalid".into(),
            ));
        return CallbackControl::Abort;
    }
    // SAFETY: p1..p1+p2 是 unrar 提供的宽字符密码缓冲（p2 个 wchar_t）。
    let dst = unsafe { std::slice::from_raw_parts_mut(p1 as *mut WCHAR, p2 as usize) };
    copy_password_wide(dst, password);
    CallbackControl::Continue
}

/// ANSI 分支复制合同：整个缓冲清零 → 复制 UTF-8 密码最多 `cap - 1` 字节 → NUL 结尾。
fn copy_password_bytes(dst: &mut [u8], password: &[u8]) {
    dst.fill(0);
    let n = password.len().min(dst.len() - 1);
    dst[..n].copy_from_slice(&password[..n]);
    dst[n] = 0;
}

/// W 分支复制合同：`cap` 个 wchar 全部清零 → 预编码密码截断到 `cap - 1` 个 → NUL 结尾。
/// 中文密码（fixture `test-pass-中文`）的主验证路径。
fn copy_password_wide(dst: &mut [WCHAR], password: &[WCHAR]) {
    dst.fill(0);
    // encode_wide 保证结尾 NUL；截断时按密码单元（不含 NUL）计
    let src = &password[..password.len().saturating_sub(1)];
    let n = src.len().min(dst.len() - 1);
    dst[..n].copy_from_slice(&src[..n]);
    dst[n] = 0;
}

// ---------------------------------------------------------------------------
// 无 FFI 单元测试：null/zero-length、恰好到限边界、宽字符截断、fail-closed
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// 简报步骤 1 的测试助手：以 UCM_PROCESSDATA 原始参数喂 sink。
    fn feed_callback_for_test(sink: &mut LimitedRarSink, p1: LPARAM, p2: LPARAM) -> CallbackControl {
        sink.feed_raw(p1, p2)
    }

    #[test]
    fn rar_callback_unit_checks_null_zero_length_and_budget_math() {
        let mut sink = LimitedRarSink::new(8);
        assert_eq!(
            feed_callback_for_test(&mut sink, std::ptr::null::<u8>() as LPARAM, 0),
            CallbackControl::Continue
        );
        // 恰好等于上限（8 字节）：允许完整保存、Continue、无错误——「恰好到限不误判」边界
        assert_eq!(
            feed_callback_for_test(&mut sink, b"12345678".as_ptr() as LPARAM, 8),
            CallbackControl::Continue
        );
        assert_eq!(sink.saved_len(), 8);
        assert!(sink.error().is_none());
        // 越界块（累计第 9 字节）：中止——观察到 9 字节（bytes_seen==9）但第 9 字节
        // 不保存（saved_len 仍为 8），state.error 为 ResourceLimitExceeded
        assert_eq!(
            feed_callback_for_test(&mut sink, b"9".as_ptr() as LPARAM, 1),
            CallbackControl::Abort
        );
        assert_eq!(sink.bytes_seen(), 9);
        assert_eq!(sink.saved_len(), 8);
        assert!(matches!(
            sink.error(),
            Some(ArchiveAccessError::ResourceLimitExceeded(_))
        ));
    }

    #[test]
    fn wide_password_branch_truncates_to_capacity_minus_one_and_null_terminates() {
        let mut state = RarCallbackState::new(Some("test-pass-中文".as_bytes()));
        // 容量 4 个 wchar：最多复制 3 个 + NUL
        let mut buf = [7 as WCHAR; 4];
        let control = dispatch_need_password_wide(
            &mut state,
            buf.as_mut_ptr() as LPARAM,
            buf.len() as LPARAM,
        );
        assert_eq!(control, CallbackControl::Continue);
        assert!(state.error.is_none());
        assert_eq!(decode_wide(&buf), "tes");
        assert_eq!(buf[3], 0);

        // 容量充足：完整中文密码 + NUL，NUL 之后（编码长度 + 1 起）全部为清零后的 0
        let mut big = [1 as WCHAR; 64];
        dispatch_need_password_wide(&mut state, big.as_mut_ptr() as LPARAM, big.len() as LPARAM);
        assert_eq!(decode_wide(&big), "test-pass-中文");
        let encoded = encode_wide("test-pass-中文");
        assert_eq!(encoded.len(), "test-pass-中文".encode_utf16().count() + 1);
        for &unit in &big[encoded.len()..] {
            assert_eq!(unit, 0);
        }
    }

    #[test]
    fn ansi_password_branch_truncates_utf8_bytes_to_capacity_minus_one() {
        let mut state = RarCallbackState::new(Some(b"secret".as_slice()));
        let mut buf = [0xffu8; 5];
        let control =
            dispatch_need_password_ansi(&mut state, buf.as_mut_ptr() as LPARAM, buf.len() as LPARAM);
        assert_eq!(control, CallbackControl::Continue);
        assert_eq!(&buf, b"secr\0");
        // 整缓冲先清零再复制的合同：首字节起即密码内容，无残留 0xff
        let mut big = [0xffu8; 32];
        dispatch_need_password_ansi(&mut state, big.as_mut_ptr() as LPARAM, big.len() as LPARAM);
        assert_eq!(&big[..6], b"secret");
        assert!(big[6..].iter().all(|&b| b == 0));
    }

    #[test]
    fn password_branches_without_password_write_password_required_and_abort() {
        // unrar 先问 W、空/失败再问 ANSI——两个无密码分支都必须先写 PasswordRequired
        let mut state = RarCallbackState::new(None);
        let mut wbuf = [0 as WCHAR; 8];
        assert_eq!(
            dispatch_need_password_wide(&mut state, wbuf.as_mut_ptr() as LPARAM, wbuf.len() as LPARAM),
            CallbackControl::Abort
        );
        assert_eq!(state.error, Some(ArchiveAccessError::PasswordRequired));
        let mut abuf = [0u8; 8];
        assert_eq!(
            dispatch_need_password_ansi(&mut state, abuf.as_mut_ptr() as LPARAM, abuf.len() as LPARAM),
            CallbackControl::Abort
        );
        assert_eq!(state.error, Some(ArchiveAccessError::PasswordRequired));
        // 缓冲不被触碰（清零只发生在有密码分支）
        assert!(abuf.iter().all(|&b| b == 0));
    }

    #[test]
    fn unknown_message_and_volume_change_fail_closed_with_typed_errors() {
        let mut state = RarCallbackState::new(None);
        // 未来消息（UCM_LARGEDICT=5 等）：fail-closed，不静默返回 0
        assert_eq!(
            dispatch_rar_message(&mut state, 5, 0, 0),
            CallbackControl::Abort
        );
        assert!(matches!(state.take_error(), Some(ArchiveAccessError::Io(_))));
        // 换卷（p2 是 RAR_VOL_ASK/RAR_VOL_NOTIFY 模式值而非长度）：直接终止
        assert_eq!(
            dispatch_rar_message(&mut state, unrar_sys::UCM_CHANGEVOLUMEW, 0x1000 as LPARAM, 0),
            CallbackControl::Abort
        );
        assert!(matches!(
            state.take_error(),
            Some(ArchiveAccessError::MultiVolumeUnsupported(_))
        ));
    }

    #[test]
    fn raw_callback_entry_rejects_null_user_data_without_crashing() {
        // user_data 为 0：无法记录错误，fail-closed 返回 -1（不解引用）
        assert_eq!(rar_ffi_callback(unrar_sys::UCM_PROCESSDATA, 0, 0, 0), -1);
    }

    #[test]
    fn encode_wide_decode_wide_round_trips_across_platform_width() {
        for s in ["page.png", "test-pass-中文", "a/note.txt", ""] {
            let wide = encode_wide(s);
            assert_eq!(*wide.last().unwrap(), 0, "encode_wide 必须以 NUL 结尾");
            assert_eq!(decode_wide(&wide), s);
        }
    }
}
