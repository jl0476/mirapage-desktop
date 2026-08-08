//! 缩略图生成器集成测试（计划任务3）。
//!
//! 覆盖：EXIF Orientation 1–8 四角颜色 + 宽高交换、JPEG/PNG/GIF/BMP/WebP 解码、
//! GIF 首帧、PNG alpha 保留、长图像素预算、输出 WebP 无 EXIF、原子写。
//!
//! Fixture 约定见 `tests/fixtures/thumbnail/README.md`。

use std::io::Cursor;
use std::path::PathBuf;

use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};

use mirapage_desktop_lib::thumbnail::generator::{generate_thumbnail, GenerateRequest};
use mirapage_desktop_lib::thumbnail::orientation::read_orientation;
use mirapage_desktop_lib::thumbnail::policy::output_pixel_budget;

// ─── 颜色常量（四角 A/B/C/D）──────────────────────────────────────────
const RED: [u8; 3] = [255, 0, 0]; // A = TL
const BLUE: [u8; 3] = [0, 0, 255]; // B = TR
const YELLOW: [u8; 3] = [255, 255, 0]; // C = BL
const CYAN: [u8; 3] = [0, 255, 255]; // D = BR
const GREEN: [u8; 3] = [0, 255, 0]; // 中格
const MAGENTA: [u8; 3] = [255, 0, 255]; // 中格

const TOL: i32 = 50;

// ─── Fixture 构造 ──────────────────────────────────────────────────────

/// 3×2 四角颜色网格（300×200），见 README 约定。
fn make_grid() -> DynamicImage {
    let mut img = RgbaImage::new(300, 200);
    let cell_w = 100u32;
    let cell_h = 100u32;
    let colors: [[u8; 3]; 6] = [RED, GREEN, BLUE, YELLOW, MAGENTA, CYAN];
    for y in 0..200 {
        for x in 0..300 {
            let col = (x / cell_w) as usize;
            let row = (y / cell_h) as usize;
            let [r, g, b] = colors[row * 3 + col];
            img.put_pixel(x, y, Rgba([r, g, b, 255]));
        }
    }
    DynamicImage::ImageRgba8(img)
}

fn solid_image(w: u32, h: u32, [r, g, b]: [u8; 3]) -> DynamicImage {
    let mut img = RgbaImage::new(w, h);
    for px in img.pixels_mut() {
        *px = Rgba([r, g, b, 255]);
    }
    DynamicImage::ImageRgba8(img)
}

fn encode(img: &DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), format)
        .unwrap_or_else(|e| panic!("encode {format:?} failed: {e}"));
    buf
}

/// 在 JPEG SOI 后注入仅含 Orientation 的最小 EXIF APP1（小端 TIFF）。
fn make_jpeg_with_orientation(jpeg: &[u8], orientation: u8) -> Vec<u8> {
    assert!((1..=8).contains(&orientation));
    let mut tiff = Vec::new();
    tiff.extend_from_slice(b"II"); // little-endian
    tiff.extend_from_slice(&0x002Au16.to_le_bytes()); // TIFF magic
    tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset（相对 TIFF 头）
    tiff.extend_from_slice(&1u16.to_le_bytes()); // IFD0 条目数
    // Orientation 条目：tag=0x0112, type=3(SHORT), count=1, value=orientation
    tiff.extend_from_slice(&0x0112u16.to_le_bytes());
    tiff.extend_from_slice(&3u16.to_le_bytes());
    tiff.extend_from_slice(&1u32.to_le_bytes());
    tiff.extend_from_slice(&(orientation as u32).to_le_bytes());
    tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD = 0

    let mut payload = Vec::new();
    payload.extend_from_slice(b"Exif\0\0");
    payload.extend_from_slice(&tiff);
    let length = (2 + payload.len()) as u16; // 含长度字段自身
    let mut out = Vec::new();
    out.extend_from_slice(&jpeg[..2]); // SOI (FF D8)
    out.extend_from_slice(&[0xFF, 0xE1]); // APP1 marker
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    out
}

/// 期望四角 [TL, TR, BL, BR]（EXIF 几何语义推导，见 README 表）。
fn expected_corners(ori: u8) -> [[u8; 3]; 4] {
    let (a, b, c, d) = (RED, BLUE, YELLOW, CYAN);
    match ori {
        1 => [a, b, c, d],
        2 => [b, a, d, c],
        3 => [d, c, b, a],
        4 => [c, d, a, b],
        5 => [a, c, b, d],
        6 => [c, a, d, b],
        7 => [d, b, c, a],
        8 => [b, d, a, c],
        _ => unreachable!(),
    }
}

