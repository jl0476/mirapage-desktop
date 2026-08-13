//! `thumbnail_cache` SQLite DAO（§9.5 §9.6 §10）。
//!
//! 提供 get / upsert / remove / total_bytes / oldest_until_bytes（LRU 驱逐候选）/
//! touch_many（访问时间批量刷新）/ clear_all / get_verified（文件一致性校验）。
//! `cache_rel_path` 只存相对路径，缓存根迁移无需逐行改索引。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

/// 建表（幂等）。生产由 migration 009 + 012 创建；测试/非 app 上下文用此函数确保 schema。
///
/// v0.1.0-database-retention-and-cleanup：补建 `maintenance_state` + 稳定 LRU 索引
/// （与 migration 012 后的 schema 一致），否则 `upsert`/`remove` 维护计数时
/// `UPDATE maintenance_state` 会因表缺失报错。
pub fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS thumbnail_cache (
          cache_key          TEXT PRIMARY KEY,
          source_key         TEXT NOT NULL,
          rel_path           TEXT NOT NULL,
          source_size        INTEGER,
          source_modified_at INTEGER,
          source_width       INTEGER,
          source_height      INTEGER,
          orientation        INTEGER,
          target_bucket      INTEGER NOT NULL,
          quality            TEXT NOT NULL,
          cache_rel_path     TEXT NOT NULL,
          output_width       INTEGER NOT NULL,
          output_height      INTEGER NOT NULL,
          byte_size          INTEGER NOT NULL,
          created_at         INTEGER NOT NULL,
          last_accessed_at   INTEGER NOT NULL
        );
        -- 旧单列索引若存在则替换为稳定排序索引（spec §6.2）
        DROP INDEX IF EXISTS idx_thumbnail_cache_lru;
        CREATE INDEX IF NOT EXISTS idx_thumbnail_cache_lru_key
            ON thumbnail_cache(last_accessed_at ASC, cache_key ASC);

        CREATE TABLE IF NOT EXISTS maintenance_state (
          key TEXT PRIMARY KEY,
          integer_value INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        -- 首次创建时以 SUM 回填计数（幂等：已存在则不动）
        INSERT OR IGNORE INTO maintenance_state (key, integer_value, updated_at)
        SELECT 'thumbnail_cache_total_bytes',
               COALESCE((SELECT SUM(byte_size) FROM thumbnail_cache), 0),
               0;
        "#,
    )?;
    Ok(())
}

