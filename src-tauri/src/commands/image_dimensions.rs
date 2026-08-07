//! `commands::image_dimensions` —— 读图片 header 返回尺寸（瀑布流布局骨架数据）
//!
//! 仅 masonry viewMode 触发（前端控制）。复用 MediaSource.read_file 的 ByteRange
//! 分块读，只读前 HEADER_READ_LEN 字节，不解码像素。

use crate::algorithm::image_header::image_dimensions;
use crate::source::descriptor::SourceDescriptor;
use crate::source::factory::MediaSourceFactory;
use crate::source::trait_def::ByteRange;
use tauri::State;

/// 读 header 的字节数。JPEG SOF0 可能藏在 APPn 后，256 字节够大部分情况。
const HEADER_READ_LEN: u64 = 256;

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
    let mut out = Vec::with_capacity(paths.len());
    for path in &paths {
        let bytes = match source
            .read_file(&descriptor, path, Some(ByteRange::new(0, HEADER_READ_LEN)))
            .await
        {
            Ok(b) => b,
            Err(_) => continue, // 单张失败跳过（小图 EOF / 权限等），不阻塞整批
        };
        if let Some(dim) = image_dimensions(&bytes) {
            out.push(ImageDim {
                path: path.clone(),
                width: dim.width,
                height: dim.height,
            });
        }
    }
    Ok(out)
}