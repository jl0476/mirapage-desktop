//! 缩略图管线端到端集成测试（计划任务13）。
//!
//! 不依赖 Tauri AppHandle，直接串联 generator + index + temp 缓存目录，
//! 覆盖冷缓存生成→热缓存命中、WebP 可重解码、坏图不阻塞、LRU 超限→80%。

use std::collections::HashSet;
use std::io::Cursor;

use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};
use mirapage_desktop_lib::thumbnail::generator::{generate_thumbnail, GenerateRequest};
use mirapage_desktop_lib::thumbnail::index::{self, ThumbnailCacheRow};
use mirapage_desktop_lib::thumbnail::key::{cache_rel_path, CacheKeyInput};
use mirapage_desktop_lib::thumbnail::{THUMBNAIL_ALGORITHM_VERSION};
use rusqlite::Connection;

fn solid(w: u32, h: u32, [r, g, b]: [u8; 3]) -> DynamicImage {
    let mut img = RgbaImage::new(w, h);
    for px in img.pixels_mut() {
        *px = Rgba([r, g, b, 255]);
    }
    DynamicImage::ImageRgba8(img)
}

fn encode(img: &DynamicImage, fmt: ImageFormat) -> Vec<u8> {
    let mut buf = Vec::new();
    img.write_to(&mut Cursor::new(&mut buf), fmt).unwrap();
    buf
}

fn open_db() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    index::ensure_schema(&conn).unwrap();
    conn
}

fn make_row(cache_key: &str, rel: &str, bytes: i64, t: i64) -> ThumbnailCacheRow {
    ThumbnailCacheRow {
        cache_key: cache_key.to_string(),
        source_key: "s".into(),
        rel_path: rel.into(),
        source_size: Some(1000),
        source_modified_at: Some(100),
        source_width: Some(2000),
        source_height: Some(1500),
        orientation: Some(1),
        target_bucket: 1024,
        quality: "high".into(),
        cache_rel_path: rel.to_string(),
        output_width: 1024,
        output_height: 768,
        byte_size: bytes,
        created_at: t,
        last_accessed_at: t,
    }
}

#[test]
fn cold_generate_then_hot_hit_and_redecode() {
    let dir = tempfile::tempdir().unwrap();
    let conn = open_db();

    let src = encode(&solid(2000, 1500, [10, 20, 30]), ImageFormat::Jpeg);
    let cache_key = key_cache(&src, 1024);
    let rel = cache_rel_path(&cache_key);
    let cache_abs = dir.path().join(&rel);

    // 冷：生成
    let req = GenerateRequest {
        source_bytes: &src,
        target_width: 1024,
        pixel_budget: 3_000_000,
        clarity_floor_width: 0,
        webp_quality: 82.0,
        cache_path: &cache_abs,
    };
    let out = generate_thumbnail(req, None, None).expect("generate");
    assert!(out.byte_size > 0);

    // 写索引
    let row = ThumbnailCacheRow {
        cache_key: cache_key.clone(),
        source_key: "s".into(),
        rel_path: "big.jpg".into(),
        source_size: Some(src.len() as i64),
        source_modified_at: Some(100),
        source_width: Some(2000),
        source_height: Some(1500),
        orientation: Some(1),
        target_bucket: 1024,
        quality: "high".into(),
        cache_rel_path: rel.clone(),
        output_width: out.width as i64,
        output_height: out.height as i64,
        byte_size: out.byte_size as i64,
        created_at: 1,
        last_accessed_at: 1,
    };
    index::upsert(&conn, &row).unwrap();

    // 热：get_verified 命中
    let hit = index::get_verified(&conn, &cache_key, dir.path()).unwrap();
    assert!(hit.is_some(), "hot cache should hit");

    // WebP 可重新解码
    let bytes = std::fs::read(&cache_abs).unwrap();
    let decoded = image::load_from_memory(&bytes).expect("webp redecodable");
    assert!(decoded.width() > 0 && decoded.height() > 0);
}

#[test]
fn bad_image_errors_does_not_block() {
    let dir = tempfile::tempdir().unwrap();
    let garbage = b"not an image";
    let cache_abs = dir.path().join("v1/bad/bad.webp");
    let req = GenerateRequest {
        source_bytes: garbage,
        target_width: 512,
        pixel_budget: 3_000_000,
        clarity_floor_width: 0,
        webp_quality: 82.0,
        cache_path: &cache_abs,
    };
    let res = generate_thumbnail(req, None, None);
    assert!(res.is_err(), "bad image should error");
    assert!(!cache_abs.exists(), "no partial file");

    // 同批其它（正常）图不受影响（独立调用）
    let src = encode(&solid(800, 600, [1, 2, 3]), ImageFormat::Jpeg);
    let ok_path = dir.path().join("v1/ok/ok.webp");
    let req2 = GenerateRequest {
        source_bytes: &src,
        target_width: 512,
        pixel_budget: 3_000_000,
        clarity_floor_width: 0,
        webp_quality: 82.0,
        cache_path: &ok_path,
    };
    assert!(generate_thumbnail(req2, None, None).is_ok(), "good image still works");
}

#[test]
fn lru_evicts_to_80_percent() {
    let conn = open_db();
    let dir = tempfile::tempdir().unwrap();
    // 5 行各 100B（总 500），limit 300 -> 目标 240（300*0.8），删最旧到 <=240
    for (k, t) in [("aa", 1i64), ("bb", 2), ("cc", 3), ("dd", 4), ("ee", 5)] {
        let rel = format!("v1/{k}/{k}.webp");
        let abs = dir.path().join(&rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, b"x").unwrap();
        index::upsert(&conn, &make_row(k, &rel, 100, t)).unwrap();
    }
    let freed = index_evict(&conn, dir.path(), 300);
    assert!(freed > 0);
    assert!(index::total_bytes(&conn).unwrap() <= 240);
}

#[test]
fn lru_skips_protected_keys() {
    let conn = open_db();
    let dir = tempfile::tempdir().unwrap();
    for (k, t) in [("aa", 1i64), ("bb", 2), ("cc", 3)] {
        let rel = format!("v1/{k}/{k}.webp");
        let abs = dir.path().join(&rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, b"x").unwrap();
        index::upsert(&conn, &make_row(k, &rel, 100, t)).unwrap();
    }
    // 保护最旧的 aa，limit 200 -> 不应删 aa
    let mut protected = HashSet::new();
    protected.insert("aa".to_string());
    let (freed, _files) = mirapage_desktop_lib::thumbnail::service::evict_to_limit(
        &conn, dir.path(), 200, &protected,
    ).unwrap();
    assert!(freed > 0);
    assert!(index::get(&conn, "aa").unwrap().is_some(), "protected key kept");
}

// ─── helpers（镜像 service 的 key 构造，避免依赖 AppHandle）────────────
fn key_cache(src: &[u8], bucket: u32) -> String {
    mirapage_desktop_lib::thumbnail::key::cache_key(&CacheKeyInput {
        source_descriptor_json: r#"{"type":"local","rootPath":"D:/x"}"#,
        rel_path: "big.jpg",
        source_size: src.len() as u64,
        source_modified_at: Some(100),
        target_bucket: bucket,
        quality: "high",
        orientation_version: 1,
        algorithm_version: THUMBNAIL_ALGORITHM_VERSION,
    })
}

fn index_evict(conn: &Connection, root: &std::path::Path, limit: u64) -> u64 {
    mirapage_desktop_lib::thumbnail::service::evict_to_limit(
        conn, root, limit, &HashSet::new(),
    ).unwrap_or((0, vec![])).0
}
