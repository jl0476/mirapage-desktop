//! MiraPage Desktop — Tauri 后端入口
//!
//! 设计原则：
//! - 所有跨平台数据源通过 `source::MediaSource` trait 抽象
//! - Phase 1 定义 trait + LocalMediaSource 实现；SMB/WebDAV 留 stub
//! - Phase 7-8 填 stub，UI 代码完全不动

mod algorithm;
mod commands;
mod db;
mod source;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            // 初始化数据库
            let app_handle = app.handle();
            let db = db::init(app_handle).expect("failed to init database");
            app.manage(db);

            // 初始化 MediaSourceFactory（注入 4 个实现）
            let factory = source::MediaSourceFactory::new();
            app.manage(factory);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_setting,
            commands::settings::set_setting,
            commands::file_browser::list_directory,
            commands::file_browser::read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}