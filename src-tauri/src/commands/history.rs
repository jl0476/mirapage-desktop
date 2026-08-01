//! `commands::history` —— 阅览记录

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub book_id: i64,
    /// source_descriptor 已是 JSON 对象 (前端可直接读 type / rootPath)
    pub source_descriptor: serde_json::Value,
    pub last_page: Option<i64>,
    pub last_read_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordHistoryArgs {
    pub source_descriptor: serde_json::Value,
    pub book_id: i64,
    pub last_page: i64,
}

#[tauri::command]
pub fn list_history(db: tauri::State<crate::db::Db>) -> Result<Vec<HistoryItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT book_id, source_descriptor, last_page, last_read_at FROM browse_history ORDER BY last_read_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            // 解析 source_descriptor JSON 字符串为 Value, 前端可直接读 {type, rootPath}
            let sd_str: String = row.get(1)?;
            let sd_value: serde_json::Value = serde_json::from_str(&sd_str)
                .unwrap_or(serde_json::Value::Null);
            Ok(HistoryItem {
                book_id: row.get::<_, i64>(0)?,
                source_descriptor: sd_value,
                last_page: row.get::<_, Option<i64>>(2)?,
                last_read_at: row.get::<_, i64>(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn record_history(args: RecordHistoryArgs, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    let now = chrono_now();
    let descriptor_str = serde_json::to_string(&args.source_descriptor).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO browse_history (book_id, source_descriptor, last_page, last_read_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET
           source_descriptor = excluded.source_descriptor,
           last_page = excluded.last_page,
           last_read_at = excluded.last_read_at",
        rusqlite::params![args.book_id, descriptor_str, args.last_page, now],
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