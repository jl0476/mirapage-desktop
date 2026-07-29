//! `commands::likes` —— 喜欢 toggle

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct LikeItem {
    pub book_id: i64,
    pub liked_at: i64,
}

#[tauri::command]
pub fn list_likes(db: tauri::State<crate::db::Db>) -> Result<Vec<LikeItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT book_id, liked_at FROM `like` ORDER BY liked_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(LikeItem {
                book_id: row.get::<_, i64>(0)?,
                liked_at: row.get::<_, i64>(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn toggle_like(book_id: i64, db: tauri::State<crate::db::Db>) -> Result<bool, String> {
    let conn = db.conn();
    let now = chrono_now();
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM `like` WHERE book_id = ?1",
            [book_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())
        .is_ok();
    if exists {
        conn.execute("DELETE FROM `like` WHERE book_id = ?1", rusqlite::params![book_id])
            .map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        conn.execute(
            "INSERT INTO `like` (book_id, liked_at) VALUES (?1, ?2)",
            rusqlite::params![book_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    }
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}