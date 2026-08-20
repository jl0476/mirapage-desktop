//! archive_cache 表 DAO（M3 spec §3；模式镜像 thumbnail/index.rs）

use rusqlite::{params, Connection, Result};

pub struct NewCacheRow {
    pub cache_key: String,
    pub origin_kind: String,
    pub archive_rel_path: String,
    pub origin_size: i64,
    pub origin_mtime: Option<i64>,
    pub cache_abs_path: String,
    pub byte_size: i64,
}

pub struct CacheRow {
    pub cache_key: String,
    pub origin_kind: String,
    pub archive_rel_path: String,
    pub origin_size: i64,
    pub origin_mtime: Option<i64>,
    pub cache_abs_path: String,
    pub byte_size: i64,
    pub created_at: i64,
    pub last_accessed_at: i64,
}

fn row_of(r: &rusqlite::Row) -> Result<CacheRow> {
    Ok(CacheRow {
        cache_key: r.get(0)?, origin_kind: r.get(1)?, archive_rel_path: r.get(2)?,
        origin_size: r.get(3)?, origin_mtime: r.get(4)?, cache_abs_path: r.get(5)?,
        byte_size: r.get(6)?, created_at: r.get(7)?, last_accessed_at: r.get(8)?,
    })
}

const COLS: &str = "cache_key, origin_kind, archive_rel_path, origin_size, origin_mtime, cache_abs_path, byte_size, created_at, last_accessed_at";

pub fn upsert(conn: &Connection, row: &NewCacheRow) -> Result<()> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    conn.execute(
        "INSERT INTO archive_cache (cache_key, origin_kind, archive_rel_path, origin_size, origin_mtime, cache_abs_path, byte_size, created_at, last_accessed_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
         ON CONFLICT(cache_key) DO UPDATE SET origin_size=?4, origin_mtime=?5, cache_abs_path=?6, byte_size=?7, last_accessed_at=?8",
        params![row.cache_key, row.origin_kind, row.archive_rel_path, row.origin_size,
                row.origin_mtime, row.cache_abs_path, row.byte_size, now],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, cache_key: &str) -> Result<Option<CacheRow>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLS} FROM archive_cache WHERE cache_key = ?1"))?;
    let mut rows = stmt.query(params![cache_key])?;
    match rows.next()? {
        Some(r) => Ok(Some(row_of(r)?)),
        None => Ok(None),
    }
}

pub fn touch(conn: &Connection, cache_key: &str) -> Result<()> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    conn.execute("UPDATE archive_cache SET last_accessed_at = ?1 WHERE cache_key = ?2", params![now, cache_key])?;
    Ok(())
}

/// 条件删除（失效竞态修复）：仅当行的 (origin_size, origin_mtime) 与调用者读到的
/// stale 快照一致时才删行——返回是否赢得失效权（rows_affected == 1）。并发场景下若
/// 行已被其他任务的 upsert 刷新成新版本，指纹不匹配 → 0 → 调用方不得删文件（防误删
/// 新 final 留下指向已删文件的悬空表行），需重读行走复用/重下分支。`IS ?3` 为
/// SQLite NULL 安全相等（NULL IS NULL 真；非 NULL 双侧等价 =）。
pub fn delete_if_version_match(
    conn: &Connection, cache_key: &str, origin_size: i64, origin_mtime: Option<i64>,
) -> Result<bool> {
    let n = conn.execute(
        "DELETE FROM archive_cache WHERE cache_key = ?1 AND origin_size = ?2 AND origin_mtime IS ?3",
        params![cache_key, origin_size, origin_mtime],
    )?;
    Ok(n == 1)
}

