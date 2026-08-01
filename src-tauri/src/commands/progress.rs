//! `commands::progress` —— 进度持久化(供 reader store 500ms 防抖回调)
//!
//! v0.1.0-module1.21: 加 `finished` 字段, 标识已读完末页（永久 true，翻回不清零）。
//! 参考 perfect-viewer `ProgressEntity.finished`。

use std::collections::HashMap;

/// 保存阅读进度。
///
/// `finished` 语义：
/// - `Some(true)` → 翻到末页；触发 finished=1（不可降级）
/// - `Some(false)` → 主动标记重置；触发 finished=0 + 清 browse_history
/// - `None` → 普通翻页，只更新 page/reader_mode（finished 字段保持不变）
#[tauri::command]
pub fn save_progress(
    book_id: i64,
    page: i64,
    reader_mode: String,
    finished: Option<bool>,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    let now = chrono_now();

    match finished {
        Some(true) => {
            // 末页判定：upsert, finished=1
            conn.execute(
                "INSERT INTO progress (book_id, page, reader_mode, updated_at, finished) VALUES (?1, ?2, ?3, ?4, 1)
                 ON CONFLICT(book_id) DO UPDATE SET
                   page = excluded.page,
                   reader_mode = excluded.reader_mode,
                   updated_at = excluded.updated_at,
                   finished = 1",
                rusqlite::params![book_id, page, reader_mode, now],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(false) => {
            // 主动重置：finished=0, 清 browse_history
            conn.execute(
                "INSERT INTO progress (book_id, page, reader_mode, updated_at, finished) VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT(book_id) DO UPDATE SET
                   page = excluded.page,
                   reader_mode = excluded.reader_mode,
                   updated_at = excluded.updated_at,
                   finished = 0",
                rusqlite::params![book_id, page, reader_mode, now],
            )
            .map_err(|e| e.to_string())?;
            let _ = conn.execute(
                "DELETE FROM browse_history WHERE book_id = ?1",
                rusqlite::params![book_id],
            );
        }
        None => {
            // 普通翻页: 保留已有 finished 值
            conn.execute(
                "INSERT INTO progress (book_id, page, reader_mode, updated_at, finished) VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT(book_id) DO UPDATE SET
                   page = excluded.page,
                   reader_mode = excluded.reader_mode,
                   updated_at = excluded.updated_at",
                rusqlite::params![book_id, page, reader_mode, now],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

/// 手动标记 / 重置 finished（不依赖翻页判定）。
///
/// `finished=false` 时同时清 browse_history，让 readStatus store 重置回 NONE。
#[tauri::command]
pub fn mark_finished(
    book_id: i64,
    finished: bool,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    let now = chrono_now();
    conn.execute(
        "INSERT INTO progress (book_id, page, reader_mode, updated_at, finished) VALUES (?1, 0, 'single', ?2, ?3)
         ON CONFLICT(book_id) DO UPDATE SET
           finished = excluded.finished,
           updated_at = excluded.updated_at",
        rusqlite::params![book_id, now, finished as i32],
    )
    .map_err(|e| e.to_string())?;
    if !finished {
        let _ = conn.execute(
            "DELETE FROM browse_history WHERE book_id = ?1",
            rusqlite::params![book_id],
        );
    }
    Ok(())
}

/// 列出所有 progress.finished 映射，给前端 readStatus store 用。
///
/// 返回 `{ book_id: finished_bool }`，key 是 i64 字符串。
#[tauri::command]
pub fn list_progress_finished(
    db: tauri::State<crate::db::Db>,
) -> Result<HashMap<String, bool>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT book_id, finished FROM progress")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let book_id: i64 = row.get(0)?;
            let finished: i32 = row.get(1)?;
            Ok((book_id.to_string(), finished != 0))
        })
        .map_err(|e| e.to_string())?;
    let mut map = HashMap::new();
    for r in rows {
        let (k, v) = r.map_err(|e| e.to_string())?;
        map.insert(k, v);
    }
    Ok(map)
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}