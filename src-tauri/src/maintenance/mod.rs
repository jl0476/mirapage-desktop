//! 数据库保留与自动清理（v0.1.0-database-retention-and-cleanup）
//!
//! maintenance 模块职责（spec §5）：
//! - 浏览历史保留评分 / 候选选择 / 有界删除
//! - 跨域维护摘要（历史 + 缩略图）与用户手动预览入口
//!
//! 缩略图维护**不**在本模块重建——继续走既有 `ThumbnailService::evict_to_limit`
//! （`thumbnail::service`），容量元数据在 `thumbnail::index` DAO 内维护（spec §5/§6）。

pub mod history;

pub use history::{HistoryCleanupPreview, HistoryCleanupResult, HistoryRetentionConfig};