/// 按 last_accessed_at 升序淘汰至 byte_total <= limit_bytes；protected 跳过。
/// 返回淘汰条数。逐批 256 + freed 累计到 need_to_free 即停（模式同 thumbnail
/// index.rs oldest_until_bytes——archive_cache 每行是完整物化的远程 zip，
/// 超限 1 字节也不得多删）。cache_key ASC tiebreaker 保证同秒多行顺序确定。
pub fn evict_to_limit(conn: &Connection, limit_bytes: i64, protected: &[String]) -> Result<usize> {
    let mut evicted = 0usize;
    loop {
        let total: i64 = conn.query_row("SELECT COALESCE(SUM(byte_size),0) FROM archive_cache", [], |r| r.get(0))?;
        if total <= limit_bytes { return Ok(evicted); }
        let need_to_free = total - limit_bytes;
        let mut stmt = conn.prepare(
            "SELECT cache_key, cache_abs_path, byte_size FROM archive_cache
             WHERE cache_key NOT IN (SELECT value FROM json_each(?1))
             ORDER BY last_accessed_at ASC, cache_key ASC LIMIT 256")?;
        let victims: Vec<(String, String, i64)> = stmt.query_map(
            params![serde_json::to_string(protected).unwrap_or_else(|_| "[]".to_string())],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_>>()?;
        drop(stmt);
        if victims.is_empty() { return Ok(evicted); } // 全被保护
        let mut freed: i64 = 0;
        for (key, abs, size) in &victims {
            conn.execute("DELETE FROM archive_cache WHERE cache_key = ?1", params![key])?;
            let _ = std::fs::remove_file(abs);
            evicted += 1;
            freed += size;
            if freed >= need_to_free { break; } // 精确停止：该批剩余行保留
        }
    }
}

/// 清表并返回被清的 cache_abs_path 列表（rev4：命令层要实删文件——裸 Result<()> 会把
/// 路径丢掉导致只清表不删文件）
pub fn clear_all(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT cache_abs_path FROM archive_cache")?;
    let paths: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_>>()?;
    drop(stmt);
    conn.execute("DELETE FROM archive_cache", [])?;
    Ok(paths)
}

/// 超限才回收，回收到 80% 水位（终审 P2-1 / spec §8/§10）：SUM ≤ limit 不动；
/// 超限以 limit*8/10 为目标调 evict_to_limit——直接以 limit 为目标会把总量压在
/// 100% 边缘，下次物化立刻又超限再回收（抖动）；80% 水位留出缓冲带。
/// startup_cleanup 与 download upsert 后回收钩子共用（避免两处重复判限）。
pub fn evict_ready_to_watermark(conn: &Connection, limit_bytes: i64, protected: &[String]) -> Result<usize> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(byte_size),0) FROM archive_cache", [], |r| r.get(0))?;
    if total <= limit_bytes { return Ok(0); }
    let target = limit_bytes.saturating_mul(8) / 10; // 80% 水位
    evict_to_limit(conn, target, protected)
}

