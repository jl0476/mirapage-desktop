//! `MediaSourceFactory` —— 按 `SourceDescriptor` 类型分派到具体实现
//!
//! **设计目的**：UI 层从不直接调用 `LocalMediaSource` 或 `SmbMediaSource`，
//! 而是通过 `factory.resolve(&descriptor)` 拿到 `Arc<dyn MediaSource>`。
//! 新增远程源（Phase 7-8）只需替换 stub，UI 完全不动。

use crate::source::archive_impl::{ArchiveMediaSource, Materialize};
use crate::source::descriptor::SourceDescriptor;
use crate::source::local::LocalMediaSource;
use crate::source::smb::connection::SmbConnectionManager;
use crate::source::smb::source::SmbMediaSource;
use crate::source::trait_def::MediaSource;
use crate::source::webdav_impl::WebDavMediaSource;
use std::sync::Arc;

/// 工厂：持有 4 种 `MediaSource` 实现（WebDav 持 DB+凭据取 Basic Auth）
#[derive(Clone)]
pub struct MediaSourceFactory {
    local: Arc<LocalMediaSource>,
    archive: Arc<ArchiveMediaSource>,
    /// M3 任务 6：cache 管理命令经 `State<Arc<Materializer>>` 直接触达——与
    /// `archive` 源共享同一 Arc（cancel_all / begin_clearing 对在途任务即时生效）
    materializer: Arc<crate::source::archive::materializer::Materializer>,
    smb: Arc<SmbMediaSource>,
    webdav: Arc<WebDavMediaSource>,
}

impl MediaSourceFactory {
    pub fn new(
        db: crate::db::Db,
        creds: std::sync::Arc<dyn crate::credentials::CredentialStore>,
    ) -> Self {
        let local = Arc::new(LocalMediaSource::new());
        let smb = Arc::new(SmbMediaSource::new(Arc::new(
            SmbConnectionManager::new_production(db.clone(), creds.clone()),
        )));
        let webdav = Arc::new(WebDavMediaSource::new(db.clone(), creds));
        // M3 spec §2 断环：Materializer 持具体源 Arc（不经 factory），
        // ArchiveMediaSource 注入 Materializer——未来加源：此处追加 + materializer 源列表
        let cache_root = crate::archive_cache_root();
        let materializer = Arc::new(crate::source::archive::materializer::Materializer::new(
            webdav.clone() as Arc<dyn MediaSource>,
            smb.clone() as Arc<dyn MediaSource>,
            db.clone(),
            cache_root,
        ));
        Self {
            local,
            archive: Arc::new(ArchiveMediaSource::new(
                materializer.clone() as Arc<dyn Materialize>,
            )),
            materializer,
            smb,
            webdav,
        }
    }

    /// M3 任务 6：setup 里 `app.manage(factory.archive_materializer())`——cache 管理
    /// 命令（usage/evict/clear，任务 9）以 `State<Arc<Materializer>>` 直接触达，
    /// 与 factory 内 ArchiveMediaSource 注入的 `Arc<dyn Materialize>` 是同一实例
    pub fn archive_materializer(&self) -> Arc<crate::source::archive::materializer::Materializer> {
        self.materializer.clone()
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