/// 一次性兼容修复：P0 修复前 `build_row` 的 `cache_rel_path` 缺 `v1/` 段
/// （`ab/<key>.webp`），文件实际在 `v1/ab/<key>.webp`。迁移后 `get_verified`
/// 校验文件不存在 -> miss -> 删脏行 + 重新生成 4K 图（慢）。
/// 给旧索引补 `v1/` 前缀即可命中文件，避免重新生成。幂等：已 `v1/` 开头的行不更新。
/// 返回更新的行数。
pub fn repair_legacy_cache_rel_paths(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE thumbnail_cache SET cache_rel_path = 'v1/' || cache_rel_path \
         WHERE cache_rel_path != '' AND cache_rel_path NOT LIKE 'v1/%'",
        [],
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThumbnailCacheRow {
    pub cache_key: String,
    pub source_key: String,
    pub rel_path: String,
    pub source_size: Option<i64>,
    pub source_modified_at: Option<i64>,
    pub source_width: Option<i64>,
    pub source_height: Option<i64>,
    pub orientation: Option<i64>,
    pub target_bucket: i64,
    pub quality: String,
    pub cache_rel_path: String,
    pub output_width: i64,
    pub output_height: i64,
    pub byte_size: i64,
    pub created_at: i64,
    pub last_accessed_at: i64,
}

const ALL_COLUMNS: &str = "cache_key, source_key, rel_path, source_size, source_modified_at, \
    source_width, source_height, orientation, target_bucket, quality, cache_rel_path, \
    output_width, output_height, byte_size, created_at, last_accessed_at";

fn row_from_db(row: &rusqlite::Row) -> rusqlite::Result<ThumbnailCacheRow> {
    Ok(ThumbnailCacheRow {
        cache_key: row.get("cache_key")?,
        source_key: row.get("source_key")?,
        rel_path: row.get("rel_path")?,
        source_size: row.get("source_size")?,
        source_modified_at: row.get("source_modified_at")?,
        source_width: row.get("source_width")?,
        source_height: row.get("source_height")?,
        orientation: row.get("orientation")?,
        target_bucket: row.get("target_bucket")?,
        quality: row.get("quality")?,
        cache_rel_path: row.get("cache_rel_path")?,
        output_width: row.get("output_width")?,
        output_height: row.get("output_height")?,
        byte_size: row.get("byte_size")?,
        created_at: row.get("created_at")?,
        last_accessed_at: row.get("last_accessed_at")?,
    })
}

/// 按 cache_key 读取一行（不校验文件）。
pub fn get(conn: &Connection, cache_key: &str) -> rusqlite::Result<Option<ThumbnailCacheRow>> {
    let sql = format!("SELECT {ALL_COLUMNS} FROM thumbnail_cache WHERE cache_key = ?1");
    conn.query_row(&sql, params![cache_key], row_from_db)
        .optional()
}

/// 插入或替换一行。
///
/// v0.1.0-database-retention-and-cleanup（spec §6.2）：`INSERT OR REPLACE` 改为
/// `ON CONFLICT(cache_key) DO UPDATE`，以便在同一事务准确计算旧/新 `byte_size` 差额
/// 并同步维护 `maintenance_state.thumbnail_cache_total_bytes`（避免 REPLACE 的
/// 删除再插入语义导致计数漂移）。
pub fn upsert(conn: &Connection, row: &ThumbnailCacheRow) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    // 先取旧行 byte_size（冲突时计差额；无冲突则 0）
    let old_bytes: Option<i64> = tx
        .query_row(
            "SELECT byte_size FROM thumbnail_cache WHERE cache_key = ?1",
            params![row.cache_key],
            |r| r.get(0),
        )
        .optional()?;
    tx.execute(
        "INSERT INTO thumbnail_cache (
            cache_key, source_key, rel_path, source_size, source_modified_at,
            source_width, source_height, orientation, target_bucket, quality,
            cache_rel_path, output_width, output_height, byte_size, created_at,
            last_accessed_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
        ON CONFLICT(cache_key) DO UPDATE SET
            source_key = excluded.source_key,
            rel_path = excluded.rel_path,
            source_size = excluded.source_size,
            source_modified_at = excluded.source_modified_at,
            source_width = excluded.source_width,
            source_height = excluded.source_height,
            orientation = excluded.orientation,
            target_bucket = excluded.target_bucket,
            quality = excluded.quality,
            cache_rel_path = excluded.cache_rel_path,
            output_width = excluded.output_width,
            output_height = excluded.output_height,
            byte_size = excluded.byte_size,
            created_at = excluded.created_at,
            last_accessed_at = excluded.last_accessed_at",
        params![
            row.cache_key, row.source_key, row.rel_path, row.source_size,
            row.source_modified_at, row.source_width, row.source_height, row.orientation,
            row.target_bucket, row.quality, row.cache_rel_path, row.output_width,
            row.output_height, row.byte_size, row.created_at, row.last_accessed_at,
        ],
    )?;
    let delta = row.byte_size - old_bytes.unwrap_or(0);
    bump_total(&tx, delta)?;
    tx.commit()?;
    Ok(())
}

