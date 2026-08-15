//! `commands::directory_sort` —— 按文件夹排序覆盖 (v0.1.0-module3.0, Android DirectorySortEntity 对齐)

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySort {
    pub location_key: String,
    pub sort_field: String,
    pub ascending: bool,
}

/// locationKey = SourceDescriptorJson + "|" + relPath (与 Android DirectorySortRepository 一致)
/// pub(crate)：find_next_volume 解析父目录排序覆盖时复用（必须同构，防键序漂移查不到行）
pub(crate) fn location_key_of(source_descriptor: &serde_json::Value, rel_path: &str) -> String {
    let sd_str = serde_json::to_string(source_descriptor).unwrap_or_default();
    format!("{}|{}", sd_str, rel_path)
}

#[tauri::command]
pub fn get_directory_sort(
    source_descriptor: serde_json::Value,
    rel_path: String,
    db: tauri::State<crate::db::Db>,
) -> Result<Option<DirectorySort>, String> {
    let conn = db.conn();
    let key = location_key_of(&source_descriptor, &rel_path);
    let mut stmt = conn
        .prepare(
            "SELECT location_key, sort_field, ascending
             FROM directory_sort WHERE location_key = ?1 LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([&key]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(DirectorySort {
            location_key: row.get(0).map_err(|e| e.to_string())?,
            sort_field: row.get(1).map_err(|e| e.to_string())?,
            ascending: row.get::<_, i64>(2).map_err(|e| e.to_string())? != 0,
        }))
    } else {
        Ok(None)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDirectorySortArgs {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub sort_field: String,
    pub ascending: bool,
}

#[tauri::command]
pub fn set_directory_sort(
    args: SetDirectorySortArgs,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    let key = location_key_of(&args.source_descriptor, &args.rel_path);
    conn.execute(
        "INSERT INTO directory_sort (location_key, sort_field, ascending)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(location_key) DO UPDATE SET
           sort_field = excluded.sort_field,
           ascending = excluded.ascending",
        rusqlite::params![
            key,
            args.sort_field,
            if args.ascending { 1i64 } else { 0i64 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}