//! 缩略图生成管线（§7 §6.4）。
//!
//! 固定顺序：读取原始字节 -> EXIF Orientation -> 解码第一帧 -> 像素变换（方向归一化）
//! -> 按目标宽度 + 像素预算缩放 -> RGBA/RGB 送入 webp::Encoder -> 写 `.tmp` -> flush ->
//! rename。**禁止**将 `DynamicImage` 或原始像素跨 IPC 返回；成功结果只返回宽高和字节数，
//! 缩略图字节落在磁盘缓存文件里，由前端 `convertFileSrc()` 经 asset protocol 加载。

use std::io::Write;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat};

use super::orientation::{apply_orientation, read_orientation};
use super::ThumbnailError;

/// 一次缩略图生成请求。
pub struct GenerateRequest<'a> {
    /// 原图字节（由 service 从 Local 文件读取后传入；generator 不直接做文件 IO 读源）。
    pub source_bytes: &'a [u8],
    /// 目标输出宽度（尺寸档位，如 512/768/1024/...）。
    pub target_width: u32,
    /// 输出像素预算（普通 3MP / 极端长图 4MP）。
    pub pixel_budget: u32,
    /// 清晰度底线宽度 = card_css_width × dpr，缩放不得低于此值（§6.4）。
    pub clarity_floor_width: u32,
    /// WebP 编码质量（0.0–100.0，对应 standard 78 / high 82 / ultra 88）。
    pub webp_quality: f32,
    /// 最终缓存文件路径；先写 `<path>.tmp` 再 rename。
    pub cache_path: &'a Path,
}

/// 生成结果元数据（不含图片字节）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedThumbnail {
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
}

/// 生成缩略图并原子写入 `cache_path`。
pub fn generate_thumbnail(req: GenerateRequest) -> Result<GeneratedThumbnail, ThumbnailError> {
    // 1. EXIF Orientation（缺失 / 不可解析视为 1）。
    let orientation = read_orientation(req.source_bytes);

    // 2. 解码第一帧（GIF / 动态 WebP 只取首帧）。
    let img = image::load_from_memory(req.source_bytes)
        .map_err(|e| ThumbnailError::Decode(e.to_string()))?;

    // 3. 方向归一化（烘焙进像素，输出不再带 Orientation）。
    let img = apply_orientation(img, orientation);
    let display_w = img.width();
    let display_h = img.height();

    // 4. 计算输出尺寸（目标宽度 + 像素预算 + 清晰度底线）。
    let (out_w, out_h) = compute_output_size(
        display_w,
        display_h,
        req.target_width,
        req.pixel_budget,
        req.clarity_floor_width,
    );

    // 5. 缩放（不放大：输出宽度等于源宽时跳过）。
    //    area resampling（thumbnail）：大幅缩小比 Triangle 快 1.5-1.7x 且质量更好
    //    （专为缩小设计，见 docs/superpowers/reports/2026-08-09-thumbnail-generation-bench.md）。
    //    thumbnail 返回 RgbaImage；按原图是否有 alpha 转回对应 DynamicImage，
    //    保持 encode_webp 的 RGB/RGBA 选择行为不变（RGB 图仍出 RGB WebP）。
    let resized = if out_w >= display_w {
        img
    } else {
        let thumb = image::imageops::thumbnail(&img, out_w, out_h);
        let dyn_thumb = DynamicImage::ImageRgba8(thumb);
        if img.color().has_alpha() {
            dyn_thumb
        } else {
            DynamicImage::ImageRgb8(dyn_thumb.to_rgb8())
        }
    };

    // 6. WebP 编码（按是否有 alpha 选 RGB / RGBA，保留 PNG 透明通道）。
    let webp_bytes = encode_webp(&resized, req.webp_quality)?;

    // 7. 原子写入：.tmp -> flush(+best-effort fsync) -> rename。
    write_atomic(req.cache_path, &webp_bytes)?;

    Ok(GeneratedThumbnail {
        width: out_w,
        height: out_h,
        byte_size: webp_bytes.len() as u64,
    })
}

