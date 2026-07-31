//! `log.rs` — 自写文件日志 (production exe 可读)
//!
//! 不依赖 tauri-plugin-log (v0.1.0-module1.7 plugin init 失败导致 exe 崩溃).
//! 直接 std::fs::OpenOptions::append 写 %LOCALAPPDATA%/<id>/logs/main.log.
//!
//! 调用方式:
//! - Rust: log::write_log("INFO", "list_directory ok: 5 entries")
//! - 前端: 通过 tauri command `log_to_file` 转发

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// 计算 log 文件路径, 同时确保父目录存在.
/// Windows: %LOCALAPPDATA%\top.racyan.mirapage-desktop\logs\main.log
/// macOS:   ~/Library/Application Support/top.racyan.mirapage-desktop/logs/main.log
/// Linux:   ~/.local/share/top.racyan.mirapage-desktop/logs/main.log
fn log_file_path() -> Option<PathBuf> {
    let mut p = dirs_data_local()?;
    p.push("top.racyan.mirapage-desktop");
    p.push("logs");
    fs::create_dir_all(&p).ok()?;
    p.push("main.log");
    Some(p)
}

/// 跨平台等价 `dirs::data_local_dir()` (不引入新 crate)
fn dirs_data_local() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| {
            let mut p = PathBuf::from(h);
            p.push("Library/Application Support");
            p
        })
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| {
                let mut p = PathBuf::from(h);
                p.push(".local/share");
                p
            }))
    }
}

/// 写一行 log 到 main.log (best-effort, 失败静默)
pub fn write_log(level: &str, target: &str, msg: &str) {
    let Some(path) = log_file_path() else { return };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 简单时间格式: unix_ms (容易 grep / awk)
    let line = format!("{now} [{level}] [{target}] {msg}\n");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}
