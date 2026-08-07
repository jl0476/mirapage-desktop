//! 纯函数图片 header 尺寸解析。只依赖 std，不解码像素。
//! 对齐 DESIGN.md §13 真值源（Android 同名算法）。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}

/// 解析图片字节数据的尺寸（宽高）。支持 JPEG/PNG/GIF/BMP。
/// 输入应是文件头部足够字节（建议 ≥ 64 字节）。无法解析返回 None。
pub fn image_dimensions(bytes: &[u8]) -> Option<ImageDimensions> {
    parse_jpeg(bytes)
        .or_else(|| parse_png(bytes))
        .or_else(|| parse_gif(bytes))
        .or_else(|| parse_bmp(bytes))
}

pub fn parse_jpeg(bytes: &[u8]) -> Option<ImageDimensions> {
    parse_jpeg_impl(bytes)
}

/// JPEG: 扫描 marker 找 SOF0(FFC0)/SOF1/SOF2...SOF15(除 SOF4/SOF8/SOF12)。
/// 尺寸在 SOFn marker 后: [precision(1)] [height(2 BE)] [width(2 BE)]
fn parse_jpeg_impl(bytes: &[u8]) -> Option<ImageDimensions> {
    // JPEG 必须以 FF D8 开头
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut i = 2usize;
    while i + 8 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        i += 2;
        // SOFn markers: C0..CF (不含 C4=DHT, C8=JPG, CC=DAC)
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            // SOFn marker 后: [length(2)] [precision(1)] [height(2 BE)] [width(2 BE)]
            if i + 7 <= bytes.len() {
                let height = u16::from_be_bytes([bytes[i + 3], bytes[i + 4]]) as u32;
                let width = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                return Some(ImageDimensions { width, height });
            }
            return None;
        }
        // 其他 marker：读 length 跳过
        if i + 1 < bytes.len() {
            let len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
            i += len;
        } else {
            return None;
        }
    }
    None
}

