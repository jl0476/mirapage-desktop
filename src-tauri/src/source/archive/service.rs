//! 共享 `ArchiveService`（任务 7）：格式分派、会话密码库、catalog LRU、
//! 工作集许可（增长-回退协议）与单窗口 request registry 的唯一权威。
//!
//! - **密码判定**只看 probe（`ArchiveProbe` 是加密元数据唯一真值源）：当前 prefix
//!   视图 `image_count > 0` 只看 `first_encrypted_image`（加密普通文件不阻塞可读
//!   图片）；`image_count == 0` 才看 `first_encrypted_file`；`entry_count == 0`/
//!   空图视图映射 `EmptyArchive`。cache hit 不替代密码证明——候选存在而同 identity
//!   password store 为空一律 `PasswordRequired`。
//! - **工作集许可只作用于 `read_entry`**：`list/stat` 仅走格式 semaphore 与元数据
//!   限额。read 按声明预检（`checked_add` 拒绝，不 `min()` 钳位）→ MiB 向上取整初始
//!   许可 → backend 内 `try_grow` 同步增长；增长失败返回 `BudgetRetryRequired`
//!   （`#[serde(skip_serializing)]`，本 Service 是唯一消费点）→ 释放全部已持许可、
//!   按 `entry_dict + output_cap = workspace_budget` 全量重新排队从头重解压（重试
//!   上限 1 次；全量持有下再出现该 marker 属契约违反，终态映射
//!   `ResourceLimitExceeded` + log error）。等待全量的任务持有量为零，依赖图无环
//!   不死锁。**预算覆盖范围是解码期间的工作集**：交付后的 `Vec` 驻留由单条目
//!   512 MiB 硬上限兜底。
//! - **request registry**（单主窗口单 session）：`begin_session` 按 WebView 页面
//!   boot 代次接受换代、拒绝更旧 boot 的迟到 begin；cancel 推进单调
//!   `cancelled_through` 水位（cancel-before-register）；commit 只接受 Prepared
//!   active 且精确幂等（`sequence == last_committed` 才重试成功）。
//! - 远程 ZIP/CBZ 在任务 10 前继续完整物化（`ArchiveInput::Path`）；Ready 的
//!   `progress_key` 本地恒 `None`，远程为 Materializer 的 opaque cache key。

use crate::source::archive::backend::{
    ArchiveAccessError, ArchiveBackend, ArchiveCatalog, ArchiveInput, ArchiveLimits,
    ArchiveProbe, DecodeBudget,
};
use crate::source::archive::cache_coordinator::ArchiveCacheCoordinator;
use crate::source::archive::password::{ArchiveIdentity, ArchivePasswordStore};
use crate::source::archive::rar_backend::RarBackend;
use crate::source::archive::sevenz_backend::SevenZBackend;
use crate::source::archive::zip_backend::ZipBackend;
use crate::source::archive_impl::Materialize;
use crate::source::archive::materializer::MaterializeError;
use crate::source::descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use zeroize::Zeroizing;

/// catalog LRU 容量（spec：32 项）
const CATALOG_LRU_CAPACITY: usize = 32;
/// MiB 字节数（permit 粒度）
const MIB: u64 = 1024 * 1024;

// ---------------------------------------------------------------------------
// IPC 可见结果类型（任务 11 只加 Tauri 外壳）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequestId {
    pub session_id: String,
    pub sequence: u64,
}

impl ArchiveRequestId {
    pub fn new(session_id: &str, sequence: u64) -> Self {
        Self { session_id: session_id.to_owned(), sequence }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveAccessMode {
    Local,
    Streaming,
    Materialized,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ArchivePrepareResult {
    Ready {
        #[serde(rename = "accessMode")]
        access_mode: ArchiveAccessMode,
        #[serde(rename = "progressKey")]
        progress_key: Option<String>,
    },
    PasswordRequired,
}

/// request registry 状态（任务 10 给 Prepared 增加 streaming prefetch intent）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestState {
    Running,
    AwaitingPassword,
    Prepared { progress_key: Option<String> },
    Cancelled,
}

// ---------------------------------------------------------------------------
// 最小 LRU（无外部依赖；容量 32，O(n) touch 可接受）
// ---------------------------------------------------------------------------

struct LruCache<K, V> {
    entries: HashMap<K, V>,
    order: VecDeque<K>,
    capacity: usize,
}

impl<K: Clone + Eq + std::hash::Hash, V> LruCache<K, V> {
    fn new(capacity: usize) -> Self {
        Self { entries: HashMap::new(), order: VecDeque::new(), capacity }
    }

    fn refresh(&mut self, key: &K) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
            self.order.push_back(key.clone());
        }
    }

    fn get_entry(&mut self, key: &K) -> Option<&mut V> {
        if self.entries.contains_key(key) {
            self.refresh(key);
            self.entries.get_mut(key)
        } else {
            None
        }
    }

    fn insert_entry(&mut self, key: K, value: V) {
        if self.entries.contains_key(&key) {
            self.refresh(&key);
        } else {
            self.order.push_back(key.clone());
        }
        self.entries.insert(key, value);
        while self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.entries.remove(&evicted);
            }
        }
    }

    fn remove(&mut self, key: &K) -> Option<V> {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.entries.remove(key)
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
    }
}

/// catalog LRU 值：probe 与 catalog 都懒填充；加密信息以 probe 为唯一真值源
#[derive(Default)]
struct CachedCatalog {
    probe: Option<ArchiveProbe>,
    catalog: Option<ArchiveCatalog>,
}

type CatalogKey = (ArchiveIdentity, String);

// ---------------------------------------------------------------------------
// session registry
// ---------------------------------------------------------------------------

struct SessionState {
    session_id: String,
    boot_ms: u64,
    /// 取消高水位：sequence ≤ 水位的 register（cancel 先于注册）直接 Cancelled
    cancelled_through: u64,
    /// 最近一次成功 commit 的精确 sequence（幂等重试判定，不得用 <=）
    last_committed: Option<u64>,
    /// 每 session 恰有零或一个 active request
    active: Option<(u64, RequestState)>,
}

// ---------------------------------------------------------------------------
// ArchiveService
// ---------------------------------------------------------------------------

struct ResolvedArchive {
    input: ArchiveInput,
    identity: ArchiveIdentity,
    prefix: String,
    format: ArchiveFormat,
    access_mode: ArchiveAccessMode,
    progress_key: Option<String>,
}

pub struct ArchiveService {
    /// 工厂构造的同一 Materializer 实例（远程源完整物化；任务 8 接 subscriber）
    materializer: Arc<dyn Materialize>,
    coordinator: Arc<ArchiveCacheCoordinator>,
    zip: Arc<dyn ArchiveBackend>,
    rar: Arc<dyn ArchiveBackend>,
    sevenz: Arc<dyn ArchiveBackend>,
    passwords: ArchivePasswordStore,
    limits: ArchiveLimits,
    /// 格式并发上限（spec §4.3：ZIP 8 / RAR 2 / 7z 2）
    zip_semaphore: Arc<tokio::sync::Semaphore>,
    rar_semaphore: Arc<tokio::sync::Semaphore>,
    sevenz_semaphore: Arc<tokio::sync::Semaphore>,
    /// 加权内存 semaphore：1 MiB 粒度 permit（生产 512 个 = 工作集 512 MiB）
    memory_semaphore: Arc<tokio::sync::Semaphore>,
    catalog_lru: Mutex<LruCache<CatalogKey, CachedCatalog>>,
    /// 单主窗口：仅一个 current session
    registry: Mutex<Option<SessionState>>,
}

impl ArchiveService {
    /// 生产构造：真实三格式 backend + 生产限额 + 512 permit 内存 semaphore。
    pub fn new(
        materializer: Arc<dyn Materialize>,
        coordinator: Arc<ArchiveCacheCoordinator>,
    ) -> Self {
        let limits = ArchiveLimits::production();
        let memory_semaphore =
            Arc::new(tokio::sync::Semaphore::new((limits.workspace_budget_bytes / MIB) as usize));
        Self::with_parts(
            materializer,
            coordinator,
            Arc::new(ZipBackend),
            Arc::new(RarBackend),
            Arc::new(SevenZBackend),
            limits,
            memory_semaphore,
        )
    }

