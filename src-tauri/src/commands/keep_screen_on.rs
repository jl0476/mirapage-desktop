//! `keep_screen_on` Tauri command
//!
//! v0.1.0-module2.0: 阅读时阻止屏幕休眠 / 自动锁屏 (Windows 调
//! `SetThreadExecutionState(ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED)`,
//! macOS 调 `IOPMAssertionCreateWithName`, Linux 同 Windows API).
//!
//! **线程作用域**: 不调 `clear()` 前持续生效. ReaderView unmount 时
//! `useKeepScreenOn` 会再调 `false` 释放. 进程退出时 OS 自动释放.
use tauri::AppHandle;

#[cfg(target_os = "windows")]
fn apply(enable: bool) -> Result<(), String> {
    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        EXECUTION_STATE,
    };
    let flags = if enable {
        ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
    } else {
        ES_CONTINUOUS
    };
    // SAFETY: SetThreadExecutionState 是线程作用域的就绪/睡眠掩码操作,
    // 无副作用指针, 失败仅返回 EXECUTION_STATE(0), 转为 Err.
    unsafe {
        let prev = SetThreadExecutionState(flags);
        if prev == EXECUTION_STATE(0) {
            Err("SetThreadExecutionState failed".into())
        } else {
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
fn apply(enable: bool) -> Result<(), String> {
    // IOPMAssertion 需 objc / cocoa crate, Phase 9 跨平台分发时再补.
    // 当前 stub: no-op (macOS 用户可手动设"防止显示屏关闭"系统设置).
    let _ = enable;
    Ok(())
}

#[cfg(target_os = "linux")]
fn apply(enable: bool) -> Result<(), String> {
    // Linux 通过 D-Bus 发 Inhibit 接口给 org.freedesktop.ScreenSaver;
    // 跨桌面差异较大 (GNOME/KDE/XFCE/Wayland), 暂 stub.
    let _ = enable;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
fn apply(_enable: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn keep_screen_on(_app: AppHandle, enable: bool) -> Result<(), String> {
    apply(enable)
}
