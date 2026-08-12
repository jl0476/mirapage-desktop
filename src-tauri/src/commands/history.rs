//! `commands::history` —— 阅览记录 (v0.1.0-module3.0: folder-level, Android BrowseHistory 对齐)
//! v0.1.0-module3.0.1: book_id 列 (关联 library.id, 用于 readStatus 派生)

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowseHistoryEntry {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub display_name: String,
    pub last_visited_at: i64,
    /// v0.1.0-module3.0.1: 关联 library.id (reader 真正打开时记录)
    pub book_id: Option<i64>,
}

#[tauri::command]
pub fn list_history(db: tauri::State<crate::db::Db>) -> Result<Vec<BrowseHistoryEntry>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare(
            "SELECT source_descriptor, rel_path, display_name, last_visited_at, book_id
             FROM browse_history ORDER BY last_visited_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let sd_str: String = row.get(0)?;
            let sd_value: serde_json::Value = serde_json::from_str(&sd_str)
                .unwrap_or(serde_json::Value::Null);
            Ok(BrowseHistoryEntry {
                source_descriptor: sd_value,
                rel_path: row.get(1)?,
                display_name: row.get(2)?,
                last_visited_at: row.get(3)?,
                book_id: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordHistoryArgs {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub display_name: String,
    /// v0.1.0-module3.0.1: optional book_id — reader 打开时传
    pub book_id: Option<i64>,
}

#[tauri::command]
pub fn record_history(args: RecordHistoryArgs, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    // 路径身份修复 (2026-08-12, spec §6.3): descriptor 反序列化校验 + rel_path 校验 source-relative。
    let descriptor: crate::source::descriptor::SourceDescriptor =
        serde_json::from_value(args.source_descriptor.clone())
            .map_err(|e| format!("source descriptor 非法: {}", e))?;
    let descriptor_str = serde_json::to_string(&descriptor).map_err(|e| e.to_string())?;
    let rel_path = crate::algorithm::validate_source_relative(&args.rel_path)
        .map_err(|_| format!("rel_path 越出数据源根: {}", args.rel_path))?;
    let now = chrono_now();
    conn.execute(
        "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_descriptor, rel_path) DO UPDATE SET
           display_name = excluded.display_name,
           last_visited_at = excluded.last_visited_at,
           book_id = excluded.book_id",
        rusqlite::params![descriptor_str, rel_path, args.display_name, now, args.book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_history(
    source_descriptor: serde_json::Value,
    rel_path: String,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    let descriptor_str = serde_json::to_string(&source_descriptor).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM browse_history WHERE source_descriptor = ?1 AND rel_path = ?2",
        rusqlite::params![descriptor_str, rel_path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}