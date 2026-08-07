//! `commands::directory_masonry` —— 按文件夹瀑布流布局参数覆盖 (v0.1.0-module3.0.6)

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryMasonry {
    pub col_count: Option<i64>,
    pub h_gap: Option<i64>,
    pub v_gap: Option<i64>,
}

/// locationKey = SourceDescriptorJson + "|" + relPath (与 directory_sort 一致,
/// 前端用 JSON.stringify(descriptor) + '|' + relPath, 必须匹配)
fn location_key_of(source_descriptor: &serde_json::Value, rel_path: &str) -> String {
    let sd_str = serde_json::to_string(source_descriptor).unwrap_or_default();
    format!("{}|{}", sd_str, rel_path)
}

#[tauri::command]
pub fn get_directory_masonry(
    source_descriptor: serde_json::Value,
    rel_path: String,
    db: tauri::State<crate::db::Db>,
) -> Result<Option<DirectoryMasonry>, String> {
    let conn = db.conn();
    let key = location_key_of(&source_descriptor, &rel_path);
    let mut stmt = conn
        .prepare(
            "SELECT col_count, h_gap, v_gap
             FROM directory_masonry WHERE location_key = ?1 LIMIT 1",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([&key]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(DirectoryMasonry {
            col_count: row.get(0).map_err(|e| e.to_string())?,
            h_gap: row.get(1).map_err(|e| e.to_string())?,
            v_gap: row.get(2).map_err(|e| e.to_string())?,
        }))
    } else {
        Ok(None)
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDirectoryMasonryArgs {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub col_count: Option<i64>,
    pub h_gap: Option<i64>,
    pub v_gap: Option<i64>,
}

#[tauri::command]
pub fn set_directory_masonry(
    args: SetDirectoryMasonryArgs,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    let key = location_key_of(&args.source_descriptor, &args.rel_path);
    // 部分更新: COALESCE 让传入 NULL 的维度保留原值
    conn.execute(
        "INSERT INTO directory_masonry (location_key, col_count, h_gap, v_gap)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(location_key) DO UPDATE SET
           col_count = COALESCE(excluded.col_count, directory_masonry.col_count),
           h_gap = COALESCE(excluded.h_gap, directory_masonry.h_gap),
           v_gap = COALESCE(excluded.v_gap, directory_masonry.v_gap)",
        rusqlite::params![key, args.col_count, args.h_gap, args.v_gap],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}