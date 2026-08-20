//! 远程 Archive 物化器（M3 spec §4）
//! cache_key = sha256(canonical origin descriptor JSON + '\0' + archive_rel_path)
//! （canonical = typed serde_json::to_string(SourceDescriptor)，migration 013 验证过的形态）

use crate::source::descriptor::SourceDescriptor;
use crate::source::trait_def::FileStat;

pub fn cache_key(origin: &SourceDescriptor, archive_rel_path: &str) -> String {
    let canonical = serde_json::to_string(origin).unwrap_or_default();
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(canonical.as_bytes());
    hasher.update([0u8]); // '\0' 分隔符：descriptor JSON 与 rel 边界不可伪造
    hasher.update(archive_rel_path.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 失效判定（spec §4.2）：size 不同 → 失效；双方 mtime Some 且不同 → 失效；
/// 行 mtime None → size 唯一判据（SMB mtime 缺失场景）保守放行；
/// 行有 mtime 但远端当前 None → 保守失效
pub fn is_stale(row_origin_size: i64, row_origin_mtime: Option<i64>, current: &FileStat) -> bool {
    if row_origin_size != current.size as i64 { return true; }
    match (row_origin_mtime, current.modified_at) {
        (Some(r), Some(c)) => r != c,
        (None, _) => false,
        (Some(_), None) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::descriptor::SourceDescriptor;
    use crate::source::trait_def::FileStat;

    fn webdav(path: &str) -> SourceDescriptor {
        SourceDescriptor::WebDav { account_id: 7, base_url: "https://d/x".into(), path: path.into() }
    }

    #[test]
    fn cache_key_stable_and_discriminating() {
        let k1 = cache_key(&webdav(""), "books/a.cbz");
        assert_eq!(k1, cache_key(&webdav(""), "books/a.cbz"), "同 origin+rel 同 key");
        assert_ne!(k1, cache_key(&webdav(""), "books/b.cbz"), "不同 rel 分 key");
        assert_ne!(k1, cache_key(&webdav("sub"), "books/a.cbz"), "不同 origin path 分 key");
        assert_eq!(k1.len(), 64, "sha256 hex");
    }

    #[test]
    fn is_stale_matrix() {
        let base = FileStat { size: 100, modified_at: Some(1000) };
        assert!(!is_stale(100, Some(1000), &base), "完全一致 → 新鲜");
        assert!(is_stale(200, Some(1000), &base), "size 变 → 失效");
        assert!(is_stale(100, Some(2000), &base), "mtime 变 → 失效");
        assert!(!is_stale(100, None, &base), "行 mtime None（物化时源没给）→ size 唯一判据，放行");
        assert!(is_stale(100, Some(1000), &FileStat { size: 100, modified_at: None }),
                "行有 mtime 但远端现在没有 → 保守失效（源行为变化）");
    }
}
