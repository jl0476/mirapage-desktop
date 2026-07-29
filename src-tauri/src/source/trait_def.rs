//! `MediaSource` trait 定义
//!
//! 所有数据源实现此 trait。trait 方法都用 `async fn`，由 `tokio` 运行时驱动。

use crate::source::descriptor::{MediaEntry, SourceDescriptor};
use async_trait::async_trait;
use std::fmt;

/// `MediaSource` 实现错误
#[derive(Debug, thiserror::Error)]
pub enum MediaSourceError {
    #[error("路径不存在或无法访问: {0}")]
    NotFound(String),

    #[error("权限被拒绝: {0}")]
    PermissionDenied(String),

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("不支持的操作（当前阶段未实现）: {0}")]
    NotImplemented(String),

    #[error("网络错误: {0}")]
    Network(String),

    #[error("超时: {0}")]
    Timeout(String),

    #[error("其他错误: {0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, MediaSourceError>;

/// 文件 Range（用于分块 / 流式读取）
#[derive(Debug, Clone, Copy)]
pub struct ByteRange {
    pub offset: u64,
    pub length: u64,
}

impl ByteRange {
    pub fn new(offset: u64, length: u64) -> Self {
        Self { offset, length }
    }

    pub fn full() -> Self {
        Self { offset: 0, length: u64::MAX }
    }
}

/// `MediaSource` trait
///
/// **设计原则**：所有方法都基于 `SourceDescriptor` 描述的位置，无状态。
/// 会话状态（连接池、打开的文件等）由各实现内部维护。
#[async_trait]
pub trait MediaSource: Send + Sync {
    /// 此实现支持的源类型
    fn descriptor_type(&self) -> &'static str;

    /// 列出目录内容
    ///
    /// 返回按自然排序（`page2.jpg < page10.jpg`）的子项。
    /// 包含目录、文件（含图片 + 压缩包）。
    async fn list_directory(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<Vec<MediaEntry>>;

    /// 读取文件内容（含可选 Range）
    ///
    /// `range = None` 读整个文件；`Some(range)` 读字节范围。
    /// 大文件（远程源 / 压缩包）建议用 Range 分块。
    async fn read_file(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>>;

    /// 获取文件总数（压缩包为条目数，目录为图片文件数）
    async fn file_count(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<u64>;

    /// 测试连接 / 验证路径（用于添加账户、保存前）
    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()>;
}

/// 统一格式化 `Result<T, MediaSourceError>` 为字符串（用于 Tauri command 返回）
pub fn format_error(e: &MediaSourceError) -> String {
    format!("{}", e)
}

/// `Result` 别名，方便 `?` 在 trait 方法中使用
pub type StdResult<T, E = Box<dyn std::error::Error + Send + Sync>> = std::result::Result<T, E>;