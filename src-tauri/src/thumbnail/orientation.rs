//! EXIF Orientation 解析与像素归一化（§7.2）。
//!
//! 第一阶段只解析 JPEG / TIFF 容器中的 Orientation（kamadak-exif 的
//! `read_from_container`）；PNG eXIf 等暂返回 1（正常方向）。Orientation 1–8
//! 的像素变换严格按设计文档 §7.2 表实现，方向语义由 `tests/thumbnail_generator.rs`
//! 的四角颜色测试校正。

use image::DynamicImage;

/// 从图片字节解析 EXIF Orientation（1–8）。无法解析或缺失时返回 1。
pub fn read_orientation(bytes: &[u8]) -> u8 {
    let mut cursor = std::io::Cursor::new(bytes);
    let reader = exif::Reader::new();
    match reader.read_from_container(&mut cursor) {
        Ok(exif_data) => {
            if let Some(field) = exif_data.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
                if let Some(v) = field.value.get_uint(0) {
                    return v as u8;
                }
            }
            1
        }
        Err(_) => 1,
    }
}

/// 按 EXIF Orientation 1–8 对像素做旋转 / 镜像归一化（§7.2）。
///
/// 输入为方向归一化前的像素，输出为「显示方向」像素。WebP 输出不再携带 Orientation，
/// 因此必须在此把方向烘焙进像素，避免 WebView 二次旋转导致方向 / 比例不一致。
///
/// 变换组合（5/7）已由四角颜色测试校正，对应 EXIF 的 transpose / transverse。
pub fn apply_orientation(img: DynamicImage, orientation: u8) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// 给定方向归一化前的物理宽高与 Orientation，返回显示方向的宽高。
/// Orientation 5–8 会交换宽高。
pub fn displayed_dimensions(phys_width: u32, phys_height: u32, orientation: u8) -> (u32, u32) {
    match orientation {
        5 | 6 | 7 | 8 => (phys_height, phys_width),
        _ => (phys_width, phys_height),
    }
}
