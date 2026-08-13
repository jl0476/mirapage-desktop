//! 浏览历史保留评分与有界清理（spec §3）。
//!
//! 评分纯函数（无 DB）+ 候选查询 + 单事务删除 DAO。所有删除以单一短事务完成。
//! 不触碰 `library` / `progress` / `shortcut` / 目录配置（spec §2/§9）。

use rusqlite::{Connection, Row};
use serde::Serialize;

/// 历史保留配置（来自 settings，task 4 的 MaintenanceService 负责读取拼装）。
#[derive(Debug, Clone)]
pub struct HistoryRetentionConfig {
    /// 最大保留条数；0 表示不限条数（spec §4 `history_retention_max_entries`，默认 2000）
    pub max_entries: i64,
    /// 最长保留天数；0 表示不限天数（spec §4 `history_retention_days`，默认 365）
    pub retention_days: i64,
    /// 条数淘汰的近期保护窗口天数，范围 0–30（spec §4 `history_recent_protect_days`，默认 7）
    pub protect_days: i64,
}

impl Default for HistoryRetentionConfig {
    fn default() -> Self {
        Self {
            max_entries: 2000,
            retention_days: 365,
            protect_days: 7,
        }
    }
}

/// 历史清理执行结果（单次 run 的统计）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct HistoryCleanupResult {
    /// 天数规则删除的行数（无条件，不受保护窗口影响）
    pub deleted_by_days: i64,
    /// 条数规则删除的行数（保护窗口外的最低分候选）
    pub deleted_by_count: i64,
    /// 清理后剩余行数
    pub remaining: i64,
    /// 保护窗口内记录数已超条数上限（暂时无法回收，待窗口自然过期）
    pub protected_exceeds_limit: bool,
}

impl HistoryCleanupResult {
    pub fn total_deleted(&self) -> i64 {
        self.deleted_by_days + self.deleted_by_count
    }
}

/// 历史清理预览（只读，不写库不删文件；spec §8 维护预览用）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCleanupPreview {
    /// 当前历史总条数
    pub total: i64,
    /// 超天数上限的候选数
    pub days_candidates: i64,
    /// 条数淘汰候选数（保护窗口外、按评分将删除的）
    pub count_candidates: i64,
    /// 保护窗口内记录数
    pub protected_in_window: i64,
    /// 保护窗口内记录已超条数上限
    pub protected_exceeds_limit: bool,
}

impl HistoryCleanupPreview {
    pub fn to_delete(&self) -> i64 {
        self.days_candidates + self.count_candidates
    }
}

/// 90 天线性衰减常量（spec §3.3）。
const RECENCY_HALFLIFE_DAYS: f64 = 90.0;

/// 访问价值评分纯函数（spec §3.3）。**分数越低越先清理。**
///
/// - `days_since_last_visit`：距上次访问天数（≥0）
/// - `visit_count`：累计访问次数（≥1）
/// - `pinned`：目录是否存在于 `library` 或 `shortcut`（仅 +0.15 有限加分，非永久豁免）
///
/// 返回 [0, 1] 区间分数：
/// ```text
/// recency   = max(0, 1 - days_since_last_visit / 90)
/// frequency = min(1, log2(visit_count + 1) / 10)
/// pin       = if pinned { 1 } else { 0 }
/// score     = 0.60 × recency + 0.25 × frequency + 0.15 × pin
/// ```
pub fn score_entry(days_since_last_visit: f64, visit_count: i64, pinned: bool) -> f64 {
    let recency = (1.0 - days_since_last_visit / RECENCY_HALFLIFE_DAYS).max(0.0);
    let frequency = ((visit_count as f64 + 1.0).log2() / 10.0).min(1.0);
    let pin = if pinned { 1.0 } else { 0.0 };
    0.60 * recency + 0.25 * frequency + 0.15 * pin
}

const SECS_PER_DAY: i64 = 86_400;

