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