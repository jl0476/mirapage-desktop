//! 数据库 migrations
//!
//! Phase 1：001_init 创建核心表 + 初始 settings 默认值。

use rusqlite::Connection;

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
}