/// 历史总条数。
pub fn count_history(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM browse_history", [], |r| r.get(0))
}

/// 单个候选行（评分计算用）。
struct Candidate {
    source_descriptor: String,
    rel_path: String,
    last_visited_at: i64,
    visit_count: i64,
    pinned: bool,
}

/// 取出保护窗口外、需要参与条数淘汰评分的候选行。
/// `protect_cutoff`：保护窗口下界（last_visited_at >= protect_cutoff 的行受保护，不参与）。
fn fetch_count_candidates(
    conn: &Connection,
    protect_cutoff: i64,
) -> rusqlite::Result<Vec<Candidate>> {
    let mut stmt = conn.prepare(
        "SELECT bh.source_descriptor, bh.rel_path, bh.last_visited_at, bh.visit_count,
                CASE WHEN EXISTS (
                        SELECT 1 FROM shortcut
                        WHERE shortcut.source_descriptor_json = bh.source_descriptor
                          AND shortcut.rel_path = bh.rel_path)
                      OR EXISTS (
                        SELECT 1 FROM library
                        WHERE library.source_descriptor = bh.source_descriptor
                          AND library.absolute_path = bh.rel_path)
                   THEN 1 ELSE 0 END AS pinned
         FROM browse_history bh
         WHERE bh.last_visited_at < ?1",
    )?;
    let rows = stmt
        .query_map([protect_cutoff], map_candidate)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_candidate(row: &Row) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        source_descriptor: row.get(0)?,
        rel_path: row.get(1)?,
        last_visited_at: row.get(2)?,
        visit_count: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
    })
}

/// 预览历史清理（只读）。不修改任何数据（spec §8）。
pub fn preview_history_cleanup(
    conn: &Connection,
    now: i64,
    cfg: &HistoryRetentionConfig,
) -> rusqlite::Result<HistoryCleanupPreview> {
    let total = count_history(conn)?;

    // 天数候选：last_visited_at < now - retention_days*86400（无条件，spec §3.2）
    let days_candidates = if cfg.retention_days > 0 {
        let cutoff = now - cfg.retention_days.saturating_mul(SECS_PER_DAY);
        conn.query_row(
            "SELECT COUNT(*) FROM browse_history WHERE last_visited_at < ?1",
            [cutoff],
            |r| r.get(0),
        )?
    } else {
        0
    };

    // 天数删除后剩余（天数删除的行都是旧的，与保护窗口互斥——保护窗口是近期）
    let after_days = total - days_candidates;

    let protect_cutoff = now - cfg.protect_days.saturating_mul(SECS_PER_DAY);
    let protected_in_window = conn.query_row(
        "SELECT COUNT(*) FROM browse_history WHERE last_visited_at >= ?1",
        [protect_cutoff],
        |r| r.get(0),
    )?;

    let mut count_candidates = 0;
    let mut protected_exceeds = false;
    if cfg.max_entries > 0 && after_days > cfg.max_entries {
        // 保护窗口内记录若已达上限，不删保护记录（spec §3.2）
        if protected_in_window >= cfg.max_entries {
            protected_exceeds = true;
        } else {
            // 需删除到上限，但只能动保护窗口外的行
            let over = after_days - cfg.max_entries;
            let non_protected = after_days - protected_in_window;
            count_candidates = over.min(non_protected).max(0);
        }
    }

    Ok(HistoryCleanupPreview {
        total,
        days_candidates,
        count_candidates,
        protected_in_window,
        protected_exceeds_limit: protected_exceeds,
    })
}

