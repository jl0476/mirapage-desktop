//! `commands::library` —— 书库收藏 (v0.1.0-module3.0: 11 字段 + WHERE is_favorite=1 过滤)

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookItem {
    pub id: i64,
    pub title: String,
    /// v0.1.0-module3.0.2: 用 serde_json::Value 序列化, IPC 边界自动拆成
    /// SourceDescriptor 对象 (与 BrowseHistoryEntry / RecordHistoryArgs 对齐).
    /// 旧 version 输出 JSON string, TS 端 ReaderView / RowContextMenu 需做
    /// 防御性 JSON.parse 才不崩, 改 Value 后两边契约一致.
    pub source_descriptor: serde_json::Value,
    pub source_type: String,
    pub absolute_path: String,
    pub cover_entry_path: Option<String>,
    pub cover_entry_name: Option<String>,
    pub page_count: i64,
    pub last_read_at: Option<i64>,
    pub added_at: i64,
    pub is_favorite: bool,
}

#[tauri::command]
pub fn list_library(db: tauri::State<crate::db::Db>) -> Result<Vec<BookItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare(
            "SELECT id, title, source_descriptor, source_type, absolute_path,
                    cover_entry_path, cover_entry_name, page_count,
                    last_read_at, added_at, is_favorite
             FROM library
             WHERE is_favorite = 1
             ORDER BY last_read_at IS NULL, last_read_at DESC, added_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let raw: String = row.get(2)?;
            let source_descriptor: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or(serde_json::Value::Null);
            Ok(BookItem {
                id: row.get::<_, i64>(0)?,
                title: row.get::<_, String>(1)?,
                source_descriptor,
                source_type: row.get::<_, String>(3)?,
                absolute_path: row.get::<_, String>(4)?,
                cover_entry_path: row.get::<_, Option<String>>(5)?,
                cover_entry_name: row.get::<_, Option<String>>(6)?,
                page_count: row.get::<_, i64>(7)?,
                last_read_at: row.get::<_, Option<i64>>(8)?,
                added_at: row.get::<_, i64>(9)?,
                is_favorite: row.get::<_, i64>(10)? != 0,
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
        "UPDATE library SET is_favorite = ?1 WHERE id = ?2",
        rusqlite::params![if favorite { 1i64 } else { 0i64 }, book_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// v0.1.0-module3.0: 按 book_id 查单条 (ReaderView 启动时用,
/// 替代旧 per-book history.bookId 查找模式)
#[tauri::command]
pub fn get_book(book_id: i64, db: tauri::State<crate::db::Db>) -> Result<Option<BookItem>, String> {
    let conn = db.conn();
    let result = conn
        .query_row(
            "SELECT id, title, source_descriptor, source_type, absolute_path,
                    cover_entry_path, cover_entry_name, page_count,
                    last_read_at, added_at, is_favorite
             FROM library WHERE id = ?1",
            rusqlite::params![book_id],
            |row| {
                let raw: String = row.get(2)?;
                let source_descriptor: serde_json::Value = serde_json::from_str(&raw)
                    .unwrap_or(serde_json::Value::Null);
                Ok(BookItem {
                    id: row.get::<_, i64>(0)?,
                    title: row.get::<_, String>(1)?,
                    source_descriptor,
                    source_type: row.get::<_, String>(3)?,
                    absolute_path: row.get::<_, String>(4)?,
                    cover_entry_path: row.get::<_, Option<String>>(5)?,
                    cover_entry_name: row.get::<_, Option<String>>(6)?,
                    page_count: row.get::<_, i64>(7)?,
                    last_read_at: row.get::<_, Option<i64>>(8)?,
                    added_at: row.get::<_, i64>(9)?,
                    is_favorite: row.get::<_, i64>(10)? != 0,
                })
            },
        )
        .ok();
    Ok(result)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBookArgs {
    pub title: String,
    pub source_descriptor: serde_json::Value,
    pub absolute_path: String,
    pub source_type: String,
    pub favorite: bool,
    /// caller 已 enumerate 一次，传入封面 + 页数；enumerate 失败时传 None / 0
    pub cover_entry_path: Option<String>,
    pub cover_entry_name: Option<String>,
    pub page_count: i64,
}

#[tauri::command]
pub fn create_book(args: CreateBookArgs, db: tauri::State<crate::db::Db>) -> Result<i64, String> {
    let conn = db.conn();
    // 路径身份修复 (2026-08-12, spec §6.3): descriptor 反序列化为 SourceDescriptor
    // 校验变体合法 + 重新序列化规范化; absolute_path 校验 source-relative。
    // 绝对路径只允许出现在 rootPath; absolute_path 必须相对 root, 根目录为 "".
    let descriptor: crate::source::descriptor::SourceDescriptor =
        serde_json::from_value(args.source_descriptor.clone())
            .map_err(|e| format!("source descriptor 非法: {}", e))?;
    let descriptor_str = serde_json::to_string(&descriptor).map_err(|e| e.to_string())?;
    let abs_path = crate::algorithm::validate_source_relative(&args.absolute_path)
        .map_err(|_| format!("absolute_path 越出数据源根: {}", args.absolute_path))?;

    // 复用同 (sourceDescriptor, absolutePath) 的 row (Android LibraryRepository.importFromSource 行为)
    let existing: Option<(i64, bool)> = conn
        .query_row(
            "SELECT id, is_favorite FROM library WHERE source_descriptor = ?1 AND absolute_path = ?2",
            rusqlite::params![descriptor_str, abs_path],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? != 0)),
        )
        .ok();

    if let Some((id, is_fav)) = existing {
        // favorite=true 且当前未 favorite → 升级
        if args.favorite && !is_fav {
            conn.execute(
                "UPDATE library SET is_favorite = 1 WHERE id = ?1",
                rusqlite::params![id],
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(id);
    }

    // 不存在则 INSERT（11 列对齐 Android LibraryEntity）
    let now = chrono_now();
    conn.execute(
        "INSERT INTO library
            (title, source_descriptor, source_type, absolute_path,
             cover_entry_path, cover_entry_name, page_count,
             added_at, is_favorite)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![
            args.title,
            descriptor_str,
            args.source_type,
            abs_path,
            args.cover_entry_path,
            args.cover_entry_name,
            args.page_count,
            now,
            if args.favorite { 1i64 } else { 0i64 },
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}