//! `commands::history` —— 阅览记录 (v0.1.0-module3.0: folder-level, Android BrowseHistory 对齐)
//! v0.1.0-module3.0.1: book_id 列 (关联 library.id, 用于 readStatus 派生)

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BrowseHistoryEntry {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub display_name: String,
    pub last_visited_at: i64,
    /// v0.1.0-module3.0.1: 关联 library.id (reader 真正打开时记录)
    pub book_id: Option<i64>,
}

fn map_history_row(row: &rusqlite::Row) -> rusqlite::Result<BrowseHistoryEntry> {
    let sd_str: String = row.get(0)?;
    let sd_value: serde_json::Value =
        serde_json::from_str(&sd_str).unwrap_or(serde_json::Value::Null);
    Ok(BrowseHistoryEntry {
        source_descriptor: sd_value,
        rel_path: row.get(1)?,
        display_name: row.get(2)?,
        last_visited_at: row.get(3)?,
        book_id: row.get(4)?,
    })
}

#[tauri::command]
pub fn list_history(
    db: tauri::State<crate::db::Db>,
    limit: Option<i64>,
    cursor: Option<String>,
) -> Result<crate::commands::pagination::Paginated<BrowseHistoryEntry>, String> {
    list_history_inner(&db.conn(), limit, cursor)
}