/// 执行历史清理（写）。返回执行统计。`library` / `progress` / `shortcut` /
/// 目录配置行不受影响。
///
/// **三阶段、最小化 Mutex 持有（审查修复 #4）**：单连接下阻塞其他 Db 用户的是
/// `Db` 的 Mutex，而非 SQLite 事务边界。因此：
/// - 阶段 A（短持锁）：读出条数判断 + 候选行；
/// - 阶段 B（**释放锁**）：评分 + 排序 + 选键（纯 CPU）；
/// - 阶段 C（短持锁）：单一事务做天数删除 + 条数删除。
/// 候选可能在 A/C 之间被其他写入改变（罕见）；按 key 删除幂等，最坏少删/漏删一两行，
/// 下次清理补回——spec 接受这种 best-effort 语义。
pub fn run_history_cleanup(
    db: &crate::db::Db,
    now: i64,
    cfg: &HistoryRetentionConfig,
) -> rusqlite::Result<HistoryCleanupResult> {
    // 阶段 A：读（短锁）
    let plan = {
        let conn = db.conn();
        build_plan(&conn, now, cfg)?
    };
    // 阶段 B：评分选键（无锁）
    let keys = score_and_select(plan.candidates, now, plan.count_over);
    // 阶段 C：写（短锁 + 单一事务）
    let (deleted_by_days, deleted_by_count) = {
        let conn = db.conn();
        apply_deletes(&conn, plan.days_cutoff, &keys)?
    };
    let remaining = {
        let conn = db.conn();
        count_history(&conn)?
    };
    Ok(HistoryCleanupResult {
        deleted_by_days,
        deleted_by_count,
        remaining,
        protected_exceeds_limit: plan.protected_exceeds,
    })
}

/// 清理计划（阶段 A 产出，供阶段 B/C 用）。
struct CleanupPlan {
    days_cutoff: Option<i64>,
    candidates: Vec<Candidate>,
    count_over: i64,
    protected_exceeds: bool,
}

fn build_plan(
    conn: &Connection,
    now: i64,
    cfg: &HistoryRetentionConfig,
) -> rusqlite::Result<CleanupPlan> {
    let days_cutoff = if cfg.retention_days > 0 {
        Some(now - cfg.retention_days.saturating_mul(SECS_PER_DAY))
    } else {
        None
    };

    if cfg.max_entries <= 0 {
        return Ok(CleanupPlan { days_cutoff, candidates: vec![], count_over: 0, protected_exceeds: false });
    }
    let total = count_history(conn)?;
    if total <= cfg.max_entries {
        return Ok(CleanupPlan { days_cutoff, candidates: vec![], count_over: 0, protected_exceeds: false });
    }
    let protect_cutoff = now - cfg.protect_days.saturating_mul(SECS_PER_DAY);
    let protected_in_window: i64 = conn.query_row(
        "SELECT COUNT(*) FROM browse_history WHERE last_visited_at >= ?1",
        [protect_cutoff],
        |r| r.get(0),
    )?;
    if protected_in_window >= cfg.max_entries {
        // 保护记录已超上限：不删保护记录（spec §3.2）
        return Ok(CleanupPlan { days_cutoff, candidates: vec![], count_over: 0, protected_exceeds: true });
    }
    // 天数规则会先删旧（旧的全在保护窗口外），但本规划在删除前计算；
    // 按「删除前总量 - 上限」估 over，候选取保护窗口外的行，评分阶段挑最低分。
    let over = total - cfg.max_entries;
    let candidates = fetch_count_candidates(conn, protect_cutoff)?;
    Ok(CleanupPlan { days_cutoff, candidates, count_over: over, protected_exceeds: false })
}

/// 阶段 B：评分 + 稳定排序 + 取前 `count_over` 个的 (source_descriptor, rel_path)。
fn score_and_select(candidates: Vec<Candidate>, now: i64, count_over: i64) -> Vec<(String, String)> {
    if count_over <= 0 {
        return vec![];
    }
    let mut scored: Vec<(f64, i64, String, String)> = candidates
        .into_iter()
        .map(|c| {
            let days = ((now - c.last_visited_at) as f64 / SECS_PER_DAY as f64).max(0.0);
            let s = score_entry(days, c.visit_count, c.pinned);
            (s, c.last_visited_at, c.source_descriptor, c.rel_path)
        })
        .collect();
    // 稳定排序：score ASC, last_visited_at ASC, source_descriptor ASC, rel_path ASC（spec §3.3）
    scored.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
            .then(a.2.cmp(&b.2))
            .then(a.3.cmp(&b.3))
    });
    scored
        .into_iter()
        .take(count_over as usize)
        .map(|(_, _, sd, rp)| (sd, rp))
        .collect()
}

