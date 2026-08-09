//! `commands::progress` —— 进度持久化(供 reader store 500ms 防抖回调)
//!
//! v0.1.0-module1.21: 加 `finished` 字段, 标识已读完末页（永久 true，翻回不清零）。
//! 参考 perfect-viewer `ProgressEntity.finished`。
//!
//! v0.1.0-module3.0: browse_history schema 改为 folder-level（不再有 book_id 列），
//! save_progress / mark_finished 不再清 browse_history（旧逻辑已删）。
//!
//! v0.1.0-module3.0.8-masonry-browse-position: 加 `image_name` 字段
//! （spec `docs/superpowers/specs/2026-08-10-masonry-browse-position-design.md` §2.2）。
//! 瀑布流浏览位置复用 progress 表——`image_name` 是瀑布流锚点，page 仍是 reader 锚点。
//! SQL 用固定参数化 + `COALESCE` / `CASE WHEN` 保持 4 组合语义（不用 `format!` 拼接）。

use std::collections::HashMap;

/// v0.1.0-module3.0.2 (H5): 取单本书最近阅读进度.
///
/// v0.1.0-module3.0.8: 加 `image_name`（masonry 滚动写入，瀑布流浏览位置锚点）。
/// 注：`finished` 不在此 struct——仍走 `list_progress_finished` 独立接口
/// （readStatus store 需要全量 finished map）。
#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressItem {
    pub book_id: i64,
    pub page: i64,
    pub image_name: Option<String>,
    pub reader_mode: String,
    pub updated_at: i64,
}

/// 内部 SQL helper：`save_progress` 调它，测试也调它。
///
/// SQL 固定参数化（?1..?6）：
///   ?1=book_id  ?2=page  ?3=reader_mode  ?4=image_name  ?5=finished  ?6=updated_at
///
/// 4 组合语义（spec §2.2.2）：
/// - finished=None / image_name=None → INSERT 走 COALESCE(?5, 0) 默认 0；
///   UPSERT 时 `CASE WHEN ?5 IS NULL THEN progress.finished ELSE ?5 END` 保留旧 finished；
///   `COALESCE(excluded.image_name, progress.image_name)` 保留旧 image_name。
/// - finished=None / image_name=Some → finished 保留旧，image_name 覆盖（COALESCE 走 excluded 分支）。
/// - finished=Some(true/false) / image_name=None → finished 按入参；image_name 保留旧。
/// - finished=Some(true/false) / image_name=Some → finished 按入参；image_name 覆盖。
pub(crate) fn save_progress_inner(
    conn: &rusqlite::Connection,
    book_id: i64,
    page: i64,
    reader_mode: &str,
    finished: Option<bool>,
    image_name: Option<&str>,
) -> rusqlite::Result<()> {
    let now = chrono_now();
    let finished_param: Option<i64> = finished.map(|b| if b { 1 } else { 0 });
    conn.execute(
        "INSERT INTO progress (book_id, page, reader_mode, image_name, updated_at, finished)
         VALUES (?1, ?2, ?3, ?4, ?6, COALESCE(?5, 0))
         ON CONFLICT(book_id) DO UPDATE SET
            page = excluded.page,
            reader_mode = excluded.reader_mode,
            image_name = COALESCE(excluded.image_name, progress.image_name),
            updated_at = excluded.updated_at,
            finished = CASE WHEN ?5 IS NULL THEN progress.finished ELSE ?5 END",
        rusqlite::params![book_id, page, reader_mode, image_name, finished_param, now],
    )?;
    Ok(())
}

/// 内部 SQL helper：`get_progress` 调它，测试也调它。
pub(crate) fn get_progress_inner(
    conn: &rusqlite::Connection,
    book_id: i64,
) -> rusqlite::Result<Option<ProgressItem>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT book_id, page, image_name, reader_mode, updated_at
         FROM progress WHERE book_id = ?1",
        rusqlite::params![book_id],
        |row| {
            Ok(ProgressItem {
                book_id: row.get::<_, i64>(0)?,
                page: row.get::<_, i64>(1)?,
                image_name: row.get(2)?,
                reader_mode: row.get::<_, String>(3)?,
                updated_at: row.get::<_, i64>(4)?,
            })
        },
    )
    .optional()
}

