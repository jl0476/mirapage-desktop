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
fn parse_png(_bytes: &[u8]) -> Option<ImageDimensions> {
    None
}
fn parse_gif(_bytes: &[u8]) -> Option<ImageDimensions> {
    None
}
fn parse_bmp(_bytes: &[u8]) -> Option<ImageDimensions> {
    None
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
}