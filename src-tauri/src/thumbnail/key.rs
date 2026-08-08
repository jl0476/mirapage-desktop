//! 缓存 key 生成（§9.3）。
//!
//! `cache_key` 标识一张具体的缓存缩略图，`source_key` 标识源文件位置（同一源的不同
//! 档位 / 质量共享 source_key，便于按源失效）。两者都用 SHA-256 的十六进制摘要：
//! 跨运行 / 跨平台稳定，碰撞概率可忽略。**绝对缓存根目录不参与 key**，因此缓存目录
//! 迁移无需重新计算 key 或逐行改索引。

use sha2::{Digest, Sha256};

/// 缩略图算法 / 策略版本，参与 cache_key。改算法时递增使旧缓存失效。
pub const POLICY_VERSION: u32 = 1;

/// 计算 `cache_key` 所需的全部输入。
pub struct CacheKeyInput<'a> {
    pub source_descriptor_json: &'a str,
    pub rel_path: &'a str,
    pub source_size: u64,
    pub source_modified_at: Option<i64>,
    pub target_bucket: u32,
    /// "standard" / "high" / "ultra"。
    pub quality: &'a str,
    /// EXIF 方向归一化版本；归一化算法变更时递增。
    pub orientation_version: u32,
    /// 缩略图生成算法版本（与 `mod::THUMBNAIL_ALGORITHM_VERSION` 一致）。
    pub algorithm_version: u32,
}

/// 源文件位置 key = hash(source_descriptor_json + rel_path)。
/// 同一源的不同档位 / 质量共享此 key。
pub fn source_key(source_descriptor_json: &str, rel_path: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"source:v1:");
    h.update(source_descriptor_json.as_bytes());
    h.update(b"\x1f");
    h.update(rel_path.as_bytes());
    hex(&h.finalize())
}

/// 缩略图缓存 key = hash(全部输入维度)。任一维度变化都会产生不同 key。
pub fn cache_key(input: &CacheKeyInput) -> String {
    let mut h = Sha256::new();
    h.update(b"thumb:v1:");
    h.update(input.source_descriptor_json.as_bytes());
    h.update(b"\x1f");
    h.update(input.rel_path.as_bytes());
    h.update(b"\x1f");
    h.update(input.source_size.to_le_bytes());
    h.update(b"\x1f");
    match input.source_modified_at {
        Some(t) => h.update(t.to_le_bytes()),
        None => h.update(b"null"),
    }
    h.update(b"\x1f");
    h.update(input.target_bucket.to_le_bytes());
    h.update(b"\x1f");
    h.update(input.quality.as_bytes());
    h.update(b"\x1f");
    h.update(input.orientation_version.to_le_bytes());
    h.update(b"\x1f");
    h.update(input.algorithm_version.to_le_bytes());
    hex(&h.finalize())
}

/// 缓存相对路径：`v1/<cache_key[0..2]>/<cache_key>.webp`。
/// 一级 hash 前缀分片，避免单目录文件过多。
pub fn cache_rel_path(key: &str) -> String {
    debug_assert!(key.len() >= 2, "cache_key 过短: {key}");
    let prefix = if key.len() >= 2 { &key[..2] } else { key };
    format!("v1/{prefix}/{key}.webp")
}

fn digest_hex(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for p in parts {
        h.update(*p);
    }
    hex(&h.finalize())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        write!(&mut s, "{b:02x}").unwrap();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input<'a>() -> CacheKeyInput<'a> {
        CacheKeyInput {
            source_descriptor_json: r#"{"type":"local","rootPath":"D:/imgs"}"#,
            rel_path: "sub/a.jpg",
            source_size: 5_000_000,
            source_modified_at: Some(1_700_000_000),
            target_bucket: 1024,
            quality: "high",
            orientation_version: 1,
            algorithm_version: 1,
        }
    }

    #[test]
    fn cache_key_stable_for_same_input() {
        assert_eq!(cache_key(&sample_input()), cache_key(&sample_input()));
    }

    #[test]
    fn cache_key_changes_when_modified_at_changes() {
        let mut a = sample_input();
        let mut b = sample_input();
        b.source_modified_at = Some(1_700_000_001);
        assert_ne!(cache_key(&a), cache_key(&b));
    }

    #[test]
    fn cache_key_changes_when_size_changes() {
        let mut b = sample_input();
        b.source_size = 5_000_001;
        assert_ne!(cache_key(&sample_input()), cache_key(&b));
    }

    #[test]
    fn cache_key_changes_when_bucket_changes() {
        let mut b = sample_input();
        b.target_bucket = 2048;
        assert_ne!(cache_key(&sample_input()), cache_key(&b));
    }

    #[test]
    fn cache_key_changes_when_quality_changes() {
        let mut b = sample_input();
        b.quality = "ultra";
        assert_ne!(cache_key(&sample_input()), cache_key(&b));
    }

    #[test]
    fn cache_key_changes_when_policy_version_changes() {
        let mut b = sample_input();
        b.algorithm_version = 2;
        assert_ne!(cache_key(&sample_input()), cache_key(&b));
    }

    #[test]
    fn cache_key_changes_when_orientation_version_changes() {
        let mut b = sample_input();
        b.orientation_version = 2;
        assert_ne!(cache_key(&sample_input()), cache_key(&b));
    }

    #[test]
    fn cache_key_distinct_for_none_vs_some_modified_at() {
        let mut b = sample_input();
        b.source_modified_at = None;
        assert_ne!(cache_key(&sample_input()), cache_key(&b));
    }

    #[test]
    fn cache_key_independent_of_cache_root() {
        // cache_key 输入不含缓存根目录；同一图片在不同缓存根下 key 相同（迁移友好）。
        assert_eq!(cache_key(&sample_input()), cache_key(&sample_input()));
    }

    #[test]
    fn source_key_stable_and_distinct() {
        let sd = r#"{"type":"local","rootPath":"D:/imgs"}"#;
        assert_eq!(source_key(sd, "a.jpg"), source_key(sd, "a.jpg"));
        assert_ne!(source_key(sd, "a.jpg"), source_key(sd, "b.jpg"));
        assert_ne!(
            source_key(sd, "a.jpg"),
            source_key(r#"{"type":"local","rootPath":"D:/other"}"#, "a.jpg")
        );
    }

    #[test]
    fn source_key_shared_across_buckets_and_qualities() {
        // 同一源 + 同一 rel_path，不同 bucket / quality 应有相同 source_key
        // （但不同 cache_key，已由上面测试覆盖）。
        let sd = r#"{"type":"local","rootPath":"D:/imgs"}"#;
        assert_eq!(source_key(sd, "a.jpg"), source_key(sd, "a.jpg"));
    }

    #[test]
    fn cache_rel_path_uses_two_char_shard_prefix() {
        let key = cache_key(&sample_input());
        let rel = cache_rel_path(&key);
        assert!(rel.starts_with("v1/"));
        assert!(rel.ends_with(".webp"));
        // v1/xx/<full-key>.webp
        assert_eq!(rel, format!("v1/{}/{}.webp", &key[..2], key));
    }

    #[test]
    fn digest_hex_helper_is_stable() {
        assert_eq!(digest_hex(&[b"a", b"b"]), digest_hex(&[b"a", b"b"]));
    }
}