/// (条数, 字节总量)
pub fn usage(conn: &Connection) -> Result<(i64, i64)> {
    conn.query_row("SELECT COUNT(*), COALESCE(SUM(byte_size),0) FROM archive_cache", [], |r| Ok((r.get(0)?, r.get(1)?)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn row(key: &str) -> NewCacheRow {
        NewCacheRow {
            cache_key: key.into(),
            origin_kind: "webdav".into(),
            archive_rel_path: "books/a.cbz".into(),
            origin_size: 100,
            origin_mtime: Some(1000),
            cache_abs_path: format!("C:/cache/{key}.zip"),
            byte_size: 100,
        }
    }

    #[test]
    fn upsert_get_touch_roundtrip() {
        let conn = db();
        upsert(&conn, &row("k1")).unwrap();
        let got = get(&conn, "k1").unwrap().unwrap();
        assert_eq!(got.archive_rel_path, "books/a.cbz");
        assert_eq!(got.origin_size, 100);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        touch(&conn, "k1").unwrap();
        let got2 = get(&conn, "k1").unwrap().unwrap();
        assert!(got2.last_accessed_at > got.last_accessed_at, "touch 刷新访问时间");
    }

    #[test]
    fn evict_oldest_first_respecting_protected() {
        let conn = db();
        upsert(&conn, &row("old")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        upsert(&conn, &row("new")).unwrap();
        // 淘汰 1 条（old 更旧），protected 指向 old 时跳过它淘汰 new
        let n = evict_to_limit(&conn, 0, &["old".to_string()]).unwrap();
        assert_eq!(n, 1);
        assert!(get(&conn, "old").unwrap().is_some(), "protected 不被淘汰");
        assert!(get(&conn, "new").unwrap().is_none());
    }

    #[test]
    fn evict_to_limit_partial_eviction_stops_precisely() {
        let conn = db();
        upsert(&conn, &row("old")).unwrap();
        upsert(&conn, &row("mid")).unwrap();
        upsert(&conn, &row("new")).unwrap();
        // 秒级时间戳直接 SQL 设不同值（确定性，不 sleep）
        conn.execute("UPDATE archive_cache SET last_accessed_at = 100 WHERE cache_key = 'old'", []).unwrap();
        conn.execute("UPDATE archive_cache SET last_accessed_at = 200 WHERE cache_key = 'mid'", []).unwrap();
        conn.execute("UPDATE archive_cache SET last_accessed_at = 300 WHERE cache_key = 'new'", []).unwrap();
        // total=300，limit=150 → need_to_free=150 → 恰删 old+mid（100+100 ≥ 150 即停），new 保留
        let n = evict_to_limit(&conn, 150, &[]).unwrap();
        assert_eq!(n, 2, "freed 累计到 need_to_free 即停，不整批清空");
        assert!(get(&conn, "old").unwrap().is_none());
        assert!(get(&conn, "mid").unwrap().is_none());
        assert!(get(&conn, "new").unwrap().is_some(), "该批剩余行保留");
        let (_, bytes) = usage(&conn).unwrap();
        assert!(bytes <= 150, "删除后 SUM(byte_size) <= limit，实际 {bytes}");
    }

    /// 终审 P2-1：未超限不回收（水位钩子先判 SUM > limit 才动手）
    #[test]
    fn evict_ready_to_watermark_below_limit_noop() {
        let conn = db();
        upsert(&conn, &row("k")).unwrap(); // 100 字节
        let n = evict_ready_to_watermark(&conn, 200, &[]).unwrap();
        assert_eq!(n, 0, "total 100 ≤ limit 200 → 不回收");
        assert!(get(&conn, "k").unwrap().is_some());
    }

    /// 终审 P2-1：超限回收到 80% 水位而非 limit 边缘——3 行各 100、limit 210：
    /// 旧语义（目标=limit 210）need 90 → 淘汰 old 即停（剩 200）；新语义目标
    /// 210*8/10=168 → need 132 → old+mid 两行（freed 200 ≥ 132）才停（剩 100）。
    #[test]
    fn evict_ready_to_watermark_targets_80pct() {
        let conn = db();
        upsert(&conn, &row("old")).unwrap();
        upsert(&conn, &row("mid")).unwrap();
        upsert(&conn, &row("new")).unwrap();
        conn.execute("UPDATE archive_cache SET last_accessed_at = 100 WHERE cache_key = 'old'", []).unwrap();
        conn.execute("UPDATE archive_cache SET last_accessed_at = 200 WHERE cache_key = 'mid'", []).unwrap();
        conn.execute("UPDATE archive_cache SET last_accessed_at = 300 WHERE cache_key = 'new'", []).unwrap();
        let n = evict_ready_to_watermark(&conn, 210, &[]).unwrap();
        assert_eq!(n, 2, "回收到 80% 水位（168B）需淘汰 2 行，limit 边缘只淘汰 1 行");
        assert!(get(&conn, "old").unwrap().is_none());
        assert!(get(&conn, "mid").unwrap().is_none());
        assert!(get(&conn, "new").unwrap().is_some());
        let (_, bytes) = usage(&conn).unwrap();
        assert_eq!(bytes, 100, "剩余 100 ≤ 水位 168");
    }

    #[test]
    fn clear_and_usage() {
        let conn = db();
        upsert(&conn, &row("k")).unwrap();
        let (count, bytes) = usage(&conn).unwrap();
        assert_eq!((count, bytes), (1, 100));
        // rev4：clear_all 返回被清路径（命令层实删文件依赖）
        let paths = clear_all(&conn).unwrap();
        assert_eq!(paths, vec!["C:/cache/k.zip".to_string()]);
        assert_eq!(usage(&conn).unwrap(), (0, 0));
        assert!(get(&conn, "k").unwrap().is_none());
    }

    #[test]
    fn delete_if_version_match_fingerprint_gate() {
        let conn = db();
        // 表是 v1 行、以 v1 的 (size,mtime) 条件删 → rows_affected 1 → 赢得失效权
        let mut v1 = row("k"); v1.origin_size = 10; v1.origin_mtime = Some(1000);
        upsert(&conn, &v1).unwrap();
        assert!(delete_if_version_match(&conn, "k", 10, Some(1000)).unwrap(),
                "指纹一致 → 删除成功");
        assert!(get(&conn, "k").unwrap().is_none(), "行已删");

        // 表已被刷成 v2 行、以 v1 的 (size,mtime) 条件删 → rows_affected 0 → 不删行
        // （并发失效竞态的核心防线：旧指纹删不动新行，调用方不得删新 final 文件）
        let mut v2 = row("k"); v2.origin_size = 20; v2.origin_mtime = Some(2000);
        upsert(&conn, &v2).unwrap();
        assert!(!delete_if_version_match(&conn, "k", 10, Some(1000)).unwrap(),
                "旧指纹 (10,1000) 删不动 v2 行");
        assert_eq!(get(&conn, "k").unwrap().unwrap().origin_size, 20, "v2 行保留");

        // mtime NULL 场景：行 mtime NULL + 条件 mtime NULL → IS NULL 匹配删除成功
        let mut nul = row("kn"); nul.origin_mtime = None;
        upsert(&conn, &nul).unwrap();
        assert!(delete_if_version_match(&conn, "kn", 100, None).unwrap(),
                "NULL IS NULL 匹配（SMB mtime 缺失源）");
        // IS 的 NULL 安全性是双向的：行 NULL + 条件 Some → 不匹配
        let mut nul2 = row("kn2"); nul2.origin_mtime = None;
        upsert(&conn, &nul2).unwrap();
        assert!(!delete_if_version_match(&conn, "kn2", 100, Some(1000)).unwrap(),
                "行 NULL vs 指纹 Some → 不匹配");
        assert!(get(&conn, "kn2").unwrap().is_some(), "行保留");
    }

    #[test]
    fn migration_016_table_exists() {
        let conn = db();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='archive_cache'",
            [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