/// 计算缩略图输出尺寸（§6.4）。
///
/// - 不放大：输出宽度不超过源宽。
/// - 按目标宽度缩放后若总像素超过预算，等比缩小至预算内。
/// - 清晰度底线优先于预算：缩小不得低于 `clarity_floor_width`。
pub fn compute_output_size(
    display_w: u32,
    display_h: u32,
    target_width: u32,
    pixel_budget: u32,
    clarity_floor_width: u32,
) -> (u32, u32) {
    if display_w == 0 || display_h == 0 {
        return (display_w, display_h);
    }
    let aspect = display_h as f64 / display_w as f64; // 每单位宽对应的高
    // 不放大：目标宽度不超过源宽。
    let desired = target_width.min(display_w);
    let mut out_w = desired;
    let out_pixels = (out_w as f64) * (out_w as f64) * aspect;
    if out_pixels > pixel_budget as f64 {
        // 等比缩小到预算内：out_w² × aspect = budget -> out_w = sqrt(budget / aspect)。
        let budget_w = (pixel_budget as f64 / aspect).sqrt().floor();
        out_w = budget_w as u32;
    }
    // 清晰度底线优先于预算（§6.4）。
    if out_w < clarity_floor_width {
        out_w = clarity_floor_width;
    }
    // 仍不超过 desired（不放大）。
    if out_w > desired {
        out_w = desired;
    }
    if out_w == 0 {
        out_w = 1;
    }
    let out_h = ((out_w as f64) * aspect).round().max(1.0) as u32;
    (out_w, out_h)
}

/// 按 alpha 通道选择 RGB / RGBA 编码 WebP。
fn encode_webp(img: &DynamicImage, quality: f32) -> Result<Vec<u8>, ThumbnailError> {
    // Encoder 借用像素缓冲，必须在同一作用域内完成 encode，再丢掉借用。
    let webp_data = if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
        encoder.encode(quality)
    } else {
        let rgb = img.to_rgb8();
        let encoder = webp::Encoder::from_rgb(&rgb, rgb.width(), rgb.height());
        encoder.encode(quality)
    };
    Ok(webp_data.to_vec())
}

/// 原子写入：写到 `<path>.tmp`，flush + fsync，再 rename 到 `path`。
/// 失败时不留下正式文件（rename 是最后一步）。
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ThumbnailError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp_path: PathBuf = format!("{}.tmp", path.display()).into();
    {
        let mut f = std::fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.flush()?;
        // best-effort fsync；缓存文件可接受忽略错误。
        let _ = f.sync_all();
    }
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

/// 按图片字节猜测格式（用于测试断言可解码格式集合）。
#[allow(dead_code)]
pub fn guess_format(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_output_size_no_upscale_beyond_source() {
        // 源 800x600，目标 1024：不放大，输出 800x600。
        let (w, h) = compute_output_size(800, 600, 1024, 3_000_000, 0);
        assert_eq!(w, 800);
        assert_eq!(h, 600);
    }

    #[test]
    fn compute_output_size_downscale_to_target() {
        // 源 4000x3000，目标 1024：下采样到 1024x768，像素 786k < 3MP。
        let (w, h) = compute_output_size(4000, 3000, 1024, 3_000_000, 0);
        assert_eq!(w, 1024);
        assert_eq!(h, 768);
        assert!((w as u64) * (h as u64) <= 3_000_000);
    }

    #[test]
    fn compute_output_size_pixel_budget_binds_huge_normal_image() {
        // 4000x3000 目标 2048：2048x1536=3.14MP > 3MP -> 缩到 2000x1500=3MP。
        let (w, h) = compute_output_size(4000, 3000, 2048, 3_000_000, 0);
        assert_eq!(w, 2000);
        assert_eq!(h, 1500);
        assert!((w as u64) * (h as u64) <= 3_000_000);
    }

    #[test]
    fn compute_output_size_long_image_uses_4mp_budget() {
        // 600x9000（宽高比 15，极端长图）目标 600，预算 4MP：
        // 600x9000=5.4MP > 4MP -> 缩到 sqrt(4M/15)=516 -> 516x7740≈4M。
        let (w, h) = compute_output_size(600, 9000, 600, 4_000_000, 0);
        assert!((w as u64) * (h as u64) <= 4_000_000);
        assert!(w >= 500, "long image width should stay near floor/budget, got {w}");
    }

    #[test]
    fn compute_output_size_clarity_floor_overrides_budget() {
        // 4000x3000 目标 2048，预算 3MP，但 clarity_floor=2048：
        // 预算要求 2000，但底线 2048 优先 -> 输出 2048（接受超预算，保证清晰度）。
        let (w, h) = compute_output_size(4000, 3000, 2048, 3_000_000, 2048);
        assert_eq!(w, 2048);
        assert_eq!(h, 1536);
    }

    #[test]
    fn compute_output_size_zero_dim_no_panic() {
        let (w, h) = compute_output_size(0, 0, 1024, 3_000_000, 0);
        assert_eq!((w, h), (0, 0));
    }
}
