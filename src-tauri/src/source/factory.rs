//! `MediaSourceFactory` —— 按 `SourceDescriptor` 类型分派到具体实现
//!
//! **设计目的**：UI 层从不直接调用 `LocalMediaSource` 或 `SmbMediaSource`，
//! 而是通过 `factory.resolve(&descriptor)` 拿到 `Arc<dyn MediaSource>`。
//! 新增远程源（Phase 7-8）只需替换 stub，UI 完全不动。

use crate::source::archive::cache_coordinator::ArchiveCacheCoordinator;
use crate::source::archive::service::ArchiveService;
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
    /// 任务 7：runtime/磁盘 cache 的单一全局准入与清空协调器（catalog LRU、
    /// 后续 block LRU、Materializer 命中/下载共用；任务 8 起注入 Materializer）
    cache_coordinator: Arc<ArchiveCacheCoordinator>,
    /// 任务 7：五格式共享服务——ArchiveMediaSource、session/prepare IPC（任务 11）
    /// 与 commit-gated prefetch（任务 10）共用同一实例
    archive_service: Arc<ArchiveService>,
    /// 任务 10：commit-gated 后台物化的生产入口（Service 的 committed hook 注入
    /// 同一实例；lib.rs setup 从这里取，与 notify_archive_window 命令共享开关）
    archive_prefetcher: Arc<crate::source::archive::prefetch::ArchivePrefetcher>,
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
        // 构造顺序（任务 7 固定）：具体远程源 → ArchiveCacheCoordinator →
        // Materializer（任务 8 起注入同一 coordinator——ensure/ready 查询/物理下载
        // 共用单一 admission 闸门）→ ArchiveService → ArchiveMediaSource。
        // M3 spec §2 断环：Materializer 持具体源 Arc（不经 factory）——未来加源：
        // 此处追加 + materializer 源列表
        let cache_coordinator = ArchiveCacheCoordinator::new_shared();
        let cache_root = crate::archive_cache_root();
        let materializer = Arc::new(crate::source::archive::materializer::Materializer::new(
            webdav.clone() as Arc<dyn MediaSource>,
            smb.clone() as Arc<dyn MediaSource>,
            db.clone(),
            cache_root,
            cache_coordinator.clone(),
        ));
        let archive_service = Arc::new(ArchiveService::new(
            materializer.clone() as Arc<dyn Materialize>,
            cache_coordinator.clone(),
        ));
        // 任务 10：commit-gated 后台物化——Service 的 committed hook 注入同一
        // Prefetcher 实例（开关 / epoch 语义单点），setup 经 archive_prefetcher() 复用
        let archive_prefetcher = Arc::new(
            crate::source::archive::prefetch::ArchivePrefetcher::new(materializer.clone()),
        );
        archive_service.set_committed_prefetcher(archive_prefetcher.clone());
        Self {
            local,
            archive: Arc::new(ArchiveMediaSource::new(archive_service.clone())),
            materializer,
            cache_coordinator,
            archive_service,
            archive_prefetcher,
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

    /// 任务 7：单一准入协调器（clear 命令与任务 9 block LRU 共用同一实例）
    pub fn cache_coordinator(&self) -> Arc<ArchiveCacheCoordinator> {
        self.cache_coordinator.clone()
    }

    /// 任务 7：五格式共享服务——session/prepare/unlock IPC（任务 11）与
    /// commit-gated prefetch（任务 10）从这里取同一实例，不得另建
    pub fn archive_service(&self) -> Arc<ArchiveService> {
        self.archive_service.clone()
    }

    /// 任务 10：commit-gated 后台物化的生产 Prefetcher——Service committed hook
    /// 已注入同一实例；lib.rs setup 从这里取（开关读取/设置单点，不另建）
    pub fn archive_prefetcher(
        &self,
    ) -> Arc<crate::source::archive::prefetch::ArchivePrefetcher> {
        self.archive_prefetcher.clone()
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