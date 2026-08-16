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

fn map_book_row(row: &rusqlite::Row) -> rusqlite::Result<BookItem> {
    let raw: String = row.get(2)?;
    let source_descriptor: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
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
}

#[tauri::command]
pub fn list_library(
    db: tauri::State<crate::db::Db>,
    limit: Option<i64>,
    cursor: Option<String>,
) -> Result<crate::commands::pagination::Paginated<BookItem>, String> {
    use crate::commands::pagination::{decode_cursor, page_limit, Paginated};
    let conn = db.conn();
    let base = "SELECT id, title, source_descriptor, source_type, absolute_path,
                cover_entry_path, cover_entry_name, page_count,
                last_read_at, added_at, is_favorite
         FROM library WHERE is_favorite = 1";
    // last_read_at IS NULL 把未读排末尾；加 id DESC 做确定性 tiebreaker（keyset 必需）
    let order = "ORDER BY last_read_at IS NULL, last_read_at DESC, added_at DESC, id DESC";

    if limit.is_none() && cursor.is_none() {
        let mut stmt = conn.prepare(&format!("{base} {order}")).map_err(|e| e.to_string())?;
        let items = stmt
            .query_map([], map_book_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        return Ok(Paginated::all(items));
    }

    let lim = page_limit(limit);
    // cursor = (last_read_at: Option, added_at, id) —— None 表示在未读(null)组
    fn last_key(b: &BookItem) -> Option<String> {
        serde_json::to_string(&(b.last_read_at, b.added_at, b.id)).ok()
    }
    let items = match &cursor {
        None => {
            let mut stmt = conn
                .prepare(&format!("{base} {order} LIMIT ?1"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![lim], map_book_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        }
        Some(c) => {
            let (lra, aa, id): (Option<i64>, i64, i64) = decode_cursor(c)?;
            match lra {
                // cursor 在已读组：续取更小的已读键 + 全部未读
                Some(l0) => {
                    let mut stmt = conn
                        .prepare(&format!(
                            "{base} AND (
                               (last_read_at IS NOT NULL AND (last_read_at < ?1
                                  OR (last_read_at = ?1 AND (added_at < ?2 OR (added_at = ?2 AND id < ?3)))))
                               OR last_read_at IS NULL
                             ) {order} LIMIT ?4"
                        ))
                        .map_err(|e| e.to_string())?;
                    let rows = stmt
                        .query_map(rusqlite::params![l0, aa, id, lim], map_book_row)
                        .map_err(|e| e.to_string())?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?
                }
                // cursor 在未读(null)组：只续取更小的 (added_at, id)
                None => {
                    let mut stmt = conn
                        .prepare(&format!(
                            "{base} AND last_read_at IS NULL
                             AND (added_at < ?1 OR (added_at = ?1 AND id < ?2))
                             {order} LIMIT ?3"
                        ))
                        .map_err(|e| e.to_string())?;
                    let rows = stmt
                        .query_map(rusqlite::params![aa, id, lim], map_book_row)
                        .map_err(|e| e.to_string())?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?
                }
            }
        }
    };
    Ok(Paginated::from_page(items, lim, last_key))
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


/// 单本书的喜欢状态（module3.0.14，serde camelCase 与 TS BookStatus 镜像）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStatus {
    pub book_id: i64,
    pub is_favorite: bool,
}

/// 按位置精确查 library 行 id（module3.0.14）。
/// abs_path 经 validate_source_relative 归一（与 find_next_volume::sibling_is_finished 同语义）。
pub(crate) fn find_library_id_by_location(
    conn: &rusqlite::Connection,
    descriptor_str: &str,
    abs_path: &str,
) -> Option<i64> {
    let norm = crate::algorithm::validate_source_relative(abs_path)
        .unwrap_or_else(|_| abs_path.to_string());
    conn.query_row(
        "SELECT id FROM library WHERE source_descriptor = ?1 AND absolute_path = ?2",
        rusqlite::params![descriptor_str, norm],
        |r| r.get(0),
    )
    .ok()
}

pub(crate) fn get_book_status_inner(
    conn: &rusqlite::Connection,
    descriptor_str: &str,
    abs_path: &str,
) -> rusqlite::Result<Option<BookStatus>> {
    let Some(book_id) = find_library_id_by_location(conn, descriptor_str, abs_path) else {
        return Ok(None);
    };
    let fav = conn.query_row(
        "SELECT is_favorite FROM library WHERE id = ?1",
        rusqlite::params![book_id],
        |r| r.get::<_, i64>(0),
    )?;
    Ok(Some(BookStatus {
        book_id,
        is_favorite: fav != 0,
    }))
}

/// 按位置精确查单本书喜欢状态（不筛 favorite、无分页，module3.0.14）。
/// 文件浏览器喜欢按钮二态用；list_library 只回 favorite 行且有分页截断，前端匹配不可靠。
#[tauri::command]
pub fn get_book_status(
    descriptor: crate::source::descriptor::SourceDescriptor,
    abs_path: String,
    db: tauri::State<crate::db::Db>,
) -> Result<Option<BookStatus>, String> {
    let descriptor_str = serde_json::to_string(&descriptor).map_err(|e| e.to_string())?;
    get_book_status_inner(&*db.conn(), &descriptor_str, &abs_path).map_err(|e| e.to_string())
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

#[cfg(test)]
mod tests {
    //! module3.0.14 任务 4：按位置查书 helper + get_book_status 单测。
    //! fixture 用 serde_json::to_string(SourceDescriptor) 真实序列化构造
    //! （手写 JSON 反斜杠转义易错，真实序列化才是 IPC 实际比对值）。
    use super::*;

    fn local_descriptor_json() -> String {
        serde_json::to_string(&crate::source::descriptor::SourceDescriptor::Local {
            root_path: r"R:\comics".to_string(),
        })
        .unwrap()
    }

    fn insert_library_row(conn: &rusqlite::Connection, abs_path: &str, favorite: bool) -> i64 {
        conn.execute(
            "INSERT INTO library (title, source_descriptor, source_type, absolute_path, added_at, is_favorite)
             VALUES ('t', ?1, 'local', ?2, 0, ?3)",
            rusqlite::params![local_descriptor_json(), abs_path, favorite as i64],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn find_library_id_by_location_matches_descriptor_and_normalized_path() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let conn = db.conn();
        let id = insert_library_row(&conn, "comics/vol1", false);
        let descriptor = local_descriptor_json();

        assert_eq!(
            find_library_id_by_location(&conn, &descriptor, "comics/vol1"),
            Some(id)
        );
        assert_eq!(
            find_library_id_by_location(&conn, &descriptor, "other/vol9"),
            None
        );
        // 不同 descriptor（rootPath 不同）同相对路径 → 不串
        let other = serde_json::to_string(
            &crate::source::descriptor::SourceDescriptor::Local { root_path: r"D:\x".to_string() },
        )
        .unwrap();
        assert_eq!(find_library_id_by_location(&conn, &other, "comics/vol1"), None);
    }

    #[test]
    fn get_book_status_returns_favorite_and_temp_rows() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let conn = db.conn();
        insert_library_row(&conn, "comics/vol1", true);
        insert_library_row(&conn, "comics/vol2", false);
        let descriptor = local_descriptor_json();

        // favorite 行
        let st = get_book_status_inner(&conn, &descriptor, "comics/vol1").unwrap();
        assert!(st.as_ref().unwrap().is_favorite);
        // temp 行（读过未喜欢）——list_library 查不到，这里必须查得到
        let st = get_book_status_inner(&conn, &descriptor, "comics/vol2").unwrap();
        assert!(!st.as_ref().unwrap().is_favorite);
        // 无行
        let st = get_book_status_inner(&conn, &descriptor, "nope").unwrap();
        assert!(st.is_none());
    }
}

