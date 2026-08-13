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
    record_history_inner(
        &conn,
        &descriptor_str,
        &rel_path,
        &args.display_name,
        now,
        args.book_id,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// UPSERT 一条浏览历史（v0.1.0-database-retention-and-cleanup）。
///
/// 冲突时（同一 source_descriptor + rel_path）：刷新 display_name / last_visited_at /
/// book_id，并 **visit_count += 1**（spec §3.1）。首次插入走 DEFAULT 1。
///
/// 抽成接受 `&Connection` 的 pub(crate) fn：① 可单测；② task 4 的 maintenance
/// dirty 通知在 command 层接入，不污染本函数。
pub(crate) fn record_history_inner(
    conn: &rusqlite::Connection,
    descriptor_str: &str,
    rel_path: &str,
    display_name: &str,
    now: i64,
    book_id: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_descriptor, rel_path) DO UPDATE SET
           display_name = excluded.display_name,
           last_visited_at = excluded.last_visited_at,
           book_id = excluded.book_id,
           visit_count = browse_history.visit_count + 1",
        rusqlite::params![descriptor_str, rel_path, display_name, now, book_id],
    )?;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn record_history_inner_first_insert_sets_visit_count_default_1() {
        let conn = test_db();
        record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "X", 100, None).unwrap();

        let vc: i64 = conn
            .query_row(
                "SELECT visit_count FROM browse_history WHERE rel_path='/x'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(vc, 1, "首次插入 visit_count 默认 1");
    }

    #[test]
    fn record_history_inner_repeat_increments_visit_count() {
        // spec §3.1 / §10 验收：访问同一目录 10 次后 visit_count=10
        let conn = test_db();
        for i in 0..10 {
            record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "X", 100 + i, None).unwrap();
        }
        let (vc, last, name): (i64, i64, String) = conn
            .query_row(
                "SELECT visit_count, last_visited_at, display_name FROM browse_history WHERE rel_path='/x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(vc, 10, "10 次 UPSERT 后 visit_count 应为 10");
        assert_eq!(last, 109, "last_visited_at 应为最后一次");
        assert_eq!(name, "X");

        // 只有一行（UPSERT 不产生重复）
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM browse_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn record_history_inner_refreshes_display_name_and_book_id() {
        let conn = test_db();
        record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "旧名", 100, None).unwrap();
        record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "新名", 200, Some(42)).unwrap();

        let (name, book_id, vc): (String, Option<i64>, i64) = conn
            .query_row(
                "SELECT display_name, book_id, visit_count FROM browse_history WHERE rel_path='/x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(name, "新名", "display_name 应刷新");
        assert_eq!(book_id, Some(42), "book_id 应刷新");
        assert_eq!(vc, 2);
    }
}