/// 删除一行索引（不删文件，文件由调用方处理）。同步扣减总字节计数。
pub fn remove(conn: &Connection, cache_key: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let bytes: Option<i64> = tx
        .query_row(
            "SELECT byte_size FROM thumbnail_cache WHERE cache_key = ?1",
            params![cache_key],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(b) = bytes {
        tx.execute(
            "DELETE FROM thumbnail_cache WHERE cache_key = ?1",
            params![cache_key],
        )?;
        bump_total(&tx, -b)?;
    }
    tx.commit()?;
    Ok(())
}

/// 批量删除索引行（单事务）。返回释放的字节总数。文件删除由调用方处理。
///
/// spec §6.2：淘汰每批最多 256 项，避免逐行开事务长期占用 SQLite Mutex。
pub fn remove_batch(conn: &Connection, cache_keys: &[String]) -> rusqlite::Result<i64> {
    if cache_keys.is_empty() {
        return Ok(0);
    }
    let tx = conn.unchecked_transaction()?;
    let mut freed = 0i64;
    {
        let mut sel = tx.prepare("SELECT byte_size FROM thumbnail_cache WHERE cache_key = ?1")?;
        let mut del = tx.prepare("DELETE FROM thumbnail_cache WHERE cache_key = ?1")?;
        for k in cache_keys {
            let b: Option<i64> = sel.query_row(params![k], |r| r.get(0)).optional()?;
            if let Some(b) = b {
                del.execute(params![k])?;
                freed += b;
            }
        }
    }
    if freed != 0 {
        bump_total(&tx, -freed)?;
    }
    tx.commit()?;
    Ok(freed)
}

/// 全表缓存字节数。
///
/// v0.1.0-database-retention-and-cleanup（spec §6.1）：读取维护态计数，不再每次全表 SUM。
/// 防御：若计数行不存在（未跑 migration 012），回退一次 SUM。
pub fn total_bytes(conn: &Connection) -> rusqlite::Result<i64> {
    let v: Option<i64> = conn
        .query_row(
            "SELECT integer_value FROM maintenance_state WHERE key = 'thumbnail_cache_total_bytes'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    match v {
        Some(n) => Ok(n),
        None => conn.query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM thumbnail_cache",
            [],
            |row| row.get(0),
        ),
    }
}

/// 返回需要驱逐的最旧行，使剩余总字节 <= `keep_bytes`。
/// 稳定排序：`last_accessed_at ASC, cache_key ASC`（spec §6.2）。
/// 若当前总量已 <= `keep_bytes`，返回空。
///
/// v0.1.0-database-retention-and-cleanup：单次最多扫描 256 行（spec §6.2「每批最多 256 项，
/// 避免一次传递大量行到 Rust 内存」），到 `freed >= need_to_free` 即停；超大缓存由
/// `evict_to_limit` 循环调用逐批回收。
pub fn oldest_until_bytes(
    conn: &Connection,
    keep_bytes: i64,
    protected: &std::collections::HashSet<String>,
) -> rusqlite::Result<Vec<ThumbnailCacheRow>> {
    // v0.1.0-database-retention-and-cleanup 审查修复：protected 在 SQL 层 NOT IN 排除，
    // 这样能扫到 protected 之外的较新可删项，而非只在最旧 256 行里 skip 后卡住
    // （否则最旧批全 protected 时会放弃，缓存长期超限）。
    const SCAN_CAP: i64 = 256;
    let total = total_bytes(conn)?;
    if total <= keep_bytes {
        return Ok(vec![]);
    }
    let need_to_free = total - keep_bytes;
    let mut sql = format!(
        "SELECT {ALL_COLUMNS} FROM thumbnail_cache"
    );
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if !protected.is_empty() {
        let placeholders = (0..protected.len())
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        sql.push_str(&format!(" WHERE cache_key NOT IN ({placeholders})"));
        for k in protected.iter() {
            args.push(Box::new(k.clone()));
        }
    }
    sql.push_str(" ORDER BY last_accessed_at ASC, cache_key ASC LIMIT ?");
    args.push(Box::new(SCAN_CAP));
    let mut stmt = conn.prepare(&sql)?;
    let params = rusqlite::params_from_iter(args.iter().map(|b| b.as_ref()));
    let rows = stmt.query_map(params, row_from_db)?;
    let mut result = Vec::new();
    let mut freed: i64 = 0;
    for r in rows {
        let row = r?;
        freed += row.byte_size;
        result.push(row);
        if freed >= need_to_free {
            break;
        }
    }
    Ok(result)
}

/// 维护态计数原子增减（私用）。delta 可正可负。假定 key 行已由 migration 012 创建。
fn bump_total(conn: &Connection, delta: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE maintenance_state
            SET integer_value = integer_value + ?1,
                updated_at = ?2
          WHERE key = 'thumbnail_cache_total_bytes'",
        params![delta, now_secs()],
    )?;
    Ok(())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 批量刷新访问时间（§9.6）。单事务提交，降低 SQLite 写放大。