    /// 测试构造：注入 fake backend / 缩小的工作集预算与内存 semaphore。
    pub fn with_parts(
        materializer: Arc<dyn Materialize>,
        coordinator: Arc<ArchiveCacheCoordinator>,
        zip: Arc<dyn ArchiveBackend>,
        rar: Arc<dyn ArchiveBackend>,
        sevenz: Arc<dyn ArchiveBackend>,
        limits: ArchiveLimits,
        memory_semaphore: Arc<tokio::sync::Semaphore>,
    ) -> Self {
        Self {
            materializer,
            coordinator,
            zip,
            rar,
            sevenz,
            passwords: ArchivePasswordStore::default(),
            limits,
            zip_semaphore: Arc::new(tokio::sync::Semaphore::new(8)),
            rar_semaphore: Arc::new(tokio::sync::Semaphore::new(2)),
            sevenz_semaphore: Arc::new(tokio::sync::Semaphore::new(2)),
            memory_semaphore,
            catalog_lru: Mutex::new(LruCache::new(CATALOG_LRU_CAPACITY)),
            registry: Mutex::new(None),
        }
    }

    pub fn cache_coordinator(&self) -> Arc<ArchiveCacheCoordinator> {
        self.coordinator.clone()
    }

    /// 清运行时缓存（catalog LRU）。只能在 `ClearGuard` 存活且 active admission
    /// 排空后调用；代次不符（陈旧清空）no-op。**不清 password store**——手动清磁盘
    /// cache 不应强制用户重新输入密码；清 catalog 使下次访问重新解析并继续用同
    /// identity 的已验证密码。
    pub fn clear_runtime_caches_while_gated(&self, generation: u64) {
        if self.coordinator.generation() != generation {
            return;
        }
        self.catalog_lru.lock().unwrap().clear();
    }

    // -----------------------------------------------------------------------
    // descriptor 解析与 identity
    // -----------------------------------------------------------------------

    fn backend_for(&self, format: ArchiveFormat) -> Arc<dyn ArchiveBackend> {
        match format {
            ArchiveFormat::Cbz | ArchiveFormat::Zip => self.zip.clone(),
            ArchiveFormat::Cbr | ArchiveFormat::Rar => self.rar.clone(),
            ArchiveFormat::SevenZ => self.sevenz.clone(),
        }
    }

    fn format_semaphore(&self, format: ArchiveFormat) -> Arc<tokio::sync::Semaphore> {
        match format {
            ArchiveFormat::Cbz | ArchiveFormat::Zip => self.zip_semaphore.clone(),
            ArchiveFormat::Cbr | ArchiveFormat::Rar => self.rar_semaphore.clone(),
            ArchiveFormat::SevenZ => self.sevenz_semaphore.clone(),
        }
    }

    async fn acquire_format(
        &self,
        format: ArchiveFormat,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, ArchiveAccessError> {
        self.format_semaphore(format)
            .acquire_owned()
            .await
            .map_err(|_| ArchiveAccessError::Cancelled)
    }

    /// origin None 本地直开 / Some 完整物化（任务 10 前远程 ZIP 同样物化）。
    /// Local identity = 规范化绝对路径 + fs metadata size/mtime；远程 identity 用
    /// origin descriptor + rel（缓存文件重建不换 identity），size/mtime 取物化产物。
    async fn resolve(&self, descriptor: &SourceDescriptor) -> Result<ResolvedArchive, ArchiveAccessError> {
        let SourceDescriptor::Archive { archive_path, entry_prefix, format, origin, archive_rel_path, .. } =
            descriptor
        else {
            return Err(ArchiveAccessError::InvalidRequest(
                "descriptor 不是 Archive 变体".into(),
            ));
        };
        let (path, location, access_mode, progress_key, meta) = match origin {
            None => {
                let path = std::path::PathBuf::from(archive_path);
                let meta = fs_metadata(&path)?;
                let canonical = std::fs::canonicalize(&path)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|_| archive_path.clone());
                (path, canonical, ArchiveAccessMode::Local, None, meta)
            }
            Some(origin_desc) => {
                let rel = archive_rel_path.as_deref().ok_or_else(|| {
                    ArchiveAccessError::InvalidRequest("远程 archive 缺少 archiveRelPath".into())
                })?;
                // mock/生产实现均返回类型化 MaterializeError——Service 边界按变体映射
                // （FormatMismatch→InvalidRequest / Cancelled→Cancelled / NotFound 保真）
                let path = self
                    .materializer
                    .ensure_cached(origin_desc, rel, *format)
                    .await
                    .map_err(map_materialize_error)?;
                let meta = fs_metadata(&path)?;
                (
                    path,
                    format!("{}|{}", origin_desc.id(), rel),
                    ArchiveAccessMode::Materialized,
                    Some(crate::source::archive::materializer::cache_key(origin_desc, rel)),
                    meta,
                )
            }
        };
        let identity = ArchiveIdentity::new(location, meta.len(), mtime_secs(&meta));
        Ok(ResolvedArchive {
            input: ArchiveInput::Path(path),
            identity,
            prefix: entry_prefix.clone(),
            format: *format,
            access_mode,
            progress_key,
        })
    }

    // -----------------------------------------------------------------------
    // backend 调用（全部 spawn_blocking；join panic → CorruptArchive）
    // -----------------------------------------------------------------------

