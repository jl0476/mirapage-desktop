//! `MediaSource` 抽象层
//!
//! 任何图片源（本地目录、SMB、WebDAV、压缩包）都实现 `MediaSource` trait。
//! UI 层通过 `SourceDescriptor` 枚举描述一个位置，`MediaSourceFactory::resolve`
//! 返回对应的具体实现。这种设计让新增远程源不影响 UI 代码。
//!
//! ## 设计参考
//! - `DESIGN.md` §3 项目结构（`source/` 子模块）
//! - `DESIGN.md` §5 Phase 1（含 MediaSource 抽象定义）
//! - MiraPage Android: `data/source/MediaSource.kt`（参考语义，不复用代码）

pub mod archive_impl;
pub mod descriptor;
pub mod factory;
pub mod local;
pub mod smb_impl;
pub mod trait_def;
pub mod webdav_impl;

pub use descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
pub use factory::MediaSourceFactory;
pub use trait_def::MediaSource;