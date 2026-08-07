//! `commands::image_dimensions` —— 读图片 header 返回尺寸（瀑布流布局骨架数据）
//!
//! 仅 masonry viewMode 触发（前端控制）。复用 MediaSource.read_file 的 ByteRange
//! 分块读，只读前 HEADER_READ_LEN 字节，不解码像素。

use crate::algorithm::image_header::image_dimensions;
use crate::source::descriptor::SourceDescriptor;
use crate::source::factory::MediaSourceFactory;
use crate::source::trait_def::ByteRange;
use std::sync::Arc;
use tauri::State;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

/// 读 header 的字节数。JPEG SOF0 可能藏在 APPn 后，256 字节够大部分情况。
const HEADER_READ_LEN: u64 = 256;

/// 并发上限。Local SSD 下再高也没意义；远程挂载下避免打满 SMB 连接。
const MAX_CONCURRENT: usize = 16;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageDim {
    pub path: String,
    pub width: u32,
    pub height: u32,
}

/// 批量读图片尺寸。paths 是子集（预读窗口内），非全量。
#[tauri::command]
pub async fn list_image_dimensions(
    factory: State<'_, MediaSourceFactory>,
    descriptor: SourceDescriptor,
    paths: Vec<String>,
) -> Result<Vec<ImageDim>, String> {
    let source = factory.resolve(&descriptor);
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut tasks: JoinSet<Option<ImageDim>> = JoinSet::new();

    for path in paths {
        let source = source.clone();
        let descriptor = descriptor.clone();
        let permit = semaphore.clone();
        tasks.spawn(async move {
            // 拿不到 permit 不读（Semaphore drop 时所有 permit 释放）
            let _permit = permit.acquire_owned().await.ok()?;
            let bytes = source
                .read_file(&descriptor, &path, Some(ByteRange::new(0, HEADER_READ_LEN)))
                .await
                .ok()?;
            let dim = image_dimensions(&bytes)?;
            Some(ImageDim {
                path,
                width: dim.width,
                height: dim.height,
            })
        });
    }

    let mut out = Vec::new();
    while let Some(res) = tasks.join_next().await {
        if let Ok(Some(dim)) = res {
            out.push(dim);
        }
    }
    Ok(out)
}