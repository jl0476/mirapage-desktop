//! 文件浏览器相关 Tauri commands
//!
//! 所有 IO 通过 `MediaSourceFactory` 分派，UI 不感知 Local/Archive/SMB/WebDAV 差异。

use crate::source::descriptor::{MediaEntry, SourceDescriptor};
use crate::source::factory::MediaSourceFactory;
use crate::source::trait_def::ByteRange;
use tauri::State;

/// 列出目录内容
#[tauri::command]
pub async fn list_directory(
    factory: State<'_, MediaSourceFactory>,
    descriptor: SourceDescriptor,
    path: String,
) -> Result<Vec<MediaEntry>, String> {
    let source = factory.resolve(&descriptor);
    source.list_directory(&descriptor, &path).await.map_err(|e| e.to_string())
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
    let source = factory.resolve(&descriptor);
    let range = match (offset, length) {
        (Some(o), Some(l)) => Some(ByteRange::new(o, l)),
        _ => None,
    };
    source
        .read_file(&descriptor, &path, range)
        .await
        .map_err(|e| e.to_string())
}