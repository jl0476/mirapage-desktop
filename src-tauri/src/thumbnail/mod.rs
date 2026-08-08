//! 缩略图缓存领域模块（v0.1.0-module3.0.7-masonry-thumbnail-cache）
//!
//! 设计依据：`docs/superpowers/specs/2026-08-08-masonry-thumbnail-cache-design.md`
//! 实现计划：`docs/superpowers/plans/2026-08-08-masonry-thumbnail-cache.md`
//!
//! ## 模块组织（按任务逐步落地）
//!
//! - `policy.rs`      尺寸档位、生成阈值、像素预算、资源预设、内存估算（纯函数）
//! - `orientation.rs` EXIF Orientation 1–8 → 像素变换映射
//! - `key.rs`         源身份 / 文件身份 / 策略版本 → 稳定 cache key
//! - `generator.rs`   读取 → 解码 → 方向归一化 → 缩放 → WebP 编码 → 原子写入
//! - `index.rs`       `thumbnail_cache` SQLite DAO、访问时间批量 flush、LRU 查询
//! - `scheduler.rs`   优先队列、worker、内存预算、in-flight 去重、stale 取消
//! - `service.rs`     Tauri managed state，串联 scheduler/index/事件/清理
//! - `migration.rs`   缓存目录校验、manifest、同盘移动 / 跨盘复制校验、恢复、回滚
//!
//! 本文件（mod.rs）只定义与前端 `src/lib/thumbnail.ts` **字段语义一致**的 serde 协议类型，
//! 以及贯穿各子模块的版本常量。具体策略实现在后续任务的子模块里。
//!
//! ## 序列化命名约定
//!
//! 与前端 TypeScript 一致：枚举变体走 `camelCase`（PowerSaver → "powerSaver"），
//! 单词型优先级走 `lowercase`（Visible → "visible"），结构体字段走 `camelCase`。
//! Tauri 在 IPC 边界对结构体字段自动做 snake_case ↔ camelCase 转换，但枚举变体
//! **不**自动转换，因此这里的 `rename_all` 必须与前端字符串精确对齐。

use serde::{Deserialize, Serialize};

pub mod generator;
pub mod index;
pub mod key;
pub mod orientation;
pub mod policy;

/// 缓存索引 / cache key 的算法版本。任何会改变缩略图输出的策略调整都递增此值，
/// 使旧缓存自然失效（由 LRU 清理）。参与 cache key 计算。
pub const THUMBNAIL_ALGORITHM_VERSION: u32 = 1;

/// 尺寸档位（§6.1）。选择「不小于需求宽度的最小档位」。
pub const THUMBNAIL_SIZE_BUCKETS: &[u32] = &[512, 768, 1024, 1536, 2048];

/// 资源模式（§8.1）。`Custom` 表示用户已手动改过高级参数，无固定预设。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceMode {
    PowerSaver,
    Balanced,
    Performance,
    Custom,
}

/// 缩略图清晰度（§6.1）。UI 三档，内部映射到 quality_margin / WebP 质量 / 最大档位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    Standard,
    High,
    Ultra,
}

/// 任务优先级（§5.2）。Visible > Ahead > Behind > Idle。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Visible,
    Ahead,
    Behind,
    Idle,
}

/// 一个资源预设的全部可调维度（§8.1）。Custom 模式无预设，由用户高级参数决定。
/// 注意：含 `f32` 屏数，仅 `PartialEq`，不 derive `Eq`。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ResourcePreset {
    pub worker_limit: u32,
    pub decode_memory_mb: u32,
    pub prefetch_screens: f32,
    pub idle_generation: bool,
    pub idle_prefetch_screens: f32,
}

/// 单张缩略图请求项（§13.2）。`required_width` 已在前端按列宽 × dpr × quality_margin 算好。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThumbnailRequestItem {
    pub path: String,
    pub file_size: u64,
    pub modified_at: Option<i64>,
    pub source_width: u32,
    pub source_height: u32,
    pub required_width: u32,
    pub priority: Priority,
}

/// 缩略图生成 / 缓存操作的统一错误类型。
#[derive(Debug, thiserror::Error)]
pub enum ThumbnailError {
    #[error("decode failed: {0}")]
    Decode(String),
    #[error("encode failed: {0}")]
    Encode(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid input: {0}")]
    Invalid(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 锁定 Rust 枚举序列化字符串与前端 `src/lib/thumbnail.ts` 字面量字节级一致。
    /// 前端不允许 import invoke 之外的解析，这些字符串是协议契约的一部分。
    #[test]
    fn resource_mode_serializes_camel_case() {
        assert_eq!(
            serde_json::to_string(&ResourceMode::PowerSaver).unwrap(),
            r#""powerSaver""#
        );
        assert_eq!(
            serde_json::to_string(&ResourceMode::Balanced).unwrap(),
            r#""balanced""#
        );
        assert_eq!(
            serde_json::to_string(&ResourceMode::Performance).unwrap(),
            r#""performance""#
        );
        assert_eq!(
            serde_json::to_string(&ResourceMode::Custom).unwrap(),
            r#""custom""#
        );
    }

    #[test]
    fn quality_serializes_camel_case() {
        assert_eq!(
            serde_json::to_string(&Quality::Standard).unwrap(),
            r#""standard""#
        );
        assert_eq!(serde_json::to_string(&Quality::High).unwrap(), r#""high""#);
        assert_eq!(serde_json::to_string(&Quality::Ultra).unwrap(), r#""ultra""#);
    }

    #[test]
    fn priority_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&Priority::Visible).unwrap(),
            r#""visible""#
        );
        assert_eq!(serde_json::to_string(&Priority::Ahead).unwrap(), r#""ahead""#);
        assert_eq!(
            serde_json::to_string(&Priority::Behind).unwrap(),
            r#""behind""#
        );
        assert_eq!(serde_json::to_string(&Priority::Idle).unwrap(), r#""idle""#);
    }

    #[test]
    fn priority_ordering_visible_highest() {
        assert!(Priority::Visible < Priority::Ahead);
        assert!(Priority::Ahead < Priority::Behind);
        assert!(Priority::Behind < Priority::Idle);
    }

    #[test]
    fn size_buckets_match_design() {
        assert_eq!(THUMBNAIL_SIZE_BUCKETS, &[512, 768, 1024, 1536, 2048]);
    }
}
