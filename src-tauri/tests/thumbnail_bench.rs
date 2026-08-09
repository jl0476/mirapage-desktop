//! 缩略图生成各阶段耗时 benchmark（手动跑，验证 decode 是否主瓶颈）。
//!
//! 跑法（dev 进程需先停，避免 target 锁）：
//!   cargo test --test thumbnail_bench bench_gen_stages -- --ignored --nocapture
//!
//! 输出 decode / orient / resize / encode 各阶段最好耗时（3 次取 min）+ 占比。

use std::time::Instant;

use image::imageops::FilterType;
use mirapage_desktop_lib::thumbnail::generator::compute_output_size;
use mirapage_desktop_lib::thumbnail::orientation::{apply_orientation, read_orientation};

#[test]
#[ignore]
fn bench_gen_stages() {
    // (路径, 标签, target_width=bucket, pixel_budget, clarity_floor)
    // bucket 512 对应 requiredWidth≈369（295 colWidth × 1 dpr × 1.25 high margin），high quality
    let cases: &[(&str, &str, u32, u32, u32)] = &[
        (r"F:\WallPaper\normal\wallhaven-m388vm.png", "1080p PNG", 512, 3_000_000, 369),
        (r"F:\WallPaper\normal\wallhaven-gpxv57.jpg", "4K JPEG", 512, 3_000_000, 369),
        (r"F:\WallPaper\normal\wallhaven-859prj.png", "7802x4389 PNG", 512, 3_000_000, 369),
    ];

    for (path, label, target_w, budget, floor) in cases {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("skip {} ({}: {})", label, path, e);
                continue;
            }
        };
        // 3 次取最好（排除冷启动 / JIT 预热）
        let mut best = (u128::MAX, u128::MAX, u128::MAX, u128::MAX, u128::MAX);
        let mut dims = (0u32, 0u32, 0u32, 0u32);
        for _ in 0..3 {
            let t0 = Instant::now();
            // decode（含 read_orientation，但 EXIF 读极快，并入 decode 阶段）
            let orientation = read_orientation(&bytes);
            let img = image::load_from_memory(&bytes).unwrap();
            let t1 = Instant::now();
            // orientation 归一化
            let img = apply_orientation(img, orientation);
            let (dw, dh) = (img.width(), img.height());
            let t2 = Instant::now();
            // resize
            let (out_w, out_h) = compute_output_size(dw, dh, *target_w, *budget, *floor);
            let resized = if out_w < dw {
                img.resize_exact(out_w, out_h, FilterType::Triangle)
            } else {
                img
            };
            let t3 = Instant::now();
            // encode webp
            let rgb = resized.to_rgb8();
            let enc = webp::Encoder::from_rgb(&rgb, rgb.width(), rgb.height());
            let _webp = enc.encode(82.0).to_vec();
            let t4 = Instant::now();

            dims = (dw, dh, out_w, out_h);
            let decode = (t1 - t0).as_millis();
            let orient = (t2 - t1).as_millis();
            let resize = (t3 - t2).as_millis();
            let encode = (t4 - t3).as_millis();
            best.0 = best.0.min(decode);
            best.1 = best.1.min(orient);
            best.2 = best.2.min(resize);
            best.3 = best.3.min(encode);
            best.4 = best.4.min((t4 - t0).as_millis());
        }
        let (decode, orient, resize, encode, total) = best;
        println!(
            "\n[{}] {}x{} -> {}x{} ({}KB)",
            label,
            dims.0,
            dims.1,
            dims.2,
            dims.3,
            bytes.len() / 1024
        );
        println!(
            "  decode {:4}ms ({:3.0}%)  orient {:3}ms  resize {:4}ms ({:3.0}%)  encode {:4}ms ({:3.0}%)  total {}ms",
            decode,
            decode as f64 / total as f64 * 100.0,
            orient,
            resize,
            resize as f64 / total as f64 * 100.0,
            encode,
            encode as f64 / total as f64 * 100.0,
            total,
        );
    }
}

#[test]
#[ignore]
fn bench_resize_compare() {
    use fast_image_resize as fir;
    let cases = [
        (r"F:\WallPaper\normal\wallhaven-m388vm.png", "1080p PNG"),
        (r"F:\WallPaper\normal\wallhaven-gpxv57.jpg", "4K JPEG"),
        (r"F:\WallPaper\normal\wallhaven-859prj.png", "7802x4389 PNG"),
    ];
    for (path, label) in cases {
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => {
                eprintln!("skip {}", label);
                continue;
            }
        };
        let img = image::load_from_memory(&bytes).unwrap();
        let (w, h) = (img.width(), img.height());
        let out_w = 512u32.min(w);
        let out_h = (out_w as f64 * h as f64 / w as f64).round() as u32;
        let rgba = img.to_rgba8();
        let raw = rgba.into_raw();
        let pt = fir::pixels::PixelType::U8x4;

        // image crate Triangle（当前生产用的）
        let mut best_img = u128::MAX;
        for _ in 0..3 {
            let t = Instant::now();
            let _ = img.resize_exact(out_w, out_h, FilterType::Triangle);
            best_img = best_img.min(t.elapsed().as_millis());
        }

        // image crate thumbnail（area resampling，大幅缩小专用优化）
        let mut best_thumb = u128::MAX;
        for _ in 0..3 {
            let t = Instant::now();
            let _ = image::imageops::thumbnail(&img, out_w, out_h);
            best_thumb = best_thumb.min(t.elapsed().as_millis());
        }

        // image crate resize_exact Nearest（最简单采样）
        let mut best_nearest = u128::MAX;
        for _ in 0..3 {
            let t = Instant::now();
            let _ = img.resize_exact(out_w, out_h, FilterType::Nearest);
            best_nearest = best_nearest.min(t.elapsed().as_millis());
        }

        // fast-image-resize 默认（含 from_vec_u8 准备，反映换 fir 的真实成本）
        let mut best_fir = u128::MAX;
        for _ in 0..3 {
            let t = Instant::now();
            let src = fir::images::Image::from_vec_u8(w, h, raw.clone(), pt).unwrap();
            let mut dst = fir::images::Image::new(out_w, out_h, pt);
            let mut resizer = fir::Resizer::new();
            resizer.resize(&src, &mut dst, None).unwrap();
            best_fir = best_fir.min(t.elapsed().as_millis());
        }

        println!(
            "[{}] {}x{}->{}x{}  triangle={}ms  thumbnail={}ms ({:.1}x)  nearest={}ms ({:.1}x)  fir={}ms",
            label,
            w,
            h,
            out_w,
            out_h,
            best_img,
            best_thumb,
            best_img as f64 / best_thumb.max(1) as f64,
            best_nearest,
            best_img as f64 / best_nearest.max(1) as f64,
            best_fir,
        );
    }
}
