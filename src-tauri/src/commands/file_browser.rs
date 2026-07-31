//! 文件浏览器相关 Tauri commands
//!
//! 所有 IO 通过 `MediaSourceFactory` 分派，UI 不感知 Local/Archive/SMB/WebDAV 差异。

use crate::log;
use crate::source::descriptor::{MediaEntry, SourceDescriptor};
use crate::source::factory::MediaSourceFactory;
use crate::source::trait_def::ByteRange;
use tauri::State;
use tracing::{debug, info};

/// 列出目录内容
#[tauri::command]
pub async fn list_directory(
    factory: State<'_, MediaSourceFactory>,
    descriptor: SourceDescriptor,
    path: String,
) -> Result<Vec<MediaEntry>, String> {
    log::write_log("DEBUG", "file_browser", &format!("list_directory type={} path={}", descriptor.type_str(), path));
    debug!(target: "file_browser", "list_directory type={:?} path={:?}", descriptor.type_str(), path);
    let source = factory.resolve(&descriptor);
    let result = source.list_directory(&descriptor, &path).await;
    match &result {
        Ok(entries) => {
            log::write_log("INFO", "file_browser", &format!("list_directory ok: {} entries", entries.len()));
            info!(target: "file_browser", "list_directory ok: {} entries", entries.len());
        }
        Err(e) => {
            log::write_log("WARN", "file_browser", &format!("list_directory failed: {:?}", e));
            tracing::warn!(target: "file_browser", "list_directory failed: {:?}", e);
        }
    }
    result.map_err(|e| e.to_string())
}

/// 读文件内容（含可选 Range）
#[tauri::command]
pub async fn read_file(
    factory: State<'_, MediaSourceFactory>,
    descriptor: SourceDescriptor,
    path: String,
    offset: Option<u64>,
    length: Option<u64>,
) -> Result<Vec<u8>, String> {
    log::write_log("DEBUG", "file_browser", &format!("read_file type={} path={}", descriptor.type_str(), path));
    debug!(target: "file_browser", "read_file type={:?} path={:?} range={:?}-{:?}", descriptor.type_str(), path, offset, length);
    let source = factory.resolve(&descriptor);
    let range = match (offset, length) {
        (Some(o), Some(l)) => Some(ByteRange::new(o, l)),
        _ => None,
    };
    let result = source.read_file(&descriptor, &path, range).await;
    match &result {
        Ok(bytes) => {
            log::write_log("INFO", "file_browser", &format!("read_file ok: {} bytes", bytes.len()));
            info!(target: "file_browser", "read_file ok: {} bytes", bytes.len());
        }
        Err(e) => {
            log::write_log("WARN", "file_browser", &format!("read_file failed: {:?}", e));
            tracing::warn!(target: "file_browser", "read_file failed: {:?}", e);
        }
    }
    result.map_err(|e| e.to_string())
}