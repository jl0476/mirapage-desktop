//! `commands::thumbnails` —— 缩略图缓存 IPC（薄封装，§13.2 §13.4）。
//!
//! 所有命令走 `State<'_, ThumbnailService>`；图片字节不进前端，只传状态/路径/元数据。

use tauri::State;

use crate::source::descriptor::SourceDescriptor;
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
    Ok(service.request(&descriptor, &items, epoch, &visible_cache_keys))
}

/// 单张失败重试（visible 优先级，不删缓存索引）。
#[tauri::command]
pub async fn retry_thumbnail(
    service: State<'_, ThumbnailService>,
    descriptor: SourceDescriptor,
    item: ThumbnailRequestItem,
    epoch: u64,
) -> Result<RequestResult, String> {
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
    Ok(service.regenerate(&descriptor, &item, epoch))
}

/// 运行时配置（worker / 内存 / 清晰度），设置页改完即时推送。
#[tauri::command]
pub async fn update_thumbnail_runtime_config(
    service: State<'_, ThumbnailService>,
    worker_limit: u32,
    memory_budget_mb: u32,
    quality: Quality,
) -> Result<(), String> {
    service.set_runtime_config(worker_limit, memory_budget_mb, quality);
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
#[tauri::command]
pub async fn clear_thumbnail_cache(service: State<'_, ThumbnailService>) -> Result<(), String> {
    service.clear();
    Ok(())
}

/// 通知新 epoch（切目录 / 切源）。
#[tauri::command]
pub async fn notify_thumbnail_epoch(
    service: State<'_, ThumbnailService>,
    epoch: u64,
) -> Result<(), String> {
    service.new_epoch(epoch);
    Ok(())
}

/// 通知快速滚动状态。
#[tauri::command]
pub async fn notify_thumbnail_fast_scrolling(
    service: State<'_, ThumbnailService>,
    fast: bool,
) -> Result<(), String> {
    service.set_fast_scrolling(fast);
    Ok(())
}
