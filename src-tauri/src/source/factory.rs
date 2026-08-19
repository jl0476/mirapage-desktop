//! `MediaSourceFactory` —— 按 `SourceDescriptor` 类型分派到具体实现
//!
//! **设计目的**：UI 层从不直接调用 `LocalMediaSource` 或 `SmbMediaSource`，
//! 而是通过 `factory.resolve(&descriptor)` 拿到 `Arc<dyn MediaSource>`。
//! 新增远程源（Phase 7-8）只需替换 stub，UI 完全不动。

use crate::source::archive_impl::ArchiveMediaSource;
use crate::source::descriptor::SourceDescriptor;
use crate::source::local::LocalMediaSource;
use crate::source::smb_impl::SmbMediaSource;
use crate::source::trait_def::MediaSource;
use crate::source::webdav_impl::WebDavMediaSource;
use std::sync::Arc;

/// 工厂：持有 4 种 `MediaSource` 实现（WebDav 持 DB+凭据取 Basic Auth）
#[derive(Clone)]
pub struct MediaSourceFactory {
    local: Arc<LocalMediaSource>,
    archive: Arc<ArchiveMediaSource>,
    smb: Arc<SmbMediaSource>,
    webdav: Arc<WebDavMediaSource>,
}

impl MediaSourceFactory {
    pub fn new(
        db: crate::db::Db,
        creds: std::sync::Arc<dyn crate::credentials::CredentialStore>,
    ) -> Self {
        Self {
            local: Arc::new(LocalMediaSource::new()),
            archive: Arc::new(ArchiveMediaSource::new()),
            smb: Arc::new(SmbMediaSource::new()),
            webdav: Arc::new(WebDavMediaSource::new(db, creds)),
        }
    }

    /// 按 `SourceDescriptor` 类型返回对应的 `MediaSource` 实现
    pub fn resolve(&self, descriptor: &SourceDescriptor) -> Arc<dyn MediaSource> {
        match descriptor {
            SourceDescriptor::Local { .. } => self.local.clone(),
            SourceDescriptor::Archive { .. } => self.archive.clone(),
            SourceDescriptor::Smb { .. } => self.smb.clone(),
            SourceDescriptor::WebDav { .. } => self.webdav.clone(),
        }
    }
}