/// PNG: 8 字节签名后第一个 chunk 是 IHDR，width/height 各 4 字节大端在 offset 16/20。
fn parse_png(bytes: &[u8]) -> Option<ImageDimensions> {
    const SIG: [u8; 8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.len() < 24 || bytes[..8] != SIG {
        return None;
    }
    // IHDR 在 offset 12（4 length + 4 type），width 在 16，height 在 20
    if &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    if width == 0 || height == 0 {
        return None;
    }
    Some(ImageDimensions { width, height })
}

/// GIF: "GIF87a"/"GIF89a" 后 width/height 各 2 字节小端。
fn parse_gif(bytes: &[u8]) -> Option<ImageDimensions> {
    if bytes.len() < 10 {
        return None;
    }
    let sig = &bytes[..6];
    if sig != b"GIF87a" && sig != b"GIF89a" {
        return None;
    }
    let width = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
    let height = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
    if width == 0 || height == 0 {
        return None;
    }
    Some(ImageDimensions { width, height })
}

/// BMP: "BM" 后 DIB header 在 offset 14，BITMAPINFOHEADER 的 width/height 在 offset 18/22（4 字节小端）。
fn parse_bmp(bytes: &[u8]) -> Option<ImageDimensions> {
    if bytes.len() < 26 || &bytes[..2] != b"BM" {
        return None;
    }
    let width = u32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]);
    // height 可能负（top-down 位图），取绝对值
    let h_raw = i32::from_le_bytes([bytes[22], bytes[23], bytes[24], bytes[25]]);
    let height = h_raw.unsigned_abs();
    if width == 0 || height == 0 {
        return None;
    }
    Some(ImageDimensions { width, height })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个最小 JPEG 字节流：SOI(FFD8) + APP0 + SOF0 marker 含 800x600
    fn make_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8]; // SOI
        // APP0 segment (最小)
        b.extend_from_slice(&[0xFF, 0xE0]); // APP0 marker
        b.extend_from_slice(&[0x00, 0x10]); // length 16
        b.extend_from_slice(b"JFIF\x00");   // identifier
        b.extend_from_slice(&[0x01, 0x02, 0x00, 0x60, 0x00, 0x60, 0x00, 0x00]); // version + units + density
        b.push(0x00); // pad to 14-byte payload so length=16 (len includes itself) is consistent
        // SOF0 marker
        b.extend_from_slice(&[0xFF, 0xC0]); // SOF0
        b.extend_from_slice(&[0x00, 0x11]); // length 17
        b.push(0x08);                       // precision 8-bit
        b.extend_from_slice(&h.to_be_bytes()); // height (big-endian)
        b.extend_from_slice(&w.to_be_bytes()); // width
        b.push(0x03);                       // 3 components
        b.extend_from_slice(&[0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        b
    }

    #[test]
    fn parse_jpeg_valid() {
        let bytes = make_jpeg(800, 600);
        let dim = parse_jpeg(&bytes).expect("valid jpeg should parse");
        assert_eq!(dim.width, 800);
        assert_eq!(dim.height, 600);
    }

    #[test]
    fn parse_jpeg_not_jpeg() {
        assert_eq!(parse_jpeg(&[0x00, 0x00, 0x00]), None);
    }

    #[test]
    fn parse_jpeg_truncated_no_sof0() {
        // SOI + APP0 但无 SOF0
        let mut b = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        b.extend_from_slice(b"JFIF\x00\x01\x02\x00\x60\x00\x60\x00\x00");
        assert_eq!(parse_jpeg(&b), None);
    }

    fn make_png(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]; // PNG signature
        // IHDR chunk
        b.extend_from_slice(&[0x00, 0x00, 0x00, 0x0D]); // length 13
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[0x08, 0x06, 0x00, 0x00, 0x00]); // bit depth, color type, ...
        b
    }

    #[test]
    fn parse_png_valid() {
        let dim = parse_png(&make_png(1920, 1080)).unwrap();
        assert_eq!(dim.width, 1920);
        assert_eq!(dim.height, 1080);
    }

    #[test]
    fn parse_png_not_png() {
        assert_eq!(parse_png(&[0x00; 16]), None);
    }

    fn make_gif(w: u16, h: u16) -> Vec<u8> {
        let mut b = b"GIF89a".to_vec();
        b.extend_from_slice(&w.to_le_bytes()); // little-endian
        b.extend_from_slice(&h.to_le_bytes());
        b
    }

    #[test]
    fn parse_gif_valid() {
        let dim = parse_gif(&make_gif(200, 150)).unwrap();
        assert_eq!(dim.width, 200);
        assert_eq!(dim.height, 150);
    }

    #[test]
    fn parse_gif_not_gif() {
        assert_eq!(parse_gif(b"NOTGIF" as &[u8]), None);
    }

    fn make_bmp(w: u32, h: u32) -> Vec<u8> {
        let mut b = vec![0x42, 0x4D]; // "BM"
        b.extend_from_slice(&[0u8; 12]); // file size + reserved + offset (占位)
        b.extend_from_slice(&40u32.to_le_bytes()); // DIB header size
        b.extend_from_slice(&w.to_le_bytes());  // width
        b.extend_from_slice(&h.to_le_bytes());  // height
        b
    }

    #[test]
    fn parse_bmp_valid() {
        let dim = parse_bmp(&make_bmp(640, 480)).unwrap();
        assert_eq!(dim.width, 640);
        assert_eq!(dim.height, 480);
    }

    #[test]
    fn image_dimensions_dispatch() {
        assert!(image_dimensions(&make_jpeg(10, 20)).is_some());
        assert!(image_dimensions(&make_png(10, 20)).is_some());
        assert!(image_dimensions(&make_gif(10, 20)).is_some());
        assert!(image_dimensions(&make_bmp(10, 20)).is_some());
        assert_eq!(image_dimensions(&[0x00; 32]), None);
    }
}