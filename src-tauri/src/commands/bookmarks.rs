//! `commands::bookmarks` —— 书签 CRUD
//!
//! 对应 DESIGN.md §5 Phase 4 + §11 bookmark 表
//! 前端通过 `lib/tauri.ts:listBookmarks / addBookmark / removeBookmark` 调用

use serde::Serialize;
use rusqlite::Connection;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkItem {
    pub id: i64,
    pub book_id: i64,
    pub page: i64,
    pub position_kind: String,
    pub label: Option<String>,
    pub created_at: i64,
}

/// 聚合行：BookmarkItem + 所属书名/书路径（侧栏"全部书签"视图显示用，JOIN library）
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookmarkRow {
    #[serde(flatten)]
    pub item: BookmarkItem,
    pub book_title: String,
    /// 展示用完整路径 = descriptor.rootPath + '\' + absolute_path（Local；解析失败为空串）
    pub book_path: String,
}

#[tauri::command]
pub fn list_bookmarks(book_id: i64, db: tauri::State<crate::db::Db>) -> Result<Vec<BookmarkItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT id, book_id, page, position_kind, label, created_at FROM bookmark WHERE book_id = ?1 ORDER BY page ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([book_id], |row| {
            Ok(BookmarkItem {
                id: row.get::<_, i64>(0)?,
                book_id: row.get::<_, i64>(1)?,
                page: row.get::<_, i64>(2)?,
                position_kind: row.get::<_, String>(3)?,
                label: row.get::<_, Option<String>>(4)?,
                created_at: row.get::<_, i64>(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// 跨书聚合：全部书签 + 书名，按 created_at DESC（最新添加在前）。
/// 侧栏 `/bookmarks`（无 bookId）视图数据源。
#[tauri::command]
pub fn list_all_bookmarks(db: tauri::State<crate::db::Db>) -> Result<Vec<BookmarkRow>, String> {
    let conn = db.conn();
    query_all_bookmarks(&conn)
}

/// list_all_bookmarks 的查询核心（抽出便于单测，绕过 tauri::State）
pub fn query_all_bookmarks(conn: &Connection) -> Result<Vec<BookmarkRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT b.id, b.book_id, b.page, b.position_kind, b.label, b.created_at, \
             IFNULL(l.title, ''), IFNULL(l.absolute_path, ''), l.source_descriptor \
             FROM bookmark b LEFT JOIN library l ON l.id = b.book_id \
             ORDER BY b.created_at DESC, b.id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let absolute_path: String = row.get::<_, String>(7).unwrap_or_default();
            let descriptor_json: Option<String> = row.get::<_, Option<String>>(8).unwrap_or(None);
            Ok(BookmarkRow {
                item: BookmarkItem {
                    id: row.get::<_, i64>(0)?,
                    book_id: row.get::<_, i64>(1)?,
                    page: row.get::<_, i64>(2)?,
                    position_kind: row.get::<_, String>(3)?,
                    label: row.get::<_, Option<String>>(4)?,
                    created_at: row.get::<_, i64>(5)?,
                },
                book_title: row.get::<_, String>(6)?,
                book_path: display_book_path(&absolute_path, descriptor_json.as_deref()),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// absolute_path（source-relative）→ 展示用完整路径。
/// Local descriptor 解析出 rootPath 拼前缀；解析失败/非 Local 返回 absolute_path 原样。
/// 分隔符统一 '\'（Windows 风格，对齐快捷方式页；仅显示用，不影响逻辑路径）。
fn display_book_path(absolute_path: &str, descriptor_json: Option<&str>) -> String {
    let root_path = descriptor_json
        .and_then(|s| serde_json::from_str::<crate::source::descriptor::SourceDescriptor>(s).ok())
        .and_then(|d| match d {
            crate::source::descriptor::SourceDescriptor::Local { root_path } => Some(root_path),
            _ => None,
        });
    match root_path {
        Some(root) if !root.is_empty() => format!(
            "{}\\{}",
            root.trim_end_matches(['\\', '/']),
            absolute_path
        ),
        _ => absolute_path.to_string(),
    }
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
        "INSERT INTO bookmark (book_id, page, position_kind, label, created_at) VALUES (?1, ?2, 'image', ?3, ?4)",
        rusqlite::params![book_id, page, label, now],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(BookmarkItem {
        id,
        book_id,
        page,
        position_kind: "image".to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn query_all_bookmarks_joins_title_and_orders_desc() {
        let conn = setup_db();
        // 两本书 + 三条书签（不同 created_at）。source_descriptor 有 UNIQUE 索引（migration 004），两行必须不同。
        // 书A 用合法 Local descriptor（book_path 拼 rootPath 前缀）；书B 用非法 JSON（fallback 原样 absolute_path）。
        conn.execute(
            "INSERT INTO library (title, source_descriptor, absolute_path, source_type, is_favorite, added_at) VALUES ('书A', '{\"type\":\"local\",\"rootPath\":\"C:\\\\comics\"}', 'vol1', 'Local', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO library (title, source_descriptor, absolute_path, source_type, is_favorite, added_at) VALUES ('书B', '{\"b\":1}', 'b', 'Local', 0, 0)",
            [],
        )
        .unwrap();
        for (book_id, page, at) in [(1, 0, 100), (2, 5, 300), (1, 2, 200)] {
            conn.execute(
                "INSERT INTO bookmark (book_id, page, position_kind, label, created_at) VALUES (?1, ?2, 'image', NULL, ?3)",
                rusqlite::params![book_id, page, at],
            )
            .unwrap();
        }

        let rows = query_all_bookmarks(&conn).unwrap();
        assert_eq!(rows.len(), 3);
        // created_at DESC：300 → 200 → 100
        assert_eq!(rows[0].item.book_id, 2);
        assert_eq!(rows[0].book_title, "书B");
        assert_eq!(rows[0].book_path, "b"); // 非法 descriptor → absolute_path 原样
        assert_eq!(rows[1].book_title, "书A");
        assert_eq!(rows[1].book_path, "C:\\comics\\vol1"); // Local → rootPath 前缀拼接，分隔符统一 '\'
        assert_eq!(rows[2].item.page, 0);
    }

    #[test]
    fn display_book_path_trims_trailing_separator() {
        // rootPath 尾部斜杠不产生双分隔符；分隔符统一 '\'（Windows 风格）
        assert_eq!(
            display_book_path("vol1", Some(r#"{"type":"local","rootPath":"C:\\comics\\"}"#)),
            "C:\\comics\\vol1"
        );
        assert_eq!(display_book_path("x", None), "x");
    }

    #[test]
    fn query_all_bookmarks_empty() {
        let conn = setup_db();
        assert!(query_all_bookmarks(&conn).unwrap().is_empty());
    }
}