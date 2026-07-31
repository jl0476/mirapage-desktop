//! `commands::log` — 日志透出 (前端 → 文件)
//!
//! 前端 console.log 调用 \`log()\` 触发的日志通过 invoke('log_to_file', { msg })
//! 进入这里, 写入 main.log. 这样 production exe 也能看前端埋点.

use crate::log;

#[tauri::command]
pub fn log_to_file(level: String, target: String, msg: String) {
    // level 限定白名单, 防滥用
    let lvl = match level.as_str() {
        "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" => level.as_str(),
        _ => "INFO",
    };
    log::write_log(lvl, &target, &msg);
}
