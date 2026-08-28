//! `commands::thumbnails` —— 缩略图缓存 IPC（薄封装，§13.2 §13.4）。
//!
//! 所有命令走 `State<'_, ThumbnailService>`；图片字节不进前端，只传状态/路径/元数据。

use std::time::Instant;

use tauri::State;

use crate::log;
use crate::source::descriptor::SourceDescriptor;
use crate::thumbnail::policy::normalize_worker_limit;
use crate::thumbnail::service::{RequestResult, ThumbnailService};
use crate::thumbnail::{Quality, ThumbnailRequestItem};

/// 批量请求缩略图状态。
#[tauri::command]
pub async fn request_thumbnails(
    service: State<'_, ThumbnailService>,
    descriptor: SourceDescriptor,
    items: Vec<ThumbnailRequestItem>,
    epoch: u64,
    visible_cache_keys: Vec<String>,
) -> Result<Vec<RequestResult>, String> {
    let t0 = Instant::now();
    let item_count = items.len();
    let vis_count = visible_cache_keys.len();
    log::write_log(
        "INFO",
        "thumbnail",
        &format!(
            "request_thumbnails enter type={} epoch={} items={} visibleKeys={}",
            descriptor.type_str(),
            epoch,
            item_count,
            vis_count,
        ),
    );
    // 2026-08-28 bug⑤ 修复：service.request 是同步批量 classify（持 Db Mutex 跑
    // 数十条 SQL + 文件 stat），大目录一次几百条会吃住 async worker 数百毫秒到数秒；
    // 与 clear/多窗口并发时把 worker 耗尽，IO driver 无线程推进 → await 命令睡死
    // （list_directory 回包悬挂，dump 实证）。搬 spawn_blocking：Sqlite 同步 IO
    // 本就属 blocking 语义，worker 归还 runtime。
    let svc = service.inner().clone();
    let results = tokio::task::spawn_blocking(move || {
        svc.request(&descriptor, &items, epoch, &visible_cache_keys)
    })
    .await
    .map_err(|e| e.to_string())?;
    // 分类统计 + duration
    let mut stats = std::collections::HashMap::<&str, usize>::new();
    for r in &results {
        *stats.entry(r.status.as_str()).or_insert(0) += 1;
    }
    let duration_ms = t0.elapsed().as_millis();
    log::write_log(
        "INFO",
        "thumbnail",
        &format!(
            "request_thumbnails done items={} results={} stats={:?} durationMs={}",
            item_count,
            results.len(),
            stats,
            duration_ms
        ),
    );
    Ok(results)
}

/// 单张失败重试（visible 优先级，不删缓存索引）。
#[tauri::command]
pub async fn retry_thumbnail(
    service: State<'_, ThumbnailService>,
    descriptor: SourceDescriptor,
    item: ThumbnailRequestItem,
    epoch: u64,
) -> Result<RequestResult, String> {
    log::write_log(
        "INFO",
        "thumbnail",
        &format!("retry_thumbnail path={} epoch={}", item.path, epoch),
    );
    Ok(service.retry(&descriptor, &item, epoch))
}

/// 强制重建（删旧缓存文件 + 索引后重新生成）。
#[tauri::command]
pub async fn regenerate_thumbnail(
    service: State<'_, ThumbnailService>,
    descriptor: SourceDescriptor,
    item: ThumbnailRequestItem,
    epoch: u64,
) -> Result<RequestResult, String> {
    log::write_log(
        "INFO",
        "thumbnail",
        &format!("regenerate_thumbnail path={} epoch={}", item.path, epoch),
    );
    Ok(service.regenerate(&descriptor, &item, epoch))
}

/// 运行时配置（worker / 内存 / 清晰度），设置页改完即时推送。
/// `worker_limit` 在 IPC 边界钳到合法范围 [1, 16]（policy::WORKER_LIMIT_MAX），
/// 防御前端脏值/越界输入。
#[tauri::command]
pub async fn update_thumbnail_runtime_config(
    service: State<'_, ThumbnailService>,
    worker_limit: u32,
    memory_budget_mb: u32,
    quality: Quality,
) -> Result<(), String> {
    let worker_limit = normalize_worker_limit(worker_limit);
    service.set_runtime_config(worker_limit, memory_budget_mb, quality);
    Ok(())
}