// ─── 生成 / 解码 辅助 ─────────────────────────────────────────────────

fn gen(
    source: &[u8],
    target_width: u32,
    pixel_budget: u32,
    floor: u32,
    quality: f32,
    cache_path: &std::path::Path,
) -> mirapage_desktop_lib::thumbnail::generator::GeneratedThumbnail {
    let req = GenerateRequest {
        source_bytes: source,
        target_width,
        pixel_budget,
        clarity_floor_width: floor,
        webp_quality: quality,
        cache_path,
    };
    generate_thumbnail(req).expect("generate should succeed")
}

fn decode_webp(bytes: &[u8]) -> DynamicImage {
    image::load_from_memory(bytes).expect("output should decode as WebP")
}

fn corner(img: &DynamicImage, pos: &str, inset: u32) -> [u8; 4] {
    let (w, h) = img.dimensions();
    // 安全 inset：不超过半边长，至少 1。
    let ix = inset.min(w / 2).max(1);
    let iy = inset.min(h / 2).max(1);
    let (x, y) = match pos {
        "tl" => (ix, iy),
        "tr" => (w - ix, iy),
        "bl" => (ix, h - iy),
        "br" => (w - ix, h - iy),
        _ => unreachable!(),
    };
    let p = img.get_pixel(x, y);
    [p[0], p[1], p[2], p[3]]
}

fn assert_color(actual: [u8; 4], expected: [u8; 3], label: &str) {
    for (i, (a, e)) in actual[..3].iter().zip(expected.iter()).enumerate() {
        let diff = (*a as i32 - *e as i32).abs();
        assert!(
            diff <= TOL,
            "{label}: channel {i} got {a}, expected {e}, diff {diff} > {TOL}"
        );
    }
}

fn tmp_cache(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("mirapage-thumb-tests");
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

// ─── 测试 ──────────────────────────────────────────────────────────────

#[test]
fn exif_injection_round_trips_with_reader() {
    let jpeg = encode(&make_grid(), ImageFormat::Jpeg);
    for ori in 1..=8u8 {
        let with_exif = make_jpeg_with_orientation(&jpeg, ori);
        assert_eq!(
            read_orientation(&with_exif),
            ori,
            "orientation {ori} should round-trip"
        );
    }
}

#[test]
fn orientation_1_to_8_corners_and_dimensions() {
    let grid_jpeg = encode(&make_grid(), ImageFormat::Jpeg);
    for ori in 1..=8u8 {
        let source = make_jpeg_with_orientation(&grid_jpeg, ori);
        let cache = tmp_cache(&format!("ori_{ori}.webp"));
        let result = gen(&source, 512, 3_000_000, 0, 82.0, &cache);
        let out = decode_webp(&std::fs::read(&cache).unwrap());

        let (w, h) = (result.width, result.height);
        if ori <= 4 {
            assert!(w > h, "orientation {ori}: expect w>h, got {w}x{h}");
        } else {
            assert!(h > w, "orientation {ori}: expect h>w (swapped), got {w}x{h}");
        }

        let exp = expected_corners(ori);
        for (pos, exp_rgb) in ["tl", "tr", "bl", "br"].iter().zip(exp.iter()) {
            // inset 50 = 100px 格子的中心，远离 WebP 块边界，避免有损编码颜色渗透。
            let px = corner(&out, pos, 50);
            assert_color(px, *exp_rgb, &format!("orientation {ori} {pos}"));
        }

        // 输出 WebP 不再携带 EXIF Orientation（方向已烘焙进像素）。
        let out_bytes = std::fs::read(&cache).unwrap();
        assert_eq!(read_orientation(&out_bytes), 1, "output webp must have no orientation");
    }
}

#[test]
fn all_formats_decode_and_generate() {
    let grid = make_grid();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("jpeg", encode(&grid, ImageFormat::Jpeg)),
        ("png", encode(&grid, ImageFormat::Png)),
        ("gif", encode(&grid, ImageFormat::Gif)),
        ("bmp", encode(&grid, ImageFormat::Bmp)),
        ("webp", {
            // image 0.24 不支持 WebP 编码，用 webp crate 造源。
            let rgb = grid.to_rgb8();
            let enc = webp::Encoder::from_rgb(&rgb, rgb.width(), rgb.height());
            enc.encode(82.0).to_vec()
        }),
    ];
    for (name, bytes) in cases {
        let cache = tmp_cache(&format!("fmt_{name}.webp"));
        let result = gen(&bytes, 512, 3_000_000, 0, 82.0, &cache);
        assert!(result.width > 0 && result.height > 0, "{name}: empty dims");
        assert!(result.byte_size > 0, "{name}: empty output");
        let out = decode_webp(&std::fs::read(&cache).unwrap());
        assert!(out.width() > 0 && out.height() > 0, "{name}: output decode");
    }
}

