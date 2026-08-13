//! `commands::maintenance` —— 维护 IPC 入口（spec §8）。
//!
//! 4 个命令：
//! - `get_maintenance_summary`：当前用量 + 上限 + 最近结果（Settings 页加载用）
//! - `get_maintenance_preview`：本次将删除的历史条数 / 缩略图条数 / 预计释放（只读）
//! - `run_maintenance`：立即维护（前端须传 `confirmed=true`）。直接执行，返回结果。
//! - `update_maintenance_settings`：写维护配置（条数 / 天数 / 保护窗口 / 总开关）
//!
//! 注意：手动 `run_maintenance` **不走**防抖 actor——直接 spawn_blocking 调
//! `run_maintenance_once(auto=false)` 同步返回结果。actor 仅负责 record_history
//! 触发的防抖自动清理（`run_maintenance_once(auto=true)`）。

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::db::Db;
use crate::maintenance::{
    self, MaintenancePreview, MaintenanceRunResult, MaintenanceSummary,
};

#[tauri::command]
pub fn get_maintenance_summary(app: AppHandle) -> Result<MaintenanceSummary, String> {
    let (_, summary) = maintenance::preview(&app);
    Ok(summary)
}

#[tauri::command]
pub fn get_maintenance_preview(app: AppHandle) -> Result<MaintenancePreview, String> {
    let (preview, _) = maintenance::preview(&app);
    Ok(preview)
}

#[tauri::command]
pub async fn run_maintenance(
    confirmed: bool,
    app: AppHandle,
) -> Result<MaintenanceRunResult, String> {
    if !confirmed {
        return Err("run_maintenance 要求前端显式传入 confirmed=true".to_string());
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || maintenance::run_maintenance_once(&app2, false))
        .await
        .map_err(|e| format!("维护任务 join 失败: {e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMaintenanceSettingsArgs {
    pub auto_cleanup_enabled: Option<bool>,
    pub history_max_entries: Option<i64>,
    pub history_retention_days: Option<i64>,
    pub history_protect_days: Option<i64>,
}

#[tauri::command]
pub fn update_maintenance_settings(
    args: UpdateMaintenanceSettingsArgs,
    db: State<Db>,
) -> Result<(), String> {
    let conn = db.conn();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(v) = args.auto_cleanup_enabled {
        write_setting(&tx, "maintenance_auto_cleanup_enabled", if v { "1" } else { "0" })?;
    }
    if let Some(v) = args.history_max_entries {
        write_setting(&tx, "history_retention_max_entries", &v.to_string())?;
    }
    if let Some(v) = args.history_retention_days {
        write_setting(&tx, "history_retention_days", &v.to_string())?;
    }
    if let Some(v) = args.history_protect_days {
        // 钳到 0–30（spec §4）
        write_setting(
            &tx,
            "history_recent_protect_days",
            &v.clamp(0, 30).to_string(),
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn write_setting(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