/// 内部 SQL helper：`list_progress_finished` 调它，测试也调它。
pub(crate) fn list_progress_finished_inner(
    conn: &rusqlite::Connection,
) -> rusqlite::Result<HashMap<String, bool>> {
    let mut stmt = conn.prepare("SELECT book_id, finished FROM progress")?;
    let rows = stmt.query_map([], |row| {
        let book_id: i64 = row.get(0)?;
        let finished: i64 = row.get(1)?;
        Ok((book_id.to_string(), finished != 0))
    })?;
    let mut map = HashMap::new();
    for r in rows {
        let (k, v) = r?;
        map.insert(k, v);
    }
    Ok(map)
}

/// 内部 SQL helper：`mark_finished` 调它，测试也调它。
///
/// v0.1.0-module3.0.8: 不动 image_name（spec §2.2.4 P0）——读者已读完末页时
/// `image_name`（即 last spread 起始图）无意义，保留作为未来 reset 兜底。
pub(crate) fn mark_finished_inner(
    conn: &rusqlite::Connection,
    book_id: i64,
    finished: bool,
) -> rusqlite::Result<()> {
    let now = chrono_now();
    conn.execute(
        "INSERT INTO progress (book_id, page, reader_mode, updated_at, finished) VALUES (?1, 0, 'single', ?2, ?3)
         ON CONFLICT(book_id) DO UPDATE SET
           finished = excluded.finished,
           updated_at = excluded.updated_at",
        rusqlite::params![book_id, now, finished as i64],
    )?;
    Ok(())
}

#[tauri::command]
pub fn get_progress(
    book_id: i64,
    db: tauri::State<crate::db::Db>,
) -> Result<Option<ProgressItem>, String> {
    get_progress_inner(&*db.conn(), book_id).map_err(|e| e.to_string())
}

/// 保存阅读进度。
///
/// `finished` 语义：
/// - `Some(true)` → 翻到末页；触发 finished=1（不可降级）
/// - `Some(false)` → 主动标记重置；触发 finished=0
/// - `None` → 普通翻页，只更新 page/reader_mode（finished 字段保持不变）
///
/// `image_name` 语义（v0.1.0-module3.0.8）：
/// - `Some(s)` → 覆盖为 `s`（masonry 滚动写入 top visible image）
/// - `None` → 保留旧值（reader 翻页不传，走 page 路径）
///
/// 调用约定：
/// - reader 翻页：`saveProgress(bookId, page, readerMode, finished?)` → 第 5 参 `None`
/// - reader 翻末页：`saveProgress(bookId, page, readerMode, true, None)` → image_name 不变
/// - masonry 滚动：`saveProgress(bookId, page, 'single', None, imageName)` → finished 保留
///
/// ⚠️ masonry **不能传 finished**（即使是 `Some(false)` 也会重置已读，spec §2.2.2 P0）
#[tauri::command]
pub fn save_progress(
    book_id: i64,
    page: i64,
    reader_mode: String,
    finished: Option<bool>,
    image_name: Option<String>,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    save_progress_inner(&*db.conn(), book_id, page, &reader_mode, finished, image_name.as_deref())
        .map_err(|e| e.to_string())
}

/// 手动标记 / 重置 finished（不依赖翻页判定）。
///
/// 不动 `image_name`（spec §2.2.4 P0）——参见 `mark_finished_inner`。
#[tauri::command]
pub fn mark_finished(
    book_id: i64,
    finished: bool,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    mark_finished_inner(&*db.conn(), book_id, finished).map_err(|e| e.to_string())
}