/// P1-4: 缓存容量运行时生效（设置页改完即时推送，无需重启）。
#[tauri::command]
pub async fn update_thumbnail_cache_limit(
    service: State<'_, ThumbnailService>,
    limit_mb: u64,
) -> Result<(), String> {
    service.set_cache_limit_mb(limit_mb);
    Ok(())
}

/// 缓存统计：{ bytes, count }。
#[tauri::command]
pub async fn get_thumbnail_cache_info(
    service: State<'_, ThumbnailService>,
) -> Result<serde_json::Value, String> {
    let (bytes, count) = service.cache_info();
    Ok(serde_json::json!({ "bytes": bytes, "count": count }))
}

/// 清空缓存（删文件 + 索引，保留根目录）。
/// 2026-08-28 bug⑤ 修复：service.clear() 含同步 Db 锁 + 数百文件删除，
/// 在 async worker 线程直接执行会吃住 worker，叠加缩略图风暴时把 IO driver
/// 的推进线程耗尽——list_directory 等 await 命令的回包永不就绪（mio poll 睡死，
/// dump 符号化实证）。整体搬 spawn_blocking（教科书 blocking 场景）。
#[tauri::command]
pub async fn clear_thumbnail_cache(service: State<'_, ThumbnailService>) -> Result<(), String> {
    // Clone 拿 'static（共享同一底层状态），spawn_blocking 内执行同步 clear。
    let svc = service.inner().clone();
    tokio::task::spawn_blocking(move || svc.clear())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 通知新 epoch（切目录 / 切源）。
#[tauri::command]
pub async fn notify_thumbnail_epoch(
    service: State<'_, ThumbnailService>,
    epoch: u64,
) -> Result<(), String> {
    log::write_log("INFO", "thumbnail", &format!("notify_thumbnail_epoch epoch={}", epoch));
    service.new_epoch(epoch);
    Ok(())
}

/// 通知快速滚动状态。
#[tauri::command]
pub async fn notify_thumbnail_fast_scrolling(
    service: State<'_, ThumbnailService>,
    fast: bool,
) -> Result<(), String> {
    log::write_log(
        "DEBUG",
        "thumbnail",
        &format!("notify_thumbnail_fast_scrolling fast={}", fast),
    );
    service.set_fast_scrolling(fast);
    Ok(())
}

// ─── 缓存位置迁移（§11）──────────────────────────────────────────────

/// 校验目标目录是否可作为新缓存根。
#[tauri::command]
pub async fn validate_thumbnail_cache_location(
    service: State<'_, ThumbnailService>,
    target: String,
) -> Result<(), String> {
    service.validate_cache_location(std::path::Path::new(&target))
}

/// 启动迁移（mode: "move" | "copy"）。进度通过 thumbnail://migration-progress 事件。
#[tauri::command]
pub async fn migrate_thumbnail_cache(
    service: State<'_, ThumbnailService>,
    target: String,
    mode: String,
) -> Result<(), String> {
    let mode = match mode.as_str() {
        "copy" => crate::thumbnail::migration::MigrationMode::Copy,
        _ => crate::thumbnail::migration::MigrationMode::Move,
    };
    service.start_migration(std::path::PathBuf::from(target), mode);
    Ok(())
}

/// 取消当前迁移（根保持旧位置）。
#[tauri::command]
pub async fn cancel_thumbnail_cache_migration(service: State<'_, ThumbnailService>) -> Result<(), String> {
    service.cancel_migration();
    Ok(())
}

/// 继续未完成的迁移（启动恢复后用户选继续）。
#[tauri::command]
pub async fn resume_thumbnail_cache_migration(
    service: State<'_, ThumbnailService>,
    target: String,
    mode: String,
) -> Result<(), String> {
    let mode = match mode.as_str() {
        "copy" => crate::thumbnail::migration::MigrationMode::Copy,
        _ => crate::thumbnail::migration::MigrationMode::Move,
    };
    service.start_migration(std::path::PathBuf::from(target), mode);
    Ok(())
}

/// 回滚：删 target 副本 + manifest，根保持旧位置。
#[tauri::command]
pub async fn rollback_thumbnail_cache_migration(
    service: State<'_, ThumbnailService>,
    target: String,
) -> Result<(), String> {
    service.rollback_migration(std::path::PathBuf::from(target))
}

/// 当前迁移状态（启动恢复检测 + 进度）。
#[tauri::command]
pub async fn get_thumbnail_migration_state(
    service: State<'_, ThumbnailService>,
) -> Result<Option<crate::thumbnail::migration::MigrationManifest>, String> {
    Ok(service.migration_state())
}
