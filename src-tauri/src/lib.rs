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
            commands::thumbnails::get_thumbnail_cache_info,
            commands::thumbnails::clear_thumbnail_cache,
            commands::thumbnails::notify_thumbnail_epoch,
            commands::thumbnails::notify_thumbnail_fast_scrolling,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 初始化缩略图缓存服务：解析 cache 目录、读 settings、建 ThumbnailService。
fn init_thumbnail_service(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|e| anyhow::anyhow!("failed to resolve app cache dir: {e}"))?
        .join("masonry-thumbnails");
    std::fs::create_dir_all(&cache_root)?;
    tracing::info!("thumbnail cache root at {}", cache_root.display());

    let db = app.state::<db::Db>();
    let conn = db.conn();
    let worker = setting_u32(&conn, "fb_thumbnail_worker_limit", 2);
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