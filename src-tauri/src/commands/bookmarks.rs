//! `commands::bookmarks` —— 书签 CRUD
//!
//! 对应 DESIGN.md §5 Phase 4 + §11 bookmark 表
//! 前端通过 `lib/tauri.ts:listBookmarks / addBookmark / removeBookmark` 调用

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct BookmarkItem {
    pub id: i64,
    pub book_id: i64,
    pub page: i64,
    pub label: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub fn list_bookmarks(book_id: i64, db: tauri::State<crate::db::Db>) -> Result<Vec<BookmarkItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT id, book_id, page, label, created_at FROM bookmark WHERE book_id = ?1 ORDER BY page ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([book_id], |row| {
            Ok(BookmarkItem {
                id: row.get::<_, i64>(0)?,
                book_id: row.get::<_, i64>(1)?,
                page: row.get::<_, i64>(2)?,
                label: row.get::<_, Option<String>>(3)?,
                created_at: row.get::<_, i64>(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn add_bookmark(
    book_id: i64,
    page: i64,
    label: Option<String>,
    db: tauri::State<crate::db::Db>,
) -> Result<BookmarkItem, String> {
    let conn = db.conn();
    let now = chrono_now();
    conn.execute(
        "INSERT INTO bookmark (book_id, page, label, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![book_id, page, label, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(BookmarkItem {
        id,
        book_id,
        page,
        label,
        created_at: now,
    })
}

#[tauri::command]
pub fn remove_bookmark(id: i64, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    conn.execute("DELETE FROM bookmark WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}