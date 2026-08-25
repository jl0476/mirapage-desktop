//! 任务 11：session/prepare/unlock/commit/cancel IPC 外壳。
//!
//! 五命令直接转发 `ArchiveService` 的 request registry（任务 7 核心 + 任务 10
//! commit-gated prefetch）：
//! - `begin_archive_session(sessionId, bootMs) -> u64`：UUID 文本校验；`bootMs >=`
//!   当前 boot 才换代（取消旧 active + 清水位）；严格更旧返回现有 boot（被销毁
//!   WebView 的迟到 begin 不得反夺）；同 id 幂等。返回生效代次服务回拨恢复路径
//!   （返回值 > 自身上报 boot → 换新 UUID 以返回值+1 重试一次，任务 12
//!   `ensureArchiveSession`）。
//! - `prepare_archive` / `unlock_archive`：注册请求 → 解析/验证 → Ready 只转
//!   Prepared（不预载）；密码经 `Zeroizing` 包裹、只作 IPC 参数不落日志。
//! - `commit_archive_open`：幂等消费 Prepared（streaming 预载意图此时才启动）。
//! - `cancel_archive_prepare`：推进取消水位 + 取消在途物化订阅者（无返回值）。
//!
//! 迟到语义：旧 session 的 prepare/unlock/commit → `Cancelled`；迟到 cancel 幂等
//! no-op——进程存活期间空间常数，不随 reload 累积。

use crate::source::archive::backend::ArchiveAccessError;
use crate::source::archive::service::{ArchivePrepareResult, ArchiveRequestId, ArchiveService};
use crate::source::descriptor::SourceDescriptor;
use std::sync::Arc;

#[tauri::command]
pub fn begin_archive_session(
    service: tauri::State<'_, Arc<ArchiveService>>,
    session_id: String,
    boot_ms: u64,
) -> Result<u64, ArchiveAccessError> {
    service.begin_session(&session_id, boot_ms)
}

#[tauri::command]
pub async fn prepare_archive(
    service: tauri::State<'_, Arc<ArchiveService>>,
    descriptor: SourceDescriptor,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    prepare_archive_inner(service.inner().as_ref(), descriptor, request_id).await
}

async fn prepare_archive_inner(
    service: &ArchiveService,
    descriptor: SourceDescriptor,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    service.prepare_with_request(&descriptor, request_id).await
}

#[tauri::command]
pub async fn unlock_archive(
    service: tauri::State<'_, Arc<ArchiveService>>,
    descriptor: SourceDescriptor,
    password: String,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    unlock_archive_inner(service.inner().as_ref(), descriptor, password, request_id).await
}

async fn unlock_archive_inner(
    service: &ArchiveService,
    descriptor: SourceDescriptor,
    password: String,
    request_id: ArchiveRequestId,
) -> Result<ArchivePrepareResult, ArchiveAccessError> {
    let bytes = zeroize::Zeroizing::new(password.into_bytes());
    service.unlock_with_request(&descriptor, bytes, request_id).await
}

#[tauri::command]
pub async fn commit_archive_open(
    service: tauri::State<'_, Arc<ArchiveService>>,
    request_id: ArchiveRequestId,
) -> Result<(), ArchiveAccessError> {
    commit_archive_open_inner(service.inner().as_ref(), request_id).await
}

async fn commit_archive_open_inner(
    service: &ArchiveService,
    request_id: ArchiveRequestId,
) -> Result<(), ArchiveAccessError> {
    service.commit_request(&request_id).await
}

/// 幂等 cancel（迟到/未知 id 均 no-op）：恒返回 `Ok(())`——Tauri 要求带
/// `State<'_>` 引用的 async command 返回 Result；取消语义上没有失败路径。
#[tauri::command]
pub async fn cancel_archive_prepare(
    service: tauri::State<'_, Arc<ArchiveService>>,
    request_id: ArchiveRequestId,
) -> Result<(), ArchiveAccessError> {
    cancel_archive_prepare_inner(service.inner().as_ref(), request_id).await;
    Ok(())
}

