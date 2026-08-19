//! MiraPage Desktop — Tauri 后端入口
//!
//! 设计原则：
//! - 所有跨平台数据源通过 `source::MediaSource` trait 抽象
//! - Phase 1 定义 trait + LocalMediaSource 实现；SMB/WebDAV 留 stub
//! - Phase 7-8 填 stub，UI 代码完全不动

mod algorithm;
mod commands;
mod credentials;
mod db;
mod log;
mod maintenance;
mod media_cache;
mod media_protocol;
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
        // 窗口状态持久化：退出保存大小/位置/最大化，启动时恢复（覆盖 tauri.conf 默认 1280x800）
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // media:// 统一协议（module3.2.0 M1）：图片字节不进 IPC，异步 handler 按
        // 固定段数 URL 解析 → DB 重建 descriptor → factory 分发 → GET/HEAD/Range
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            tokio::spawn(async move {
                let resp = handle_media_request(&app, request).await;
                let _ = responder.respond(resp);
            });
        })
        // Phase 1 决策：settings 走自家 DB（commands::settings + db/migrations 001），
        // 不需要 tauri-plugin-store。依赖已在 Cargo.toml 注释，此处同步移除注册。
        .setup(|app| {
            // 初始化数据库
            let app_handle = app.handle();
            let db = db::init(app_handle).expect("failed to init database");
            app.manage(db.clone());

            // 凭据存储（spec §3.4：keyring 生产实现，密码不落 DB）
            let creds = std::sync::Arc::new(credentials::KeyringStore)
                as std::sync::Arc<dyn credentials::CredentialStore>;
            app.manage(creds.clone());

            // 初始化 MediaSourceFactory（WebDav 源持 DB 克隆 + 凭据取 Basic Auth）
            let factory = source::MediaSourceFactory::new(db, creds);
            app.manage(factory);

            // 初始化缩略图缓存服务（v0.1.0-module3.0.7）
            init_thumbnail_service(app_handle)?;

            // 维护服务（v0.1.0-database-retention-and-cleanup）：历史保留防抖自动清理
            let maintenance_svc = maintenance::MaintenanceService::new(app_handle.clone());
            app.manage(maintenance_svc);

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
            commands::bookmarks::list_all_bookmarks,
            commands::bookmarks::add_bookmark,
            commands::bookmarks::remove_bookmark,
            commands::history::list_history,
            commands::history::record_history,
            commands::history::delete_history,
            // 阅览记录导出 JSON（module3.1.2）
            commands::history_export::export_browse_history,
            commands::library::list_library,
            commands::library::set_favorite,
            commands::library::create_book,
            commands::library::get_book,
            commands::directory_sort::get_directory_sort,
            commands::directory_sort::set_directory_sort,
            commands::progress::save_progress,
            commands::progress::mark_finished,
            commands::progress::reset_progress_by_location,
            commands::library::get_book_status,
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
            // 维护（v0.1.0-database-retention-and-cleanup）
            commands::maintenance::get_maintenance_summary,
            commands::maintenance::get_maintenance_preview,
            commands::maintenance::run_maintenance,
            commands::maintenance::update_maintenance_settings,
            // module3.2.0: 远程图片预读预载（warm 会话协议，spec rev5 §3.6）
            commands::warm::advance_warm_session,
            commands::warm::warm_media_urls,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// media:// 请求组装：解析 → 重建 descriptor → factory 分发 → stat/read → HTTP 响应。
/// 纯函数（codec/Range/校验链）在 media_protocol.rs；此处只做 app state 组装。
async fn handle_media_request(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use media_protocol::*;
    use tauri::http::Response;
    use tauri::http::StatusCode;

    let path = request.uri().path().to_string();
    let target = match parse_media_path(&path) {
        Ok(t) => t,
        Err(ProtocolError::BadShape(_)) => return err_response(StatusCode::NOT_FOUND, "not found"),
        Err(_) => return err_response(StatusCode::FORBIDDEN, "forbidden"),
    };
    let factory = app.state::<source::MediaSourceFactory>();
    let (descriptor, file_path) = match rebuild_descriptor(app, &target) {
        Ok(v) => v,
        Err((code, msg)) => return err_response(code, &msg),
    };
    let src = factory.resolve(&descriptor);
    let name = file_path.rsplit('/').next().unwrap_or(&file_path).to_string();
    let mime = crate::algorithm::mime_from_name(&name)
        .unwrap_or("application/octet-stream")
        .to_string();
    let is_head = request.method() == "HEAD";

    // stat（HEAD / Range 判定需要 total）
    let stat = match src.stat(&descriptor, &file_path).await {
        Ok(s) => s,
        Err(e) => return error_to_status(e),
    };
    let range = match parse_range_header(
        request.headers().get("range").and_then(|v| v.to_str().ok()),
        stat.size,
    ) {
        RangeResolution::Full => None,
        RangeResolution::Partial(r) => Some(r),
        RangeResolution::Unsatisfiable => {
            return finish(
                Response::builder()
                    .status(416)
                    .header("Content-Range", format_unsatisfiable_range(stat.size))
                    .header("Cache-Control", "no-store"),
                Vec::new(),
            );
        }
        RangeResolution::Malformed => None,
    };
    if is_head {
        return finish(
            Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Content-Length", stat.size.to_string())
                .header("Accept-Ranges", "bytes")
                .header("Cache-Control", "no-store"),
            Vec::new(),
        );
    }
    // 预读缓存条件（spec rev5 §3.6，rev7 显式顺序）：
    // 1. Local → 跳过 LRU 直读（文件系统页缓存已够）
    // 2. 带 Range 头 → 跳过 LRU 直读源（缓存条目只有全量 bytes，命中回 200 会破坏 Range 语义）
    // 3. 无 Range 的远程 GET → 命中回 200 全量；miss 读源后填充
    let cacheable = range.is_none() && !matches!(target, MediaTarget::Local { .. });
    if cacheable {
        if let Some(hit) = media_cache::global().lock().unwrap().get(&path) {
            return finish(
                Response::builder()
                    .status(200)
                    .header("Content-Type", hit.mime.clone())
                    .header("Content-Length", hit.bytes.len().to_string())
                    .header("Accept-Ranges", "bytes")
                    .header("Cache-Control", "no-store"),
                hit.bytes.to_vec(),
            );
        }
    }
    match src.read_file(&descriptor, &file_path, range).await {
        Ok(bytes) => {
            if cacheable {
                media_cache::global().lock().unwrap().put(
                    path,
                    media_cache::CachedMedia { bytes: bytes.clone(), mime: mime.clone() },
                );
            }
            let b = if let Some(r) = range {
                Response::builder()
                    .status(206)
                    .header("Content-Type", mime)
                    .header("Content-Length", bytes.len().to_string())
                    .header("Content-Range", format_content_range(r.offset, r.offset + r.length - 1, stat.size))
                    .header("Accept-Ranges", "bytes")
                    .header("Cache-Control", "no-store")
            } else {
                Response::builder()
                    .status(200)
                    .header("Content-Type", mime)
                    .header("Content-Length", bytes.len().to_string())
                    .header("Accept-Ranges", "bytes")
                    .header("Cache-Control", "no-store")
            };
            finish(b, bytes)
        }
        Err(e) => error_to_status(e),
    }
}

/// 从 DB 重建 descriptor（URL 只带定位信息，host/port/凭据全在 DB）。
/// Smb 分支同时执行根路径契约校验（initialPath 首段 === account.share，spec §4.2）。
pub(crate) fn rebuild_descriptor(
    app: &tauri::AppHandle,
    t: &media_protocol::MediaTarget,
) -> Result<(source::descriptor::SourceDescriptor, String), (tauri::http::StatusCode, String)> {
    use media_protocol::MediaTarget;
    use source::descriptor::SourceDescriptor;
    use tauri::http::StatusCode;
    let db = app.state::<crate::db::Db>();
    let not_found = || (StatusCode::NOT_FOUND, "account not found".to_string());
    Ok(match t {
        MediaTarget::Local { abs_path } => {
            // resolve_path = root.join(rel)：root = 文件所在目录、rel = 文件名（跨盘 join 安全）
            let norm = abs_path.replace('\\', "/");
            let (dir, file) = norm
                .rsplit_once('/')
                .ok_or_else(|| (StatusCode::FORBIDDEN, "forbidden".to_string()))?;
            (SourceDescriptor::Local { root_path: dir.to_string() }, file.to_string())
        }
        MediaTarget::WebDav { account_id, rel_path } => {
            let (host, _) = account_row(&db, *account_id, "webdav")?;
            let base_url = host.ok_or_else(not_found)?;
            (
                SourceDescriptor::WebDav { account_id: *account_id, base_url, path: rel_path.clone() },
                rel_path.clone(),
            )
        }
        MediaTarget::Smb { account_id, initial_path, rel_path } => {
            let (host, port, share) = smb_account_row(&db, *account_id)?;
            let first = initial_path.split('/').next().unwrap_or("");
            if share.as_deref() != Some(first) {
                return Err((StatusCode::FORBIDDEN, "forbidden".to_string()));
            }
            (
                SourceDescriptor::Smb {
                    account_id: *account_id,
                    initial_path: initial_path.clone(),
                    path: rel_path.clone(),
                    port: port.unwrap_or(445) as i32,
                },
                rel_path.clone(),
            )
        }
        MediaTarget::Archive { origin, account_id, origin_ref, archive_rel_path, entry_path } => {
            match origin.as_str() {
                "local" => {
                    let abs = origin_ref.clone();
                    (
                        SourceDescriptor::Archive {
                            archive_path: abs,
                            entry_prefix: String::new(),
                            format: format_from_name(origin_ref),
                            origin: None,
                            origin_entry_path: None,
                            archive_rel_path: None,
                        },
                        entry_path.clone(),
                    )
                }
                "webdav" => {
                    let id = account_id.ok_or_else(not_found)?;
                    let (host, _) = account_row(&db, id, "webdav")?;
                    let base_url = host.ok_or_else(not_found)?;
                    let ar = archive_rel_path.clone().unwrap_or_default();
                    (
                        SourceDescriptor::Archive {
                            archive_path: format!("{}/{}", base_url.trim_end_matches('/'), ar), // 虚拟路径（spec §5.1）
                            entry_prefix: String::new(),
                            format: format_from_name(&ar),
                            origin: Some(Box::new(SourceDescriptor::WebDav {
                                account_id: id,
                                base_url,
                                path: String::new(),
                            })),
                            origin_entry_path: Some(ar.clone()),
                            archive_rel_path: Some(ar),
                        },
                        entry_path.clone(),
                    )
                }
                "smb" => {
                    let id = account_id.ok_or_else(not_found)?;
                    let (host, port, share) = smb_account_row(&db, id)?;
                    let init = origin_ref.clone();
                    let first = init.split('/').next().unwrap_or("");
                    if share.as_deref() != Some(first) {
                        return Err((StatusCode::FORBIDDEN, "forbidden".to_string()));
                    }
                    let ar = archive_rel_path.clone().unwrap_or_default();
                    (
                        SourceDescriptor::Archive {
                            archive_path: format!("\\\\{}\\{}\\{}", host.unwrap_or_default(), init, ar), // UNC 虚拟路径
                            entry_prefix: String::new(),
                            format: format_from_name(&ar),
                            origin: Some(Box::new(SourceDescriptor::Smb {
                                account_id: id,
                                initial_path: init,
                                path: String::new(),
                                port: port.unwrap_or(445) as i32,
                            })),
                            origin_entry_path: Some(ar.clone()),
                            archive_rel_path: Some(ar),
                        },
                        entry_path.clone(),
                    )
                }
                _ => return Err(not_found()),
            }
        }
    })
}

fn account_row(
    db: &crate::db::Db,
    id: i64,
    kind: &str,
) -> Result<(Option<String>, Option<i64>), (tauri::http::StatusCode, String)> {
    let conn = db.conn();
    conn.query_row(
        "SELECT host, port FROM account WHERE id = ?1 AND type = ?2",
        rusqlite::params![id, kind],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .map_err(|_| (tauri::http::StatusCode::NOT_FOUND, "account not found".into()))
}

fn smb_account_row(
    db: &crate::db::Db,
    id: i64,
) -> Result<(Option<String>, Option<i64>, Option<String>), (tauri::http::StatusCode, String)> {
    let conn = db.conn();
    conn.query_row(
        "SELECT host, port, share FROM account WHERE id = ?1 AND type = 'smb'",
        rusqlite::params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|_| (tauri::http::StatusCode::NOT_FOUND, "account not found".into()))
}

fn format_from_name(name: &str) -> source::descriptor::ArchiveFormat {
    let ext = std::path::Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    source::descriptor::ArchiveFormat::from_extension(ext).unwrap_or(source::descriptor::ArchiveFormat::Zip)
}

fn err_response(status: tauri::http::StatusCode, msg: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

fn finish(
    b: tauri::http::response::Builder,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    b.body(body).unwrap()
}

fn error_to_status(e: crate::source::trait_def::MediaSourceError) -> tauri::http::Response<Vec<u8>> {
    use crate::source::trait_def::MediaSourceError;
    use tauri::http::StatusCode;
    match e {
        MediaSourceError::NotFound(_) => err_response(StatusCode::NOT_FOUND, "not found"),
        MediaSourceError::PermissionDenied(_) | MediaSourceError::PathEscape(_) => {
            err_response(StatusCode::FORBIDDEN, "forbidden")
        }
        MediaSourceError::Network(_) | MediaSourceError::Timeout(_) => {
            err_response(StatusCode::BAD_GATEWAY, "bad gateway")
        }
        MediaSourceError::NotImplemented(_) => {
            err_response(StatusCode::NOT_IMPLEMENTED, "not implemented")
        }
        _ => err_response(StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    }
}

/// 初始化缩略图缓存服务：解析 cache 目录（支持自定义位置）、读 settings、建 ThumbnailService。
fn init_thumbnail_service(app: &tauri::AppHandle) -> anyhow::Result<()> {    let default_root = app
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