#[test]
fn png_alpha_preserved_in_webp() {
    // 左半透明红、右半不透明蓝。
    let mut img = RgbaImage::new(100, 100);
    for (x, _y, px) in img.enumerate_pixels_mut() {
        *px = if x < 50 {
            Rgba([255, 0, 0, 0])
        } else {
            Rgba([0, 0, 255, 255])
        };
    }
    let source = encode(&DynamicImage::ImageRgba8(img), ImageFormat::Png);
    let cache = tmp_cache("alpha.webp");
    gen(&source, 512, 3_000_000, 0, 82.0, &cache);
    let out = decode_webp(&std::fs::read(&cache).unwrap());
    assert!(out.color().has_alpha(), "output webp must keep alpha");
    let tl = corner(&out, "tl", 10);
    assert!(tl[3] < 20, "TL should be transparent, alpha={}", tl[3]);
    let tr = corner(&out, "tr", 10);
    assert!(tr[3] > 230, "TR should be opaque, alpha={}", tr[3]);
    assert_color(tr, BLUE, "TR color");
}

#[test]
fn gif_takes_first_frame_only() {
    // 两帧 GIF：帧0 纯红、帧1 纯蓝。生成应取首帧（红）。
    let mut buf = Vec::new();
    {
        let mut enc = image::codecs::gif::GifEncoder::new(&mut buf);
        enc.encode_frame(image::Frame::new(solid_image(100, 100, RED).to_rgba8()))
            .unwrap();
        enc.encode_frame(image::Frame::new(solid_image(100, 100, BLUE).to_rgba8()))
            .unwrap();
    }
    let cache = tmp_cache("gif_first.webp");
    gen(&buf, 512, 3_000_000, 0, 82.0, &cache);
    let out = decode_webp(&std::fs::read(&cache).unwrap());
    let c = corner(&out, "tl", 10);
    assert_color(c, RED, "GIF first frame should be red");
    // 确保不是第二帧（蓝）
    let diff_blue = (c[2] as i32 - BLUE[2] as i32).abs();
    assert!(diff_blue > TOL, "should not be blue (frame 2)");
}

#[test]
fn long_image_output_within_pixel_budget() {
    // 600x9000（宽高比 15，极端长图），目标 600，预算由 policy 判定为 4MP。
    let source = encode(&solid_image(600, 9000, RED), ImageFormat::Jpeg);
    let budget = output_pixel_budget(600, 9000);
    assert_eq!(budget, 4_000_000, "long image should get 4MP budget");
    let cache = tmp_cache("long.webp");
    let result = gen(&source, 600, budget, 0, 82.0, &cache);
    let pixels = (result.width as u64) * (result.height as u64);
    assert!(pixels <= 4_000_000, "long image pixels {pixels} must be <= 4MP");
    assert!(result.width < 600, "budget should force width below target 600");
}

#[test]
fn atomic_write_success_leaves_no_tmp() {
    let source = encode(&solid_image(200, 150, GREEN), ImageFormat::Jpeg);
    let cache = tmp_cache("atomic_ok.webp");
    let tmp = PathBuf::from(format!("{}.tmp", cache.display()));
    let result = gen(&source, 512, 3_000_000, 0, 82.0, &cache);
    assert!(cache.exists(), "final cache file must exist");
    assert!(!tmp.exists(), ".tmp must be renamed away");
    assert!(result.byte_size > 0);
    // 文件可重新解码。
    let _ = decode_webp(&std::fs::read(&cache).unwrap());
}

#[test]
fn atomic_write_failure_leaves_no_final_file() {
    let garbage = b"not an image at all";
    let cache = tmp_cache("atomic_fail.webp");
    let tmp = PathBuf::from(format!("{}.tmp", cache.display()));
    let req = GenerateRequest {
        source_bytes: garbage,
        target_width: 512,
        pixel_budget: 3_000_000,
        clarity_floor_width: 0,
        webp_quality: 82.0,
        cache_path: &cache,
    };
    let res = generate_thumbnail(req);
    assert!(res.is_err(), "corrupt input must error");
    assert!(!cache.exists(), "no final file on failure");
    assert!(!tmp.exists(), "no .tmp left on failure");
}