/// 列出所有 progress.finished 映射，给前端 readStatus store 用。
///
/// 返回 `{ book_id: finished_bool }`，key 是 i64 字符串。
#[tauri::command]
pub fn list_progress_finished(
    db: tauri::State<crate::db::Db>,
) -> Result<HashMap<String, bool>, String> {
    list_progress_finished_inner(&*db.conn()).map_err(|e| e.to_string())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    //! v0.1.0-module3.0.8-masonry-browse-position 任务 2 单测
    //!
    //! 4 SQL 语义组合（spec §2.2.2 完成清单）：
    //!   1. finished=Some(true) image_name=None  → 新行 INSERT finished=1 image_name=NULL
    //!   2. finished=None       image_name=None  → UPSERT 保留旧 finished + image_name
    //!   3. finished=None       image_name=Some  → UPSERT finished 保留旧 + image_name 覆盖
    //!   4. finished=Some(true) image_name=None  → UPSERT finished=1 + image_name 保留旧
    //!
    //! 2 接口兼容：
    //!   5. ProgressItem JSON 序列化为 camelCase（TS 镜像）
    //!   6. mark_finished 不动 image_name（spec §2.2.4 P0 不变量）
    use super::*;
    use std::collections::HashMap;

    fn setup_db() -> crate::db::Db {
        crate::db::Db::open_in_memory().expect("in-memory db with migrations")
    }

    fn save_with_db(
        db: &crate::db::Db,
        book_id: i64,
        page: i64,
        reader_mode: &str,
        finished: Option<bool>,
        image_name: Option<&str>,
    ) {
        // `&*db.conn()` 解引用 MutexGuard → &Connection
        save_progress_inner(&*db.conn(), book_id, page, reader_mode, finished, image_name)
            .expect("save_progress_inner");
    }

    fn get_with_db(db: &crate::db::Db, book_id: i64) -> Option<ProgressItem> {
        get_progress_inner(&*db.conn(), book_id).expect("get_progress_inner")
    }

    fn list_finished_with_db(db: &crate::db::Db) -> HashMap<String, bool> {
        list_progress_finished_inner(&*db.conn()).expect("list_progress_finished_inner")
    }

    // ---- 4 SQL 语义组合 ----

    /// 1) 新行 + finished=None image_name=None：INSERT finished=0（COALESCE 默认）image_name=NULL
    #[test]
    fn save_progress_new_row_no_image_name_no_finished() {
        let db = setup_db();
        let book_id = 1i64;
        save_with_db(&db, book_id, 5, "single", None, None);
        let item = get_with_db(&db, book_id).expect("行应存在");
        assert_eq!(item.page, 5);
        assert_eq!(item.image_name, None, "新行 image_name 应为 NULL");
        let finished = list_finished_with_db(&db);
        assert_eq!(
            finished.get(&book_id.to_string()).copied(),
            Some(false),
            "新行 finished 应默认 0"
        );
    }

    /// 2) UPSERT + finished=None image_name=None：保留旧 finished + 保留旧 image_name
    #[test]
    fn save_progress_upsert_keeps_existing_image_name_when_none() {
        let db = setup_db();
        let book_id = 1i64;
        // 前提行：image_name="a.jpg" finished=1
        save_with_db(&db, book_id, 0, "single", Some(true), Some("a.jpg"));
        // UPSERT：finished=None image_name=None
        save_with_db(&db, book_id, 3, "double", None, None);
        let item = get_with_db(&db, book_id).expect("行应存在");
        assert_eq!(item.page, 3, "page 应被覆盖");
        assert_eq!(
            item.image_name,
            Some("a.jpg".to_string()),
            "COALESCE 应保留旧 image_name"
        );
        let finished = list_finished_with_db(&db);
        assert_eq!(
            finished.get(&book_id.to_string()).copied(),
            Some(true),
            "CASE WHEN None 应保留旧 finished"
        );
    }

    /// 3) UPSERT + finished=None image_name=Some：finished 保留旧 + image_name 覆盖
    #[test]
    fn save_progress_upsert_overwrites_image_name_when_some() {
        let db = setup_db();
        let book_id = 1i64;
        save_with_db(&db, book_id, 0, "single", Some(true), Some("a.jpg"));
        save_with_db(&db, book_id, 3, "double", None, Some("b.jpg"));
        let item = get_with_db(&db, book_id).expect("行应存在");
        assert_eq!(
            item.image_name,
            Some("b.jpg".to_string()),
            "新 image_name 应覆盖"
        );
        let finished = list_finished_with_db(&db);
        assert_eq!(
            finished.get(&book_id.to_string()).copied(),
            Some(true),
            "finished 不应被重置"
        );
    }

    /// 4) UPSERT + finished=Some(true) image_name=None：finished=1 强制 + image_name 保留
    #[test]
    fn save_progress_finished_some_true_overrides_but_keeps_image_name() {
        let db = setup_db();
        let book_id = 1i64;
        save_with_db(&db, book_id, 0, "single", Some(false), Some("a.jpg"));
        save_with_db(&db, book_id, 5, "single", Some(true), None);
        let item = get_with_db(&db, book_id).expect("行应存在");
        let finished = list_finished_with_db(&db);
        assert_eq!(
            finished.get(&book_id.to_string()).copied(),
            Some(true),
            "finished=Some(true) 应强制 1"
        );
        assert_eq!(
            item.image_name,
            Some("a.jpg".to_string()),
            "image_name=None 时应保留旧值"
        );
    }

    // ---- 2 接口兼容 ----

    /// 5) ProgressItem 序列化为 camelCase（TS 端 ProgressItem 期望 imageName/bookId/...）
    #[test]
    fn progress_item_serializes_as_camel_case() {
        let item = ProgressItem {
            book_id: 1,
            page: 5,
            image_name: Some("page05.jpg".to_string()),
            reader_mode: "single".to_string(),
            updated_at: 1000,
        };
        let json = serde_json::to_string(&item).expect("serialize");
        assert!(json.contains("\"imageName\""), "应是 imageName: {json}");
        assert!(json.contains("\"bookId\""), "应是 bookId: {json}");
        assert!(json.contains("\"readerMode\""), "应是 readerMode: {json}");
        assert!(json.contains("\"updatedAt\""), "应是 updatedAt: {json}");
        assert!(!json.contains("\"image_name\""), "不应有 image_name: {json}");
        assert!(!json.contains("\"book_id\""), "不应有 book_id: {json}");
    }

    /// 6) mark_finished 不动 image_name（spec §2.2.4 P0 不变量）
    #[test]
    fn mark_finished_keeps_existing_image_name() {
        let db = setup_db();
        let book_id = 1i64;
        // 先写 image_name + finished=0
        save_with_db(&db, book_id, 0, "single", Some(false), Some("a.jpg"));
        // mark_finished(true) → finished=1，但 image_name 保留
        mark_finished_inner(&*db.conn(), book_id, true).expect("mark_finished_inner");
        let item = get_with_db(&db, book_id).expect("行应存在");
        assert_eq!(
            item.image_name,
            Some("a.jpg".to_string()),
            "mark_finished(true) 不应清除 image_name"
        );
        let finished = list_finished_with_db(&db);
        assert_eq!(
            finished.get(&book_id.to_string()).copied(),
            Some(true),
            "mark_finished(true) 应设 finished=1"
        );

        // mark_finished(false) 重置 → image_name 仍保留（spec §2.2.4 设计取舍：reset 不清）
        mark_finished_inner(&*db.conn(), book_id, false).expect("mark_finished_inner reset");
        let item = get_with_db(&db, book_id).expect("行应存在");
        assert_eq!(
            item.image_name,
            Some("a.jpg".to_string()),
            "mark_finished(false) 不应清除 image_name"
        );
    }
}