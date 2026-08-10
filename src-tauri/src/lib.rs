//! MiraPage Desktop — Tauri 后端入口
//!
//! 设计原则：
//! - 所有跨平台数据源通过 `source::MediaSource` trait 抽象
//! - Phase 1 定义 trait + LocalMediaSource 实现；SMB/WebDAV 留 stub
//! - Phase 7-8 填 stub，UI 代码完全不动

mod algorithm;
mod commands;
mod db;
mod log;
mod source;
pub mod thumbnail;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

pub fn run() {
    // 初始化 tracing — RUST_LOG=debug 看全部, RUST_LOG=mirapage_desktop_lib=debug
    // 看本 crate, 默认 info. release 模式下 dev 默认关日志.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .try_init();

    // 写一行 startup log 到 main.log, 方便确认 exe 是否真起来
    log::write_log("INFO", "app", "MiraPage Desktop starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // Phase 1 决策：settings 走自家 DB（commands::settings + db/migrations 001），
        // 不需要 tauri-plugin-store。依赖已在 Cargo.toml 注释，此处同步移除注册。
        .setup(|app| {
            // 初始化数据库
            let app_handle = app.handle();
            let db = db::init(app_handle).expect("failed to init database");
            app.manage(db);

            // 初始化 MediaSourceFactory（注入 4 个实现）
            let factory = source::MediaSourceFactory::new();
            app.manage(factory);

            // 初始化缩略图缓存服务（v0.1.0-module3.0.7）
            init_thumbnail_service(app_handle)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::file_browser::list_directory,
            commands::file_browser::read_file,
            // Phase 3 压缩包
            // (list_directory/read_file 通用,无需重复声明)
            // Phase 4 业务
            commands::bookmarks::list_bookmarks,
            commands::bookmarks::add_bookmark,
            commands::bookmarks::remove_bookmark,
            commands::likes::list_likes,
            commands::likes::toggle_like,
            commands::history::list_history,
            commands::history::record_history,
            commands::history::delete_history,
            commands::library::list_library,
            commands::library::set_favorite,
            commands::library::create_book,
            commands::library::get_book,
            commands::directory_sort::get_directory_sort,
            commands::directory_sort::set_directory_sort,
            commands::progress::save_progress,
            commands::progress::mark_finished,
            commands::progress::list_progress_finished,
            commands::progress::get_progress,
            commands::tags::list_tags,
            commands::tags::create_tag,
            commands::tags::delete_tag,
            commands::tags::add_book_tag,
            commands::tags::remove_book_tag,
            commands::accounts::list_accounts,
            commands::accounts::upsert_account,
            commands::accounts::delete_account,
            commands::accounts::test_connection,
            // 模块 #1 快捷方式
            commands::shortcuts::list_shortcuts,
            commands::shortcuts::create_shortcut,
            commands::shortcuts::delete_shortcut,
            // 日志 (前端 → 文件)
            commands::log::log_to_file,
            // 阅读器屏幕常亮 (v0.1.0-module2.0)
            commands::keep_screen_on::keep_screen_on,
            // Phase 5
            commands::find_next_volume::find_next_volume,
            // 瀑布流布局骨架数据（masonry viewMode 预读 header）
            commands::image_dimensions::list_image_dimensions,
            // 瀑布流布局参数覆盖 (v0.1.0-module3.0.6)
            commands::directory_masonry::get_directory_masonry,
            commands::directory_masonry::set_directory_masonry,
            // 缩略图缓存 (v0.1.0-module3.0.7)
            commands::thumbnails::request_thumbnails,
            commands::thumbnails::retry_thumbnail,
            commands::thumbnails::regenerate_thumbnail,
            commands::thumbnails::update_thumbnail_runtime_config,
            commands::thumbnails::update_thumbnail_cache_limit,
            commands::thumbnails::get_thumbnail_cache_info,
            commands::thumbnails::clear_thumbnail_cache,
            commands::thumbnails::notify_thumbnail_epoch,
            commands::thumbnails::notify_thumbnail_fast_scrolling,
            // 缓存位置迁移 (§11)
            commands::thumbnails::validate_thumbnail_cache_location,
            commands::thumbnails::migrate_thumbnail_cache,
            commands::thumbnails::cancel_thumbnail_cache_migration,
            commands::thumbnails::resume_thumbnail_cache_migration,
            commands::thumbnails::rollback_thumbnail_cache_migration,
            commands::thumbnails::get_thumbnail_migration_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 初始化缩略图缓存服务：解析 cache 目录（支持自定义位置）、读 settings、建 ThumbnailService。
fn init_thumbnail_service(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let default_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| anyhow::anyhow!("failed to resolve app cache dir: {e}"))?
        .join("masonry-thumbnails");

    let db = app.state::<db::Db>();
    let conn = db.conn();
    // 一次性兼容修复：P0 修复前旧索引 cache_rel_path 缺 v1/ 段，补前缀让文件命中缓存，
    // 避免迁移后 get_verified miss 重新生成 4K 图（慢）。幂等，无旧行时 0 更新。
    match thumbnail::index::repair_legacy_cache_rel_paths(&conn) {
        Ok(n) if n > 0 => tracing::info!("repaired {} legacy cache_rel_path rows", n),
        Ok(_) => {}
        Err(e) => tracing::warn!("repair legacy cache_rel_path failed: {e}"),
    }
    // 自定义缓存位置（fb_thumbnail_cache_root 非空则用之，否则系统默认）
    let configured = setting_str(&conn, "fb_thumbnail_cache_root", "");
    let cache_root = if configured.is_empty() {
        default_root
    } else {
        std::path::PathBuf::from(&configured)
    };
    std::fs::create_dir_all(&cache_root)?;
    tracing::info!("thumbnail cache root at {}", cache_root.display());

    let worker = read_thumbnail_worker_limit(&conn);
    let mem = setting_u32(&conn, "fb_thumbnail_decode_memory_mb", 128);
    let quality = match setting_str(&conn, "fb_thumbnail_quality", "high").as_str() {
        "standard" => thumbnail::Quality::Standard,
        "ultra" => thumbnail::Quality::Ultra,
        _ => thumbnail::Quality::High,
    };
    let limit = setting_u64(&conn, "fb_thumbnail_cache_limit_mb", 512);

    let service = thumbnail::service::ThumbnailService::new(
        app.clone(),
        cache_root,
        worker,
        mem,
        quality,
        limit,
    );
    app.manage(service);
    Ok(())
}

fn setting_str(conn: &rusqlite::Connection, key: &str, default: &str) -> String {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| default.to_string())
}

fn setting_u32(conn: &rusqlite::Connection, key: &str, default: u32) -> u32 {
    setting_str(conn, key, &default.to_string())
        .parse()
        .unwrap_or(default)
}

fn setting_u64(conn: &rusqlite::Connection, key: &str, default: u64) -> u64 {
    setting_str(conn, key, &default.to_string())
        .parse()
        .unwrap_or(default)
}

/// 启动时读 worker_limit 并钳到合法范围（防御脏 DB：旧版本可能写入了越界值）。
/// 与 IPC 入口 `update_thumbnail_runtime_config` 的钳制保持一致。
fn read_thumbnail_worker_limit(conn: &rusqlite::Connection) -> u32 {
    let raw = setting_u32(conn, "fb_thumbnail_worker_limit", 2);
    thumbnail::policy::normalize_worker_limit(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn open_settings_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn
    }

    fn upsert(conn: &Connection, key: &str, value: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES(?1, ?2)",
            rusqlite::params![key, value],
        )
        .unwrap();
    }

    #[test]
    fn read_thumbnail_worker_limit_clamps_out_of_range_db_value() {
        let conn = open_settings_db();
        // 脏 DB：上限越界 → 钳到 16
        upsert(&conn, "fb_thumbnail_worker_limit", "100");
        assert_eq!(read_thumbnail_worker_limit(&conn), 16);
        // 上界
        upsert(&conn, "fb_thumbnail_worker_limit", "17");
        assert_eq!(read_thumbnail_worker_limit(&conn), 16);
        // 合法值原原样返回
        upsert(&conn, "fb_thumbnail_worker_limit", "8");
        assert_eq!(read_thumbnail_worker_limit(&conn), 8);
        upsert(&conn, "fb_thumbnail_worker_limit", "16");
        assert_eq!(read_thumbnail_worker_limit(&conn), 16);
    }

    #[test]
    fn read_thumbnail_worker_limit_clamps_below_min_db_value() {
        let conn = open_settings_db();
        // 脏 DB：下限越界 → 钳到 1
        upsert(&conn, "fb_thumbnail_worker_limit", "0");
        assert_eq!(read_thumbnail_worker_limit(&conn), 1);
    }

    #[test]
    fn read_thumbnail_worker_limit_handles_unparseable_db_value() {
        let conn = open_settings_db();
        // 脏 DB：value 不可解析（parse 失败）→ fallback 到默认 2
        upsert(&conn, "fb_thumbnail_worker_limit", "not_a_number");
        assert_eq!(read_thumbnail_worker_limit(&conn), 2);
    }

    #[test]
    fn read_thumbnail_worker_limit_uses_default_when_row_missing() {
        let conn = open_settings_db();
        // 干净 DB：该 key 不存在 → 默认 2
        assert_eq!(read_thumbnail_worker_limit(&conn), 2);
    }
}