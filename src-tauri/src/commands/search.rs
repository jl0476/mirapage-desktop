//! `commands::search` —— 模糊搜索(book/bookmark/tag 三表 UNION)
//!
//! 模糊匹配依赖 `fuse` crate;Phase 4 用 SQLite LIKE 子串匹配起步,
//! Phase 6 升级 fuzzy。

use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub source: String, // "library" | "bookmark" | "tag"
    pub book_id: i64,
    pub title: String,
    pub snippet: Option<String>,
}

#[tauri::command]
pub fn search(query: String, db: tauri::State<crate::db::Db>) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let conn = db.conn();
    let pattern = format!("%{}%", query);
    let mut hits = Vec::new();

    // Library:book.title LIKE
    {
        let mut stmt = conn
            .prepare("SELECT id, title FROM book WHERE title LIKE ?1 LIMIT 20")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&pattern], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (id, title) = r.map_err(|e| e.to_string())?;
            hits.push(SearchHit {
                source: "library".to_string(),
                book_id: id,
                title,
                snippet: None,
            });
        }
    }

    // Bookmark:bookmark.label LIKE
    {
        let mut stmt = conn
            .prepare(
                "SELECT b.id, b.title, bm.label FROM bookmark bm
                 JOIN book b ON b.id = bm.book_id
                 WHERE bm.label LIKE ?1 LIMIT 20",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&pattern], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (id, title, label) = r.map_err(|e| e.to_string())?;
            hits.push(SearchHit {
                source: "bookmark".to_string(),
                book_id: id,
                title,
                snippet: label,
            });
        }
    }

    // Tag:tag.name LIKE → 返回带此 tag 的书
    {
        let mut stmt = conn
            .prepare(
                "SELECT b.id, b.title, t.name FROM book_tag bt
                 JOIN book b ON b.id = bt.book_id
                 JOIN tag t ON t.id = bt.tag_id
                 WHERE t.name LIKE ?1 LIMIT 20",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&pattern], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for r in rows {
            let (id, title, tag_name) = r.map_err(|e| e.to_string())?;
            hits.push(SearchHit {
                source: "tag".to_string(),
                book_id: id,
                title,
                snippet: Some(tag_name),
            });
        }
    }

    // 去重 + 限制 50
    hits.truncate(50);
    Ok(hits)
}