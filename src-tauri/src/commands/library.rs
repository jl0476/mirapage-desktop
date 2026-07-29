//! `commands::library` —— 书架收藏

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct BookItem {
    pub id: i64,
    pub title: String,
    pub source_descriptor: String,
    pub last_read_at: Option<i64>,
    pub is_favorite: bool,
}

#[tauri::command]
pub fn list_library(db: tauri::State<crate::db::Db>) -> Result<Vec<BookItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare(
            "SELECT id, title, source_descriptor, last_read_at, is_favorite FROM book ORDER BY is_favorite DESC, last_read_at DESC NULLS LAST",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(BookItem {
                id: row.get::<_, i64>(0)?,
                title: row.get::<_, String>(1)?,
                source_descriptor: row.get::<_, String>(2)?,
                last_read_at: row.get::<_, Option<i64>>(3)?,
                is_favorite: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn set_favorite(
    book_id: i64,
    favorite: bool,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    conn.execute(
        "UPDATE book SET is_favorite = ?1 WHERE id = ?2",
        rusqlite::params![if favorite { 1i64 } else { 0i64 }, book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct CreateBookArgs {
    pub title: String,
    pub source_descriptor: serde_json::Value,
}

#[tauri::command]
pub fn create_book(args: CreateBookArgs, db: tauri::State<crate::db::Db>) -> Result<i64, String> {
    let conn = db.conn();
    let descriptor_str = serde_json::to_string(&args.source_descriptor).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO book (title, source_descriptor, is_favorite) VALUES (?1, ?2, 0)",
        rusqlite::params![args.title, descriptor_str],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}