pub fn touch_many(conn: &Connection, cache_keys: &[String], now: i64) -> rusqlite::Result<()> {
    if cache_keys.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE thumbnail_cache SET last_accessed_at = ?1 WHERE cache_key = ?2",
        )?;
        for k in cache_keys {
            stmt.execute(params![now, k])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 清空全部索引行（不删文件）。总字节计数同步归零。
pub fn clear_all(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM thumbnail_cache", [])?;
    tx.execute(
        "UPDATE maintenance_state SET integer_value = 0, updated_at = ?1
         WHERE key = 'thumbnail_cache_total_bytes'",
        params![now_secs()],
    )?;
    tx.commit()?;
    Ok(())
}

/// 脏索引抽样——只读取两端候选的 `(cache_key, cache_rel_path)`（spec §6.3）。
///
/// **只读、短持锁**：文件存在性校验（`fs::metadata`）与删除由调用方在**释放 Db 锁后**
/// 执行（spec §5.5「磁盘操作在事务外」；否则 256 次 stat 持锁会冻死 UI——历史回归）。
/// 取最近访问（DESC）+ 最旧访问（ASC）两端各最多 `per_end` 条，cache_key ASC 稳定 tiebreaker。
pub fn sample_keys(conn: &Connection, per_end: i64) -> rusqlite::Result<Vec<(String, String)>> {
    let mut out: Vec<(String, String)> = Vec::new();
    for dir in ["DESC", "ASC"] {
        let sql = format!(
            "SELECT cache_key, cache_rel_path FROM thumbnail_cache
             ORDER BY last_accessed_at {dir}, cache_key ASC LIMIT ?1"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![per_end], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        for r in rows {
            out.push(r?);
        }
    }
    Ok(out)
}

/// 读取并校验缓存文件存在且非空：命中返回行；文件缺失则删除脏行并返回 None。
pub fn get_verified(
    conn: &Connection,
    cache_key: &str,
    cache_root: &Path,
) -> rusqlite::Result<Option<ThumbnailCacheRow>> {
    let Some(row) = get(conn, cache_key)? else {
        return Ok(None);
    };
    let file = cache_root.join(&row.cache_rel_path);
    let ok = std::fs::metadata(&file).map(|m| m.len() > 0).unwrap_or(false);
    if ok {
        Ok(Some(row))
    } else {
        // 脏行：索引在但文件缺失 / 损坏 -> 删除索引行。
        remove(conn, cache_key)?;
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        conn
    }

    fn sample_row(key: &str, accessed: i64, bytes: i64) -> ThumbnailCacheRow {
        ThumbnailCacheRow {
            cache_key: key.to_string(),
            source_key: "src".to_string(),
            rel_path: "a.jpg".to_string(),
            source_size: Some(1000),
            source_modified_at: Some(100),
            source_width: Some(4000),
            source_height: Some(3000),
            orientation: Some(1),
            target_bucket: 1024,
            quality: "high".to_string(),
            cache_rel_path: format!("v1/{ab}/{key}.webp", ab = &key[..2]),
            output_width: 1024,
            output_height: 768,
            byte_size: bytes,
            created_at: accessed,
            last_accessed_at: accessed,
        }
    }

    #[test]
    fn repair_legacy_cache_rel_paths_adds_v1_prefix() {
        let conn = open();
        // 旧格式（缺 v1/，P0 修复前）+ 新格式（有 v1/）
        let mut old = sample_row("old1", 1000, 5000);
        old.cache_rel_path = "ab/oldkey.webp".into();
        let new_row = sample_row("new1", 2000, 6000); // v1/ne/new1.webp
        upsert(&conn, &old).unwrap();
        upsert(&conn, &new_row).unwrap();
        let n = repair_legacy_cache_rel_paths(&conn).unwrap();
        assert_eq!(n, 1, "只修旧格式行");
        assert_eq!(
            get(&conn, "old1").unwrap().unwrap().cache_rel_path,
            "v1/ab/oldkey.webp"
        );
        assert_eq!(
            get(&conn, "new1").unwrap().unwrap().cache_rel_path,
            "v1/ne/new1.webp",
            "新格式不变"
        );
        // 幂等：再跑 0 行
        assert_eq!(repair_legacy_cache_rel_paths(&conn).unwrap(), 0);
    }

    #[test]
    fn upsert_and_get_round_trip() {
        let conn = open();
        let row = sample_row("abcd", 10, 5000);
        upsert(&conn, &row).unwrap();
        let got = get(&conn, "abcd").unwrap().expect("row should exist");
        assert_eq!(got, row);
    }

    #[test]
    fn upsert_replaces_existing() {
        let conn = open();
        upsert(&conn, &sample_row("abcd", 10, 5000)).unwrap();
        let mut updated = sample_row("abcd", 20, 9000);
        updated.byte_size = 9000;
        upsert(&conn, &updated).unwrap();
        let got = get(&conn, "abcd").unwrap().unwrap();
        assert_eq!(got.byte_size, 9000);
        assert_eq!(got.last_accessed_at, 20);
    }

    #[test]
    fn remove_deletes_row() {
        let conn = open();
        upsert(&conn, &sample_row("abcd", 10, 5000)).unwrap();
        remove(&conn, "abcd").unwrap();
        assert!(get(&conn, "abcd").unwrap().is_none());
    }

    #[test]
    fn total_bytes_sums_all_rows() {
        let conn = open();
        upsert(&conn, &sample_row("aa11", 1, 100)).unwrap();
        upsert(&conn, &sample_row("bb22", 2, 200)).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 300);
    }

    #[test]
    fn oldest_until_bytes_returns_oldest_to_reach_keep() {
        let conn = open();
        // 三行：A(100B, t=1) B(200B, t=2) C(300B, t=3)。total=600，keep=400，需释放 200。
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap(); // A
        upsert(&conn, &sample_row("bb00", 2, 200)).unwrap(); // B
        upsert(&conn, &sample_row("cc00", 3, 300)).unwrap(); // C
        let evict = oldest_until_bytes(&conn, 400, &Default::default()).unwrap();
        // 最旧优先：A(100) 不够，再加 B(累计 300 >= 200) 停止 -> [A, B]
        assert_eq!(evict.len(), 2);
        assert_eq!(evict[0].cache_key, "aa00");
        assert_eq!(evict[1].cache_key, "bb00");
        // 删除后剩余 C(300) <= 400
        for r in &evict {
            remove(&conn, &r.cache_key).unwrap();
        }
        assert!(total_bytes(&conn).unwrap() <= 400);
    }

    #[test]
    fn oldest_until_bytes_empty_when_under_keep() {
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap();
        assert!(oldest_until_bytes(&conn, 1000, &Default::default()).unwrap().is_empty());
    }

    #[test]
    fn touch_many_updates_access_time() {
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap();
        upsert(&conn, &sample_row("bb00", 2, 100)).unwrap();
        touch_many(&conn, &["aa00".to_string(), "bb00".to_string()], 999).unwrap();
        assert_eq!(
            get(&conn, "aa00").unwrap().unwrap().last_accessed_at,
            999
        );
        assert_eq!(
            get(&conn, "bb00").unwrap().unwrap().last_accessed_at,
            999
        );
    }

    #[test]
    fn touch_many_empty_is_noop() {
        let conn = open();
        touch_many(&conn, &[], 999).unwrap();
    }

    #[test]
    fn clear_all_removes_every_row() {
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap();
        upsert(&conn, &sample_row("bb00", 2, 100)).unwrap();
        clear_all(&conn).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 0);
        assert!(get(&conn, "aa00").unwrap().is_none());
    }

    #[test]
    fn get_verified_hit_when_file_exists() {
        let conn = open();
        let row = sample_row("abcd", 10, 5000);
        upsert(&conn, &row).unwrap();

        let dir = tempfile::tempdir().unwrap();
        // 在缓存根下创建对应文件
        let file = dir.path().join(&row.cache_rel_path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"webp-bytes").unwrap();

        let got = get_verified(&conn, "abcd", dir.path()).unwrap();
        assert!(got.is_some(), "file exists -> hit");
        assert_eq!(got.unwrap().cache_key, "abcd");
    }

    #[test]
    fn get_verified_miss_removes_dirty_row() {
        let conn = open();
        let row = sample_row("abcd", 10, 5000);
        upsert(&conn, &row).unwrap();

        let dir = tempfile::tempdir().unwrap();
        // 不创建文件 -> miss
        let got = get_verified(&conn, "abcd", dir.path()).unwrap();
        assert!(got.is_none(), "file missing -> miss");
        // 脏行应被删除
        assert!(get(&conn, "abcd").unwrap().is_none(), "dirty row removed");
    }

    #[test]
    fn get_verified_miss_when_file_empty() {
        let conn = open();
        let row = sample_row("abcd", 10, 5000);
        upsert(&conn, &row).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(&row.cache_rel_path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"").unwrap(); // 空文件视为损坏
        let got = get_verified(&conn, "abcd", dir.path()).unwrap();
        assert!(got.is_none(), "empty file -> miss");
        assert!(get(&conn, "abcd").unwrap().is_none(), "dirty row removed");
    }

    // —— v0.1.0-database-retention-and-cleanup：容量元数据计数维护（spec §6.1/§6.2）——

    /// 直接读 SUM 作为对照基准（计数应与之一致）。
    fn sum_bytes(conn: &Connection) -> i64 {
        conn.query_row::<i64, _, _>(
            "SELECT COALESCE(SUM(byte_size), 0) FROM thumbnail_cache",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn count_rows(conn: &Connection) -> i64 {
        conn.query_row::<i64, _, _>("SELECT COUNT(*) FROM thumbnail_cache", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn total_bytes_counter_equals_actual_sum() {
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap();
        upsert(&conn, &sample_row("bb00", 2, 250)).unwrap();
        upsert(&conn, &sample_row("cc00", 3, 50)).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 400);
        assert_eq!(total_bytes(&conn).unwrap(), sum_bytes(&conn), "计数应 == 实际 SUM");
    }

    #[test]
    fn upsert_replace_adjusts_total_by_diff() {
        let conn = open();
        upsert(&conn, &sample_row("abcd", 10, 5000)).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 5000);
        let mut updated = sample_row("abcd", 20, 9000);
        updated.byte_size = 9000;
        upsert(&conn, &updated).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 9000, "替换同 key 按差额 +4000");
        assert_eq!(total_bytes(&conn).unwrap(), sum_bytes(&conn));
    }

    #[test]
    fn remove_decrements_total() {
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 300)).unwrap();
        upsert(&conn, &sample_row("bb00", 2, 700)).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 1000);
        remove(&conn, "aa00").unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 700, "remove 扣减对应字节");
        assert_eq!(total_bytes(&conn).unwrap(), sum_bytes(&conn));
    }

    #[test]
    fn remove_batch_decrements_total() {
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap();
        upsert(&conn, &sample_row("bb00", 2, 200)).unwrap();
        upsert(&conn, &sample_row("cc00", 3, 300)).unwrap();
        let freed = remove_batch(&conn, &["aa00".to_string(), "cc00".to_string()]).unwrap();
        assert_eq!(freed, 400, "返回释放字节");
        assert_eq!(total_bytes(&conn).unwrap(), 200, "计数只余 bb00");
        assert_eq!(total_bytes(&conn).unwrap(), sum_bytes(&conn));
    }

    #[test]
    fn clear_all_resets_total_to_zero() {
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap();
        upsert(&conn, &sample_row("bb00", 2, 200)).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 300);
        clear_all(&conn).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 0, "clear 后计数归零");
    }

    #[test]
    fn get_verified_dirty_delete_decrements_total() {
        let conn = open();
        upsert(&conn, &sample_row("abcd", 10, 5000)).unwrap();
        assert_eq!(total_bytes(&conn).unwrap(), 5000);
        let dir = tempfile::tempdir().unwrap();
        // 不创建文件 -> miss -> 删脏行
        let got = get_verified(&conn, "abcd", dir.path()).unwrap();
        assert!(got.is_none());
        assert_eq!(total_bytes(&conn).unwrap(), 0, "脏行删除应扣减计数");
    }

    #[test]
    fn oldest_until_bytes_stable_order_with_cache_key_tiebreaker() {
        // 同 last_accessed_at 时按 cache_key ASC 稳定排序（spec §6.2）
        let conn = open();
        upsert(&conn, &sample_row("cc00", 5, 100)).unwrap(); // t=5
        upsert(&conn, &sample_row("aa00", 5, 100)).unwrap(); // t=5（同时间，key 靠前）
        upsert(&conn, &sample_row("bb00", 5, 100)).unwrap(); // t=5
        let evict = oldest_until_bytes(&conn, 0, &Default::default()).unwrap(); // 全删
        assert_eq!(evict[0].cache_key, "aa00");
        assert_eq!(evict[1].cache_key, "bb00");
        assert_eq!(evict[2].cache_key, "cc00");
    }

    #[test]
    fn oldest_until_bytes_skips_protected_and_continues() {
        // 审查修复 #2：最旧的被 protected 时，应跳过它继续找可删项，而非卡在最旧批
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap(); // 最旧，将标 protected
        upsert(&conn, &sample_row("bb00", 2, 100)).unwrap();
        upsert(&conn, &sample_row("cc00", 3, 100)).unwrap();
        let mut protected = std::collections::HashSet::new();
        protected.insert("aa00".to_string());
        // keep=0 → 需释放全部 300；aa00 protected 被排除 → 返回 bb00+cc00
        let evict = oldest_until_bytes(&conn, 0, &protected).unwrap();
        let keys: Vec<_> = evict.iter().map(|r| r.cache_key.as_str()).collect();
        assert!(!keys.contains(&"aa00"), "protected aa00 应被跳过");
        assert!(keys.contains(&"bb00") && keys.contains(&"cc00"), "应继续返回可删项");
    }

    #[test]
    fn sample_keys_returns_both_end_candidates_readonly() {
        // sample_keys 只读两端候选 (key, rel)，不做文件 stat / 删除（spec §6.3；
        // 文件 IO 已移到 service 层锁外，避免持 Db 锁冻 UI）
        let conn = open();
        upsert(&conn, &sample_row("aa00", 1, 100)).unwrap(); // 最旧
        upsert(&conn, &sample_row("bb00", 2, 200)).unwrap();
        upsert(&conn, &sample_row("cc00", 3, 300)).unwrap(); // 最新
        let pairs = sample_keys(&conn, 1).unwrap();
        let keys: Vec<_> = pairs.iter().map(|(k, _)| k.as_str()).collect();
        // 两端各 1：最新 cc00（DESC 取 1）+ 最旧 aa00（ASC 取 1）
        assert!(keys.contains(&"cc00"), "DESC 端应含最新 cc00");
        assert!(keys.contains(&"aa00"), "ASC 端应含最旧 aa00");
        // 只读：三行都在
        assert_eq!(count_rows(&conn), 3);
        // (key, rel) 配对正确
        for (k, rel) in &pairs {
            assert!(!rel.is_empty(), "rel_path 应非空 for {k}");
        }
    }

    #[test]
    fn dirty_cleanup_via_sample_keys_then_remove_batch() {
        // 验证 service 层编排的等价逻辑（锁内读 → 锁外 stat → 锁内 remove）：
        // 这里在测试层手动串起来（service.rs 的 sample_dirty 需 AppHandle，无法单测）。
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        let r1 = sample_row("aa00", 1, 100);
        let r3 = sample_row("cc00", 3, 300); // 将不创建文件 -> 脏
        upsert(&conn, &r1).unwrap();
        upsert(&conn, &sample_row("bb00", 2, 200)).unwrap();
        upsert(&conn, &r3).unwrap();
        for r in [&r1] {
            let f = dir.path().join(&r.cache_rel_path);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, b"x").unwrap();
        }
        assert_eq!(total_bytes(&conn).unwrap(), 600);

        // 锁内读
        let pairs = sample_keys(&conn, 128).unwrap();
        // 锁外 stat → 脏键（bb00/cc00 无文件 = 脏；两端重叠用 HashSet 去重）
        let dirty: Vec<String> = {
            let set: std::collections::HashSet<String> = pairs
                .into_iter()
                .filter(|(_, rel)| {
                    std::fs::metadata(dir.path().join(rel)).map(|m| m.len() > 0).unwrap_or(false)
                        == false
                })
                .map(|(k, _)| k)
                .collect();
            set.into_iter().collect()
        };
        assert_eq!(dirty.len(), 2, "bb00+cc00 无文件 = 脏（去重后 2）");
        // 锁内 remove
        remove_batch(&conn, &dirty).unwrap();
        assert!(get(&conn, "bb00").unwrap().is_none(), "脏行 bb00 已删");
        assert!(get(&conn, "cc00").unwrap().is_none(), "脏行 cc00 已删");
        assert!(get(&conn, "aa00").unwrap().is_some(), "aa00 文件存在保留");
        assert_eq!(total_bytes(&conn).unwrap(), 100, "只剩 aa00=100");
        assert_eq!(total_bytes(&conn).unwrap(), sum_bytes(&conn));
    }
}
