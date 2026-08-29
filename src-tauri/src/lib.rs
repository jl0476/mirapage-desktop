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
mod window_bounds;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

/// 全局 AppHandle（archive://progress 等无 AppHandle 注入路径的后台模块 emit 事件用）。
/// 单测无 app → None 静默跳过（materializer emit_progress 分支已写）
static PROGRESS_EMITTER: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// 供物化器等后台模块非阻塞 emit 进度事件（setup 时 set，之前为 None）
pub fn progress_emitter() -> Option<&'static tauri::AppHandle> {
    PROGRESS_EMITTER.get()
}

/// archive 物化缓存根（M3）：setup 内 get_or_init 真实 app_cache_dir()/archive-cache
/// （随后 create_dir_all part/ + 启动清理 startup_cleanup）；未初始化（单测 / setup
/// 前的兜底构造，如 commands 里的独立 factory）回落 temp 目录
static ARCHIVE_CACHE_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn archive_cache_root() -> std::path::PathBuf {
    ARCHIVE_CACHE_ROOT
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("mirapage-archive-cache"))
}

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
            // Windows 上 scheme handler 在主线程回调（无 tokio reactor）——裸 tokio::spawn
            // 首个 media:// 请求即 panic，且闭包不可 unwind 直接 abort 全进程
            // （2026-08-19 实机撞过：浏览目录瀑布流加载首图时崩溃）。必须走
            // tauri::async_runtime（与 thumbnail scheduler/fetch actor 同款约束）。
            tauri::async_runtime::spawn(async move {
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

            // 全局 AppHandle：archive 物化进度等后台事件 emit（materializer 用）
            let _ = PROGRESS_EMITTER.set(app_handle.clone());

            // 凭据存储（spec §3.4：keyring 生产实现，密码不落 DB）
                        // keyring 平台后端探测：mock 时 error 日志（密码不持久化的防御告警）
            crate::credentials::warn_if_mock_backend();
let creds = std::sync::Arc::new(credentials::KeyringStore)
                as std::sync::Arc<dyn credentials::CredentialStore>;
            app.manage(creds.clone());

            // M3：archive cache root 先于 factory（factory 内 Materializer 经
            // archive_cache_root() 取根）——app_cache_dir()/archive-cache，解析失败回落 temp
            let cache_root = app.path().app_cache_dir()
                .map(|d| d.join("archive-cache"))
                .unwrap_or_else(|_| std::env::temp_dir().join("mirapage-archive-cache"));
            ARCHIVE_CACHE_ROOT.get_or_init(|| cache_root.clone());
            std::fs::create_dir_all(cache_root.join("part"))?;

            // 初始化 MediaSourceFactory（WebDav 源持 DB 克隆 + 凭据取 Basic Auth）
            let factory = source::MediaSourceFactory::new(db, creds);
            app.manage(factory.clone());
            // cache 管理命令直接触达物化器（factory 与 manage 共享同一 Arc）
            app.manage(factory.archive_materializer());
            // 任务 7：五格式共享 ArchiveService——session/prepare IPC（任务 11）与
            // commit-gated prefetch（任务 10）从这里取同一实例，不得另建
            app.manage(factory.archive_service());

            // M3 任务 8：三级预载调度器（spec §7）——持 factory 同一物化器 Arc；
            // 任务 10：从 factory 取同一实例（Service 的 committed hook 已注入它，
            // 开关单点）；开关读 settings（默认 true，仅 "false" 关闭，脏值 fail-open）
            let prefetch_enabled = {
                let db_state = app.state::<db::Db>();
                let conn = db_state.conn();
                setting_str(&conn, "remote_archive_prefetch_enabled", "true") != "false"
            };
            let prefetcher = factory.archive_prefetcher();
            prefetcher.set_enabled(prefetch_enabled);
            app.manage(prefetcher);

            // archive cache 启动清理（M3 spec §8 rev2）：孤儿 part / 孤儿缓存文件 /
            // 超容量淘汰（零网络请求；一致性验证推迟到下次 ensure_cached 的 stat）
            //
            // 死锁修复（审查 task-6）：startup_cleanup 内部会再次 db.conn()——
            // conn guard 不得横跨该调用存活（同线程对同一非重入 Arc<Mutex<Connection>>
            // 二次加锁 = 启动即 hang，setup 闭包 cargo test 不覆盖）。限值读取收
            // 内层作用域，guard 先释放；乘法饱和 + 钳 i64 上界防脏 DB 超大值回绕负数。
            {
                let db_state = app.state::<db::Db>();
                let limit = {
                    let conn = db_state.conn();
                    setting_u64(&conn, "archive_cache_max_mb", 2048)
                };
                let limit_bytes =
                    (limit.saturating_mul(1024 * 1024)).min(i64::MAX as u64) as i64;
                source::archive::materializer::startup_cleanup(&cache_root, &db_state, limit_bytes);
            }

            // 初始化缩略图缓存服务（v0.1.0-module3.0.7）
            init_thumbnail_service(app_handle)?;

            // 维护服务（v0.1.0-database-retention-and-cleanup）：历史保留防抖自动清理
            let maintenance_svc = maintenance::MaintenanceService::new(app_handle.clone());
            app.manage(maintenance_svc);

            // 窗口恢复尺寸钳位（3.1.1 遗留打磨项）：window-state 插件对 SIZE 无条件
            // set_size（POSITION 才有显示器守卫），副屏断连后大尺寸可恢复出超屏窗口。
            // 插件 on_window_ready 恢复先于本 setup 闭包，此处做一次性事后钳位；
            // 最大化/全屏态尺寸由系统管理，不干预。失败仅记日志不阻断启动。
            if let Some(window) = app.get_webview_window("main") {
                let maximized = window.is_maximized().unwrap_or(false);
                let fullscreen = window.is_fullscreen().unwrap_or(false);
                if !maximized && !fullscreen {
                    if let (Ok(win_size), Ok(Some(monitor))) =
                        (window.outer_size(), window.current_monitor())
                    {
                        let (w, h) = window_bounds::clamp_window_size(
                            win_size.width,
                            win_size.height,
                            monitor.size().width,
                            monitor.size().height,
                        );
                        if (w, h) != (win_size.width, win_size.height) {
                            log::write_log(
                                "INFO",
                                "app",
                                &format!(
                                    "window size clamped to monitor: {}x{} -> {}x{}",
                                    win_size.width, win_size.height, w, h
                                ),
                            );
                            let _ = window.set_size(tauri::PhysicalSize::new(w, h));
                        }
                    }
                }
            }

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
            commands::thumbnails::invalidate_thumbnail_cache_keys,
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
            // M3 任务 8: 三级预载（metadata stat 预热 / 内容低优物化 + epoch 取消）
            commands::archive_prefetch::notify_archive_window,
            commands::archive_prefetch::set_archive_prefetch_enabled,
            // M3 任务 9: cache 管理命令（clear 四段式 / info 用量统计）
            commands::archive_cache::get_archive_cache_info,
            commands::archive_cache::clear_archive_cache,
            // 任务 11: session/prepare/unlock/commit/cancel 结构化准备 IPC
            // （request registry 状态机；factory.archive_service() 同一 Arc manage）
            commands::archive_access::begin_archive_session,
            commands::archive_access::prepare_archive,
            commands::archive_access::unlock_archive,
            commands::archive_access::commit_archive_open,
            commands::archive_access::cancel_archive_prepare,
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
        Err(ProtocolError::BadShape(reason)) => {
            warn_reject(StatusCode::NOT_FOUND, &path, reason);
            return err_response(StatusCode::NOT_FOUND, "not found");
        }
        Err(e) => {
            warn_reject(StatusCode::FORBIDDEN, &path, &format!("{e:?}"));
            return err_response(StatusCode::FORBIDDEN, "forbidden");
        }
    };
    let factory = app.state::<source::MediaSourceFactory>();
    let (descriptor, file_path) = match rebuild_descriptor(app, &target) {
        Ok(v) => v,
        Err((code, msg)) => {
            warn_reject(code, &path, &msg);
            return err_response(code, &msg);
        }
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
        Err(e) => return error_to_status(e, &path),
    };
    let has_range_header = request.headers().contains_key("range");
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
    let cacheable = !has_range_header && !matches!(target, MediaTarget::Local { .. });
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
        // singleflight miss 分支（spec §8）：与 warm 共享同路径单飞 + generation 守卫
        if media_cache::fetch_remote_to_cache(&path, src.clone(), &descriptor, &file_path).await {
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
        warn_reject(StatusCode::BAD_GATEWAY, &path, "remote media fetch failed");
        return err_response(StatusCode::BAD_GATEWAY, "remote media fetch failed");
    }
    match src.read_file(&descriptor, &file_path, range).await {
        Ok(bytes) => {
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
        Err(e) => error_to_status(e, &path),
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
        MediaTarget::Local { abs_path } => local_descriptor_for_abs_path(abs_path)?,
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

/// 将本地文件绝对路径拆为 `root.join(file)`；保留盘符根与 POSIX 根的尾随 `/`，
/// 避免 `D:` / 空字符串在 Windows 上退化为当前工作目录相对路径。
fn local_descriptor_for_abs_path(
    abs_path: &str,
) -> Result<(source::descriptor::SourceDescriptor, String), (tauri::http::StatusCode, String)> {
    let norm = abs_path.replace('\\', "/");
    let (dir, file) = norm
        .rsplit_once('/')
        .ok_or_else(|| (tauri::http::StatusCode::FORBIDDEN, "forbidden".to_string()))?;
    let root = if dir.is_empty() || dir.ends_with(':') {
        format!("{dir}/")
    } else {
        dir.to_string()
    };
    Ok((source::descriptor::SourceDescriptor::Local { root_path: root }, file.to_string()))
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

/// 2026-08-28 任务 2：media handler 对 403/404/502 拒绝留 WARN 日志（status + 请求
/// path + 原因）——SMB 空段 403 白屏那类缺陷此前完全无痕。其余状态（416/422/423/
/// 413/501）属预期控制流或专项语义，不记录防刷屏。reason 只进本地 main.log，
/// 响应体仍是固定短语（3.5.0 任务 14「零细节」契约不破坏）。
fn warn_reject(status: tauri::http::StatusCode, path: &str, reason: &str) {
    if let Some(line) = reject_log_line(status, path, reason) {
        log::write_log("WARN", "media", &line);
    }
}

/// 纯函数：生成 reject 日志行（仅 403/404/502），供 warn_reject 与单测共用。
fn reject_log_line(
    status: tauri::http::StatusCode,
    path: &str,
    reason: &str,
) -> Option<String> {
    use tauri::http::StatusCode;
    if matches!(
        status,
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::BAD_GATEWAY
    ) {
        Some(format!("reject {} {} reason={}", status.as_u16(), path, reason))
    } else {
        None
    }
}

fn finish(
    b: tauri::http::response::Builder,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    b.body(body).unwrap()
}

fn error_to_status(
    e: crate::source::trait_def::MediaSourceError,
    path: &str,
) -> tauri::http::Response<Vec<u8>> {
    use crate::source::archive::backend::ArchiveAccessError;
    use crate::source::trait_def::MediaSourceError;
    use tauri::http::StatusCode;
    // 单一映射表：先出 (status, phrase)，统一走 warn_reject 留日志 + err_response 固定短语
    let (status, phrase) = match &e {
        MediaSourceError::NotFound(_) => (StatusCode::NOT_FOUND, "not found"),
        MediaSourceError::PermissionDenied(_) | MediaSourceError::PathEscape(_) => {
            (StatusCode::FORBIDDEN, "forbidden")
        }
        MediaSourceError::Network(_) | MediaSourceError::Timeout(_) => {
            (StatusCode::BAD_GATEWAY, "bad gateway")
        }
        MediaSourceError::NotImplemented(_) => {
            (StatusCode::NOT_IMPLEMENTED, "not implemented")
        }
        // Archive 专项映射（任务 14）：响应体是固定短语，不含第三方错误文本与密码信息。
        // 注意：容器本身不可读（如权限拒绝）在 service 层归 Io（ArchiveAccessError 无
        // PermissionDenied 变体，任务 7 收口），落入末尾 Archive(_) => 422。
        MediaSourceError::Archive(ArchiveAccessError::PasswordRequired)
        | MediaSourceError::Archive(ArchiveAccessError::WrongPassword) => {
            (StatusCode::LOCKED, "archive locked")
        }
        MediaSourceError::Archive(ArchiveAccessError::EntryNotFound(_)) => {
            (StatusCode::NOT_FOUND, "not found")
        }
        MediaSourceError::Archive(ArchiveAccessError::ResourceLimitExceeded(_)) => {
            (StatusCode::PAYLOAD_TOO_LARGE, "archive resource limit")
        }
        MediaSourceError::Archive(ArchiveAccessError::Network(_)) => {
            (StatusCode::BAD_GATEWAY, "bad gateway")
        }
        MediaSourceError::Archive(_) => {
            (StatusCode::UNPROCESSABLE_ENTITY, "archive error")
        }
        _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal error"),
    };
    warn_reject(status, path, &e.to_string());
    err_response(status, phrase)
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

    #[test]
    fn local_media_file_at_filesystem_root_keeps_absolute_root() {
        let (descriptor, file) = local_descriptor_for_abs_path("D:/x.jpg").unwrap();
        assert!(matches!(descriptor, source::descriptor::SourceDescriptor::Local { root_path } if root_path == "D:/"));
        assert_eq!(file, "x.jpg");

        let (descriptor, file) = local_descriptor_for_abs_path("/x.jpg").unwrap();
        assert!(matches!(descriptor, source::descriptor::SourceDescriptor::Local { root_path } if root_path == "/"));
        assert_eq!(file, "x.jpg");
    }

    // =========================================================================
    // media:// Archive 错误映射（任务 14）：状态码正确 + 响应体固定短语无细节泄漏
    // =========================================================================

    #[test]
    fn archive_password_error_maps_to_locked_response_without_detail() {
        let response = error_to_status(
            crate::source::trait_def::MediaSourceError::Archive(
                crate::source::archive::backend::ArchiveAccessError::PasswordRequired,
            ),
            "media-test/archive/locked",
        );
        assert_eq!(response.status(), tauri::http::StatusCode::LOCKED);
        assert_eq!(response.body().as_slice(), b"archive locked");

        let response = error_to_status(
            crate::source::trait_def::MediaSourceError::Archive(
                crate::source::archive::backend::ArchiveAccessError::WrongPassword,
            ),
            "media-test/archive/locked",
        );
        assert_eq!(response.status(), tauri::http::StatusCode::LOCKED);
        assert_eq!(response.body().as_slice(), b"archive locked");
    }

    #[test]
    fn archive_resource_limit_maps_to_payload_too_large() {
        let response = error_to_status(
            crate::source::trait_def::MediaSourceError::Archive(
                crate::source::archive::backend::ArchiveAccessError::ResourceLimitExceeded(
                    "entry > 512 MiB".into(),
                ),
            ),
            "media-test/archive/limit",
        );
        assert_eq!(response.status(), tauri::http::StatusCode::PAYLOAD_TOO_LARGE);
        // 携带细节的源错误只决定状态码，不进响应体
        assert!(!response.body().as_slice().windows(11).any(|w| w == b"512 MiB"));
        assert_eq!(response.body().as_slice(), b"archive resource limit");
    }

    #[test]
    fn archive_entry_not_found_and_network_map_to_404_and_502() {
        let response = error_to_status(
            crate::source::trait_def::MediaSourceError::Archive(
                crate::source::archive::backend::ArchiveAccessError::EntryNotFound("page.png".into()),
            ),
            "media-test/archive/404",
        );
        assert_eq!(response.status(), tauri::http::StatusCode::NOT_FOUND);
        assert_eq!(response.body().as_slice(), b"not found");

        let response = error_to_status(
            crate::source::trait_def::MediaSourceError::Archive(
                crate::source::archive::backend::ArchiveAccessError::Network("tcp reset".into()),
            ),
            "media-test/archive/502",
        );
        assert_eq!(response.status(), tauri::http::StatusCode::BAD_GATEWAY);
        assert_eq!(response.body().as_slice(), b"bad gateway");
    }

    #[test]
    fn archive_remaining_kinds_map_to_unprocessable_entity() {
        // 容器不可读在 service 层归 Io（任务 7 收口：无 PermissionDenied 变体）→ 422
        for err in [
            crate::source::archive::backend::ArchiveAccessError::Io("permission denied (demo)".into()),
            crate::source::archive::backend::ArchiveAccessError::CorruptArchive(
                "bad start header 0x00000000".into(),
            ),
            crate::source::archive::backend::ArchiveAccessError::MultiVolumeUnsupported(
                "part1 of 3".into(),
            ),
            crate::source::archive::backend::ArchiveAccessError::UnsupportedCodec("BCJ2".into()),
        ] {
            let response = error_to_status(
                crate::source::trait_def::MediaSourceError::Archive(err),
                "media-test/archive/422",
            );
            assert_eq!(response.status(), tauri::http::StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(response.body().as_slice(), b"archive error");
        }
    }

    // =========================================================================
    // 任务 2（2026-08-28）：media handler 403/404/502 拒绝日志调用点
    // =========================================================================

    #[test]
    fn reject_log_line_covers_403_404_502_with_status_path_reason() {
        use tauri::http::StatusCode;
        // 三个目标状态各出一行：status + 请求 path + reason
        assert_eq!(
            reject_log_line(StatusCode::FORBIDDEN, "/smb/2/x%2Fy.jpg", "InvalidPath(\"rel 为空\")")
                .as_deref(),
            Some("reject 403 /smb/2/x%2Fy.jpg reason=InvalidPath(\"rel 为空\")")
        );
        assert_eq!(
            reject_log_line(StatusCode::NOT_FOUND, "/local/missing.jpg", "not found").as_deref(),
            Some("reject 404 /local/missing.jpg reason=not found")
        );
        assert_eq!(
            reject_log_line(StatusCode::BAD_GATEWAY, "/webdav/7/a.jpg", "tcp reset").as_deref(),
            Some("reject 502 /webdav/7/a.jpg reason=tcp reset")
        );
        // 其余状态（416/422/423/413/501）不记录，防刷屏
        for s in [
            StatusCode::RANGE_NOT_SATISFIABLE,
            StatusCode::UNPROCESSABLE_ENTITY,
            StatusCode::LOCKED,
            StatusCode::PAYLOAD_TOO_LARGE,
            StatusCode::NOT_IMPLEMENTED,
        ] {
            assert_eq!(reject_log_line(s, "/x", "r"), None, "{s:?} 不应产生日志行");
        }
    }

    #[test]
    fn error_to_status_logs_reason_via_display_not_response_body() {
        // 404 路径：日志 reason 走 Display（含源细节），响应体仍是固定短语
        // （断言映射不回归即可；日志行内容已由 reject_log_line 用例锁定）
        let response = error_to_status(
            crate::source::trait_def::MediaSourceError::NotFound("smb entry gone".into()),
            "media-test/smb/2/share%2Fmissing.jpg",
        );
        assert_eq!(response.status(), tauri::http::StatusCode::NOT_FOUND);
        assert_eq!(response.body().as_slice(), b"not found");
        assert!(!String::from_utf8_lossy(response.body().as_slice()).contains("smb entry gone"));
    }
}
