//! `commands::progress` —— 进度持久化(供 reader store 500ms 防抖回调)

#[tauri::command]
pub fn save_progress(
    book_id: i64,
    page: i64,
    reader_mode: String,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    let now = chrono_now();
    conn.execute(
        "INSERT INTO progress (book_id, page, reader_mode, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(book_id) DO UPDATE SET
           page = excluded.page,
           reader_mode = excluded.reader_mode,
           updated_at = excluded.updated_at",
        rusqlite::params![book_id, page, reader_mode, now],
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