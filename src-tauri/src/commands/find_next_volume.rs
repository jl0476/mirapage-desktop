//! `commands::find_next_volume` —— 跨卷连续阅读算法
//!
//! 当前为 stub——完整实现见 usecase/find_next_volume.rs(Phase 5)。

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")] // v0.1.0-module3.0.2 (H4): 与 create_book / record_history 对齐
pub struct FindNextVolumeArgs {
    pub descriptor: serde_json::Value,
    pub current_path: String,
    pub direction: String, // "next" | "prev"
}

#[tauri::command]
pub fn find_next_volume(args: FindNextVolumeArgs) -> Result<Option<String>, String> {
    // TODO(Phase 5): 接 usecase::find_next_volume
    // 当前为占位:返回 None(无下一卷 / 上一卷)
    let _ = args;
    Ok(None)
}