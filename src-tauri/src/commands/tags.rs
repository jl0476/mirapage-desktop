//! `commands::tags` —— 标签 CRUD + 书本打标签

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
pub struct TagItem {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub fn list_tags(db: tauri::State<crate::db::Db>) -> Result<Vec<TagItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT id, name, color, created_at FROM tag ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TagItem {
                id: row.get::<_, i64>(0)?,
                name: row.get::<_, String>(1)?,
                color: row.get::<_, Option<String>>(2)?,
                created_at: row.get::<_, i64>(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn create_tag(
    name: String,
    color: Option<String>,
    db: tauri::State<crate::db::Db>,
) -> Result<TagItem, String> {
    let conn = db.conn();
    let now = chrono_now();
    conn.execute(
        "INSERT INTO tag (name, color, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![name, color, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(TagItem {
        id,
        name,
        color,
        created_at: now,
    })
}

#[tauri::command]
pub fn delete_tag(id: i64, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    conn.execute("DELETE FROM tag WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn add_book_tag(
    book_id: i64,
    tag_id: i64,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    conn.execute(
        "INSERT OR IGNORE INTO book_tag (book_id, tag_id) VALUES (?1, ?2)",
        rusqlite::params![book_id, tag_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_book_tag(
    book_id: i64,
    tag_id: i64,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    conn.execute(
        "DELETE FROM book_tag WHERE book_id = ?1 AND tag_id = ?2",
        rusqlite::params![book_id, tag_id],
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