    async fn run_blocking<T, F>(f: F) -> Result<T, ArchiveAccessError>
    where
        F: FnOnce() -> Result<T, ArchiveAccessError> + Send + 'static,
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(|_| ArchiveAccessError::CorruptArchive("backend task panicked".into()))?
    }

    async fn run_probe(
        backend: Arc<dyn ArchiveBackend>,
        input: ArchiveInput,
        prefix: String,
        password: Option<Vec<u8>>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        Self::run_blocking(move || backend.probe(&input, &prefix, password.as_deref())).await
    }

    async fn run_catalog(
        backend: Arc<dyn ArchiveBackend>,
        input: ArchiveInput,
        prefix: String,
        password: Option<Vec<u8>>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError> {
        Self::run_blocking(move || backend.catalog(&input, &prefix, password.as_deref())).await
    }

    async fn run_stat(
        backend: Arc<dyn ArchiveBackend>,
        input: ArchiveInput,
        entry: String,
        password: Option<Vec<u8>>,
    ) -> Result<u64, ArchiveAccessError> {
        Self::run_blocking(move || backend.stat_entry(&input, &entry, password.as_deref())).await
    }

    async fn run_read(
        backend: Arc<dyn ArchiveBackend>,
        input: ArchiveInput,
        entry: String,
        password: Option<Vec<u8>>,
        mut budget: DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        // budget 整体 move 进 blocking 任务；backend 内部 mem::replace 消费真实槽位，
        // 许可随 writer drop（含错误路径）在 read_entry 返回时统一释放——
        // 每次 read 都必须新建 DecodeBudget，绝不复用槽位做第二次读取
        Self::run_blocking(move || backend.read_entry(&input, &entry, password.as_deref(), &mut budget))
            .await
    }

    // -----------------------------------------------------------------------
    // LRU 辅助（提交前 generation 复核：清空期间完成的加载不得复活已清数据）
    // -----------------------------------------------------------------------

    fn lru_probe(&self, key: &CatalogKey) -> Option<ArchiveProbe> {
        self.catalog_lru
            .lock()
            .unwrap()
            .get_entry(key)
            .and_then(|entry| entry.probe.clone())
    }

    fn lru_catalog(&self, key: &CatalogKey) -> Option<ArchiveCatalog> {
        self.catalog_lru
            .lock()
            .unwrap()
            .get_entry(key)
            .and_then(|entry| entry.catalog.clone())
    }

    fn store_probe(&self, key: &CatalogKey, probe: ArchiveProbe, generation: u64) {
        if self.coordinator.generation() != generation {
            return;
        }
        let mut lru = self.catalog_lru.lock().unwrap();
        if let Some(entry) = lru.get_entry(key) {
            entry.probe = Some(probe);
        } else {
            lru.insert_entry(key.clone(), CachedCatalog { probe: Some(probe), catalog: None });
        }
    }

    fn store_catalog(&self, key: &CatalogKey, catalog: ArchiveCatalog, generation: u64) {
        if self.coordinator.generation() != generation {
            return;
        }
        let mut lru = self.catalog_lru.lock().unwrap();
        if let Some(entry) = lru.get_entry(key) {
            entry.catalog = Some(catalog);
        } else {
            lru.insert_entry(
                key.clone(),
                CachedCatalog { probe: None, catalog: Some(catalog) },
            );
        }
    }

    /// 密码判定失败/验证失败：同时清旧密码与对应 catalog 项
    fn invalidate(&self, identity: &ArchiveIdentity, prefix: &str) {
        self.passwords.forget(identity);
        self.catalog_lru
            .lock()
            .unwrap()
            .remove(&(identity.clone(), prefix.to_string()));
    }

    /// LRU 未命中时取 probe（backend 调用）；PasswordRequired/WrongPassword 由调用方
    /// 决定清场语义，本方法只透传
    async fn probe_or_cache(
        &self,
        backend: &Arc<dyn ArchiveBackend>,
        input: &ArchiveInput,
        key: &CatalogKey,
        generation: u64,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError> {
        if let Some(hit) = self.lru_probe(key) {
            return Ok(hit);
        }
        let probe = Self::run_probe(
            backend.clone(),
            input.clone(),
            key.1.clone(),
            password.map(|p| p.to_vec()),
        )
        .await?;
        self.store_probe(key, probe.clone(), generation);
        Ok(probe)
    }

    // -----------------------------------------------------------------------
    // prepare / unlock / list / read / stat
    // -----------------------------------------------------------------------

    /// 密码需求判定（probe 单一真值源，见模块文档）。候选存在且同 identity 无已
    /// 验证密码 → `PasswordRequired`；有密码不重复验证（unlock 时已完整校验）。
    pub async fn prepare(
        &self,
        descriptor: &SourceDescriptor,
    ) -> Result<ArchivePrepareResult, ArchiveAccessError> {
        let admission = self.coordinator.admit()?;
        let generation = admission.generation();
        let resolved = self.resolve(descriptor).await?;
        let password = self.passwords.get(&resolved.identity);
        let backend = self.backend_for(resolved.format);
        let _permit = self.acquire_format(resolved.format).await?;
        let key = (resolved.identity.clone(), resolved.prefix.clone());
        let probe = match self
            .probe_or_cache(&backend, &resolved.input, &key, generation, password.as_deref().map(|v| v.as_slice()))
            .await
        {
            Ok(probe) => probe,
            // RAR -hp 等 probe 阶段索要密码 / 旧密码失效：清旧密码与 catalog 项后
            // 重新要求输入
            Err(ArchiveAccessError::PasswordRequired)
            | Err(ArchiveAccessError::WrongPassword) => {
                self.invalidate(&resolved.identity, &resolved.prefix);
                return Ok(ArchivePrepareResult::PasswordRequired);
            }
            Err(e) => return Err(e),
        };
        if probe.entry_count == 0 {
            return Err(ArchiveAccessError::EmptyArchive);
        }
        if probe.image_count == 0 {
            // 空图视图：加密普通文件存在且无密码才索要（经 first_encrypted_file
            // 验证成功的语义由 unlock 承载）；否则 EmptyArchive
            if probe.first_encrypted_file.is_some() && password.is_none() {
                return Ok(ArchivePrepareResult::PasswordRequired);
            }
            return Err(ArchiveAccessError::EmptyArchive);
        }
        if probe.first_encrypted_image.is_some() && password.is_none() {
            return Ok(ArchivePrepareResult::PasswordRequired);
        }
        Ok(ArchivePrepareResult::Ready {
            access_mode: resolved.access_mode,
            progress_key: resolved.progress_key,
        })
    }

    /// 密码验证：按 probe 同一优先级选验证条目（image_count > 0 用
    /// first_encrypted_image，否则 first_encrypted_file），**完整读取并校验成功**
    /// 才写 store；空图包验证成功后仍返回 EmptyArchive。
    pub async fn unlock(
        &self,
        descriptor: &SourceDescriptor,
        password: Zeroizing<Vec<u8>>,
    ) -> Result<ArchivePrepareResult, ArchiveAccessError> {
        let admission = self.coordinator.admit()?;
        let generation = admission.generation();
        let resolved = self.resolve(descriptor).await?;
        let backend = self.backend_for(resolved.format);
        let _permit = self.acquire_format(resolved.format).await?;
        let key = (resolved.identity.clone(), resolved.prefix.clone());
        // probe 本身对加密 header（RAR5 -hp）即密码校验：失败直接 WrongPassword
        let probe = match self
            .probe_or_cache(&backend, &resolved.input, &key, generation, Some(password.as_slice()))
            .await
        {
            Ok(probe) => probe,
            Err(ArchiveAccessError::WrongPassword)
            | Err(ArchiveAccessError::PasswordRequired) => {
                self.invalidate(&resolved.identity, &resolved.prefix);
                return Err(ArchiveAccessError::WrongPassword);
            }
            Err(e) => return Err(e),
        };
        if probe.entry_count == 0 {
            return Err(ArchiveAccessError::EmptyArchive);
        }
        let candidate = if probe.image_count > 0 {
            probe.first_encrypted_image.clone()
        } else {
            probe.first_encrypted_file.clone()
        };
        let Some(candidate) = candidate else {
            return Err(ArchiveAccessError::InvalidRequest(
                "archive 没有可验证的加密条目".into(),
            ));
        };
        let entry_dict = probe.entry_dictionaries.get(&candidate).copied().unwrap_or(0);
        let declared =
            Self::run_stat(backend.clone(), resolved.input.clone(), candidate.clone(), Some(password.to_vec()))
                .await?;
        match self
            .read_with_budget(
                &backend,
                &resolved.input,
                &candidate,
                Some(password.as_slice()),
                declared,
                entry_dict,
            )
            .await
        {
            Ok(_verified) => {}
            Err(ArchiveAccessError::WrongPassword) => {
                self.invalidate(&resolved.identity, &resolved.prefix);
                return Err(ArchiveAccessError::WrongPassword);
            }
            Err(e) => return Err(e),
        }
        self.passwords.insert(resolved.identity.clone(), password);
        if probe.image_count == 0 {
            // 密码已入库：空图包返回 EmptyArchive（下次 prepare 直接走空图分支）
            return Err(ArchiveAccessError::EmptyArchive);
        }
        Ok(ArchivePrepareResult::Ready {
            access_mode: resolved.access_mode,
            progress_key: resolved.progress_key,
        })
    }

    /// 列条目（catalog LRU 优先）。catalog 不做密码判定；backend 返回
    /// PasswordRequired/WrongPassword（RAR -hp）时清场并透传。
    pub async fn list(
        &self,
        descriptor: &SourceDescriptor,
    ) -> Result<Vec<MediaEntry>, ArchiveAccessError> {
        let admission = self.coordinator.admit()?;
        let generation = admission.generation();
        let resolved = self.resolve(descriptor).await?;
        let key = (resolved.identity.clone(), resolved.prefix.clone());
        if let Some(cached) = self.lru_catalog(&key) {
            return Ok(cached.entries);
        }
        let backend = self.backend_for(resolved.format);
        let _permit = self.acquire_format(resolved.format).await?;
        let password = self.passwords.get(&resolved.identity);
        let catalog = match Self::run_catalog(
            backend.clone(),
            resolved.input.clone(),
            resolved.prefix.clone(),
            password_bytes(&password),
        )
        .await
        {
            Ok(catalog) => catalog,
            Err(ArchiveAccessError::PasswordRequired) | Err(ArchiveAccessError::WrongPassword) => {
                self.invalidate(&resolved.identity, &resolved.prefix);
                return Err(ArchiveAccessError::PasswordRequired);
            }
            Err(e) => return Err(e),
        };
        self.store_catalog(&key, catalog.clone(), generation);
        Ok(catalog.entries)
    }

    /// 读单条目：工作集许可协议（见模块文档）。每次 read 新建 DecodeBudget。
    pub async fn read(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        let admission = self.coordinator.admit()?;
        let generation = admission.generation();
        let resolved = self.resolve(descriptor).await?;
        let password = self.passwords.get(&resolved.identity);
        let backend = self.backend_for(resolved.format);
        let entry = qualified_entry_name(&resolved.prefix, path);
        let key = (resolved.identity.clone(), resolved.prefix.clone());
        // entry_dict 按目标条目名从缓存的 probe 查询（仅 7z 非零；solid folder
        // 内多条目共享同值，不取全容器最大值）
        let probe = self
            .probe_or_cache(&backend, &resolved.input, &key, generation, password.as_deref().map(|v| v.as_slice()))
            .await?;
        let entry_dict = probe.entry_dictionaries.get(&entry).copied().unwrap_or(0);
        let _permit = self.acquire_format(resolved.format).await?;
        // 声明大小总是可得（ZIP central directory / RAR UnpSize / 7z entry size）
        let declared =
            Self::run_stat(backend.clone(), resolved.input.clone(), entry.clone(), password_bytes(&password))
                .await?;
        self.read_with_budget(&backend, &resolved.input, &entry, password.as_deref().map(|v| v.as_slice()), declared, entry_dict)
            .await
    }

    /// 条目声明 size（media:// 协议层 stat；明文元数据，无密码参与）
    pub async fn stat_entry_size(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<u64, ArchiveAccessError> {
        let _admission = self.coordinator.admit()?;
        let resolved = self.resolve(descriptor).await?;
        let backend = self.backend_for(resolved.format);
        let _permit = self.acquire_format(resolved.format).await?;
        let entry = qualified_entry_name(&resolved.prefix, path);
        let password = self.passwords.get(&resolved.identity);
        Self::run_stat(backend, resolved.input, entry, password_bytes(&password)).await
    }

    /// 工作集许可核心：声明预检 + 初始许可（`DecodeBudget::for_limits` 承载）→
    /// spawn_blocking 解码 → `BudgetRetryRequired` 触发「释放→全量→重解压」（重试
    /// 上限 1；全量后仍 retry 属契约违反 → 终态 ResourceLimitExceeded + log error）。
    async fn read_with_budget(
        &self,
        backend: &Arc<dyn ArchiveBackend>,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        declared: u64,
        entry_dict: u64,
    ) -> Result<Vec<u8>, ArchiveAccessError> {
        // ① 声明预检（checked_add 溢出/超预算拒绝，不 min() 钳位）+ ② 初始许可
        let budget = DecodeBudget::for_limits(
            &self.limits,
            declared,
            entry_dict,
            self.memory_semaphore.clone(),
        )
        .await?;
        match Self::run_read(
            backend.clone(),
            input.clone(),
            entry.to_string(),
            password.map(|p| p.to_vec()),
            budget,
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(ArchiveAccessError::BudgetRetryRequired) => {}
            Err(e) => return Err(e),
        }
        // ③ 增长失败回退：真实许可已在 backend writer drop 时归还；此处按
        //    held_total 全量 = entry_dict + output_cap = workspace_budget 重新排队
        //    并从头重解压。等待全量期间持有量为零——依赖图无环，无死锁。
        let full_declared = self.limits.workspace_budget_bytes - entry_dict;
        let budget = DecodeBudget::for_limits(
            &self.limits,
            full_declared,
            entry_dict,
            self.memory_semaphore.clone(),
        )
        .await?;
        match Self::run_read(
            backend.clone(),
            input.clone(),
            entry.to_string(),
            password.map(|p| p.to_vec()),
            budget,
        )
        .await
        {
            Ok(bytes) => Ok(bytes),
            Err(ArchiveAccessError::BudgetRetryRequired) => {
                // 全量持有下增长不可能再失败——实现契约违反的终态兜底，
                // 保证任何路径都不把内部 marker 带到序列化边界
                crate::log::write_log(
                    "ERROR",
                    "archive",
                    "budget retry still required after full requeue (backend contract violation)",
                );
                Err(ArchiveAccessError::ResourceLimitExceeded(
                    "decode budget retry exceeded".into(),
                ))
            }
            Err(e) => Err(e),
        }
    }

    /// 测试专用：清除 identity 的已验证密码（cache hit 不替代密码证明用例）
    async fn forget_password_for_test(
        &self,
        descriptor: &SourceDescriptor,
    ) -> Result<(), ArchiveAccessError> {
        let _admission = self.coordinator.admit()?;
        let resolved = self.resolve(descriptor).await?;
        self.passwords.forget(&resolved.identity);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // request registry（任务 11 只加 IPC 外壳；规则见任务 11 步骤 3）
    // -----------------------------------------------------------------------

    /// 安装/换代 session：同 id 幂等返回该 session 的 boot；`boot_ms >=` 当前 boot
    /// 才换代（取消旧 active、清 cancelled_through/last_committed）；严格更旧的
    /// 迟到 begin 不安装不取消，返回现有 boot。session id 非空且 ≤ 64 bytes。
    pub fn begin_session(&self, session_id: &str, boot_ms: u64) -> Result<u64, ArchiveAccessError> {
        if session_id.is_empty() || session_id.len() > 64 {
            return Err(ArchiveAccessError::InvalidRequest(
                "session id 非法（需 1..=64 bytes）".into(),
            ));
        }
        let mut registry = self.registry.lock().unwrap();
        match registry.as_mut() {
            Some(current) if current.session_id == session_id => Ok(current.boot_ms),
            Some(current) if boot_ms < current.boot_ms => Ok(current.boot_ms),
            _ => {
                *registry = Some(SessionState {
                    session_id: session_id.to_string(),
                    boot_ms,
                    cancelled_through: 0,
                    last_committed: None,
                    active: None,
                });
                Ok(boot_ms)
            }
        }
    }

    /// 注册请求：session 不符或 sequence ≤ 取消水位（cancel-before-register）→
    /// `Cancelled`；否则原子取消/替换旧 active（每 session 恰零或一个 active）。
    fn register_request(&self, id: &ArchiveRequestId) -> Result<(), ArchiveAccessError> {
        let mut registry = self.registry.lock().unwrap();
        let Some(current) = registry.as_mut() else {
            return Err(ArchiveAccessError::Cancelled);
        };
        if current.session_id != id.session_id || id.sequence <= current.cancelled_through {
            return Err(ArchiveAccessError::Cancelled);
        }
        current.active = Some((id.sequence, RequestState::Running));
        Ok(())
    }

    /// 更新 active 状态：仅当 active 仍是同一 sequence（未被 cancel/替换）时生效
    fn set_request_state(&self, id: &ArchiveRequestId, state: RequestState) {
        let mut registry = self.registry.lock().unwrap();
        let Some(current) = registry.as_mut() else { return };
        if current.session_id != id.session_id {
            return;
        }
        if let Some((sequence, active)) = current.active.as_mut() {
            if *sequence == id.sequence {
                *active = state;
            }
        }
    }

    /// 错误/取消时清理 Running guard（Ready 保留 Prepared 到 commit/cancel）
    fn finish_request(&self, id: &ArchiveRequestId) {
        let mut registry = self.registry.lock().unwrap();
        let Some(current) = registry.as_mut() else { return };
        if current.session_id != id.session_id {
            return;
        }
        if current
            .active
            .as_ref()
            .is_some_and(|(sequence, _)| *sequence == id.sequence)
        {
            current.active = None;
        }
    }

    pub async fn prepare_with_request(
        &self,
        descriptor: &SourceDescriptor,
        request_id: ArchiveRequestId,
    ) -> Result<ArchivePrepareResult, ArchiveAccessError> {
        self.register_request(&request_id)?;
        match self.prepare(descriptor).await {
            Ok(result) => {
                let state = match &result {
                    ArchivePrepareResult::Ready { progress_key, .. } => {
                        RequestState::Prepared { progress_key: progress_key.clone() }
                    }
                    ArchivePrepareResult::PasswordRequired => RequestState::AwaitingPassword,
                };
                self.set_request_state(&request_id, state);
                Ok(result)
            }
            Err(e) => {
                self.finish_request(&request_id);
                Err(e)
            }
        }
    }

    pub async fn unlock_with_request(
        &self,
        descriptor: &SourceDescriptor,
        password: Zeroizing<Vec<u8>>,
        request_id: ArchiveRequestId,
    ) -> Result<ArchivePrepareResult, ArchiveAccessError> {
        self.register_request(&request_id)?;
        match self.unlock(descriptor, password).await {
            Ok(result) => {
                let state = match &result {
                    ArchivePrepareResult::Ready { progress_key, .. } => {
                        RequestState::Prepared { progress_key: progress_key.clone() }
                    }
                    ArchivePrepareResult::PasswordRequired => RequestState::AwaitingPassword,
                };
                self.set_request_state(&request_id, state);
                Ok(result)
            }
            Err(e) => {
                self.finish_request(&request_id);
                Err(e)
            }
        }
    }

    /// 幂等 commit：只接受 Prepared active；成功写入精确 `last_committed` 并移除
    /// active。只有 `sequence == last_committed` 的重试返回成功（不用 <= 把稀疏
    /// sequence 误判成功）。旧 session 的迟到 commit 一律 Cancelled。
    pub async fn commit_request(&self, id: &ArchiveRequestId) -> Result<(), ArchiveAccessError> {
        let mut registry = self.registry.lock().unwrap();
        let Some(current) = registry.as_mut() else {
            return Err(ArchiveAccessError::Cancelled);
        };
        if current.session_id != id.session_id {
            return Err(ArchiveAccessError::Cancelled);
        }
        if current.last_committed == Some(id.sequence) {
            return Ok(());
        }
        match current.active.take() {
            Some((sequence, RequestState::Prepared { .. })) if sequence == id.sequence => {
                current.last_committed = Some(sequence);
                Ok(())
            }
            Some((sequence, _)) if sequence == id.sequence => Err(
                ArchiveAccessError::InvalidRequest("request 尚未 Prepared，不能 commit".into()),
            ),
            _ => Err(ArchiveAccessError::Cancelled),
        }
    }

    /// 幂等 cancel：推进取消高水位；active.sequence ≤ 水位时取消未 commit 项。
    /// 已提交 id 为 no-op；旧 session 的迟到 cancel 不影响新 session。
    pub async fn cancel_request(&self, id: &ArchiveRequestId) {
        let mut registry = self.registry.lock().unwrap();
        let Some(current) = registry.as_mut() else { return };
        if current.session_id != id.session_id {
            return;
        }
        current.cancelled_through = current.cancelled_through.max(id.sequence);
        if current
            .active
            .as_ref()
            .is_some_and(|(sequence, _)| *sequence <= current.cancelled_through)
        {
            current.active = None;
        }
    }
}

// ---------------------------------------------------------------------------
// 辅助纯函数
// ---------------------------------------------------------------------------

/// prefix 视图内条目全名：`page.png` + prefix `章节一` → `章节一/page.png`
fn qualified_entry_name(prefix: &str, path: &str) -> String {
    if prefix.is_empty() {
        path.to_string()
    } else {
        format!("{}/{}", prefix.trim_end_matches('/'), path)
    }
}

fn fs_metadata(path: &std::path::Path) -> Result<std::fs::Metadata, ArchiveAccessError> {
    std::fs::metadata(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            ArchiveAccessError::EntryNotFound(path.display().to_string())
        }
        _ => ArchiveAccessError::Io(e.to_string()),
    })
}

/// 已存储密码（Zeroizing）→ blocking 任务的普通 Vec 拷贝
fn password_bytes(password: &Option<Zeroizing<Vec<u8>>>) -> Option<Vec<u8>> {
    password.as_ref().map(|p| p.as_slice().to_vec())
}

fn mtime_secs(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
}

/// Materializer 错误 → ArchiveAccessError：NotFound 保 EntryNotFound 语义
/// （media:// 404 合同），Network/Timeout 保类型；其余归 Io
fn map_materialize_error(e: MaterializeError) -> ArchiveAccessError {
    match e {
        MaterializeError::NotFound(s) => ArchiveAccessError::EntryNotFound(s),
        MaterializeError::Network(s) => ArchiveAccessError::Network(s),
        // spec §8 双重校验：descriptor 声明格式与路径扩展名不一致是调用方契约违反，
        // 不得透传为 Other/Io 字符串
        MaterializeError::FormatMismatch { declared, rel_path } => {
            ArchiveAccessError::InvalidRequest(format!(
                "descriptor 声明格式与扩展名不一致: declared={declared:?} rel={rel_path}"
            ))
        }
        // 取消不触发网络降级（任务 10 白名单外；IPC 层映射取消状态）
        MaterializeError::Cancelled => ArchiveAccessError::Cancelled,
        MaterializeError::Io(io) => ArchiveAccessError::Io(io.to_string()),
        MaterializeError::Other(s) => ArchiveAccessError::Io(s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::algorithm::mime::is_image;
    use crate::algorithm::natural_compare;
    use crate::source::archive::backend::{
        ArchiveAccessError, ArchiveBackend, ArchiveCatalog, ArchiveInput, ArchiveLimits,
        ArchiveProbe, BudgetRetryIoError, DecodeBudget, LimitedEntryIoError, LimitedEntryWriter,
    };
    use crate::source::archive::cache_coordinator::ArchiveCacheCoordinator;
    use crate::source::archive_impl::Materialize;
    use crate::source::descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
    use async_trait::async_trait;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::{Duration, Instant};
    use tempfile::tempdir;
    use zeroize::Zeroizing;

    const MIB: u64 = 1024 * 1024;

    // =========================================================================
    // fake backend：解耦「声明大小」与「实际输出」，承载谎报/并发/密码合同
    // =========================================================================

    #[derive(Default)]
    struct FakeGateState {
        armed: bool,
        open: bool,
    }

    /// 预算测试的启动闸：armed 后 read_entry 阻塞到 release（release_first 与
    /// release_all 语义等价——weighted 用例的串行化由内存 semaphore 承担，闸门
    /// 只需把首个解码任务按到测试观察到 started_count 之后）。
    #[derive(Default)]
    struct FakeGates {
        state: Mutex<FakeGateState>,
        cv: Condvar,
    }

    impl FakeGates {
        fn arm(&self) {
            self.state.lock().unwrap().armed = true;
        }
        fn release(&self) {
            self.state.lock().unwrap().open = true;
            self.cv.notify_all();
        }
        fn wait_open(&self) {
            let mut st = self.state.lock().unwrap();
            while st.armed && !st.open {
                st = self.cv.wait(st).unwrap();
            }
        }
    }

    #[derive(Default)]
    struct ActiveAccounting {
        active: usize,
        max_active: usize,
        current_bytes: u64,
        max_bytes: u64,
    }

    /// 解码窗口记账：read_entry 存续期间的活跃任务数与活跃输出字节（交付后的
    /// 返回 Vec 不计入——drop 时先于返回值释放）。
    struct ActiveTask<'a> {
        accounting: &'a Mutex<ActiveAccounting>,
        written: u64,
    }

    impl<'a> ActiveTask<'a> {
        fn begin(accounting: &'a Mutex<ActiveAccounting>) -> Self {
            let mut a = accounting.lock().unwrap();
            a.active += 1;
            a.max_active = a.max_active.max(a.active);
            Self { accounting, written: 0 }
        }
        fn note_bytes(&mut self, n: u64) {
            let mut a = self.accounting.lock().unwrap();
            self.written += n;
            a.current_bytes += n;
            a.max_bytes = a.max_bytes.max(a.current_bytes);
        }
    }

    impl Drop for ActiveTask<'_> {
        fn drop(&mut self) {
            let mut a = self.accounting.lock().unwrap();
            a.active -= 1;
            a.current_bytes -= self.written;
        }
    }

    #[derive(Default)]
    struct ConfiguredEntries {
        encrypted: Vec<(String, Vec<u8>)>,
        plain_files: Vec<String>,
        images: Vec<String>,
        empty: bool,
    }

    #[derive(Default)]
    enum FakeMode {
        /// 默认：单个加密图片 page.png、密码 secret——`cached_encrypted_catalog`
        /// 用例不显式 require_password 也走加密合同
        #[default]
        DefaultEncrypted,
        /// 显式条目配置（require_password / add_plain_file / add_plain_image / mark_empty）
        Configured(ConfiguredEntries),
        /// 预算模式（set_declared_size_mib / set_lying_entry 触发并 arm 闸门）：
        /// 无密码、诚实或谎报输出
        Budget { lying: HashMap<String, (u64, u64, u64)> },
    }

    struct FakeInner {
        mode: FakeMode,
        /// 全局默认声明（MiB）
        declared_mib: u64,
        last_password: Option<Vec<u8>>,
    }

    impl Default for FakeInner {
        fn default() -> Self {
            Self { mode: FakeMode::default(), declared_mib: 1, last_password: None }
        }
    }

    struct FakeArchiveBackend {
        state: Mutex<FakeInner>,
        gates: FakeGates,
        started: AtomicUsize,
        accounting: Mutex<ActiveAccounting>,
    }

    impl Default for FakeArchiveBackend {
        fn default() -> Self {
            Self {
                state: Mutex::new(FakeInner::default()),
                gates: FakeGates::default(),
                started: AtomicUsize::new(0),
                accounting: Mutex::new(ActiveAccounting::default()),
            }
        }
    }

    fn map_fake_io_error(e: std::io::Error) -> ArchiveAccessError {
        if e.get_ref().is_some_and(|c| c.is::<BudgetRetryIoError>()) {
            ArchiveAccessError::BudgetRetryRequired
        } else if let Some(limited) = e.get_ref().and_then(|c| c.downcast_ref::<LimitedEntryIoError>()) {
            ArchiveAccessError::ResourceLimitExceeded(limited.to_string())
        } else {
            ArchiveAccessError::Io(e.to_string())
        }
    }

    impl FakeArchiveBackend {
        fn with_configured<R>(&self, f: impl FnOnce(&mut ConfiguredEntries) -> R) -> R {
            let mut st = self.state.lock().unwrap();
            assert!(
                !matches!(st.mode, FakeMode::Budget { .. }),
                "fake：预算模式与条目配置不得混用"
            );
            if !matches!(st.mode, FakeMode::Configured(_)) {
                st.mode = FakeMode::Configured(ConfiguredEntries::default());
            }
            let FakeMode::Configured(fields) = &mut st.mode else {
                unreachable!()
            };
            f(fields)
        }

        fn require_password(&self, entry: &str, password: &[u8]) {
            self.with_configured(|c| c.encrypted.push((entry.to_string(), password.to_vec())));
        }

        fn add_plain_file(&self, entry: &str) {
            self.with_configured(|c| c.plain_files.push(entry.to_string()));
        }

        fn add_plain_image(&self, entry: &str) {
            self.with_configured(|c| c.images.push(entry.to_string()));
        }

        fn mark_empty(&self) {
            self.with_configured(|c| c.empty = true);
        }

        fn set_declared_size_mib(&self, mib: u64) {
            {
                let mut st = self.state.lock().unwrap();
                st.declared_mib = mib;
                st.mode = FakeMode::Budget { lying: HashMap::new() };
            }
            self.gates.arm();
        }

        fn set_lying_entry(&self, entry: &str, declared_mib: u64, actual_mib: u64, dict_mib: u64) {
            {
                let mut st = self.state.lock().unwrap();
                let lying = match &mut st.mode {
                    FakeMode::Budget { lying } => lying,
                    _ => {
                        st.mode = FakeMode::Budget { lying: HashMap::new() };
                        let FakeMode::Budget { lying } = &mut st.mode else {
                            unreachable!()
                        };
                        lying
                    }
                };
                lying.insert(entry.to_string(), (declared_mib, actual_mib, dict_mib));
            }
            // 不 arm 启动闸：单任务谎报用例（简报逐字）没有 release 调用，arm 会让
            // read_entry 永远阻塞在 Condvar 上（spawn_blocking 线程悬挂 → runtime
            // drop 等待 blocking 线程 → 测试进程挂死）。并发用例的确定性观察靠
            // started 单调计数器即可，无需闸门。
        }

        fn note_password(&self, password: Option<&[u8]>) {
            if let Some(p) = password {
                self.state.lock().unwrap().last_password = Some(p.to_vec());
            }
        }

        fn password_seen(&self) -> Option<Vec<u8>> {
            self.state.lock().unwrap().last_password.clone()
        }

        fn started_count(&self) -> usize {
            self.started.load(Ordering::SeqCst)
        }

        fn max_concurrent(&self) -> usize {
            self.accounting.lock().unwrap().max_active
        }

        fn max_concurrent_actual_bytes(&self) -> u64 {
            self.accounting.lock().unwrap().max_bytes
        }

        fn release_first(&self) {
            self.gates.release();
        }

        fn release_all(&self) {
            self.gates.release();
        }

        async fn wait_until_first_started(&self) {
            self.wait_until_started_n(1).await;
        }

        async fn wait_until_both_started(&self) {
            self.wait_until_started_n(2).await;
        }

        async fn wait_until_started_n(&self, n: usize) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while self.started.load(Ordering::SeqCst) < n {
                assert!(
                    Instant::now() < deadline,
                    "fake backend 等待 {n} 个解码任务启动超时"
                );
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }

        /// (name, encrypted) 列表（按注册顺序）
        fn entries_snapshot(&self) -> Vec<(String, bool)> {
            let st = self.state.lock().unwrap();
            match &st.mode {
                FakeMode::DefaultEncrypted => vec![("page.png".to_string(), true)],
                FakeMode::Configured(fields) => {
                    if fields.empty {
                        return vec![];
                    }
                    let mut v: Vec<(String, bool)> =
                        fields.encrypted.iter().map(|(n, _)| (n.clone(), true)).collect();
                    v.extend(fields.plain_files.iter().map(|n| (n.clone(), false)));
                    v.extend(fields.images.iter().map(|n| (n.clone(), false)));
                    v
                }
                FakeMode::Budget { lying } => {
                    lying.keys().map(|n| (n.clone(), false)).collect()
                }
            }
        }

        fn expected_password(&self, entry: &str) -> Option<Vec<u8>> {
            let st = self.state.lock().unwrap();
            match &st.mode {
                FakeMode::DefaultEncrypted if entry == "page.png" => Some(b"secret".to_vec()),
                FakeMode::Configured(fields) => fields
                    .encrypted
                    .iter()
                    .find(|(n, _)| n == entry)
                    .map(|(_, p)| p.clone()),
                _ => None,
            }
        }

        fn declared_bytes(&self, entry: &str) -> u64 {
            let st = self.state.lock().unwrap();
            match &st.mode {
                FakeMode::Budget { lying } => {
                    lying.get(entry).map(|(d, _, _)| *d).unwrap_or(st.declared_mib) * MIB
                }
                _ => st.declared_mib * MIB,
            }
        }

        fn actual_bytes(&self, entry: &str) -> u64 {
            let st = self.state.lock().unwrap();
            match &st.mode {
                FakeMode::Budget { lying } => {
                    lying.get(entry).map(|(_, a, _)| *a).unwrap_or(st.declared_mib) * MIB
                }
                // 非预算模式：小载荷即可（谎报/预算合同由 Budget 模式承载）
                _ => 64,
            }
        }
    }

    impl ArchiveBackend for FakeArchiveBackend {
        fn probe(
            &self,
            _input: &ArchiveInput,
            prefix: &str,
            password: Option<&[u8]>,
        ) -> Result<ArchiveProbe, ArchiveAccessError> {
            self.note_password(password);
            let mut probe = ArchiveProbe::default();
            for (name, encrypted) in self.entries_snapshot() {
                probe.entry_count += 1;
                if !name.starts_with(prefix) {
                    continue;
                }
                if is_image(&name) {
                    probe.image_count += 1;
                    if encrypted && probe.first_encrypted_image.is_none() {
                        probe.first_encrypted_image = Some(name);
                    }
                } else if encrypted && probe.first_encrypted_file.is_none() {
                    probe.first_encrypted_file = Some(name);
                }
            }
            let st = self.state.lock().unwrap();
            if let FakeMode::Budget { lying } = &st.mode {
                for (name, (_, _, dict)) in lying {
                    if *dict > 0 {
                        probe.entry_dictionaries.insert(name.clone(), dict * MIB);
                    }
                }
            }
            Ok(probe)
        }

        fn catalog(
            &self,
            _input: &ArchiveInput,
            prefix: &str,
            password: Option<&[u8]>,
        ) -> Result<ArchiveCatalog, ArchiveAccessError> {
            self.note_password(password);
            let mut entries: Vec<MediaEntry> = self
                .entries_snapshot()
                .into_iter()
                .filter(|(name, _)| name.starts_with(prefix) && is_image(name))
                .map(|(name, _)| MediaEntry {
                    size: self.declared_bytes(&name),
                    name: name.clone(),
                    path: name,
                    is_directory: false,
                    is_archive: false,
                    modified_at: None,
                })
                .collect();
            entries.sort_by(|a, b| natural_compare(&a.name, &b.name));
            Ok(ArchiveCatalog { entries })
        }

        fn read_entry(
            &self,
            _input: &ArchiveInput,
            entry: &str,
            password: Option<&[u8]>,
            budget: &mut DecodeBudget,
        ) -> Result<Vec<u8>, ArchiveAccessError> {
            let mut task = ActiveTask::begin(&self.accounting);
            self.started.fetch_add(1, Ordering::SeqCst);
            self.note_password(password);
            if let Some(expected) = self.expected_password(entry) {
                match password {
                    None => return Err(ArchiveAccessError::PasswordRequired),
                    Some(p) if p != expected.as_slice() => {
                        return Err(ArchiveAccessError::WrongPassword)
                    }
                    _ => {}
                }
            }
            let total = self.actual_bytes(entry) as usize;
            self.gates.wait_open();
            let writer_budget = std::mem::replace(budget, DecodeBudget::unbounded());
            let mut writer = LimitedEntryWriter::with_budget(writer_budget);
            let chunk = MIB as usize;
            let mut written = 0usize;
            while written < total {
                let n = chunk.min(total - written);
                writer.write_all(&vec![0u8; n]).map_err(map_fake_io_error)?;
                written += n;
                task.note_bytes(n as u64);
            }
            Ok(writer.finish())
        }

        fn stat_entry(
            &self,
            _input: &ArchiveInput,
            entry: &str,
            password: Option<&[u8]>,
        ) -> Result<u64, ArchiveAccessError> {
            self.note_password(password);
            Ok(self.declared_bytes(entry))
        }
    }

    // =========================================================================
    // ServiceHarness
    // =========================================================================

    /// 本地直开用恒失败物化 mock——origin None 用例不应触达物化路径
    struct NeverMaterialize;

    #[async_trait]
    impl Materialize for NeverMaterialize {
        async fn ensure_cached(
            &self,
            _origin: &SourceDescriptor,
            _archive_rel_path: &str,
            _format: ArchiveFormat,
        ) -> std::result::Result<PathBuf, MaterializeError> {
            Err(MaterializeError::Other("fake 无物化".into()))
        }
    }

    struct ServiceHarness {
        service: Arc<ArchiveService>,
        zip: Arc<FakeArchiveBackend>,
        rar: Arc<FakeArchiveBackend>,
        sevenz: Arc<FakeArchiveBackend>,
        zip_a: SourceDescriptor,
        zip_b: SourceDescriptor,
        sevenz_a: SourceDescriptor,
        _dir: tempfile::TempDir,
    }

    impl ServiceHarness {
        fn new() -> Self {
            Self::build(None)
        }

        fn with_memory_budget_mib(mib: u64) -> Self {
            Self::build(Some(mib))
        }

        fn build(memory_budget_mib: Option<u64>) -> Self {
            let zip = Arc::new(FakeArchiveBackend::default());
            let rar = Arc::new(FakeArchiveBackend::default());
            let sevenz = Arc::new(FakeArchiveBackend::default());
            let (limits, memory) = match memory_budget_mib {
                Some(mib) => (
                    ArchiveLimits::for_test().budget_bytes(mib * MIB),
                    Arc::new(tokio::sync::Semaphore::new(mib as usize)),
                ),
                None => {
                    let limits = ArchiveLimits::production();
                    let permits = (limits.workspace_budget_bytes / MIB) as usize;
                    (limits, Arc::new(tokio::sync::Semaphore::new(permits)))
                }
            };
            let service = Arc::new(ArchiveService::with_parts(
                Arc::new(NeverMaterialize),
                ArchiveCacheCoordinator::new_shared(),
                zip.clone(),
                rar.clone(),
                sevenz.clone(),
                limits,
                memory,
            ));
            let dir = tempdir().unwrap();
            let zip_a = Self::descriptor_at(dir.path(), "a.zip", ArchiveFormat::Zip);
            let zip_b = Self::descriptor_at(dir.path(), "b.zip", ArchiveFormat::Zip);
            let sevenz_a = Self::descriptor_at(dir.path(), "a.7z", ArchiveFormat::SevenZ);
            Self { service, zip, rar, sevenz, zip_a, zip_b, sevenz_a, _dir: dir }
        }

        fn descriptor_at(dir: &std::path::Path, name: &str, format: ArchiveFormat) -> SourceDescriptor {
            let path = dir.join(name);
            std::fs::write(&path, b"fake archive").unwrap();
            SourceDescriptor::Archive {
                archive_path: path.display().to_string(),
                entry_prefix: String::new(),
                format,
                origin: None,
                origin_entry_path: None,
                archive_rel_path: None,
            }
        }

        fn local_descriptor(&self, name: &str, format: ArchiveFormat) -> SourceDescriptor {
            Self::descriptor_at(self._dir.path(), name, format)
        }

        fn spawn_read(
            &self,
            descriptor: SourceDescriptor,
            entry: &str,
        ) -> tokio::task::JoinHandle<Result<Vec<u8>, ArchiveAccessError>> {
            let service = self.service.clone();
            let entry = entry.to_string();
            tokio::spawn(async move { service.read(&descriptor, &entry).await })
        }
    }

    // =========================================================================
    // 步骤 1 合同测试（任务简报逐字用例 + 五分支 + registry + 清缓存 + serde）
    // =========================================================================

    #[tokio::test]
    async fn service_dispatches_formats_and_reuses_verified_password() {
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("encrypted.cbr", ArchiveFormat::Cbr);
        harness.rar.require_password("page.png", b"secret");
        assert_eq!(
            harness.service.prepare(&descriptor).await.unwrap(),
            ArchivePrepareResult::PasswordRequired
        );
        assert_eq!(
            harness
                .service
                .unlock(&descriptor, zeroize::Zeroizing::new(b"wrong".to_vec()))
                .await
                .unwrap_err(),
            ArchiveAccessError::WrongPassword
        );
        assert_eq!(
            harness
                .service
                .unlock(&descriptor, Zeroizing::new(b"secret".to_vec()))
                .await
                .unwrap(),
            ArchivePrepareResult::Ready {
                access_mode: ArchiveAccessMode::Local,
                progress_key: None,
            }
        );
        let entries = harness.service.list(&descriptor).await.unwrap();
        assert_eq!(entries[0].name, "page.png");
        assert_eq!(harness.rar.password_seen(), Some(b"secret".to_vec()));
    }

    #[tokio::test]
    async fn cached_encrypted_catalog_never_replaces_password_proof() {
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("encrypted.cbz", ArchiveFormat::Cbz);
        harness
            .service
            .unlock(&descriptor, Zeroizing::new(b"secret".to_vec()))
            .await
            .unwrap();
        harness.service.list(&descriptor).await.unwrap(); // populate catalog LRU
        harness
            .service
            .forget_password_for_test(&descriptor)
            .await
            .unwrap();
        assert_eq!(
            harness.service.prepare(&descriptor).await.unwrap(),
            ArchivePrepareResult::PasswordRequired
        );
    }

    #[tokio::test]
    async fn weighted_memory_budget_serializes_large_decodes() {
        let harness = ServiceHarness::with_memory_budget_mib(8);
        harness.zip.set_declared_size_mib(8);
        let first = harness.spawn_read(harness.zip_a.clone(), "page.png");
        let second = harness.spawn_read(harness.zip_b.clone(), "page.png");
        harness.zip.wait_until_first_started().await;
        assert_eq!(harness.zip.started_count(), 1);
        harness.zip.release_first();
        let (a, b) = tokio::join!(first, second);
        a.unwrap().unwrap();
        b.unwrap().unwrap();
        assert_eq!(harness.zip.max_concurrent(), 1);
    }

    #[tokio::test]
    async fn lying_declared_size_is_capped_by_remaining_budget() {
        // fake SevenZ backend 承载非零 dict 合同（entry_dict 仅 7z 非零——用 zip fake 注入
        // 非零 dict 会违反格式合同、让 output_cap 计算失去意义）：声明 1 MiB、实际输出
        // 5 MiB、entry_dict 4 MiB、注入预算 8 MiB——声明和 5 ≤ 8 通过预检，实际输出越过
        // output_cap = 8 - 4 = 4 MiB 被终态拦截
        let harness = ServiceHarness::with_memory_budget_mib(8);
        harness.sevenz.set_lying_entry("page.png", 1, 5, 4); // (name, 声明 MiB, 实际输出 MiB, dict MiB)
        assert!(matches!(
            harness
                .spawn_read(harness.sevenz_a.clone(), "page.png")
                .await
                .unwrap()
                .unwrap_err(),
            ArchiveAccessError::ResourceLimitExceeded(_)
        ));
    }

    #[tokio::test]
    async fn concurrent_lying_reads_serialize_within_process_budget() {
        // 双谎报并发（dict=0，格式无关），注入 8 MiB 预算、各声明 1 MiB、实际各输出 6 MiB——
        // 不用生产级尺寸：join! 会真实持有先完成任务的返回 Vec，400 MiB 级会令 CI/开发机
        // OOM；小尺寸同样证明增长、回退、串行与 timeout 合同。后到者增长失败回退全量排队
        // （等待者持有量为零，无死锁），两任务的**解码窗口**在时间上串行化；timeout 包裹
        // join 锁定"不死锁"，两次读取按串行合同都成功（各 6 ≤ output_cap 8）。峰值计数只
        // 统计 backend 解码期间的活跃输出（max_concurrent_actual_bytes）——第一个任务返回
        // 的 Vec 已脱离许可、由单条目硬上限兜底，不在本预算断言范围（收窄合同见任务 7）。
        let harness = ServiceHarness::with_memory_budget_mib(8);
        harness.zip.set_lying_entry("a.png", 1, 6, 0); // (name, 声明 MiB, 实际输出 MiB, dict MiB)
        harness.zip.set_lying_entry("b.png", 1, 6, 0);
        let first = harness.spawn_read(harness.zip_a.clone(), "a.png");
        let second = harness.spawn_read(harness.zip_b.clone(), "b.png");
        harness.zip.wait_until_both_started().await;
        harness.zip.release_all();
        let (a, b) = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            async { tokio::join!(first, second) },
        )
        .await
        .expect("增长-回退协议死锁：join 未在超时内完成");
        a.unwrap().unwrap();
        b.unwrap().unwrap();
        assert!(harness.zip.max_concurrent_actual_bytes() <= 8 * 1024 * 1024);
    }

    // ---- 密码判定五分支（probe 的 image_count 分支规则） ----

    #[tokio::test]
    async fn encrypted_txt_only_archive_asks_password_then_empty_archive() {
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("notes.cbz", ArchiveFormat::Cbz);
        harness.zip.require_password("note.txt", b"secret");
        // 分支 1：纯加密 TXT 包先 PasswordRequired
        assert_eq!(
            harness.service.prepare(&descriptor).await.unwrap(),
            ArchivePrepareResult::PasswordRequired
        );
        assert_eq!(
            harness
                .service
                .unlock(&descriptor, Zeroizing::new(b"bad".to_vec()))
                .await
                .unwrap_err(),
            ArchiveAccessError::WrongPassword
        );
        // 分支 2：经 note.txt 验证成功后返回 EmptyArchive 且密码入库
        assert_eq!(
            harness
                .service
                .unlock(&descriptor, Zeroizing::new(b"secret".to_vec()))
                .await
                .unwrap_err(),
            ArchiveAccessError::EmptyArchive
        );
        // 密码入库证明：prepare 不再要求密码（仍 EmptyArchive——无图可读）
        assert_eq!(
            harness.service.prepare(&descriptor).await.unwrap_err(),
            ArchiveAccessError::EmptyArchive
        );
    }

    #[tokio::test]
    async fn plain_txt_only_and_empty_archives_are_empty_without_password_prompt() {
        // 分支 3：未加密纯 TXT 包直接 EmptyArchive
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("plain.cbz", ArchiveFormat::Cbz);
        harness.zip.add_plain_file("readme.txt");
        assert_eq!(
            harness.service.prepare(&descriptor).await.unwrap_err(),
            ArchiveAccessError::EmptyArchive
        );
        // 分支 4：空包 EmptyArchive 不误报密码
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("empty.cbz", ArchiveFormat::Cbz);
        harness.zip.mark_empty();
        assert_eq!(
            harness.service.prepare(&descriptor).await.unwrap_err(),
            ArchiveAccessError::EmptyArchive
        );
    }

    #[tokio::test]
    async fn mixed_archive_with_encrypted_readme_is_ready_without_password() {
        // 分支 5：混合包（未加密图片 + 加密 README）——加密普通文件不阻塞可读图片
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("mixed.cbz", ArchiveFormat::Cbz);
        harness.zip.add_plain_image("page.png");
        harness.zip.require_password("README.txt", b"secret");
        assert_eq!(
            harness.service.prepare(&descriptor).await.unwrap(),
            ArchivePrepareResult::Ready {
                access_mode: ArchiveAccessMode::Local,
                progress_key: None,
            }
        );
    }

    // ---- request registry 状态机 ----

    #[tokio::test]
    async fn session_registry_rollover_rejects_stale_boot_and_cancels_old_requests() {
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("plain.cbz", ArchiveFormat::Cbz);
        harness.zip.add_plain_image("page.png");
        assert_eq!(harness.service.begin_session("s1", 100).unwrap(), 100);
        // 更旧 boot 的迟到 begin：不安装、不取消，返回现有 session 的 boot
        assert_eq!(harness.service.begin_session("s2", 50).unwrap(), 100);
        let id = ArchiveRequestId { session_id: "s1".into(), sequence: 1 };
        assert!(matches!(
            harness.service.prepare_with_request(&descriptor, id.clone()).await.unwrap(),
            ArchivePrepareResult::Ready { .. }
        ));
        // 同 boot（>=）新 session 换代：旧 session 的 commit 即刻失效
        assert_eq!(harness.service.begin_session("s3", 100).unwrap(), 100);
        assert_eq!(
            harness.service.commit_request(&id).await.unwrap_err(),
            ArchiveAccessError::Cancelled
        );
        // 同 id 重试幂等：返回该 session 的 boot
        assert_eq!(harness.service.begin_session("s3", 100).unwrap(), 100);
        assert_eq!(harness.service.begin_session("s3", 77).unwrap(), 100);
    }

    #[tokio::test]
    async fn cancel_before_register_and_exact_idempotent_commit() {
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("plain.cbz", ArchiveFormat::Cbz);
        harness.zip.add_plain_image("page.png");
        // 无 session：一切请求直接 Cancelled
        assert_eq!(
            harness
                .service
                .prepare_with_request(
                    &descriptor,
                    ArchiveRequestId { session_id: "s".into(), sequence: 1 },
                )
                .await
                .unwrap_err(),
            ArchiveAccessError::Cancelled
        );
        harness.service.begin_session("s", 1).unwrap();
        // cancel-before-register：sequence 水位先行，后到的 register 直接 Cancelled
        harness
            .service
            .cancel_request(&ArchiveRequestId { session_id: "s".into(), sequence: 5 })
            .await;
        assert_eq!(
            harness
                .service
                .prepare_with_request(
                    &descriptor,
                    ArchiveRequestId { session_id: "s".into(), sequence: 5 },
                )
                .await
                .unwrap_err(),
            ArchiveAccessError::Cancelled
        );
        // 正常 register → Prepared → 精确幂等 commit
        let id6 = ArchiveRequestId { session_id: "s".into(), sequence: 6 };
        assert!(matches!(
            harness.service.prepare_with_request(&descriptor, id6.clone()).await.unwrap(),
            ArchivePrepareResult::Ready { .. }
        ));
        harness.service.commit_request(&id6).await.unwrap();
        harness.service.commit_request(&id6).await.unwrap();
        // cancel 已提交 id 为 no-op；稀疏/未注册 sequence 不能误判成功
        harness.service.cancel_request(&id6).await;
        assert_eq!(
            harness
                .service
                .commit_request(&ArchiveRequestId { session_id: "s".into(), sequence: 4 })
                .await
                .unwrap_err(),
            ArchiveAccessError::Cancelled
        );
        assert_eq!(
            harness
                .service
                .commit_request(&ArchiveRequestId { session_id: "s".into(), sequence: 7 })
                .await
                .unwrap_err(),
            ArchiveAccessError::Cancelled
        );
    }

    #[test]
    fn begin_session_rejects_invalid_session_ids() {
        let harness = ServiceHarness::new();
        assert!(matches!(
            harness.service.begin_session("", 1),
            Err(ArchiveAccessError::InvalidRequest(_))
        ));
        let long = "x".repeat(65);
        assert!(matches!(
            harness.service.begin_session(&long, 1),
            Err(ArchiveAccessError::InvalidRequest(_))
        ));
    }

    // ---- 清运行时缓存（catalog 清、密码留） ----

    #[tokio::test]
    async fn clear_runtime_caches_drops_catalog_but_keeps_verified_password() {
        let harness = ServiceHarness::new();
        let descriptor = harness.local_descriptor("encrypted.cbz", ArchiveFormat::Cbz);
        harness
            .service
            .unlock(&descriptor, Zeroizing::new(b"secret".to_vec()))
            .await
            .unwrap();
        harness.service.list(&descriptor).await.unwrap(); // populate LRU
        let coordinator = harness.service.cache_coordinator();
        let clear_guard = coordinator.begin_clear();
        assert!(coordinator.wait_drained(Duration::from_secs(2)).await);
        harness
            .service
            .clear_runtime_caches_while_gated(clear_guard.generation());
        drop(clear_guard);
        // catalog 被清 → list 重新解析；密码保留 → 后端拿到已验证密码而非 None
        let entries = harness.service.list(&descriptor).await.unwrap();
        assert_eq!(entries[0].name, "page.png");
        assert_eq!(harness.zip.password_seen(), Some(b"secret".to_vec()));
    }

    // ---- IPC 可见结果类型的序列化形状 ----

    #[test]
    fn prepare_result_serializes_as_camelcase_status_tag() {
        let ready = ArchivePrepareResult::Ready {
            access_mode: ArchiveAccessMode::Materialized,
            progress_key: Some("cache-key".into()),
        };
        assert_eq!(
            serde_json::to_value(&ready).unwrap(),
            serde_json::json!({
                "status": "ready",
                "accessMode": "materialized",
                "progressKey": "cache-key"
            })
        );
        assert_eq!(
            serde_json::to_value(&ArchivePrepareResult::PasswordRequired).unwrap(),
            serde_json::json!({ "status": "passwordRequired" })
        );
    }

    #[test]
    fn archive_request_id_round_trips_camelcase() {
        let id = ArchiveRequestId { session_id: "s-1".into(), sequence: 3 };
        let json = serde_json::to_value(&id).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "sessionId": "s-1", "sequence": 3 })
        );
        let back: ArchiveRequestId = serde_json::from_value(json).unwrap();
        assert_eq!(back, id);
    }
}
