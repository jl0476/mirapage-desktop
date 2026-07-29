//! MIME 与扩展名工具
//!
//! 参考 MiraPage Android `MimeUtils.kt:7`，用 Rust 重写。

/// 支持的图片扩展名（小写）
const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif",
];

/// 支持的压缩包扩展名（小写）
const ARCHIVE_EXTS: &[&str] = &[
    "cbz", "cbr", "zip", "rar", "7z",
];

/// 提取文件扩展名（不含前导 `.`，小写）。无扩展名返回 None。
pub fn extension_of(name: &str) -> Option<String> {
    // 取最后 `.` 之后；若没有则取最后 `/` 之后
    let last_dot = name.rfind('.');
    let last_slash = name.rfind('/').or_else(|| name.rfind('\\'));

    match (last_dot, last_slash) {
        (Some(d), Some(s)) if d > s => Some(name[d + 1..].to_lowercase()),
        (Some(d), None) => Some(name[d + 1..].to_lowercase()),
        _ => None,
    }
}

/// 判断是否为图片文件
pub fn is_image(name: &str) -> bool {
    extension_of(name)
        .map(|ext| IMAGE_EXTS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// 判断是否为压缩包文件
pub fn is_archive(name: &str) -> bool {
    extension_of(name)
        .map(|ext| ARCHIVE_EXTS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// 从文件名推断 MIME（如 `image/jpeg`）；非图片返回 None
pub fn mime_from_name(name: &str) -> Option<&'static str> {
    let ext = extension_of(name)?;
    match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "heic" => Some("image/heic"),
        "heif" => Some("image/heif"),
        _ => None,
    }
}

/// 返回所有支持图片扩展名（小写）
pub fn supported_extensions() -> Vec<&'static str> {
    IMAGE_EXTS.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extension_of() {
        assert_eq!(extension_of("page1.jpg"), Some("jpg".to_string()));
        assert_eq!(extension_of("subdir/file.PNG"), Some("png".to_string()));
        assert_eq!(extension_of("noext"), None);
        assert_eq!(extension_of(".hidden"), Some("hidden".to_string()));
    }

    #[test]
    fn test_is_image() {
        assert!(is_image("page1.jpg"));
        assert!(is_image("a.PNG"));
        assert!(!is_image("archive.cbz"));
        assert!(!is_image("noext"));
    }

    #[test]
    fn test_is_archive() {
        assert!(is_archive("comic.cbz"));
        assert!(is_archive("x.7Z"));
        assert!(!is_archive("page.jpg"));
    }

    #[test]
    fn test_mime_from_name() {
        assert_eq!(mime_from_name("a.jpg"), Some("image/jpeg"));
        assert_eq!(mime_from_name("a.png"), Some("image/png"));
        assert_eq!(mime_from_name("a.zip"), None);
    }
}