async fn cancel_archive_prepare_inner(service: &ArchiveService, request_id: ArchiveRequestId) {
    service.cancel_request(&request_id).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::archive::cache_coordinator::ArchiveCacheCoordinator;
    use crate::source::archive::materializer::Materializer;
    use crate::source::archive::password::ArchiveIdentity;
    use crate::source::archive::prefetch::CommittedPrefetch;
    use crate::source::archive::rar_backend::RarBackend;
    use crate::source::archive::remote_zip::BLOCK_SIZE;
    use crate::source::archive::service::{ArchiveAccessMode, RequestState};
    use crate::source::archive::sevenz_backend::SevenZBackend;
    use crate::source::archive::zip_backend::ZipBackend;
    use crate::source::archive_impl::Materialize;
    use crate::source::descriptor::{ArchiveFormat, MediaEntry};
    use crate::source::trait_def::{
        ByteRange, FileStat, MediaSource, MediaSourceError,
    };
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tempfile::tempdir;

    const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\nmirapage-archive-access-test-image";

    // =========================================================================
    // mock：门闩（阻塞下载）/ 远端字节服务源 / commit-gated prefetch 观察桩
    // =========================================================================

    /// 下载门闩：release 前挂起全部 read（async 等待，不阻塞 worker 线程）；
    /// 30s 兜底超时防测试进程挂死。
    struct TestGate {
        released: AtomicBool,
        started: AtomicBool,
        notify: tokio::sync::Notify,
    }

    impl TestGate {
        fn new() -> Self {
            Self {
                released: AtomicBool::new(false),
                started: AtomicBool::new(false),
                notify: tokio::sync::Notify::new(),
            }
        }

        async fn wait_open(&self) {
            self.started.store(true, Ordering::SeqCst);
            let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
            while !self.released.load(Ordering::SeqCst) {
                let notified = self.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if self.released.load(Ordering::SeqCst) {
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                let _ = tokio::time::timeout_at(deadline, notified).await;
            }
        }
    }

    /// 远端字节服务源：stat 尺寸/mtime 与字节一致；read 支持精确 Range（流式
    /// reader 块加载）与全量（物化下载形状）；可选门闩阻塞。
    struct ServingOrigin {
        bytes: Vec<u8>,
        reads_started: Arc<AtomicUsize>,
        gate: Option<Arc<TestGate>>,
    }

    #[async_trait::async_trait]
    impl MediaSource for ServingOrigin {
        fn descriptor_type(&self) -> &'static str {
            "serving-origin"
        }

        async fn list_directory(
            &self,
            _: &SourceDescriptor,
            _: &str,
        ) -> crate::source::trait_def::Result<Vec<MediaEntry>> {
            Err(MediaSourceError::NotImplemented("serving-origin".into()))
        }

        async fn read_file(
            &self,
            _: &SourceDescriptor,
            _: &str,
            range: Option<ByteRange>,
        ) -> crate::source::trait_def::Result<Vec<u8>> {
            self.reads_started.fetch_add(1, Ordering::SeqCst);
            if let Some(gate) = &self.gate {
                gate.wait_open().await;
            }
            match range {
                Some(r) => {
                    let start = r.offset as usize;
                    let end = (r.offset + r.length) as usize;
                    self.bytes.get(start..end).map(|s| s.to_vec()).ok_or_else(|| {
                        MediaSourceError::Other(format!(
                            "serving-origin range 越界 {start}..{end} > {}",
                            self.bytes.len()
                        ))
                    })
                }
                None => Ok(self.bytes.clone()),
            }
        }

        async fn file_count(
            &self,
            _: &SourceDescriptor,
            _: &str,
        ) -> crate::source::trait_def::Result<u64> {
            Ok(0)
        }

        async fn stat(
            &self,
            _: &SourceDescriptor,
            _: &str,
        ) -> crate::source::trait_def::Result<FileStat> {
            Ok(FileStat { size: self.bytes.len() as u64, modified_at: Some(1000) })
        }

        async fn test(&self, _: &SourceDescriptor) -> crate::source::trait_def::Result<()> {
            Ok(())
        }
    }

    /// 本地直开用恒失败物化 mock——origin None 用例不应触达物化路径
    struct NeverMaterialize;

    #[async_trait::async_trait]
    impl Materialize for NeverMaterialize {
        async fn ensure_cached(
            &self,
            _origin: &SourceDescriptor,
            _archive_rel_path: &str,
            _format: ArchiveFormat,
        ) -> std::result::Result<PathBuf, crate::source::archive::materializer::MaterializeError>
        {
            Err(crate::source::archive::materializer::MaterializeError::Other(
                "mock 无物化".into(),
            ))
        }
    }

    /// commit-gated 后台物化观察桩：计数 + 记录最近一次 progress_key（后台任务
    /// spawn 后自灭，断言只看同步计数与 key）
    struct CountingPrefetchHook {
        mat: Arc<Materializer>,
        starts: Arc<AtomicUsize>,
        last_key: Arc<Mutex<Option<String>>>,
    }

    impl CommittedPrefetch for CountingPrefetchHook {
        fn prefetch_committed(&self, origin: SourceDescriptor, rel: String, progress_key: String) {
            self.starts.fetch_add(1, Ordering::SeqCst);
            *self.last_key.lock().unwrap() = Some(progress_key.clone());
            let mat = self.mat.clone();
            tokio::spawn(async move {
                let epoch = mat.current_epoch();
                let _ = mat
                    .ensure_cached_background(&origin, &rel, epoch, progress_key, ArchiveFormat::Cbz)
                    .await;
            });
        }
    }

    // =========================================================================
    // CommandHarness
    // =========================================================================

    struct CommandHarness {
        service: Arc<ArchiveService>,
        descriptor: SourceDescriptor,
        identity: ArchiveIdentity,
        gate: Option<Arc<TestGate>>,
        reads_started: Arc<AtomicUsize>,
        db: Option<crate::db::Db>,
        cache_root: Option<PathBuf>,
        prefetch_starts: Arc<AtomicUsize>,
        last_prefetch_key: Arc<Mutex<Option<String>>>,
        _dirs: Vec<tempfile::TempDir>,
    }

    /// 与 Service::resolve（origin None）同一套 identity 推导：canonicalize + 
    /// fs metadata size/mtime（秒）
    fn local_identity(path: &Path) -> ArchiveIdentity {
        let meta = std::fs::metadata(path).unwrap();
        let canonical = std::fs::canonicalize(path)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| path.display().to_string());
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        ArchiveIdentity::new(canonical, meta.len(), mtime)
    }

    fn write_plain_zip(path: &Path) {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            use std::io::Write;
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("page.png", options).unwrap();
            zip.write_all(PNG_BYTES).unwrap();
            zip.finish().unwrap();
        }
        std::fs::write(path, buf.into_inner()).unwrap();
    }

    fn write_encrypted_zip(path: &Path) {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            use std::io::Write;
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .with_aes_encryption(zip::AesMode::Aes256, "secret");
            zip.start_file("page.png", options).unwrap();
            zip.write_all(PNG_BYTES).unwrap();
            zip.finish().unwrap();
        }
        std::fs::write(path, buf.into_inner()).unwrap();
    }

    /// 尾块超过 BLOCK_SIZE 的 stored ZIP：probe/catalog 只触碰尾部块（流式），
    /// 物化下载是 (0, size) 全量读（与 service.rs 任务 10 harness 同构）
    fn streaming_zip_bytes() -> Vec<u8> {
        let pad = vec![0x5Au8; BLOCK_SIZE + 256 * 1024];
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            use std::io::Write;
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("page1.png", options).unwrap();
            zip.write_all(PNG_BYTES).unwrap();
            zip.start_file("pad.bin", options).unwrap();
            zip.write_all(&pad).unwrap();
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    fn plain_rar5_bytes() -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests")
                .join("fixtures")
                .join("archive")
                .join("plain-rar5.rar"),
        )
        .unwrap()
    }

    fn webdav_origin() -> SourceDescriptor {
        crate::source::archive::materializer::tests::webdav("")
    }

    impl CommandHarness {
        /// 本地直开（origin None）：真实三格式 backend + 恒失败物化 mock
        fn local(write: impl FnOnce(&Path)) -> Self {
            let dir = tempdir().unwrap();
            let path = dir.path().join("book.zip");
            write(&path);
            let identity = local_identity(&path);
            let service = Arc::new(ArchiveService::with_parts(
                Arc::new(NeverMaterialize),
                ArchiveCacheCoordinator::new_shared(),
                Arc::new(ZipBackend),
                Arc::new(RarBackend),
                Arc::new(SevenZBackend),
                crate::source::archive::backend::ArchiveLimits::production(),
                Arc::new(tokio::sync::Semaphore::new(512)),
            ));
            let descriptor = SourceDescriptor::Archive {
                archive_path: path.display().to_string(),
                entry_prefix: String::new(),
                format: ArchiveFormat::Zip,
                origin: None,
                origin_entry_path: None,
                archive_rel_path: None,
            };
            Self {
                service,
                descriptor,
                identity,
                gate: None,
                reads_started: Arc::new(AtomicUsize::new(0)),
                db: None,
                cache_root: None,
                prefetch_starts: Arc::new(AtomicUsize::new(0)),
                last_prefetch_key: Arc::new(Mutex::new(None)),
                _dirs: vec![dir],
            }
        }

        fn local_zip() -> Self {
            Self::local(write_plain_zip)
        }

        fn encrypted_zip() -> Self {
            Self::local(write_encrypted_zip)
        }

        /// 远程 harness：真实 Materializer（webdav 槽位 = ServingOrigin）+ 真实
        /// backend Service + commit-gated prefetch 观察桩
        fn remote(bytes: Vec<u8>, format: ArchiveFormat, rel: &str, gated: bool) -> Self {
            let dir = tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join("part")).unwrap();
            let db = crate::db::Db::open_in_memory().unwrap();
            let gate = gated.then(|| Arc::new(TestGate::new()));
            let reads_started = Arc::new(AtomicUsize::new(0));
            let origin_src = Arc::new(ServingOrigin {
                bytes,
                reads_started: reads_started.clone(),
                gate: gate.clone(),
            });
            let coordinator = ArchiveCacheCoordinator::new_shared();
            let mat = Arc::new(Materializer::new(
                origin_src.clone() as Arc<dyn MediaSource>,
                Arc::new(ServingOrigin {
                    bytes: Vec::new(),
                    reads_started: Arc::new(AtomicUsize::new(0)),
                    gate: None,
                }) as Arc<dyn MediaSource>,
                db.clone(),
                dir.path().to_path_buf(),
                coordinator.clone(),
            ));
            let service = Arc::new(ArchiveService::with_parts(
                mat.clone() as Arc<dyn Materialize>,
                coordinator,
                Arc::new(ZipBackend),
                Arc::new(RarBackend),
                Arc::new(SevenZBackend),
                crate::source::archive::backend::ArchiveLimits::production(),
                Arc::new(tokio::sync::Semaphore::new(512)),
            ));
            let prefetch_starts = Arc::new(AtomicUsize::new(0));
            let last_prefetch_key = Arc::new(Mutex::new(None));
            service.set_committed_prefetcher(Arc::new(CountingPrefetchHook {
                mat: mat.clone(),
                starts: prefetch_starts.clone(),
                last_key: last_prefetch_key.clone(),
            }));
            let descriptor = SourceDescriptor::Archive {
                archive_path: format!("https://d/x/{rel}"),
                entry_prefix: String::new(),
                format,
                origin: Some(Box::new(webdav_origin())),
                origin_entry_path: Some(rel.into()),
                archive_rel_path: Some(rel.into()),
            };
            Self {
                service,
                descriptor,
                identity: ArchiveIdentity::new("remote-harness", 0, None),
                gate,
                reads_started,
                db: Some(db),
                cache_root: Some(dir.path().to_path_buf()),
                prefetch_starts,
                last_prefetch_key,
                _dirs: vec![dir],
            }
        }

        /// 远程 RAR（非门闩）：完整物化后 RarBackend 真解析 plain-rar5.rar
        fn remote_rar() -> Self {
            Self::remote(plain_rar5_bytes(), ArchiveFormat::Rar, "book.rar", false)
        }

        /// 远程 RAR（门闩）：物化下载挂起在 TestGate 上——cancel/rollover 的靶子
        fn blocking_remote_rar() -> Self {
            Self::remote(plain_rar5_bytes(), ArchiveFormat::Rar, "book.rar", true)
        }

        /// 远程 ZIP 流式首开（尾块超 BLOCK_SIZE → Ready(Streaming)）
        fn streaming_remote_zip() -> Self {
            Self::remote(streaming_zip_bytes(), ArchiveFormat::Cbz, "book.cbz", false)
        }

        fn spawn_prepare(
            &self,
            request_id: ArchiveRequestId,
        ) -> tokio::task::JoinHandle<Result<ArchivePrepareResult, ArchiveAccessError>> {
            let service = self.service.clone();
            let descriptor = self.descriptor.clone();
            tokio::spawn(async move { prepare_archive_inner(&service, descriptor, request_id).await })
        }

        async fn wait_download_started(&self) {
            let deadline = Instant::now() + Duration::from_secs(10);
            while self.reads_started.load(Ordering::SeqCst) < 1 {
                assert!(Instant::now() < deadline, "物化下载在 10s 内未启动");
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }

        /// ready 表行或 final 文件任一存在（.part/.part.meta 半截下载不算）
        fn has_ready_row_or_final_file(&self) -> bool {
            let Some(db) = &self.db else { return false };
            let rows = {
                let conn = db.conn();
                crate::source::archive::dao::usage(&conn)
                    .map(|(count, _)| count)
                    .unwrap_or(0)
            };
            if rows > 0 {
                return true;
            }
            let Some(root) = &self.cache_root else { return false };
            std::fs::read_dir(root)
                .map(|entries| {
                    entries.filter_map(|e| e.ok()).any(|e| {
                        // 只看常规文件：part/ 子目录（.part 半截下载的家）不算 final
                        e.file_type().is_ok_and(|t| t.is_file())
                            && !e.file_name().to_string_lossy().contains(".part")
                    })
                })
                .unwrap_or(false)
        }

        fn prefetch_start_count(&self) -> usize {
            self.prefetch_starts.load(Ordering::SeqCst)
        }

        fn last_background_progress_key(&self) -> Option<String> {
            self.last_prefetch_key.lock().unwrap().clone()
        }
    }

    // =========================================================================
    // 合同测试（任务简报逐字用例）
    // =========================================================================

    #[tokio::test]
    async fn unlock_only_caches_verified_password() {
        let harness = CommandHarness::encrypted_zip();
        let session_id = "550e8400-e29b-41d4-a716-446655440020";
        harness.service.begin_session(session_id, 1_000).unwrap();
        let request_id = ArchiveRequestId::new(session_id, 1);
        assert_eq!(prepare_archive_inner(
            &harness.service, harness.descriptor.clone(), request_id.clone()
        ).await.unwrap(),
                   ArchivePrepareResult::PasswordRequired);
        assert_eq!(unlock_archive_inner(
            &harness.service, harness.descriptor.clone(), "wrong".into(), request_id.clone()
        ).await.unwrap_err(), ArchiveAccessError::WrongPassword);
        assert!(!harness.service.has_password(&harness.identity));
        assert_eq!(unlock_archive_inner(
            &harness.service, harness.descriptor, "secret".into(), request_id.clone()
        ).await.unwrap(), ArchivePrepareResult::Ready {
            access_mode: ArchiveAccessMode::Local,
            progress_key: None,
        });
        assert!(harness.service.has_password(&harness.identity));
        commit_archive_open_inner(&harness.service, request_id).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_request_stops_forced_materialization_without_committing() {
        let harness = CommandHarness::blocking_remote_rar();
        let session_id = "550e8400-e29b-41d4-a716-446655440021";
        harness.service.begin_session(session_id, 1_000).unwrap();
        let request_id = ArchiveRequestId::new(session_id, 2);
        let opening = harness.spawn_prepare(request_id.clone());
        harness.wait_download_started().await;
        cancel_archive_prepare_inner(&harness.service, request_id).await;
        assert_eq!(opening.await.unwrap().unwrap_err(), ArchiveAccessError::Cancelled);
        assert!(!harness.has_ready_row_or_final_file());
    }

    #[tokio::test]
    async fn cancel_before_register_is_observed_by_monotonic_high_water() {
        let harness = CommandHarness::remote_rar();
        let session_id = "550e8400-e29b-41d4-a716-446655440022";
        harness.service.begin_session(session_id, 1_000).unwrap();
        let cancelled = ArchiveRequestId::new(session_id, 7);
        cancel_archive_prepare_inner(&harness.service, cancelled.clone()).await;
        assert_eq!(prepare_archive_inner(
            &harness.service, harness.descriptor.clone(), cancelled
        ).await.unwrap_err(), ArchiveAccessError::Cancelled);
        assert_eq!(harness.service.cancelled_through(session_id), Some(7));
        assert!(harness.service.prepare_with_request(
            &harness.descriptor, ArchiveRequestId::new(session_id, 8)
        ).await.is_ok());
    }

    #[tokio::test]
    async fn prepare_does_not_prefetch_until_commit() {
        let harness = CommandHarness::streaming_remote_zip();
        let session_id = "550e8400-e29b-41d4-a716-446655440023";
        harness.service.begin_session(session_id, 1_000).unwrap();
        let request_id = ArchiveRequestId::new(session_id, 1);
        let ready = prepare_archive_inner(
            &harness.service, harness.descriptor.clone(), request_id.clone()
        ).await.unwrap();
        let progress_key = match ready {
            ArchivePrepareResult::Ready { access_mode: ArchiveAccessMode::Streaming, progress_key: Some(key) } => key,
            other => panic!("unexpected result: {other:?}"),
        };
        assert_eq!(harness.prefetch_start_count(), 0);
        commit_archive_open_inner(&harness.service, request_id.clone()).await.unwrap();
        commit_archive_open_inner(&harness.service, request_id).await.unwrap(); // idempotent
        assert_eq!(harness.prefetch_start_count(), 1);
        assert_eq!(harness.last_background_progress_key(), Some(progress_key));
    }

    #[tokio::test]
    async fn newer_request_cancels_old_prepared_and_sparse_commit_is_rejected() {
        let harness = CommandHarness::streaming_remote_zip();
        let session_id = "550e8400-e29b-41d4-a716-446655440024";
        harness.service.begin_session(session_id, 1_000).unwrap();
        let old = ArchiveRequestId::new(session_id, 1);
        let new = ArchiveRequestId::new(session_id, 3); // 故意留 sequence=2 空洞
        harness.service.prepare_with_request(&harness.descriptor, old.clone()).await.unwrap();
        harness.service.prepare_with_request(&harness.descriptor, new.clone()).await.unwrap();
        assert_eq!(harness.service.request_state(&old), None);
        harness.service.commit_request(&new).await.unwrap();
        harness.service.commit_request(&new).await.unwrap(); // 只对精确 last_committed 幂等
        assert_eq!(harness.prefetch_start_count(), 1);
        assert_eq!(harness.service.commit_request(&old).await.unwrap_err(),
                   ArchiveAccessError::Cancelled);
    }

    #[tokio::test]
    async fn session_rollover_cancels_and_reclaims_previous_webview_state() {
        let harness = CommandHarness::blocking_remote_rar();
        harness.service.begin_session("550e8400-e29b-41d4-a716-446655440000", 1_000).unwrap();
        let old = ArchiveRequestId::new("550e8400-e29b-41d4-a716-446655440000", 1);
        let opening = harness.spawn_prepare(old.clone());
        harness.wait_download_started().await;
        // 新 WebView 的 boot 更新（2_000 > 1_000），rollover 生效
        harness.service.begin_session("550e8400-e29b-41d4-a716-446655440001", 2_000).unwrap();
        assert_eq!(opening.await.unwrap().unwrap_err(), ArchiveAccessError::Cancelled);
        assert!(!harness.service.has_session(old.session_id()));
        assert_eq!(harness.service.commit_request(&old).await.unwrap_err(),
                   ArchiveAccessError::Cancelled);
    }

    #[tokio::test]
    async fn stale_boot_begin_cannot_rollover_established_session() {
        let harness = CommandHarness::local_zip();
        let new_session = "550e8400-e29b-41d4-a716-446655440031";
        assert_eq!(harness.service.begin_session(new_session, 2_000).unwrap(), 2_000);
        let request = ArchiveRequestId::new(new_session, 1);
        harness.service.prepare_with_request(&harness.descriptor, request.clone()).await.unwrap();
        // 旧 WebView 的迟到 begin（boot 更旧）不安装、不取消任何状态，返回当前生效代次
        assert_eq!(
            harness.service.begin_session("550e8400-e29b-41d4-a716-446655440030", 1_000).unwrap(),
            2_000
        );
        assert!(matches!(
            harness.service.request_state(&request),
            Some(RequestState::Prepared { .. })
        ));
        // 回拨恢复路径：携带生效值 + 1 的新 id 换代成功，旧 session 请求转为 Cancelled
        assert_eq!(
            harness.service.begin_session("550e8400-e29b-41d4-a716-446655440032", 2_001).unwrap(),
            2_001
        );
        assert_eq!(harness.service.commit_request(&request).await.unwrap_err(),
                   ArchiveAccessError::Cancelled);
    }

    #[test]
    fn equal_boot_later_begin_wins_as_documented_hmr_semantics() {
        let harness = CommandHarness::local_zip();
        harness.service.begin_session("550e8400-e29b-41d4-a716-446655440040", 1_000).unwrap();
        // 同 bootMs 后到者接管是为 HMR 同页换代选择的有意语义（先到者胜会杀死同毫秒的
        // 页面内换代）。"迟到 begin 无法反夺"的保证以 boot 严格更旧为界：跨 WebView
        // reload 的 boot 必然相差百毫秒以上、已被更旧拒绝覆盖；同毫秒且到达顺序颠倒的
        // 理论竞态明确接受（Tauri 同窗口 IPC FIFO 使跨页乱序实际不可达）。
        assert_eq!(
            harness.service.begin_session("550e8400-e29b-41d4-a716-446655440041", 1_000).unwrap(),
            1_000
        );
        assert!(!harness.service.has_session("550e8400-e29b-41d4-a716-446655440040"));
    }

    #[test]
    fn begin_session_rejects_non_uuid_or_oversized_ids() {
        let harness = CommandHarness::local_zip();
        assert!(matches!(harness.service.begin_session("session-a", 1_000),
                         Err(ArchiveAccessError::InvalidRequest(_))));
        assert!(matches!(harness.service.begin_session(&"a".repeat(65), 1_000),
                         Err(ArchiveAccessError::InvalidRequest(_))));
    }

    // =========================================================================
    // 审查回归修复用例（任务 11 复审）
    // =========================================================================

    /// 回归（关键）：同步 `#[tauri::command]` 在 wry 主线程内联执行、无 ambient
    /// tokio 上下文——旧实现 `Handle::try_current()` 在该形状下恒 Err，换代取消被
    /// 静默跳过（#[tokio::test] 的 ambient runtime 是测试盲区）。用纯 std 线程模拟
    /// 生产上下文：rollover 取消经 `tauri::async_runtime`（懒初始化全局 runtime）
    /// 仍必须交付——旧请求的物化订阅者收到 Cancelled。
    #[tokio::test]
    async fn rollover_cancel_is_delivered_without_ambient_runtime() {
        let harness = CommandHarness::blocking_remote_rar();
        let old_session = "550e8400-e29b-41d4-a716-446655440060";
        harness.service.begin_session(old_session, 1_000).unwrap();
        let old = ArchiveRequestId::new(old_session, 1);
        let opening = harness.spawn_prepare(old.clone());
        harness.wait_download_started().await;
        // 纯 std 线程：无 ambient tokio runtime（生产 wry 主线程形状）内联换代
        let service = harness.service.clone();
        std::thread::spawn(move || {
            service
                .begin_session("550e8400-e29b-41d4-a716-446655440061", 2_000)
                .unwrap();
        })
        .join()
        .unwrap();
        assert_eq!(opening.await.unwrap().unwrap_err(), ArchiveAccessError::Cancelled);
        assert!(!harness.service.has_session(old.session_id()));
        assert_eq!(
            harness.service.commit_request(&old).await.unwrap_err(),
            ArchiveAccessError::Cancelled
        );
    }

    /// 回归（重要）：迟到 cancel(N) 且 N < active M 时不得清 M 槽——take-then-filter
    /// 会无条件清槽，使 M 的 prepare 成功后 commit 落入 Err(Cancelled)、预载意图
    /// 丢失；正确语义是 M 保持 Prepared 并正常 commit。
    #[tokio::test]
    async fn late_cancel_below_active_sequence_keeps_slot_and_commit_succeeds() {
        let harness = CommandHarness::streaming_remote_zip();
        let session_id = "550e8400-e29b-41d4-a716-446655440050";
        harness.service.begin_session(session_id, 1_000).unwrap();
        let active = ArchiveRequestId::new(session_id, 9);
        let ready = prepare_archive_inner(
            &harness.service, harness.descriptor.clone(), active.clone()
        ).await.unwrap();
        let progress_key = match ready {
            ArchivePrepareResult::Ready { access_mode: ArchiveAccessMode::Streaming, progress_key: Some(key) } => key,
            other => panic!("unexpected result: {other:?}"),
        };
        // 迟到 cancel：sequence 5 < active 9——不得移除 active 槽、不得取消其订阅者
        cancel_archive_prepare_inner(&harness.service, ArchiveRequestId::new(session_id, 5)).await;
        assert!(matches!(
            harness.service.request_state(&active),
            Some(RequestState::Prepared { .. })
        ));
        // M 之后正常 commit：成功且预载意图恰好启动一次
        assert_eq!(harness.prefetch_start_count(), 0);
        commit_archive_open_inner(&harness.service, active).await.unwrap();
        assert_eq!(harness.prefetch_start_count(), 1);
        assert_eq!(harness.last_background_progress_key(), Some(progress_key));
        // N=5 已在水位内：其后的 register 仍按 cancel-before-register 拒绝
        assert_eq!(
            prepare_archive_inner(
                &harness.service, harness.descriptor.clone(), ArchiveRequestId::new(session_id, 5)
            ).await.unwrap_err(),
            ArchiveAccessError::Cancelled
        );
    }
}
