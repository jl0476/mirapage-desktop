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

use std::fmt;

use serde::{Deserialize, Serialize};

pub mod fetch;
pub mod generator;
pub mod index;
pub mod key;
pub mod migration;
pub mod orientation;
pub mod policy;
pub mod scheduler;
pub mod service;

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

impl fmt::Display for Priority {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // P1: Debug 格式派生（"Visible" 等）。若用 `{}` (Display) 而未 derive，
        // 输出空字符串 —— 之前 scheduler.rs 中所有 `priority={}` 静默空，无法
        // 排查卡在 queued 的任务。统一用 Display 让 `{}` 与 `{:?}` 同输出。
        write!(f, "{:?}", self)
    }
}

/// 单张缩略图生成的阶段步进（前端进度显示用，§3.1）。
/// `Queued` 不经 generate_thumbnail（前端 IPC 返回即设置），故 generator 只发后 4 个。
/// Serialize + rename_all = "lowercase"（round-1 P1）：序列化契约测试直接
/// `serde_json::to_string(&GenPhase::X)`，漏 derive 无法编译；模式对齐 `Priority`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GenPhase {
    Queued,
    Decoding,
    Resizing,
    Encoding,
    Writing,
}

/// GenPhase → 事件字符串（与前端 `ThumbnailPhase` 字面量一致）。
pub fn phase_str(p: GenPhase) -> &'static str {
    match p {
        GenPhase::Queued => "queued",
        GenPhase::Decoding => "decoding",
        GenPhase::Resizing => "resizing",
        GenPhase::Encoding => "encoding",
        GenPhase::Writing => "writing",
    }
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
///
/// **P0 修复**：必须 `rename_all = "camelCase"`。Tauri 2 对 struct 字段不做自动 case
/// 转换（只转顶层命令参数名），前端 `src/lib/thumbnail.ts` 发 camelCase（`sourceRelPath`
/// 等），漏标会导致反序列化失败 `missing field source_rel_path` -> `flushRequest` catch
/// 静默吞错 -> stateMap 永远空 -> 瀑布流卡片全 spinner。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailRequestItem {
    /// UI key（前端 entry.path，当前目录内相对），完成事件 `path` 字段用它。
    pub path: String,
    /// 相对 source root 的完整路径（含 currentPath 前缀，如 `normal/a.jpg`），
    /// 后端读文件 + cache key + 索引 rel_path 用。子目录场景必需。
    pub source_rel_path: String,
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

    /// 生成阶段枚举序列化字符串与前端 `src/lib/thumbnail.ts` 字面量字节级一致。
    #[test]
    fn gen_phase_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&GenPhase::Queued).unwrap(), r#""queued""#);
        assert_eq!(serde_json::to_string(&GenPhase::Decoding).unwrap(), r#""decoding""#);
        assert_eq!(serde_json::to_string(&GenPhase::Resizing).unwrap(), r#""resizing""#);
        assert_eq!(serde_json::to_string(&GenPhase::Encoding).unwrap(), r#""encoding""#);
        assert_eq!(serde_json::to_string(&GenPhase::Writing).unwrap(), r#""writing""#);
    }

    #[test]
    fn gen_phase_str_roundtrip() {
        assert_eq!(phase_str(GenPhase::Queued), "queued");
        assert_eq!(phase_str(GenPhase::Decoding), "decoding");
        assert_eq!(phase_str(GenPhase::Resizing), "resizing");
        assert_eq!(phase_str(GenPhase::Encoding), "encoding");
        assert_eq!(phase_str(GenPhase::Writing), "writing");
    }

    #[test]
    fn size_buckets_match_design() {
        assert_eq!(THUMBNAIL_SIZE_BUCKETS, &[512, 768, 1024, 1536, 2048]);
    }

    /// 回归 P0：`ThumbnailRequestItem` 必须接受前端发出的 camelCase JSON。
    /// 之前漏标 `rename_all = "camelCase"`，Tauri 2 不自动转 struct 字段 case，
    /// 导致 `missing field source_rel_path` -> 缩略图请求 100% 失败 -> 瀑布流全 spinner。
    #[test]
    fn thumbnail_request_item_deserializes_camel_case() {
        let json = r#"{"path":"a.jpg","sourceRelPath":"dir/a.jpg","fileSize":1234,"modifiedAt":1700000000,"sourceWidth":3840,"sourceHeight":2400,"requiredWidth":461,"priority":"visible"}"#;
        let item: ThumbnailRequestItem = serde_json::from_str(json).unwrap();
        assert_eq!(item.path, "a.jpg");
        assert_eq!(item.source_rel_path, "dir/a.jpg");
        assert_eq!(item.file_size, 1234);
        assert_eq!(item.source_width, 3840);
        assert_eq!(item.source_height, 2400);
        assert_eq!(item.required_width, 461);
        assert!(matches!(item.priority, Priority::Visible));
        // modifiedAt: null 也应可反序列化
        let json_null = r#"{"path":"b.jpg","sourceRelPath":"b.jpg","fileSize":0,"modifiedAt":null,"sourceWidth":100,"sourceHeight":100,"requiredWidth":100,"priority":"ahead"}"#;
        let item2: ThumbnailRequestItem = serde_json::from_str(json_null).unwrap();
        assert_eq!(item2.modified_at, None);
    }
}