/// 接 `&Connection` 的可测 inner（spec §7 keyset 分页）。
pub(crate) fn list_history_inner(
    conn: &rusqlite::Connection,
    limit: Option<i64>,
    cursor: Option<String>,
) -> Result<crate::commands::pagination::Paginated<BrowseHistoryEntry>, String> {
    use crate::commands::pagination::{decode_cursor, page_limit, Paginated};
    // 稳定排序：加 source_descriptor/rel_path 做确定性 tiebreaker（keyset 必需）
    let order = "ORDER BY last_visited_at DESC, source_descriptor DESC, rel_path DESC";
    let cols = "SELECT source_descriptor, rel_path, display_name, last_visited_at, book_id FROM browse_history";

    // 无参兼容：返回全部
    if limit.is_none() && cursor.is_none() {
        let mut stmt = conn.prepare(&format!("{cols} {order}")).map_err(|e| e.to_string())?;
        let items = stmt
            .query_map([], map_history_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        return Ok(Paginated::all(items));
    }

    let lim = page_limit(limit);
    // cursor JSON = [last_visited_at, source_descriptor, rel_path]（上一页最后一条的键）
    fn last_key(e: &BrowseHistoryEntry) -> Option<String> {
        let sd = match &e.source_descriptor {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        serde_json::to_string(&(e.last_visited_at, sd, e.rel_path.clone())).ok()
    }

    let items = match &cursor {
        None => {
            let mut stmt = conn
                .prepare(&format!("{cols} {order} LIMIT ?1"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![lim], map_history_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        }
        Some(c) => {
            let (lva, sd, rp): (i64, String, String) = decode_cursor(c)?;
            // DESC：after = 元组严格更小
            let mut stmt = conn
                .prepare(&format!(
                    "{cols} WHERE last_visited_at < ?1
                        OR (last_visited_at = ?1 AND source_descriptor < ?2)
                        OR (last_visited_at = ?1 AND source_descriptor = ?2 AND rel_path < ?3)
                     {order} LIMIT ?4"
                ))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![lva, sd, rp, lim], map_history_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        }
    };
    Ok(Paginated::from_page(items, lim, last_key))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordHistoryArgs {
    pub source_descriptor: serde_json::Value,
    pub rel_path: String,
    pub display_name: String,
    /// v0.1.0-module3.0.1: optional book_id — reader 打开时传
    pub book_id: Option<i64>,
}

#[tauri::command]
pub fn record_history(
    args: RecordHistoryArgs,
    db: tauri::State<crate::db::Db>,
    maintenance: tauri::State<'_, crate::maintenance::MaintenanceService>,
) -> Result<(), String> {
    let conn = db.conn();
    // 路径身份修复 (2026-08-12, spec §6.3): descriptor 反序列化校验 + rel_path 校验 source-relative。
    let descriptor: crate::source::descriptor::SourceDescriptor =
        serde_json::from_value(args.source_descriptor.clone())
            .map_err(|e| format!("source descriptor 非法: {}", e))?;
    let descriptor_str = serde_json::to_string(&descriptor).map_err(|e| e.to_string())?;
    let rel_path = crate::algorithm::validate_source_relative(&args.rel_path)
        .map_err(|_| format!("rel_path 越出数据源根: {}", args.rel_path))?;
    let now = chrono_now();
    record_history_inner(
        &conn,
        &descriptor_str,
        &rel_path,
        &args.display_name,
        now,
        args.book_id,
    )
    .map_err(|e| e.to_string())?;
    // v0.1.0-database-retention-and-cleanup：成功写入后标记 history dirty，
    // 触发防抖自动维护（spec §5.1）。
    maintenance.notify_dirty();
    Ok(())
}

/// UPSERT 一条浏览历史（v0.1.0-database-retention-and-cleanup）。
///
/// 冲突时（同一 source_descriptor + rel_path）：刷新 display_name / last_visited_at /
/// book_id，并 **visit_count += 1**（spec §3.1）。首次插入走 DEFAULT 1。
///
/// 抽成接受 `&Connection` 的 pub(crate) fn：① 可单测；② task 4 的 maintenance
/// dirty 通知在 command 层接入，不污染本函数。
pub(crate) fn record_history_inner(
    conn: &rusqlite::Connection,
    descriptor_str: &str,
    rel_path: &str,
    display_name: &str,
    now: i64,
    book_id: Option<i64>,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_descriptor, rel_path) DO UPDATE SET
           display_name = excluded.display_name,
           last_visited_at = excluded.last_visited_at,
           book_id = excluded.book_id,
           visit_count = browse_history.visit_count + 1",
        rusqlite::params![descriptor_str, rel_path, display_name, now, book_id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn delete_history(
    source_descriptor: serde_json::Value,
    rel_path: String,
    db: tauri::State<crate::db::Db>,
) -> Result<(), String> {
    let conn = db.conn();
    delete_history_inner(&conn, &source_descriptor, &rel_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 内部 SQL helper：`delete_history` 调它，测试也调它。
///
/// 2026-08-14 fix: descriptor 先反序列化为 SourceDescriptor 再序列化（typed canonical，
/// 与 `record_history_inner` 一致）。之前直接 `to_string(&Value)` —— serde_json Map
/// 按字母序输出（rootPath 在前），与 typed tag-first（type 在前）不同串，
/// 导致 2cb24e4 之后写入的行 delete 匹配不到（删除静默失效）。
pub(crate) fn delete_history_inner(
    conn: &rusqlite::Connection,
    source_descriptor: &serde_json::Value,
    rel_path: &str,
) -> rusqlite::Result<usize> {
    let descriptor_str = match serde_json::from_value::<crate::source::descriptor::SourceDescriptor>(
        source_descriptor.clone(),
    ) {
        Ok(d) => serde_json::to_string(&d).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        // 非法 descriptor 保持原值（与旧行为一致，删不到行由调用方结果体现）
        Err(_) => serde_json::to_string(source_descriptor)
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
    };
    conn.execute(
        "DELETE FROM browse_history WHERE source_descriptor = ?1 AND rel_path = ?2",
        rusqlite::params![descriptor_str, rel_path],
    )
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

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn record_history_inner_first_insert_sets_visit_count_default_1() {
        let conn = test_db();
        record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "X", 100, None).unwrap();

        let vc: i64 = conn
            .query_row(
                "SELECT visit_count FROM browse_history WHERE rel_path='/x'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(vc, 1, "首次插入 visit_count 默认 1");
    }

    #[test]
    fn record_history_inner_repeat_increments_visit_count() {
        // spec §3.1 / §10 验收：访问同一目录 10 次后 visit_count=10
        let conn = test_db();
        for i in 0..10 {
            record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "X", 100 + i, None).unwrap();
        }
        let (vc, last, name): (i64, i64, String) = conn
            .query_row(
                "SELECT visit_count, last_visited_at, display_name FROM browse_history WHERE rel_path='/x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(vc, 10, "10 次 UPSERT 后 visit_count 应为 10");
        assert_eq!(last, 109, "last_visited_at 应为最后一次");
        assert_eq!(name, "X");

        // 只有一行（UPSERT 不产生重复）
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM browse_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn record_history_inner_refreshes_display_name_and_book_id() {
        let conn = test_db();
        record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "旧名", 100, None).unwrap();
        record_history_inner(&conn, "{\"type\":\"local\"}", "/x", "新名", 200, Some(42)).unwrap();

        let (name, book_id, vc): (String, Option<i64>, i64) = conn
            .query_row(
                "SELECT display_name, book_id, visit_count FROM browse_history WHERE rel_path='/x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(name, "新名", "display_name 应刷新");
        assert_eq!(book_id, Some(42), "book_id 应刷新");
        assert_eq!(vc, 2);
    }

    // —— v0.1.0-database-retention-and-cleanup：keyset 分页（spec §7）——

    fn seed_history(conn: &rusqlite::Connection, n: i64) {
        for i in 0..n {
            record_history_inner(
                conn,
                "{\"type\":\"local\"}",
                &format!("/p{i:03}"),
                &format!("P{i}"),
                1000 + i, // last_visited_at 递增
                None,
            )
            .unwrap();
        }
    }

    #[test]
    fn list_history_no_args_returns_all_compat() {
        let conn = test_db();
        seed_history(&conn, 5);
        let page = list_history_inner(&conn, None, None).unwrap();
        assert_eq!(page.items.len(), 5);
        assert!(page.next_cursor.is_none(), "无参 = 全量，无下一页");
        // DESC：最新的（/p004, t=1004）在前
        assert_eq!(page.items[0].rel_path, "/p004");
        assert_eq!(page.items[4].rel_path, "/p000");
    }

    #[test]
    fn list_history_default_limit_when_cursor_absent() {
        // limit=None 但要分页（这里通过显式 Some 测 default 行为靠 page_limit）
        let conn = test_db();
        seed_history(&conn, 3);
        let page = list_history_inner(&conn, Some(2), None).unwrap();
        assert_eq!(page.items.len(), 2);
        assert!(page.next_cursor.is_some(), "满页应有 nextCursor");
        assert_eq!(page.items[0].rel_path, "/p002");
        assert_eq!(page.items[1].rel_path, "/p001");
    }

    #[test]
    fn list_history_max_limit_clamped_to_500() {
        // page_limit 钳制；这里只验证不 panic 且返回全部（< 500）
        let conn = test_db();
        seed_history(&conn, 3);
        let page = list_history_inner(&conn, Some(99999), None).unwrap();
        assert_eq!(page.items.len(), 3, "limit>500 钳到 500，全部返回");
    }

    #[test]
    fn list_history_pages_do_not_overlap_and_cover_all() {
        // DESC（最新在前）：5 条 /p000..p004，limit 2 →
        // p1=[p004,p003] p2=[p002,p001] p3=[p000]
        let conn = test_db();
        seed_history(&conn, 5);
        let p1 = list_history_inner(&conn, Some(2), None).unwrap();
        let cur1 = p1.next_cursor.clone().expect("p1 应有 nextCursor");
        let p2 = list_history_inner(&conn, Some(2), Some(cur1)).unwrap();
        let cur2 = p2.next_cursor.clone().expect("p2 应有 nextCursor");
        let p3 = list_history_inner(&conn, Some(2), Some(cur2)).unwrap();

        let keys: Vec<&String> = p1
            .items
            .iter()
            .chain(p2.items.iter())
            .chain(p3.items.iter())
            .map(|e| &e.rel_path)
            .collect();
        // 无重复 + 覆盖全部 5 条
        let mut sorted = keys.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 5, "三页合并应无重复");
        assert_eq!(p1.items.len(), 2);
        assert_eq!(p2.items.len(), 2);
        assert_eq!(p3.items.len(), 1);
        assert!(p3.next_cursor.is_none(), "末页无 nextCursor");
        // 首页确实是最新的两条
        assert_eq!(p1.items[0].rel_path, "/p004");
        assert_eq!(p1.items[1].rel_path, "/p003");
    }

    #[test]
    fn list_history_invalid_cursor_errors() {
        let conn = test_db();
        seed_history(&conn, 3);
        let res = list_history_inner(&conn, Some(2), Some("not-a-valid-cursor".to_string()));
        assert!(res.is_err(), "无效游标应返回参数错误");
    }

    // —— 2026-08-14 fix: delete_history descriptor canonical 化 ——

    /// record_history (typed tag-first) 写入的行，用前端 raw Value（字母序字段
    /// 顺序）删除应命中 —— 修复前 to_string(&Value) 生成字母序串匹配不到 typed 行。
    #[test]
    fn delete_history_inner_canonicalizes_descriptor_to_match_typed_rows() {
        let conn = test_db();
        let typed = serde_json::to_string(&crate::source::descriptor::SourceDescriptor::Local {
            root_path: "D:/x".into(),
        })
        .unwrap();
        record_history_inner(&conn, &typed, "/a", "A", 100, Some(1)).unwrap();

        // 前端等价 raw Value：字段顺序与 typed 序列化不同（rootPath 在前）
        let v: serde_json::Value =
            serde_json::from_str(r#"{"rootPath":"D:/x","type":"local"}"#).unwrap();
        let n = delete_history_inner(&conn, &v, "/a").unwrap();
        assert_eq!(n, 1, "canonical 化后应删掉 typed 格式行");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM browse_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    /// canonical 化不改变合法行删除语义（typed 串传 typed Value 也能删）。
    #[test]
    fn delete_history_inner_deletes_canonical_value_rows() {
        let conn = test_db();
        record_history_inner(&conn, r#"{"type":"local","rootPath":"D:/x"}"#, "/a", "A", 100, None).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(r#"{"type":"local","rootPath":"D:/x"}"#).unwrap();
        let n = delete_history_inner(&conn, &v, "/a").unwrap();
        assert_eq!(n, 1);
    }
}