/// 阶段 C：单一短事务——天数删除 + 按 key 条数删除。
fn apply_deletes(
    conn: &Connection,
    days_cutoff: Option<i64>,
    keys: &[(String, String)],
) -> rusqlite::Result<(i64, i64)> {
    conn.execute_batch("BEGIN")?;
    let result = (|| -> rusqlite::Result<(i64, i64)> {
        let deleted_by_days = if let Some(cutoff) = days_cutoff {
            conn.execute(
                "DELETE FROM browse_history WHERE last_visited_at < ?1",
                [cutoff],
            )? as i64
        } else {
            0
        };
        let mut deleted_by_count = 0i64;
        for (sd, rp) in keys {
            conn.execute(
                "DELETE FROM browse_history WHERE source_descriptor = ?1 AND rel_path = ?2",
                rusqlite::params![sd, rp],
            )?;
            deleted_by_count += 1;
        }
        Ok((deleted_by_days, deleted_by_count))
    })();
    match result {
        Ok(r) => {
            conn.execute_batch("COMMIT")?;
            Ok(r)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个跑完所有 migration 的 in-memory DB（审查修复 #4：run_history_cleanup 接 &Db）。
    fn test_db() -> crate::db::Db {
        crate::db::Db::open_in_memory().expect("in-memory db with migrations")
    }

    fn insert_history(db: &crate::db::Db, sd: &str, rel: &str, name: &str, visited: i64, vc: i64) {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, visit_count)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![sd, rel, name, visited, vc],
        )
        .unwrap();
    }

    fn history_exists(db: &crate::db::Db, sd: &str, rel: &str) -> bool {
        let conn = db.conn();
        conn.query_row(
            "SELECT 1 FROM browse_history WHERE source_descriptor=?1 AND rel_path=?2",
            rusqlite::params![sd, rel],
            |_| Ok(()),
        )
        .is_ok()
    }

    fn insert_shortcut(db: &crate::db::Db, sd: &str, rel: &str) {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO shortcut (source_descriptor_json, rel_path, alias, icon_hint, created_at)
             VALUES (?1, ?2, 'a', 'local', 1)",
            rusqlite::params![sd, rel],
        )
        .unwrap();
    }

    fn insert_library(db: &crate::db::Db, sd: &str, abs_path: &str) -> i64 {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO library (title, source_descriptor, source_type, absolute_path,
                 cover_entry_path, cover_entry_name, page_count, last_read_at, added_at, is_favorite)
             VALUES ('T', ?1, 'Local', ?2, NULL, NULL, 0, NULL, 0, 0)",
            rusqlite::params![sd, abs_path],
        )
        .unwrap();
        conn.query_row::<i64, _, _>(
            "SELECT id FROM library WHERE absolute_path=?1",
            [abs_path],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn insert_progress(db: &crate::db::Db, book_id: i64) {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, updated_at) VALUES (?1, 0, 'single', 1)",
            [book_id],
        )
        .unwrap();
    }

    fn library_exists(db: &crate::db::Db, sd: &str, abs_path: &str) -> bool {
        let conn = db.conn();
        conn.query_row(
            "SELECT 1 FROM library WHERE source_descriptor=?1 AND absolute_path=?2",
            rusqlite::params![sd, abs_path],
            |_| Ok(()),
        )
        .is_ok()
    }

    fn shortcut_exists(db: &crate::db::Db, sd: &str, rel: &str) -> bool {
        let conn = db.conn();
        conn.query_row(
            "SELECT 1 FROM shortcut WHERE source_descriptor_json=?1 AND rel_path=?2",
            rusqlite::params![sd, rel],
            |_| Ok(()),
        )
        .is_ok()
    }

    // —— 评分纯函数 ——

    #[test]
    fn score_higher_visit_count_scores_higher() {
        let s1 = score_entry(10.0, 1, false);
        let s10 = score_entry(10.0, 10, false);
        assert!(s10 > s1, "同等时间下 visit_count=10 应比 =1 评分高");
    }

    #[test]
    fn score_recent_higher_than_old() {
        let recent = score_entry(1.0, 1, false);
        let old = score_entry(100.0, 1, false);
        assert!(recent > old, "近期访问应比老旧评分高");
    }

    #[test]
    fn score_recency_zero_after_90_days() {
        // 超过 90 天 recency 归零；此时 score 仅来自 frequency + pin
        let s = score_entry(90.0, 1, false);
        let frequency = (2.0f64).log2() / 10.0; // log2(1+1)/10
        assert!((s - 0.25 * frequency).abs() < 1e-9, "90 天后 recency=0");
        // 远超 90 天也为 0（max 兜底）
        assert!((score_entry(365.0, 1, false) - 0.25 * frequency).abs() < 1e-9);
    }

    #[test]
    fn score_pin_adds_015() {
        let pinned = score_entry(10.0, 1, true);
        let unpinned = score_entry(10.0, 1, false);
        assert!((pinned - unpinned - 0.15).abs() < 1e-9, "pin 应精确加 0.15");
    }

    // —— 清理：天数规则 ——

    fn count(db: &crate::db::Db) -> i64 {
        count_history(&db.conn()).unwrap()
    }

    #[test]
    fn cleanup_deletes_over_retention_days_regardless_of_score() {
        let db = test_db();
        let now = 1_000_000_000i64;
        insert_history(&db, "{\"type\":\"local\"}", "/a", "A", now - 100 * 86400, 100);
        insert_history(&db, "{\"type\":\"local\"}", "/b", "B", now - 1 * 86400, 1);

        let cfg = HistoryRetentionConfig {
            max_entries: 0,
            retention_days: 30,
            protect_days: 7,
        };
        let res = run_history_cleanup(&db, now, &cfg).unwrap();
        assert_eq!(res.deleted_by_days, 1, "天数规则应删 1 行");
        assert!(!history_exists(&db, "{\"type\":\"local\"}", "/a"));
        assert!(history_exists(&db, "{\"type\":\"local\"}", "/b"));
    }

    #[test]
    fn cleanup_protect_window_blocks_count_deletion() {
        let db = test_db();
        let now = 1_000_000_000i64;
        insert_history(&db, "{\"type\":\"local\"}", "/a", "A", now - 1 * 86400, 1);
        insert_history(&db, "{\"type\":\"local\"}", "/b", "B", now - 1 * 86400, 1);
        insert_history(&db, "{\"type\":\"local\"}", "/c", "C", now - 1 * 86400, 1);

        let cfg = HistoryRetentionConfig {
            max_entries: 2,
            retention_days: 0,
            protect_days: 7,
        };
        let res = run_history_cleanup(&db, now, &cfg).unwrap();
        assert_eq!(res.deleted_by_count, 0, "保护窗口内不应有条数删除");
        assert!(
            res.protected_exceeds_limit,
            "保护记录已超上限应标记 protected_exceeds_limit"
        );
        assert_eq!(count(&db), 3, "三行都应保留");
    }

    #[test]
    fn cleanup_count_deletes_lowest_score_first() {
        let db = test_db();
        let now = 1_000_000_000i64;
        insert_history(&db, "{\"type\":\"local\"}", "/a", "A", now - 100 * 86400, 1);
        insert_history(&db, "{\"type\":\"local\"}", "/b", "B", now - 90 * 86400, 1);
        insert_history(&db, "{\"type\":\"local\"}", "/c", "C", now - 80 * 86400, 50);
        insert_history(&db, "{\"type\":\"local\"}", "/d", "D", now - 10 * 86400, 50);

        let cfg = HistoryRetentionConfig {
            max_entries: 2,
            retention_days: 0,
            protect_days: 7,
        };
        let res = run_history_cleanup(&db, now, &cfg).unwrap();
        assert_eq!(res.deleted_by_count, 2);
        assert!(!history_exists(&db, "{\"type\":\"local\"}", "/a"), "/a 应删");
        assert!(!history_exists(&db, "{\"type\":\"local\"}", "/b"), "/b 应删");
        assert!(history_exists(&db, "{\"type\":\"local\"}", "/c"), "/c 高频保留");
        assert!(history_exists(&db, "{\"type\":\"local\"}", "/d"), "/d 近期高频保留");
        assert_eq!(res.remaining, 2);
    }

    #[test]
    fn cleanup_pin_gives_pinned_higher_survival_priority() {
        let db = test_db();
        let now = 1_000_000_000i64;
        insert_history(&db, "{\"type\":\"local\"}", "/a", "A", now - 50 * 86400, 5);
        insert_history(&db, "{\"type\":\"local\"}", "/b", "B", now - 50 * 86400, 5);
        insert_shortcut(&db, "{\"type\":\"local\"}", "/a");

        let cfg = HistoryRetentionConfig {
            max_entries: 1,
            retention_days: 0,
            protect_days: 7,
        };
        let res = run_history_cleanup(&db, now, &cfg).unwrap();
        assert_eq!(res.deleted_by_count, 1);
        assert!(history_exists(&db, "{\"type\":\"local\"}", "/a"), "pin 的 /a 应保留");
        assert!(!history_exists(&db, "{\"type\":\"local\"}", "/b"), "未 pin 的 /b 先删");
    }

    #[test]
    fn cleanup_does_not_touch_library_shortcut_progress() {
        let db = test_db();
        let now = 1_000_000_000i64;
        insert_history(&db, "{\"type\":\"local\"}", "/a", "A", now - 100 * 86400, 1);
        let book_id = insert_library(&db, "{\"type\":\"local\"}", "/a");
        insert_shortcut(&db, "{\"type\":\"local\"}", "/a");
        insert_progress(&db, book_id);

        let cfg = HistoryRetentionConfig {
            max_entries: 0,
            retention_days: 30,
            protect_days: 7,
        };
        let res = run_history_cleanup(&db, now, &cfg).unwrap();
        assert_eq!(res.deleted_by_days, 1, "历史行应删");
        assert!(!history_exists(&db, "{\"type\":\"local\"}", "/a"));

        assert!(library_exists(&db, "{\"type\":\"local\"}", "/a"), "library 行不应删");
        assert!(shortcut_exists(&db, "{\"type\":\"local\"}", "/a"), "shortcut 行不应删");
        let prog: i64 = {
            let conn = db.conn();
            conn.query_row(
                "SELECT COUNT(*) FROM progress WHERE book_id=?1",
                [book_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(prog, 1, "progress 行不应删");
    }

    #[test]
    fn preview_does_not_modify_data() {
        let db = test_db();
        let now = 1_000_000_000i64;
        insert_history(&db, "{\"type\":\"local\"}", "/a", "A", now - 100 * 86400, 1);
        insert_history(&db, "{\"type\":\"local\"}", "/b", "B", now - 1 * 86400, 1);

        let cfg = HistoryRetentionConfig {
            max_entries: 1,
            retention_days: 30,
            protect_days: 7,
        };
        let p = {
            let conn = db.conn();
            preview_history_cleanup(&conn, now, &cfg).unwrap()
        };
        assert_eq!(p.total, 2);
        assert_eq!(p.days_candidates, 1, "/a 超天数");
        assert_eq!(p.to_delete(), 1);
        assert_eq!(count(&db), 2);
        assert!(history_exists(&db, "{\"type\":\"local\"}", "/a"));
    }
}
