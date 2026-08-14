//! 数据库 migrations
//!
//! Phase 1：001_init 创建核心表 + 初始 settings 默认值。

use rusqlite::Connection;

use crate::source::descriptor::SourceDescriptor;

/// 全部 migrations 按版本号顺序执行
pub fn run(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
            version INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
        );",
    )?;

    let current: i32 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM _migrations",
            [],
            |row| row.get(0),
        )?;

    if current < 1 {
        apply_001_init(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (1, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 2 {
        apply_002_shortcuts(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (2, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 3 {
        apply_003_finished_flag(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (3, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 4 {
        apply_004_book_source_descriptor_unique(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (4, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 5 {
        apply_005_library_history_redesign(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (5, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 6 {
        apply_006_history_book_id(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (6, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 7 {
        apply_007_shortcuts_cross_source(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (7, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 8 {
        apply_008_directory_masonry(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (8, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 9 {
        apply_009_thumbnail_cache(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (9, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 10 {
        apply_010_progress_image_name(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (10, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 11 {
        apply_011_drop_like_table(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (11, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 12 {
        apply_012_maintenance_retention(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (12, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 13 {
        apply_013_descriptor_canonical_dedupe(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (13, ?1)",
            [chrono_now()],
        )?;
    }

    if current < 14 {
        apply_014_drop_touch_zone_settings(conn)?;
        conn.execute(
            "INSERT INTO _migrations (version, applied_at) VALUES (14, ?1)",
            [chrono_now()],
        )?;
    }

    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Migration 001 —— 初始化 7 张核心表 + settings 默认值
fn apply_001_init(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE book (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          source_descriptor TEXT NOT NULL,
          last_read_at INTEGER,
          is_favorite INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE progress (
          book_id INTEGER PRIMARY KEY,
          page INTEGER NOT NULL DEFAULT 0,
          reader_mode TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE bookmark (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          book_id INTEGER NOT NULL,
          page INTEGER NOT NULL,
          position REAL,
          label TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE like (
          book_id INTEGER PRIMARY KEY,
          liked_at INTEGER NOT NULL
        );

        CREATE TABLE browse_history (
          book_id INTEGER PRIMARY KEY,
          source_descriptor TEXT NOT NULL,
          last_page INTEGER,
          last_read_at INTEGER NOT NULL
        );

        CREATE TABLE account (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          host TEXT,
          port INTEGER,
          share TEXT,
          username TEXT,
          encrypted_password TEXT
        );

        CREATE TABLE tag (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          color TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE book_tag (
          book_id INTEGER NOT NULL,
          tag_id INTEGER NOT NULL,
          PRIMARY KEY (book_id, tag_id)
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- 初始 settings 默认值
        INSERT INTO settings (key, value) VALUES
          ('reader_default_mode', 'single'),
          ('default_scale_mode', 'fit_screen'),
          ('default_read_direction', 'ltr'),
          ('theme_mode', 'system'),
          ('color_theme', 'blue'),
          ('keep_screen_on', '1'),
          ('volume_key_paging', '1'),
          ('startup_screen', 'file_browser'),
          ('continue_to_next_volume', 'manual'),
          ('slideshow_interval_ms', '3000'),
          ('slideshow_direction', 'forward'),
          ('slideshow_loop', '1'),
          ('fb_sort_field', 'name'),
          ('fb_sort_ascending', '1'),
          ('smb_archive_strategy', 'download'),
          ('webdav_archive_strategy', 'stream'),
          ('webdav_stream_buffer_kb', '256'),
          ('concurrent_downloads', '3'),
          ('page_cache_size_mb', '512'),
          ('prefetch_budget_mb', '8'),
          ('archive_cache_size_mb', '2048'),
          ('download_concurrency', '4'),
          ('auto_delete_after_finished', '0'),
          ('locale', 'system'),
          ('search_mode', 'fuzzy');
        "#,
    )?;

    // 触控 3x3 默认映射（与 MiraPage Android TouchScheme.DEFAULT 对齐）
    let touch_defaults = [
        ("touch_top_left", "FIT_WIDTH"),
        ("touch_top_center", "OPEN_FILE_BROWSER"),
        ("touch_top_right", "JUMP_LAST"),
        ("touch_mid_left", "PREV_PAGE"),
        ("touch_mid_center", "OPEN_MAIN_MENU"),
        ("touch_mid_right", "NEXT_PAGE"),
        ("touch_bot_left", "FOLDER_PREV"),
        ("touch_bot_center", "SLIDESHOW_TOGGLE"),
        ("touch_bot_right", "FOLDER_NEXT"),
    ];
    for (key, value) in touch_defaults {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )?;
    }

    Ok(())
}

/// Migration 002 — 快捷方式表 (UNIQUE root_path)
fn apply_002_shortcuts(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE shortcut (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          root_path TEXT NOT NULL UNIQUE,
          label TEXT,
          created_at INTEGER NOT NULL
        );
        "#,
    )?;
    Ok(())
}

/// Migration 003 — progress 表加 `finished` 列
///
/// 参考 perfect-viewer `ProgressEntity.finished` 字段：
/// - 已翻到末页 = `finished=1`，永久 true（翻回不清零）
/// - reader 末页判定后由 `commands::progress::save_progress` 写入
fn apply_003_finished_flag(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "ALTER TABLE progress ADD COLUMN finished INTEGER NOT NULL DEFAULT 0;",
    )?;
    Ok(())
}

/// Migration 004 — book / browse_history 加 source_descriptor UNIQUE 索引
///
/// 目的:
/// - 与 Android 端 schema 对齐 (Android `book` 表对 source_descriptor UNIQUE 约束)
/// - 保证双端导出互导: 同 sourceDescriptor 必同 bookId
/// - `create_book` 命令 INSERT ... ON CONFLICT(source_descriptor) DO NOTHING
///   + 回查 id 即复用, 前端无需查 listHistory
fn apply_004_book_source_descriptor_unique(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE UNIQUE INDEX IF NOT EXISTS idx_book_source_descriptor
            ON book(source_descriptor);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_browse_history_source_descriptor
            ON browse_history(source_descriptor);
        "#,
    )?;
    Ok(())
}

/// Migration 005 — book → library 重命名 + 7 列新增（Android LibraryEntity 对齐）
/// + browse_history per-book → per-folder 重写（Android BrowseHistoryEntity 对齐）
/// + directory_sort 新建（Android DirectorySortEntity 对齐）
///
/// 注意：browse_history schema 完全重构（per-book book_id PK → per-folder
/// (source_descriptor, rel_path) PK），旧行不可迁移 → DROP。
fn apply_005_library_history_redesign(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        -- 1. book → library 重命名
        ALTER TABLE book RENAME TO library;

        -- 2. 删 migration 004 留下的单列 UNIQUE 索引（重命名后仍是 idx_library_source_descriptor）
        --    与下面的 (source_descriptor, absolute_path) UNIQUE 冲突（同一 source 多本书被禁）
        DROP INDEX IF EXISTS idx_library_source_descriptor;
        DROP INDEX IF EXISTS idx_book_source_descriptor;

        -- 3. library 补字段（Android LibraryEntity 11 列对齐）
        ALTER TABLE library ADD COLUMN source_type TEXT NOT NULL DEFAULT 'Local';
        ALTER TABLE library ADD COLUMN absolute_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE library ADD COLUMN cover_entry_path TEXT;
        ALTER TABLE library ADD COLUMN cover_entry_name TEXT;
        ALTER TABLE library ADD COLUMN page_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE library ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0;

        -- 4. UNIQUE 索引：(source_descriptor, absolute_path) 一书一行（Android 对齐）
        CREATE UNIQUE INDEX IF NOT EXISTS idx_library_source_path
            ON library(source_descriptor, absolute_path);

        -- 5. browse_history 重写：per-book → per-folder
        DROP TABLE IF EXISTS browse_history;
        CREATE TABLE browse_history (
          source_descriptor TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          display_name TEXT NOT NULL,
          last_visited_at INTEGER NOT NULL,
          PRIMARY KEY (source_descriptor, rel_path)
        );
        CREATE INDEX idx_browse_history_last_visited
            ON browse_history(last_visited_at DESC);

        -- 6. directory_sort 新建（Android DirectorySortEntity 对齐）
        CREATE TABLE directory_sort (
          location_key TEXT PRIMARY KEY,
          sort_field TEXT NOT NULL,
          ascending INTEGER NOT NULL
        );
        "#,
    )?;
    Ok(())
}

/// Migration 006 — browse_history 加 book_id 列 (关联 library.id)
///
/// 目的:
/// - v0.1.0-module3.0.1 readStatus 修正: 走 history ∩ progress 路径
/// - reader 打开时 record_history 把 book_id 存进去, 后端 join 查 progress 决定 finished/reading
fn apply_006_history_book_id(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("ALTER TABLE browse_history ADD COLUMN book_id INTEGER", [])?;
    Ok(())
}

/// Migration 007 — shortcut 表跨源 + 子目录对齐 (Android ShortcutEntity 对齐)
///
/// 旧 schema (migration 002): `(id, root_path TEXT UNIQUE, label, created_at)` —— 只存裸路径字符串.
/// 新 schema: `(id, source_descriptor_json, rel_path, alias, icon_hint, created_at)`
///   UNIQUE(source_descriptor_json, rel_path) —— 跨源 (Local/Smb/WebDav/Archive) + 任意子目录.
///
/// SQLite 不支持直接改 UNIQUE 约束 → 用「重建表」标准模式:
///   1. 建新表 shortcut_new (新 schema)
///   2. 逐行迁移旧数据: root_path → SourceDescriptor::Local JSON + rel_path=''
///      (用 Rust 行级迁移而非 SQL 字符串拼接: Windows 路径含反斜杠会被 JSON 误当转义前缀)
///   3. DROP TABLE shortcut + RENAME shortcut_new → shortcut
fn apply_007_shortcuts_cross_source(conn: &Connection) -> anyhow::Result<()> {
    // 1. 建新表
    conn.execute_batch(
        r#"
        CREATE TABLE shortcut_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_descriptor_json TEXT NOT NULL,
          rel_path TEXT NOT NULL DEFAULT '',
          alias TEXT,
          icon_hint TEXT NOT NULL DEFAULT 'local',
          created_at INTEGER NOT NULL,
          UNIQUE(source_descriptor_json, rel_path)
        );
        "#,
    )?;

    // 2. 逐行迁移: root_path → SourceDescriptor::Local { root_path } JSON
    {
        let mut stmt = conn.prepare("SELECT id, root_path, label, created_at FROM shortcut")?;
        let rows: Vec<(i64, String, Option<String>, i64)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut insert = conn.prepare(
            "INSERT INTO shortcut_new (id, source_descriptor_json, rel_path, alias, icon_hint, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (id, root_path, label, created_at) in rows {
            let descriptor = SourceDescriptor::Local { root_path };
            let json = serde_json::to_string(&descriptor)
                .map_err(|e| anyhow::anyhow!("serialize shortcut descriptor: {e}"))?;
            insert.execute(rusqlite::params![id, json, "", label, "local", created_at])?;
        }
    }

    // 3. 替换旧表
    conn.execute_batch(
        r#"
        DROP TABLE shortcut;
        ALTER TABLE shortcut_new RENAME TO shortcut;
        "#,
    )?;
    Ok(())
}

fn apply_008_directory_masonry(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "-- directory_masonry: per-folder 瀑布流布局参数覆盖 (v0.1.0-module3.0.6)
         CREATE TABLE directory_masonry (
           location_key TEXT PRIMARY KEY,
           col_count   INTEGER,
           h_gap       INTEGER,
           v_gap       INTEGER
         );",
    )?;
    Ok(())
}

/// Migration 009 — 缩略图缓存索引（v0.1.0-module3.0.7-masonry-thumbnail-cache）
///
/// 表结构按实现计划任务4 字段：cache_key/source_key/rel_path/source_size/
/// source_modified_at/source_width/source_height/orientation/target_bucket/quality/
/// cache_rel_path/output_width/output_height/byte_size/created_at/last_accessed_at。
/// 失败状态不持久化（调度器内存态），故无 failure_count/failure_until 列。
/// `cache_rel_path` 只存相对路径，缓存根迁移时无需逐行更新。
fn apply_009_thumbnail_cache(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE thumbnail_cache (
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

        CREATE INDEX idx_thumbnail_cache_lru
            ON thumbnail_cache(last_accessed_at);
        "#,
    )?;
    Ok(())
}

/// Migration 010 — progress 加 `image_name` 列（v0.1.0-module3.0.8-masonry-browse-position）
///
/// 用途：瀑布流浏览位置复用 progress 表——滚动到某图记录 image_name（持久锚点，
/// 不依赖滚动位置数值）。重启 / 跨会话跳回瀑布流目录时按 image_name 找 spread。
///
/// 不改 `page INTEGER`：bookmark / 旧行迁移 / mark_finished 都依赖 page 兜底，
/// 保留 page 作为 reader 恢复的次选锚点（spec §4.1 fallback 链：image_name → page → cover）。
///
/// 旧行 image_name 默认 NULL——`ReaderView` / `MasonryView` 加载时 NULL 行走 page
/// fallback（spec §4.1），新行由 `commands::progress::save_progress` 写入。
fn apply_010_progress_image_name(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("ALTER TABLE progress ADD COLUMN image_name TEXT")?;
    Ok(())
}

/// Migration 011 —— Library→Likes 合并:UPDATE 合并 like 数据到 library.is_favorite,再 DROP `like` 表
///
/// `like.book_id` 必有对应 `library.id`(toggle_like 调用点 ReaderView 守
/// `book?.id != null`,book.id 来自 get_book 查 library 表),所以 IN 子查询
/// 无丢失风险 — 任何 like 行都能在 library 找到对应 row。
fn apply_011_drop_like_table(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        UPDATE library
           SET is_favorite = 1
         WHERE id IN (SELECT book_id FROM `like`)
           AND is_favorite = 0;

        DROP TABLE IF EXISTS `like`;
        "#,
    )?;
    Ok(())
}

/// Migration 012 —— 数据库保留与自动清理（v0.1.0-database-retention-and-cleanup）
///
/// 仅新增列/表/索引/默认设置，不在升级过程删除任何历史或缓存文件。
/// 首次实际清理由运行时 maintenance 服务按配置触发（spec §9）。
///
/// - `browse_history` 加 `visit_count`(默认 1) + `last_cleanup_candidate_at`(可空)
/// - 建 `maintenance_state` 单行 KV 表，回填 `thumbnail_cache_total_bytes = SUM(byte_size)`
/// - spec §7 查询索引 + spec §6.2 稳定 LRU 索引（替换旧 idx_thumbnail_cache_lru）
/// - INSERT OR IGNORE 写入维护设置默认值（不覆盖用户已有）
fn apply_012_maintenance_retention(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        -- 1. browse_history 访问价值评分字段（spec §3.1）
        ALTER TABLE browse_history ADD COLUMN visit_count INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE browse_history ADD COLUMN last_cleanup_candidate_at INTEGER;

        -- 2. 维护状态 KV 表（缩略图总字节计数等，spec §6.1）
        CREATE TABLE IF NOT EXISTS maintenance_state (
          key TEXT PRIMARY KEY,
          integer_value INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- 3. spec §7 查询索引治理
        CREATE INDEX IF NOT EXISTS idx_library_favorite_read
            ON library(is_favorite, last_read_at DESC, added_at DESC);
        CREATE INDEX IF NOT EXISTS idx_shortcut_created_at
            ON shortcut(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_bookmark_book_page
            ON bookmark(book_id, page);
        CREATE INDEX IF NOT EXISTS idx_book_tag_tag_book
            ON book_tag(tag_id, book_id);
        CREATE INDEX IF NOT EXISTS idx_browse_history_cleanup
            ON browse_history(last_visited_at ASC, visit_count ASC);

        -- 4. spec §6.2 稳定 LRU 索引（替换旧单列索引，加入 cache_key 做稳定排序）
        DROP INDEX IF EXISTS idx_thumbnail_cache_lru;
        CREATE INDEX IF NOT EXISTS idx_thumbnail_cache_lru_key
            ON thumbnail_cache(last_accessed_at ASC, cache_key ASC);

        -- 5. 维护设置默认值（INSERT OR IGNORE 不覆盖用户已有，spec §4）
        INSERT OR IGNORE INTO settings (key, value) VALUES
          ('maintenance_auto_cleanup_enabled', '1'),
          ('history_retention_max_entries', '2000'),
          ('history_retention_days', '365'),
          ('history_recent_protect_days', '7'),
          ('maintenance_last_run_at', '0'),
          ('maintenance_last_result_json', '{}');
        "#,
    )?;

    // 6. 回填缩略图总字节：一次 SUM，此后由 thumbnail::index DAO 维护（spec §6.1）
    conn.execute(
        "INSERT OR REPLACE INTO maintenance_state (key, integer_value, updated_at)
         VALUES ('thumbnail_cache_total_bytes',
                 COALESCE((SELECT SUM(byte_size) FROM thumbnail_cache), 0),
                 ?1)",
        [chrono_now()],
    )?;

    Ok(())
}

/// Migration 013 — descriptor 序列化格式统一 + 重复行去重（2026-08-14）
///
/// 根因：2cb24e4（2026-08-12 路径身份修复）之前 `record_history`/`create_book` 直接
/// `serde_json::to_string(&Value)`（serde_json Map 按字母序，rootPath 在前），之后改为
/// typed `SourceDescriptor` 序列化（tag-first，type 在前）。同一 descriptor 解析值相同、
/// 字符串不同 → `ON CONFLICT(source_descriptor, ...)` 永不命中 → browse_history /
/// library 同目录出现「旧行 + 新行」双行（browse_history.book_id 指向两个 library 行，
/// readStatus 旧行覆盖新行导致进度状态显示错误）。
///
/// 本迁移：
/// ① browse_history：descriptor 重写为 typed canonical；同 (canonical, rel_path) 组
///   保 last_visited_at 最大行（tie: 后写者），visit_count 求和。
/// ② library：descriptor 重写为 canonical；同 (canonical, absolute_path) 组保 id 最大
///   （最新创建）行，被删行的 progress / bookmark / book_tag 引用迁到保留行
///   （progress 冲突时保 updated_at 大者）。
/// 幂等：对已 canonical 且无重复的数据是 no-op；非法 JSON 行原样保留不迁移。
fn apply_013_descriptor_canonical_dedupe(conn: &Connection) -> anyhow::Result<()> {
    canonicalize_browse_history(conn)?;
    canonicalize_library(conn)?;
    Ok(())
}

/// Migration 014 —— 移除 9 宫格触控残留 key（v0.1.0-module3.0.12-touch-zones-removal）
///
/// 001 seed 的 9 个 `touch_{top,mid,bot}_{left,center,right}` 是大写枚举值（`FIT_WIDTH`），
/// 与前端 kebab 值不匹配，从未被读回使用（死数据）；`touch_zones_enabled` 为运行时写入。
/// 9 宫格功能整体移除后前端不再读写任何 touch_* key，此处一并清理。幂等：重跑无行可删。
fn apply_014_drop_touch_zone_settings(conn: &Connection) -> anyhow::Result<()> {
    conn.execute("DELETE FROM settings WHERE key LIKE 'touch_%'", [])?;
    Ok(())
}

/// descriptor 字符串 → typed canonical 串；解析失败原样返回（防御脏数据）。
fn canonical_descriptor(s: &str) -> String {
    serde_json::from_str::<crate::source::descriptor::SourceDescriptor>(s)
        .ok()
        .and_then(|d| serde_json::to_string(&d).ok())
        .unwrap_or_else(|| s.to_string())
}

#[allow(clippy::type_complexity)]
fn canonicalize_browse_history(conn: &Connection) -> anyhow::Result<()> {
    // 1. 读全部行到内存（browse_history 行数受 retention 2000 上限约束）
    let mut stmt = conn.prepare(
        "SELECT source_descriptor, rel_path, display_name, last_visited_at, book_id, visit_count
         FROM browse_history",
    )?;
    let rows: Vec<(String, String, String, i64, Option<i64>, i64)> = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    // 2. 分组合并：key = (canonical, rel_path)；保 last_visited_at 最大（tie: 后写者）
    //    — 与前端 readStatus.refresh「同 key 取最新」语义一致
    struct Best {
        descriptor: String,
        rel_path: String,
        display_name: String,
        last_visited_at: i64,
        book_id: Option<i64>,
        visit_count: i64,
        order: usize,
    }
    let mut best: std::collections::HashMap<(String, String), Best> =
        std::collections::HashMap::new();
    for (i, (sd, rel, name, lva, bid, vc)) in rows.into_iter().enumerate() {
        let canonical = canonical_descriptor(&sd);
        let key = (canonical.clone(), rel.clone());
        match best.get(&key) {
            Some(b) if (lva, i) <= (b.last_visited_at, b.order) => {
                // 旧行：只累计 visit_count
                if let Some(b) = best.get_mut(&key) {
                    b.visit_count += vc;
                }
            }
            _ => {
                let visit_total = vc + best.get(&key).map(|b| b.visit_count).unwrap_or(0);
                best.insert(
                    key,
                    Best {
                        descriptor: canonical,
                        rel_path: rel,
                        display_name: name,
                        last_visited_at: lva,
                        book_id: bid,
                        visit_count: visit_total,
                        order: i,
                    },
                );
            }
        }
    }

    // 3. 重写表（PK (source_descriptor, rel_path)，DELETE + 重插）
    conn.execute("DELETE FROM browse_history", [])?;
    let mut insert = conn.prepare(
        "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id, visit_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for b in best.into_values() {
        insert.execute(rusqlite::params![
            b.descriptor,
            b.rel_path,
            b.display_name,
            b.last_visited_at,
            b.book_id,
            b.visit_count
        ])?;
    }
    Ok(())
}

#[allow(clippy::type_complexity)]
fn canonicalize_library(conn: &Connection) -> anyhow::Result<()> {
    // 1. 读全部行
    let mut stmt = conn.prepare(
        "SELECT id, title, source_descriptor, source_type, absolute_path,
                cover_entry_path, cover_entry_name, page_count, last_read_at, added_at, is_favorite
         FROM library",
    )?;
    let rows: Vec<(i64, String, String, String, String, Option<String>, Option<String>, i64, Option<i64>, i64, i64)> =
        stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
                row.get(10)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    // 2. 分组：key = (canonical, absolute_path)，组内保 id 最大（最新创建）。
    //    两遍式（先定 keep 再生成 remap）避免链式映射在 3+ 行组里丢失中间行。
    let mut groups: std::collections::HashMap<(String, String), Vec<i64>> =
        std::collections::HashMap::new();
    for (id, _title, sd, _st, abs, ..) in &rows {
        let canonical = canonical_descriptor(sd);
        groups.entry((canonical, abs.clone())).or_default().push(*id);
    }
    // (old_id → keep_id)：非 keep 行的引用迁到 keep 行
    let remap: Vec<(i64, i64)> = groups
        .iter()
        .filter(|(_, ids)| ids.len() > 1)
        .flat_map(|(_, ids)| {
            let keep_id = ids.iter().copied().max().unwrap();
            ids.iter()
                .copied()
                .filter(move |&id| id != keep_id)
                .map(move |id| (id, keep_id))
        })
        .collect();

    // 3. 迁移被删行的引用（progress / bookmark / book_tag）
    for (old_id, keep_id) in &remap {
        // progress：old 有行 → keep 也有时保 updated_at 大者，否则直接迁移
        let old_ts: Option<i64> = conn
            .query_row(
                "SELECT updated_at FROM progress WHERE book_id = ?1",
                [old_id],
                |r| r.get(0),
            )
            .ok();
        if let Some(old_updated) = old_ts {
            let keep_ts: Option<i64> = conn
                .query_row(
                    "SELECT updated_at FROM progress WHERE book_id = ?1",
                    [keep_id],
                    |r| r.get(0),
                )
                .ok();
            match keep_ts {
                Some(keep_updated) if keep_updated >= old_updated => {
                    // 保留行的进度更新，旧行进度丢弃
                    conn.execute("DELETE FROM progress WHERE book_id = ?1", [old_id])?;
                }
                _ => {
                    // 旧行进度更新（或保留行无进度）→ 旧行进度顶替
                    conn.execute("DELETE FROM progress WHERE book_id = ?1", [keep_id])?;
                    conn.execute(
                        "UPDATE progress SET book_id = ?1 WHERE book_id = ?2",
                        rusqlite::params![keep_id, old_id],
                    )?;
                }
            }
        }
        // bookmark / book_tag：OR REPLACE 吸收 (keep 已有同键) 的冲突
        conn.execute(
            "UPDATE OR REPLACE bookmark SET book_id = ?1 WHERE book_id = ?2",
            rusqlite::params![keep_id, old_id],
        )?;
        conn.execute(
            "UPDATE OR REPLACE book_tag SET book_id = ?1 WHERE book_id = ?2",
            rusqlite::params![keep_id, old_id],
        )?;
        conn.execute("DELETE FROM library WHERE id = ?1", [old_id])?;
    }

    // 4. descriptor 全表重写为 canonical
    let mut update = conn.prepare("UPDATE library SET source_descriptor = ?1 WHERE id = ?2")?;
    for (id, _title, sd, ..) in &rows {
        let canonical = canonical_descriptor(sd);
        if &canonical != sd {
            update.execute(rusqlite::params![canonical, id])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn migration_002_creates_shortcut_table() {
        let conn = Connection::open_in_memory().unwrap();
        apply_002_shortcuts(&conn).unwrap();

        // 表存在
        let exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='shortcut'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1, "shortcut 表未创建");

        // 列存在
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(shortcut)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(cols.contains(&"id".to_string()));
        assert!(cols.contains(&"root_path".to_string()));
        assert!(cols.contains(&"label".to_string()));
        assert!(cols.contains(&"created_at".to_string()));

        // UNIQUE 约束（root_path 列必须有 UNIQUE）
        let sql: String = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='shortcut'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(sql.contains("UNIQUE"), "root_path 应有 UNIQUE 约束");

        // UNIQUE 实际生效
        conn.execute(
            "INSERT INTO shortcut (root_path, created_at) VALUES ('/a', 100)",
            [],
        )
        .unwrap();
        let r = conn.execute(
            "INSERT INTO shortcut (root_path, created_at) VALUES ('/a', 200)",
            [],
        );
        assert!(r.is_err(), "重复 root_path 应违反 UNIQUE");
    }

    #[test]
    fn migration_003_adds_finished_flag() {
        let conn = Connection::open_in_memory().unwrap();
        apply_001_init(&conn).unwrap();
        apply_003_finished_flag(&conn).unwrap();

        // finished 列存在
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(progress)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(cols.contains(&"finished".to_string()), "progress 应有 finished 列");

        // DEFAULT 0: 新插入行 finished=0
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, updated_at) VALUES (1, 0, 'single', 100)",
            [],
        )
        .unwrap();
        let finished: i32 = conn
            .query_row(
                "SELECT finished FROM progress WHERE book_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(finished, 0, "新行 finished 默认 0");
    }

    #[test]
    fn migration_005_renames_book_to_library_and_adds_columns() {
        let conn = Connection::open_in_memory().unwrap();

        // 走 001~004 完整路径
        apply_001_init(&conn).unwrap();
        apply_002_shortcuts(&conn).unwrap();
        apply_003_finished_flag(&conn).unwrap();
        apply_004_book_source_descriptor_unique(&conn).unwrap();

        // 旧表名 book 应存在（迁移前）
        let book_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='book'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(book_exists, 1, "迁移前 book 表应存在");

        // 应用 migration 005
        apply_005_library_history_redesign(&conn).unwrap();

        // 1. book → library 重命名
        let library_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='library'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(library_exists, 1, "library 表应存在");
        let book_remaining: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='book'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(book_remaining, 0, "book 表名应消失");

        // 2. 11 列（含新增 6 列）
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(library)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in [
            "id", "title", "source_descriptor", "last_read_at", "is_favorite",
            "source_type", "absolute_path", "cover_entry_path", "cover_entry_name",
            "page_count", "added_at",
        ] {
            assert!(cols.contains(&expected.to_string()), "library 缺列 {expected}");
        }

        // 3. UNIQUE 索引 (source_descriptor, absolute_path)
        let idx_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_library_source_path'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(idx_exists, 1, "idx_library_source_path 应存在");

        // 4. browse_history 重写（per-folder schema）
        let bh_cols: Vec<String> = conn
            .prepare("PRAGMA table_info(browse_history)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(bh_cols.contains(&"source_descriptor".to_string()));
        assert!(bh_cols.contains(&"rel_path".to_string()));
        assert!(bh_cols.contains(&"display_name".to_string()));
        assert!(bh_cols.contains(&"last_visited_at".to_string()));
        assert!(!bh_cols.contains(&"book_id".to_string()), "book_id 列应已消失");
        assert!(!bh_cols.contains(&"last_page".to_string()), "last_page 列应已消失");

        // 5. directory_sort 新建
        let ds_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='directory_sort'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ds_exists, 1, "directory_sort 表应存在");
    }

    #[test]
    fn migration_005_preserves_old_book_data() {
        let conn = Connection::open_in_memory().unwrap();
        apply_001_init(&conn).unwrap();
        apply_002_shortcuts(&conn).unwrap();
        apply_003_finished_flag(&conn).unwrap();
        apply_004_book_source_descriptor_unique(&conn).unwrap();

        // 插入一行旧数据
        conn.execute(
            "INSERT INTO book (title, source_descriptor, is_favorite, last_read_at)
             VALUES ('TestVol', '{\"type\":\"local\",\"rootPath\":\"/a\"}', 1, 1000)",
            [],
        )
        .unwrap();

        apply_005_library_history_redesign(&conn).unwrap();

        // 行仍在 library，5 旧字段值保留
        let (id, title, is_fav, last_read_at, sd): (i64, String, i64, Option<i64>, String) = conn
            .query_row(
                "SELECT id, title, is_favorite, last_read_at, source_descriptor FROM library WHERE title = 'TestVol'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(title, "TestVol");
        assert_eq!(is_fav, 1);
        assert_eq!(last_read_at, Some(1000));
        assert!(sd.contains("/a"));

        // 6 新字段填默认值（source_type='Local', absolute_path='', page_count=0, added_at=0）
        let (st, ap, pc, aa): (String, String, i64, i64) = conn
            .query_row(
                "SELECT source_type, absolute_path, page_count, added_at FROM library WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(st, "Local");
        assert_eq!(ap, "");
        assert_eq!(pc, 0);
        assert_eq!(aa, 0);
    }

    #[test]
    fn migration_007_migrates_shortcut_to_cross_source_schema() {
        let conn = Connection::open_in_memory().unwrap();
        apply_001_init(&conn).unwrap();
        apply_002_shortcuts(&conn).unwrap();

        // 插入旧 schema 数据 (正斜杠路径，验证迁移正确)
        conn.execute(
            "INSERT INTO shortcut (root_path, label, created_at) VALUES ('D:/manga/x', 'A', 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO shortcut (root_path, label, created_at) VALUES ('C:/comics', NULL, 200)",
            [],
        )
        .unwrap();

        apply_007_shortcuts_cross_source(&conn).unwrap();

        // 新 schema: 列存在
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(shortcut)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in ["id", "source_descriptor_json", "rel_path", "alias", "icon_hint", "created_at"] {
            assert!(cols.contains(&expected.to_string()), "shortcut 缺列 {expected}");
        }
        assert!(!cols.contains(&"root_path".to_string()), "旧 root_path 列应已消失");

        // 旧行迁移: root_path → descriptor JSON + rel_path='' + icon_hint='local'
        let (json1, rel1, alias1, hint1): (String, String, Option<String>, String) = conn
            .query_row(
                "SELECT source_descriptor_json, rel_path, alias, icon_hint FROM shortcut WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(rel1, "", "rel_path 应为空");
        assert_eq!(hint1, "local");
        assert_eq!(alias1, Some("A".to_string()));
        assert_eq!(
            json1, r#"{"type":"local","rootPath":"D:/manga/x"}"#,
            "root_path 应序列化为 Local descriptor JSON",
        );

        // 第二行 (label=null) 也正确迁移
        let alias2: Option<String> = conn
            .query_row("SELECT alias FROM shortcut WHERE id = 2", [], |row| row.get(0))
            .unwrap();
        assert!(alias2.is_none());
    }

    #[test]
    fn migration_007_migrates_windows_backslash_path() {
        // Windows 路径含反斜杠: 用绑定参数插入 (避免 SQL 字面量转义混淆),
        // 验证 serde_json 序列化不畸形
        let conn = Connection::open_in_memory().unwrap();
        apply_001_init(&conn).unwrap();
        apply_002_shortcuts(&conn).unwrap();

        let raw = "D:\\manga\\x"; // Rust 字面量 → 实际字符串 D:\manga\x
        conn.execute(
            "INSERT INTO shortcut (root_path, label, created_at) VALUES (?1, 'A', 100)",
            rusqlite::params![raw],
        )
        .unwrap();

        apply_007_shortcuts_cross_source(&conn).unwrap();

        let json: String = conn
            .query_row(
                "SELECT source_descriptor_json FROM shortcut WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        // 能正确反序列化回 Local descriptor，rootPath 字节级一致
        let d: SourceDescriptor = serde_json::from_str(&json).unwrap();
        match d {
            SourceDescriptor::Local { root_path } => assert_eq!(root_path, raw),
            _ => panic!("应是 Local variant"),
        }
    }

    #[test]
    fn migration_007_new_unique_constraint_is_descriptor_plus_relpath() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap(); // 完整迁移到 007

        // 同一 descriptor + 同一 rel_path 应违反 UNIQUE
        let json = r#"{"type":"local","rootPath":"C:/a"}"#;
        conn.execute(
            "INSERT INTO shortcut (source_descriptor_json, rel_path, alias, icon_hint, created_at) VALUES (?1, '', 'A', 'local', 100)",
            rusqlite::params![json],
        )
        .unwrap();
        let r = conn.execute(
            "INSERT INTO shortcut (source_descriptor_json, rel_path, alias, icon_hint, created_at) VALUES (?1, '', 'B', 'local', 200)",
            rusqlite::params![json],
        );
        assert!(r.is_err(), "同 descriptor+rel_path 应违反 UNIQUE");

        // 同一 descriptor + 不同 rel_path 应成功 (子目录场景)
        conn.execute(
            "INSERT INTO shortcut (source_descriptor_json, rel_path, alias, icon_hint, created_at) VALUES (?1, 'sub', 'B', 'local', 200)",
            rusqlite::params![json],
        )
        .unwrap();
    }

    #[test]
    fn migration_009_creates_thumbnail_cache_and_lru_index() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        // 表存在
        let table_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='thumbnail_cache'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(table_exists, 1, "thumbnail_cache 表未创建");

        // LRU 索引存在（migration 012 将单列 idx_thumbnail_cache_lru 替换为稳定排序的 idx_thumbnail_cache_lru_key）
        let idx_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_thumbnail_cache_lru_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(idx_exists, 1, "idx_thumbnail_cache_lru_key 索引未创建");

        // 16 列全部存在
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(thumbnail_cache)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in [
            "cache_key", "source_key", "rel_path", "source_size", "source_modified_at",
            "source_width", "source_height", "orientation", "target_bucket", "quality",
            "cache_rel_path", "output_width", "output_height", "byte_size", "created_at",
            "last_accessed_at",
        ] {
            assert!(cols.contains(&expected.to_string()), "thumbnail_cache 缺列 {expected}");
        }

        // 版本号到 ≥9（migration 010 后整体版本号为 10）
        let v: i32 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |row| row.get(0))
            .unwrap();
        assert!(v >= 9, "thumbnail_cache migration 009 应已应用, 当前 {v}");
    }

    #[test]
    fn migration_009_preserves_old_tables_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        // 旧表仍在
        let library_exists: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='library'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(library_exists, 1, "旧 library 表应保留");

        // 重复执行幂等
        super::run(&conn).expect("重复 run 应幂等无错");
        super::run(&conn).expect("三次 run 仍幂等");
    }

    #[test]
    fn migration_010_adds_image_name_column() {
        // v0.1.0-module3.0.8-masonry-browse-position:
        // progress 加 image_name 锚点列（瀑布流浏览位置 = 阅读进度）
        let conn = Connection::open_in_memory().unwrap();
        apply_001_init(&conn).unwrap();
        apply_003_finished_flag(&conn).unwrap();

        // 旧列仍在：book_id / page / reader_mode / updated_at / finished
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(progress)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in ["book_id", "page", "reader_mode", "updated_at", "finished"] {
            assert!(cols.contains(&expected.to_string()), "progress 缺旧列 {expected}");
        }
        assert!(
            !cols.contains(&"image_name".to_string()),
            "应用 migration 前不应有 image_name 列"
        );

        // 应用 migration 010
        super::apply_010_progress_image_name(&conn).unwrap();

        // image_name 列出现
        let cols_after: Vec<String> = conn
            .prepare("PRAGMA table_info(progress)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            cols_after.contains(&"image_name".to_string()),
            "progress 应有 image_name 列"
        );

        // page / finished 列未改（保留 page 兜底 + finished 三态）
        assert!(cols_after.contains(&"page".to_string()), "page 列应保留");
        assert!(cols_after.contains(&"finished".to_string()), "finished 列应保留");

        // 新列可空：旧行未迁移，INSERT 新行 image_name 默认 NULL
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, updated_at) VALUES (1, 0, 'single', 100)",
            [],
        )
        .unwrap();
        let image_name: Option<String> = conn
            .query_row(
                "SELECT image_name FROM progress WHERE book_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(image_name.is_none(), "新行 image_name 应默认为 NULL");

        // image_name 可写入 + 读回（瀑布流路径存图像文件名）
        conn.execute(
            "UPDATE progress SET image_name = ?1 WHERE book_id = 1",
            rusqlite::params!["page_001.jpg"],
        )
        .unwrap();
        let stored: Option<String> = conn
            .query_row(
                "SELECT image_name FROM progress WHERE book_id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored.as_deref(), Some("page_001.jpg"));
    }

    #[test]
    fn migration_010_run_bumps_version_to_10() {
        // 走完整 run()，验证版本号到最新且幂等（migration 014 后,完整 run 到 14）
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let v: i32 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v, 14, "完整 run 后版本号应为 14");

        // image_name 列存在
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(progress)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            cols.contains(&"image_name".to_string()),
            "完整 run 后 progress 应有 image_name 列"
        );

        // 幂等
        super::run(&conn).expect("重复 run 应幂等无错");
    }

    #[test]
    fn migration_011_drops_like_table() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        // `like` 表应已不存在
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='like'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 0, "`like` 表应在 migration 011 后不存在");
    }

    #[test]
    fn migration_011_merges_like_data_into_library_is_favorite() {
        let conn = Connection::open_in_memory().unwrap();
        // 跑到 010(不跑 011,先准备数据)
        apply_001_init(&conn).unwrap();
        apply_002_shortcuts(&conn).unwrap();
        apply_003_finished_flag(&conn).unwrap();
        apply_004_book_source_descriptor_unique(&conn).unwrap();
        apply_005_library_history_redesign(&conn).unwrap();
        apply_006_history_book_id(&conn).unwrap();
        apply_007_shortcuts_cross_source(&conn).unwrap();
        apply_008_directory_masonry(&conn).unwrap();
        apply_009_thumbnail_cache(&conn).unwrap();
        apply_010_progress_image_name(&conn).unwrap();

        // 准备:library.id=42 is_favorite=0 + like(book_id=42)
        // library 表 schema 在 apply_005_library_history_redesign 后定型,字段对齐当前 11 列
        conn.execute(
            "INSERT INTO library (title, source_descriptor, source_type, absolute_path,
                                  cover_entry_path, cover_entry_name, page_count,
                                  last_read_at, added_at, is_favorite)
             VALUES ('Test', '{}', 'Local', '/x', NULL, NULL, 10, NULL, 0, 0)",
            [],
        )
        .unwrap();
        let book_id: i64 = conn
            .query_row(
                "SELECT id FROM library WHERE title='Test'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO `like` (book_id, liked_at) VALUES (?1, 100)",
            [book_id],
        )
        .unwrap();

        // 跑 011
        apply_011_drop_like_table(&conn).unwrap();

        let is_fav: i64 = conn
            .query_row(
                "SELECT is_favorite FROM library WHERE id=?1",
                [book_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            is_fav, 1,
            "migration 011 应把 like 表数据合并到 library.is_favorite=1"
        );
    }

    // —— Migration 012：数据库保留与自动清理（TDD）——

    /// 跑到 migration 011（不含 012），用于在 012 前准备数据。
    fn run_until_011(conn: &Connection) {
        apply_001_init(conn).unwrap();
        apply_002_shortcuts(conn).unwrap();
        apply_003_finished_flag(conn).unwrap();
        apply_004_book_source_descriptor_unique(conn).unwrap();
        apply_005_library_history_redesign(conn).unwrap();
        apply_006_history_book_id(conn).unwrap();
        apply_007_shortcuts_cross_source(conn).unwrap();
        apply_008_directory_masonry(conn).unwrap();
        apply_009_thumbnail_cache(conn).unwrap();
        apply_010_progress_image_name(conn).unwrap();
        apply_011_drop_like_table(conn).unwrap();
    }

    #[test]
    fn migration_012_adds_browse_history_visit_count_columns() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(browse_history)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            cols.contains(&"visit_count".to_string()),
            "browse_history 应有 visit_count 列"
        );
        assert!(
            cols.contains(&"last_cleanup_candidate_at".to_string()),
            "browse_history 应有 last_cleanup_candidate_at 列"
        );

        // 新行 visit_count 默认 1（NOT NULL DEFAULT 1）
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at)
             VALUES ('Local', '/x', 'x', 100)",
            [],
        )
        .unwrap();
        let vc: i64 = conn
            .query_row(
                "SELECT visit_count FROM browse_history WHERE rel_path='/x'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(vc, 1, "新行 visit_count 默认应为 1");

        // last_cleanup_candidate_at 默认 NULL（仅诊断用）
        let lcc: Option<i64> = conn
            .query_row(
                "SELECT last_cleanup_candidate_at FROM browse_history WHERE rel_path='/x'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(lcc.is_none(), "last_cleanup_candidate_at 默认应为 NULL");
    }

    #[test]
    fn migration_012_creates_maintenance_state_table() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='maintenance_state'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 1, "maintenance_state 表应存在");

        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(maintenance_state)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for expected in ["key", "integer_value", "updated_at"] {
            assert!(
                cols.contains(&expected.to_string()),
                "maintenance_state 缺列 {expected}"
            );
        }
    }

    #[test]
    fn migration_012_backfills_thumbnail_cache_total_bytes() {
        let conn = Connection::open_in_memory().unwrap();
        run_until_011(&conn);

        // 塞 3 行 thumbnail_cache（byte_size 100/200/300，sum=600）
        for (i, size) in [100i64, 200, 300].iter().enumerate() {
            conn.execute(
                "INSERT INTO thumbnail_cache (cache_key, source_key, rel_path, target_bucket,
                    quality, cache_rel_path, output_width, output_height, byte_size,
                    created_at, last_accessed_at)
                 VALUES (?1, 'sk', '/p', 256, 'q', 'c', 10, 20, ?2, 1, ?3)",
                rusqlite::params![format!("key_{i}"), size, i as i64],
            )
            .unwrap();
        }

        super::apply_012_maintenance_retention(&conn).unwrap();

        let total: i64 = conn
            .query_row(
                "SELECT integer_value FROM maintenance_state WHERE key='thumbnail_cache_total_bytes'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            total, 600,
            "012 应以 SUM(byte_size) 回填 thumbnail_cache_total_bytes"
        );
    }

    #[test]
    fn migration_012_inserts_default_maintenance_settings() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let expected: &[(&str, &str)] = &[
            ("maintenance_auto_cleanup_enabled", "1"),
            ("history_retention_max_entries", "2000"),
            ("history_retention_days", "365"),
            ("history_recent_protect_days", "7"),
            ("maintenance_last_run_at", "0"),
            ("maintenance_last_result_json", "{}"),
        ];
        for (k, v) in expected {
            let val: String = conn
                .query_row("SELECT value FROM settings WHERE key=?1", [k], |row| row.get(0))
                .unwrap_or_else(|_| panic!("settings 缺 key {k}"));
            assert_eq!(val, *v, "settings.{k} 默认值应为 {v}");
        }
    }

    #[test]
    fn migration_012_does_not_overwrite_existing_settings() {
        // INSERT OR IGNORE 不得覆盖用户已配置的值
        let conn = Connection::open_in_memory().unwrap();
        run_until_011(&conn);

        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('history_retention_max_entries', '500')",
            [],
        )
        .unwrap();

        super::apply_012_maintenance_retention(&conn).unwrap();

        let val: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key='history_retention_max_entries'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, "500", "INSERT OR IGNORE 不应覆盖用户已有设置");
    }

    #[test]
    fn migration_012_creates_query_indexes() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        for idx in [
            "idx_library_favorite_read",
            "idx_shortcut_created_at",
            "idx_bookmark_book_page",
            "idx_book_tag_tag_book",
            "idx_browse_history_cleanup",
        ] {
            let n: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "索引 {idx} 应由 migration 012 创建");
        }
    }

    #[test]
    fn migration_012_replaces_thumbnail_cache_lru_index_with_stable_key() {
        // spec §6.2：旧单列 idx_thumbnail_cache_lru → 新稳定排序 idx_thumbnail_cache_lru_key
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let old_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_thumbnail_cache_lru'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old_exists, 0, "旧 idx_thumbnail_cache_lru 应已删除");

        let new_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_thumbnail_cache_lru_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(new_exists, 1, "新 idx_thumbnail_cache_lru_key 应存在");
    }

    #[test]
    fn migration_012_like_table_still_absent() {
        // 回归守卫：012 不得重建 like 表，也不得引用它（spec §9）
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='like'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(exists, 0, "like 表在 012 后仍不应存在");
    }

    #[test]
    fn migration_012_run_bumps_version_to_12_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let v: i32 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v, 14, "完整 run 后版本号应为 14");

        // 幂等：run() 的 current<12 守卫使重复调用不再执行 012
        super::run(&conn).expect("重复 run 应幂等无错");
        super::run(&conn).expect("三次 run 仍幂等");

        let v2: i32 = conn
            .query_row("SELECT MAX(version) FROM _migrations", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v2, 14, "重复 run 不应再升版本号");
    }

    /// 任务 7：EXPLAIN QUERY PLAN 手动验证（`--ignored --nocapture` 跑，输出写入报告）。
    ///
    /// 标 `#[ignore]`：查询规划器的索引选择依赖数据量/统计启发式，断言在 CI 不稳定；
    /// 索引**存在性**已由 `migration_012_creates_query_indexes` 守护。本测试用代表性数据量
    /// 打印 3 条 plan，人工确认 spec §7 索引被采用，结果记入验收报告。
    #[test]
    #[ignore]
    fn explain_query_plan_snapshot() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..200i64 {
            tx.execute(
                "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, visit_count)
                 VALUES (?1, ?2, ?3, ?4, 1)",
                rusqlite::params!["{\"type\":\"local\"}", format!("/p{i:03}"), format!("P{i}"), 1000 + i],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO library (title, source_descriptor, source_type, absolute_path, page_count, added_at, is_favorite, last_read_at)
                 VALUES (?1, '{\"type\":\"local\"}', 'Local', ?2, 1, ?3, ?4, ?5)",
                rusqlite::params![format!("T{i}"), format!("/x{i}"), i, (i % 2) as i64, Some(i)],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO thumbnail_cache (cache_key, source_key, rel_path, target_bucket, quality, cache_rel_path, output_width, output_height, byte_size, created_at, last_accessed_at)
                 VALUES (?1, 's', 'p', 256, 'q', 'c', 10, 20, 100, 1, ?2)",
                rusqlite::params![format!("k{i:03}"), i],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        fn detail(conn: &Connection, sql: &str) -> String {
            let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
            let mut rows = stmt.query([]).unwrap();
            let mut out = String::new();
            while let Ok(Some(r)) = rows.next() {
                out.push_str(&r.get::<_, String>(3).unwrap_or_default());
                out.push('\n');
            }
            out.trim().to_string()
        }

        eprintln!(
            "PLAN history  : {}",
            detail(&conn, "SELECT rel_path FROM browse_history WHERE last_visited_at < 1100 ORDER BY last_visited_at DESC, source_descriptor DESC LIMIT 100")
        );
        eprintln!(
            "PLAN library  : {}",
            detail(&conn, "SELECT id FROM library WHERE is_favorite = 1 ORDER BY last_read_at IS NULL, last_read_at DESC, added_at DESC, id DESC")
        );
        eprintln!(
            "PLAN thumbnail: {}",
            detail(&conn, "SELECT cache_key FROM thumbnail_cache ORDER BY last_accessed_at ASC, cache_key ASC LIMIT 256")
        );
    }

    // —— Migration 013：descriptor 序列化格式统一 + 重复行去重（2026-08-14）——

    /// 复刻 2cb24e4 前后两种序列化格式（解析值相同、字符串不同）
    const OLD_FMT: &str = r#"{"rootPath":"D:\\Wallpaper","type":"local"}"#;
    const NEW_FMT: &str = r#"{"type":"local","rootPath":"D:\\Wallpaper"}"#;
    const CANONICAL: &str = r#"{"type":"local","rootPath":"D:\\Wallpaper"}"#;

    #[test]
    fn migration_013_dedupes_dual_format_rows() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap(); // 跑到 012

        // browse_history 双行同 rel_path（旧 book_id=1 lva=100 vc=3；新 book_id=3 lva=200 vc=2）
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id, visit_count)
             VALUES (?1, 'normal', 'normal旧', 100, 1, 3)",
            [OLD_FMT],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id, visit_count)
             VALUES (?1, 'normal', 'normal新', 200, 3, 2)",
            [NEW_FMT],
        )
        .unwrap();

        // library 双行同 absolute_path（旧 id 自增=1，新 id=3——手动指定保证确定性）
        conn.execute(
            "INSERT INTO library (id, title, source_descriptor, source_type, absolute_path, page_count, added_at, is_favorite)
             VALUES (1, 'normal', ?1, 'local', 'normal', 10, 1, 0)",
            [OLD_FMT],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO library (id, title, source_descriptor, source_type, absolute_path, page_count, added_at, is_favorite)
             VALUES (3, 'normal', $fmt, 'local', 'normal', 20, 2, 0)",
            rusqlite::params![NEW_FMT],
        )
        .unwrap();

        // progress 双行（旧 finished=0 updated=100；新 finished=1 updated=200）
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, image_name, updated_at, finished)
             VALUES (1, 0, 'single', NULL, 100, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, image_name, updated_at, finished)
             VALUES (3, 211, 'single', NULL, 200, 1)",
            [],
        )
        .unwrap();

        // bookmark 指向旧 book
        conn.execute(
            "INSERT INTO bookmark (book_id, page, position, label, created_at)
             VALUES (1, 5, NULL, 'bm', 1)",
            [],
        )
        .unwrap();

        super::apply_013_descriptor_canonical_dedupe(&conn).unwrap();

        // browse_history: 单行 canonical，保最新行（lva=200, book_id=3, name=新），visit_count=5
        let (sd, name, lva, bid, vc): (String, String, i64, Option<i64>, i64) = conn
            .query_row(
                "SELECT source_descriptor, display_name, last_visited_at, book_id, visit_count
                 FROM browse_history WHERE rel_path='normal'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(sd, CANONICAL);
        assert_eq!(name, "normal新");
        assert_eq!(lva, 200);
        assert_eq!(bid, Some(3));
        assert_eq!(vc, 5, "visit_count 应求和 3+2");

        // library: 单行 canonical，保 id=3
        let (count, sd, id): (i64, String, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(source_descriptor), MAX(id) FROM library WHERE absolute_path='normal'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(sd, CANONICAL);
        assert_eq!(id, 3);

        // progress: 迁到 book_id=3（updated 大者胜出），finished=1 保留
        let (bid, page, finished): (i64, i64, i64) = conn
            .query_row(
                "SELECT book_id, page, finished FROM progress",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((bid, page, finished), (3, 211, 1));

        // bookmark: book_id 迁到 3
        let bm_bid: i64 = conn
            .query_row("SELECT book_id FROM bookmark", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bm_bid, 3);
    }

    #[test]
    fn migration_013_keeps_progress_of_old_row_when_newer() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();
        // 旧行（小 id）的 progress 更新（updated_at 更大）→ 顶替保留行进度
        conn.execute(
            "INSERT INTO library (id, title, source_descriptor, source_type, absolute_path, page_count, added_at, is_favorite)
             VALUES (1, 'n', $fmt, 'local', 'n', 0, 1, 0)",
            rusqlite::params![OLD_FMT],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO library (id, title, source_descriptor, source_type, absolute_path, page_count, added_at, is_favorite)
             VALUES (3, 'n', $fmt, 'local', 'n', 0, 2, 0)",
            rusqlite::params![NEW_FMT],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, image_name, updated_at, finished)
             VALUES (1, 99, 'single', NULL, 900, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, image_name, updated_at, finished)
             VALUES (3, 1, 'single', NULL, 100, 0)",
            [],
        )
        .unwrap();

        super::apply_013_descriptor_canonical_dedupe(&conn).unwrap();

        let (bid, page, finished): (i64, i64, i64) = conn
            .query_row(
                "SELECT book_id, page, finished FROM progress",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((bid, page, finished), (3, 99, 1), "updated_at 大的旧行进度应顶替");
    }

    #[test]
    fn migration_013_canonicalizes_without_dupes_and_keeps_invalid_json() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();
        // 单行旧格式（无重复）+ 一行非法 JSON
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id, visit_count)
             VALUES (?1, 'normal', 'n', 100, 1, 1)",
            [OLD_FMT],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id, visit_count)
             VALUES ('not-json', 'x', 'x', 50, NULL, 1)",
            [],
        )
        .unwrap();

        super::apply_013_descriptor_canonical_dedupe(&conn).unwrap();

        let sd: String = conn
            .query_row(
                "SELECT source_descriptor FROM browse_history WHERE rel_path='normal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sd, CANONICAL, "无重复也应重写为 canonical");

        let bad: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM browse_history WHERE source_descriptor='not-json'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bad, 1, "非法 JSON 行原样保留不迁移");

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM browse_history", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2, "无重复场景行数不变");
    }

    #[test]
    fn migration_013_idempotent_rerun() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at, book_id, visit_count)
             VALUES (?1, 'a', 'a', 100, 1, 2)",
            [NEW_FMT],
        )
        .unwrap();

        super::apply_013_descriptor_canonical_dedupe(&conn).unwrap();
        super::apply_013_descriptor_canonical_dedupe(&conn).unwrap(); // 幂等重跑

        let (n, vc): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(visit_count) FROM browse_history",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((n, vc), (1, 2), "重跑不产生重复 / 不重复累计 visit_count");
    }

    #[test]
    fn migration_014_run_clears_001_touch_seed() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();

        let touch: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key LIKE 'touch_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touch, 0, "完整 run() 后 001 seed 的 9 个 touch_* key 已被 014 清除");
    }

    #[test]
    fn migration_014_deletes_only_touch_keys_and_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        super::run(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO settings (key, value) VALUES
             ('touch_zones_enabled', '1'),
             ('touch_top_left', 'FIT_WIDTH'),
             ('unrelated_key', 'x')",
        )
        .unwrap();

        super::apply_014_drop_touch_zone_settings(&conn).unwrap();
        super::apply_014_drop_touch_zone_settings(&conn).unwrap(); // 幂等重跑

        let touch: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key LIKE 'touch_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touch, 0, "touch_* key（含运行时写入的 touch_zones_enabled）全部清除");
        let other: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM settings WHERE key = 'unrelated_key'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(other, 1, "非 touch key 不受影响");
    }
}