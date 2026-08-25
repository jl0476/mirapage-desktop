//! 远程 ZIP Range reader（任务 9）：`Read + Seek` 外观 + 固定块 LRU + singleflight。
//!
//! - [`RemoteZipReader`] 把远端 ZIP/CBZ 呈现为 `Box<dyn ArchiveReadSeek>`（zip crate
//!   按需 Seek/Read），底层按 [`BLOCK_SIZE`] 分块向 [`RangeOrigin`] 发精确 Range 请求；
//!   最后一块请求 `min(BLOCK_SIZE, size - block_start)`，短读在 loader 侧类型化为
//!   `RemoteRangeUnavailable`（降级白名单触发，不落 Other→Io）。
//! - [`RangeBlockCache`]：`Mutex<State> + Condvar`；同 key 单 loader（其余线程等
//!   Condvar，RAII loading guard 覆盖成功/失败/unwind 并 `notify_all`）；进入
//!   `get_or_load` **先 admission 再查 cache**（hit 与 miss 同受唯一
//!   `ArchiveCacheCoordinator` clear gate 约束）；loader 插入前复核 generation，
//!   清空期间完成的加载丢弃 bytes 返回 `Cancelled`；插入后按 LRU 淘汰到
//!   `BLOCK_CACHE_BYTES`（= 32 个满块）以内，cache hit 更新顺序。
//! - loader 只在 `spawn_blocking` 线程内 `runtime.block_on(origin.read_range(...))`；
//!   调用线程经 channel 等待（runtime 关闭 / 任务 panic → channel 断开 → Io，不悬挂）。
//!   `MaterializeError` 映射臂表：RemoteRangeUnavailable → RemoteRangeUnavailable /
//!   Network → Network / Cancelled → Cancelled / 其余 → Io，再经
//!   `RemoteZipIoError` marker 包成 `io::Error`，由 `zip_backend::map_zip_io_error`
//!   五臂顺序在边界恢复（BudgetRetry / Limited / InvalidData(CRC) / Io 同序）。

use crate::source::archive::backend::{ArchiveAccessError, ReaderFactory, RemoteZipIoError};
use crate::source::archive::cache_coordinator::ArchiveCacheCoordinator;
use crate::source::archive::materializer::{MaterializeError, Materializer};
use crate::source::archive::password::ArchiveIdentity;
use crate::source::descriptor::SourceDescriptor;
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, ErrorKind, Read, Seek, SeekFrom};
use std::sync::{Arc, Condvar, Mutex};

pub const BLOCK_SIZE: usize = 1024 * 1024;
pub const BLOCK_CACHE_BYTES: usize = 32 * 1024 * 1024;

/// 块缓存键：identity（origin descriptor + size/mtime）区分不同归档，block 是
/// `offset / BLOCK_SIZE` 的块序号——同一归档的多个 reader（catalog / read_entry /
/// 并发条目读取）经同 key singleflight 复用同一批块。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BlockKey {
    pub identity: ArchiveIdentity,
    pub block: u64,
}

/// 远端字节供给（任务 9 的 origin Range 抽象）：生产实现
/// [`MaterializerRangeOrigin`] 包装 `Materializer::read_origin_range`；测试注入
/// mock（`MockRangeOrigin` / 门控 origin）。
#[async_trait::async_trait]
pub trait RangeOrigin: Send + Sync {
    /// 读取远端 `[offset, offset+length)` 精确字节；短读 / 越界经
    /// `MaterializeError` 类型化（`RemoteRangeUnavailable` / `Network` 等）。
    async fn read_range(&self, offset: u64, length: u64) -> Result<Vec<u8>, MaterializeError>;
    /// origin 总大小（`SeekFrom::End` 与最后一块 min 截断的基准）
    fn size(&self) -> u64;
}

/// 生产 origin：Materializer 的 `(origin descriptor, rel)` 固定句柄。
pub struct MaterializerRangeOrigin {
    materializer: Materializer,
    origin: SourceDescriptor,
    rel: String,
    size: u64,
}

impl MaterializerRangeOrigin {
    pub fn new(materializer: Materializer, origin: SourceDescriptor, rel: String, size: u64) -> Self {
        Self { materializer, origin, rel, size }
    }
}

#[async_trait::async_trait]
impl RangeOrigin for MaterializerRangeOrigin {
    async fn read_range(&self, offset: u64, length: u64) -> Result<Vec<u8>, MaterializeError> {
        self.materializer.read_origin_range(&self.origin, &self.rel, offset, length).await
    }
    fn size(&self) -> u64 {
        self.size
    }
}

/// `ArchiveInput::Reader` 工厂（任务 10 Service streaming 路径接入）：identity /
/// origin / cache / runtime 全部闭包捕获，每次 open 产出独立 `RemoteZipReader`
/// 共享同一块缓存（singleflight 的跨 reader 去重前提）。
pub fn remote_zip_reader_factory(
    identity: ArchiveIdentity,
    origin: Arc<dyn RangeOrigin>,
    cache: Arc<RangeBlockCache>,
    runtime: tokio::runtime::Handle,
) -> ReaderFactory {
    Arc::new(move || {
        Ok(Box::new(RemoteZipReader::new(
            identity.clone(),
            origin.clone(),
            cache.clone(),
            runtime.clone(),
        )) as Box<dyn crate::source::archive::backend::ArchiveReadSeek>)
    })
}

// ---------------------------------------------------------------------------
// 固定块缓存：singleflight + admission + generation 复核 + LRU
// ---------------------------------------------------------------------------

#[derive(Default)]
struct CacheState {
    /// 已就绪块（value = 恰好一个块的字节）
    blocks: HashMap<BlockKey, Arc<Vec<u8>>>,
    /// LRU 顺序（front = 最久未用，back = 最新）
    order: VecDeque<BlockKey>,
    /// 加载中的 key（singleflight 标记；由 RAII LoadingGuard 摘除）
    loading: HashSet<BlockKey>,
    /// 在缓存块的总字节数（LRU 淘汰到 capacity 以内的依据）
    bytes: usize,
}

impl CacheState {
    /// cache hit 必须更新 LRU 顺序
    fn touch(&mut self, key: &BlockKey) {
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
            self.order.push_back(key.clone());
        }
    }

    /// 插入并按字节预算 LRU 淘汰（32 MiB 容量 + 1 MiB 满块 = 32 块上限）
    fn insert_lru(&mut self, key: BlockKey, value: Arc<Vec<u8>>, capacity_bytes: usize) {
        if let Some(old) = self.blocks.insert(key.clone(), value.clone()) {
            self.bytes = self.bytes.saturating_sub(old.len());
            if let Some(pos) = self.order.iter().position(|k| *k == key) {
                self.order.remove(pos);
            }
        }
        self.order.push_back(key.clone());
        self.bytes += value.len();
        while self.bytes > capacity_bytes {
            let Some(evicted) = self.order.pop_front() else { break };
            if let Some(v) = self.blocks.remove(&evicted) {
                self.bytes = self.bytes.saturating_sub(v.len());
            }
        }
    }
}

pub struct RangeBlockCache {
    coordinator: Arc<ArchiveCacheCoordinator>,
    capacity_bytes: usize,
    state: Mutex<CacheState>,
    /// loader 完成（成功/失败/unwind）时 notify_all，唤醒同 key 等待者重查
    loaded: Condvar,
}

impl RangeBlockCache {
    /// 独立协调器构造（单测 / 独立使用）；生产必须用
    /// [`RangeBlockCache::with_coordinator`] 注入 Service 持有的唯一 coordinator。
    pub fn new(capacity_bytes: usize) -> Self {
        Self::with_coordinator(capacity_bytes, ArchiveCacheCoordinator::new_shared())
    }

    /// 注入唯一 `ArchiveCacheCoordinator`（与 catalog LRU / Materializer / Service
    /// 同一闸门：clear gate 拒绝 admission 时 hit 与 miss 一律 `Cancelled`）。
    pub fn with_coordinator(
        capacity_bytes: usize,
        coordinator: Arc<ArchiveCacheCoordinator>,
    ) -> Self {
        Self {
            coordinator,
            capacity_bytes,
            state: Mutex::new(CacheState::default()),
            loaded: Condvar::new(),
        }
    }

    pub fn coordinator_generation(&self) -> u64 {
        self.coordinator.generation()
    }

    /// 就绪块数（测试 / 诊断）
    pub fn len(&self) -> usize {
        self.state.lock().unwrap().blocks.len()
    }

    /// 清空就绪块（`Service::clear_runtime_caches_while_gated` 在 clear guard 存活
    /// 且 admission 排空后调用）。加载中的 loader 由 generation 复核拒绝插入。
    pub fn clear(&self) {
        let mut state = self.state.lock().unwrap();
        state.blocks.clear();
        state.order.clear();
        state.bytes = 0;
    }

    /// singleflight 块获取：**admission 先行**（clear gate 约束 hit 与 miss）→
    /// hit（touch 后返回）→ miss 时同 key 只允许一个 loader（其余等 Condvar）。
    /// loader 捕获 admission generation，插入前复核——清空期间完成的加载丢弃
    /// bytes 返回 `Cancelled`，不得复活已清数据。
    pub fn get_or_load(
        &self,
        key: BlockKey,
        load: impl FnOnce() -> Result<Arc<Vec<u8>>, ArchiveAccessError>,
    ) -> Result<Arc<Vec<u8>>, ArchiveAccessError> {
        // admission 先行：hit 与 miss 都受 clear gate 约束（clearing → Cancelled）
        let admission = self.coordinator.admit()?;
        let generation = admission.generation();
        let mut state = self.state.lock().unwrap();
        loop {
            if state.blocks.contains_key(&key) {
                state.touch(&key); // cache hit 必须更新 LRU 顺序
                return Ok(state.blocks.get(&key).unwrap().clone());
            }
            if state.loading.contains(&key) {
                // 同 key 单 loader：等待者在这里睡眠；loader 的 RAII guard 在
                // 成功 / 失败 / unwind 三条路径都 notify_all（挂死防御：错误路径
                // 也必须唤醒等待者）
                state = self.loaded.wait(state).unwrap();
                continue;
            }
            state.loading.insert(key.clone());
            drop(state); // loader 网络往返期间不持锁（其他 key 并发不受影响）
            let _loading_guard = LoadingGuard { cache: self, key: key.clone() };
            let loaded = load();
            let mut state = self.state.lock().unwrap();
            return match loaded {
                Ok(bytes) => {
                    // generation 复核：清空期间完成的加载不得复活已清数据
                    if self.coordinator.generation() != generation {
                        Err(ArchiveAccessError::Cancelled)
                    } else {
                        state.insert_lru(key, bytes.clone(), self.capacity_bytes);
                        Ok(bytes)
                    }
                }
                Err(e) => Err(e),
            };
        }
    }
}

/// loading 标记的 RAII 摘除：成功、失败、unwind 三条路径都移除 loading 并
/// `notify_all`（挂死防御：等待者永远能被错误路径唤醒，不依赖 loader 成功）。
struct LoadingGuard<'a> {
    cache: &'a RangeBlockCache,
    key: BlockKey,
}

impl Drop for LoadingGuard<'_> {
    fn drop(&mut self) {
        {
            let mut state = self.cache.state.lock().unwrap();
            state.loading.remove(&self.key);
        }
        self.cache.loaded.notify_all();
    }
}

// ---------------------------------------------------------------------------
// loader：MaterializeError → ArchiveAccessError 臂表 + spawn_blocking 内 block_on
// ---------------------------------------------------------------------------

/// loader 的 `MaterializeError` 映射臂表（任务 9 合同，顺序固定）：
/// `RemoteRangeUnavailable → RemoteRangeUnavailable`（短 Range 是降级触发，不得落
/// Io）、`Network → Network`、`Cancelled → Cancelled`、其余 → `Io`。
/// （`MediaSourceError::Timeout` 在 `From<MediaSourceError>` 垫片已折入 Network；
/// loader 产生的 Timeout 语义由 `RemoteZipIoError` marker 经 zip 边界五臂恢复。）
fn map_origin_error(e: MaterializeError) -> ArchiveAccessError {
    match e {
        MaterializeError::RemoteRangeUnavailable(s) => ArchiveAccessError::RemoteRangeUnavailable(s),
        MaterializeError::Network(s) => ArchiveAccessError::Network(s),
        MaterializeError::Cancelled => ArchiveAccessError::Cancelled,
        other => ArchiveAccessError::Io(other.to_string()),
    }
}

/// 块加载：只在 `spawn_blocking` 线程内 `runtime.block_on`；调用线程（自身可能是
/// blocking 线程或普通线程）经 channel 等待。runtime 关闭（block_on panic）或任务
/// panic → 发送端 drop → `recv` 断开 → `Io`，**不悬挂**。返回后复核长度：短读
/// 类型化 `RemoteRangeUnavailable`（不经 Other 扁平化）。
fn load_block(
    origin: Arc<dyn RangeOrigin>,
    runtime: tokio::runtime::Handle,
    offset: u64,
    length: u64,
) -> Result<Arc<Vec<u8>>, ArchiveAccessError> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Vec<u8>, MaterializeError>>(1);
    let task_runtime = runtime.clone();
    // block_on 只发生在 spawn_blocking 线程内；JoinHandle 即弃（结果经 channel 回传）。
    // runtime 关闭（block_on panic）或任务 panic → tx drop → recv 断开 → Io，不悬挂。
    let _detached = task_runtime.spawn_blocking(move || {
        let result = runtime.block_on(origin.read_range(offset, length));
        let _ = tx.send(result);
    });
    let result = rx
        .recv()
        .map_err(|_| ArchiveAccessError::Io("块加载任务未送达结果（runtime 关闭或 panic）".into()))?;
    let bytes = result.map_err(map_origin_error)?;
    if bytes.len() as u64 != length {
        // 短读类型化（降级白名单触发；Materializer::read_origin_range 同款契约，
        // 此处对任意 RangeOrigin 实现兜底，不落 Other→Io）
        return Err(ArchiveAccessError::RemoteRangeUnavailable(format!(
            "Range 长度不符: offset={offset} expected={length} actual={}",
            bytes.len()
        )));
    }
    Ok(Arc::new(bytes))
}

// ---------------------------------------------------------------------------
// RemoteZipReader：Read + Seek 外观
// ---------------------------------------------------------------------------

pub struct RemoteZipReader {
    position: u64,
    size: u64,
    identity: ArchiveIdentity,
    origin: Arc<dyn RangeOrigin>,
    cache: Arc<RangeBlockCache>,
    runtime: tokio::runtime::Handle,
    /// 构造时刻的 coordinator generation（任务 10 streaming prefetch intent
    /// 携带；逐块正确性由 get_or_load 的 admission + generation 复核保证，
    /// 字段本身在任务 10 接线前无消费方）
    #[allow(dead_code)]
    generation: u64,
}

impl RemoteZipReader {
    pub fn new(
        identity: ArchiveIdentity,
        origin: Arc<dyn RangeOrigin>,
        cache: Arc<RangeBlockCache>,
        runtime: tokio::runtime::Handle,
    ) -> Self {
        let size = origin.size();
        let generation = cache.coordinator_generation();
        Self { position: 0, size, identity, origin, cache, runtime, generation }
    }

    #[allow(dead_code)] // 任务 10 streaming prefetch intent 消费
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl Read for RemoteZipReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        let block_index = self.position / BLOCK_SIZE as u64;
        let block_start = block_index * BLOCK_SIZE as u64;
        // 最后一块 min 截断：请求恰为剩余长度（短读由 loader 判 RemoteRangeUnavailable）
        let block_len = (self.size - block_start).min(BLOCK_SIZE as u64);
        let key = BlockKey { identity: self.identity.clone(), block: block_index };
        let origin = self.origin.clone();
        let runtime = self.runtime.clone();
        let bytes = self
            .cache
            .get_or_load(key, move || load_block(origin, runtime, block_start, block_len))
            .map_err(|e| io::Error::new(ErrorKind::Other, RemoteZipIoError(e)))?;
        let offset_in_block = (self.position - block_start) as usize;
        let available = bytes.len().saturating_sub(offset_in_block);
        let n = available.min(buf.len());
        buf[..n].copy_from_slice(&bytes[offset_in_block..offset_in_block + n]);
        self.position += n as u64;
        Ok(n)
    }
}

impl Seek for RemoteZipReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        // i128 计算：Start/Current/End 三种偏移统一在有符号宽域里求和，
        // 拒绝负数与超过 u64 的目标位置（seek 超过 size 合法——Read 返回 EOF）
        let target: i128 = match pos {
            SeekFrom::Start(offset) => offset as i128,
            SeekFrom::Current(delta) => self.position as i128 + delta as i128,
            SeekFrom::End(delta) => self.size as i128 + delta as i128,
        };
        if target < 0 || target > u64::MAX as i128 {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "seek 目标位置为负或超出 u64 范围",
            ));
        }
        self.position = target as u64;
        Ok(self.position)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::source::archive::backend::{
        ArchiveAccessError, ArchiveBackend, ArchiveInput, DecodeBudget,
    };
    use crate::source::archive::cache_coordinator::ArchiveCacheCoordinator;
    use crate::source::archive::materializer::MaterializeError;
    use crate::source::archive::service::ArchiveService;
    use crate::source::archive::sevenz_backend::SevenZBackend;
    use crate::source::archive::rar_backend::RarBackend;
    use crate::source::archive::zip_backend::ZipBackend;
    use crate::source::archive_impl::Materialize;
    use crate::source::descriptor::{ArchiveFormat, SourceDescriptor};
    use std::io::ErrorKind;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    const TEST_TIMEOUT: Duration = Duration::from_secs(10);

    fn test_identity() -> ArchiveIdentity {
        ArchiveIdentity::new("remote-zip-test://book.cbz", 0, None)
    }

    fn sequence_bytes(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 256) as u8).collect()
    }

    fn sequence_slice(start: usize, len: usize) -> Vec<u8> {
        (start..start + len).map(|i| (i % 256) as u8).collect()
    }

    /// io::Error → ArchiveAccessError：Remote marker 优先恢复（reader 的对外错误
    /// 全部经 marker 包装，非 marker 的按 Io 兜底）
    fn remote_io_to_access(e: std::io::Error) -> ArchiveAccessError {
        e.get_ref()
            .and_then(|c| c.downcast_ref::<RemoteZipIoError>())
            .map(|r| r.0.clone())
            .unwrap_or_else(|| ArchiveAccessError::Io(e.to_string()))
    }

    // =========================================================================
    // MockRangeOrigin：可编程字节供给 + Range 记录 + 定点失败 / 短读注入
    // =========================================================================

    #[derive(Clone)]
    enum MockFail {
        Network(String),
        Cancelled,
        RemoteRangeUnavailable(String),
        Other(String),
    }

    impl MockFail {
        fn build(&self) -> MaterializeError {
            match self {
                MockFail::Network(s) => MaterializeError::Network(s.clone()),
                MockFail::Cancelled => MaterializeError::Cancelled,
                MockFail::RemoteRangeUnavailable(s) => {
                    MaterializeError::RemoteRangeUnavailable(s.clone())
                }
                MockFail::Other(s) => MaterializeError::Other(s.clone()),
            }
        }
    }

    fn access_to_mock_fail(e: ArchiveAccessError) -> MockFail {
        match e {
            ArchiveAccessError::Network(s) => MockFail::Network(s),
            ArchiveAccessError::Cancelled => MockFail::Cancelled,
            ArchiveAccessError::RemoteRangeUnavailable(s) => MockFail::RemoteRangeUnavailable(s),
            other => MockFail::Other(other.to_string()),
        }
    }

    struct MockRangeOrigin {
        bytes: Vec<u8>,
        ranges: Mutex<Vec<(u64, u64)>>,
        calls: AtomicUsize,
        fail: Option<MockFail>,
        /// 定点失败（命中 offset 即失败；catalog 后注入 payload block 故障用）
        fail_at_offset: Mutex<Option<(u64, MockFail)>>,
        /// 定点短读（命中 offset 返回 length-1 字节 → loader 判 RemoteRangeUnavailable）
        short_at_offset: Mutex<Option<u64>>,
    }

    impl MockRangeOrigin {
        fn new(bytes: Vec<u8>) -> Arc<Self> {
            Arc::new(Self {
                bytes,
                ranges: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
                fail: None,
                fail_at_offset: Mutex::new(None),
                short_at_offset: Mutex::new(None),
            })
        }

        fn failing(err: ArchiveAccessError) -> Arc<Self> {
            // 非空 body：catalog 的尾部块读取必须真实触达 origin，注入错误才能
            // 经 reader → io::Error → zip 边界恢复（空 body 会在 EOCD 预检早退，
            // 变成 InvalidArchive 而非注入类型）
            Arc::new(Self {
                bytes: vec![0; BLOCK_SIZE],
                ranges: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
                fail: Some(access_to_mock_fail(err)),
                fail_at_offset: Mutex::new(None),
                short_at_offset: Mutex::new(None),
            })
        }

        fn ranges(&self) -> Vec<(u64, u64)> {
            self.ranges.lock().unwrap().clone()
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn arm_fail_at(&self, offset: u64, err: ArchiveAccessError) {
            *self.fail_at_offset.lock().unwrap() = Some((offset, access_to_mock_fail(err)));
        }

        fn clear_fail_at(&self) {
            *self.fail_at_offset.lock().unwrap() = None;
        }

        fn arm_short_at(&self, offset: u64) {
            *self.short_at_offset.lock().unwrap() = Some(offset);
        }
    }

    #[async_trait::async_trait]
    impl RangeOrigin for MockRangeOrigin {
        async fn read_range(&self, offset: u64, length: u64) -> Result<Vec<u8>, MaterializeError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.ranges.lock().unwrap().push((offset, length));
            if let Some(f) = &self.fail {
                return Err(f.build());
            }
            if let Some((at, f)) = self.fail_at_offset.lock().unwrap().clone() {
                if at == offset {
                    return Err(f.build());
                }
            }
            let mut len = length;
            if let Some(at) = self.short_at_offset.lock().unwrap().clone() {
                if at == offset {
                    len = length.saturating_sub(1);
                }
            }
            let start = offset as usize;
            let end = (offset + len) as usize;
            self.bytes
                .get(start..end)
                .map(|s| s.to_vec())
                .ok_or_else(|| {
                    MaterializeError::Network(format!(
                        "mock range 越界 {start}..{end} > {}",
                        self.bytes.len()
                    ))
                })
        }

        fn size(&self) -> u64 {
            self.bytes.len() as u64
        }
    }

    /// 测试工厂：fresh cache（独立 coordinator）+ 固定 identity
    fn remote_reader_factory(origin: Arc<MockRangeOrigin>, runtime: tokio::runtime::Handle) -> crate::source::archive::backend::ReaderFactory {
        let cache = Arc::new(RangeBlockCache::new(32 * BLOCK_SIZE));
        remote_zip_reader_factory(test_identity(), origin, cache, runtime)
    }

    /// Stored ZIP 字节（payload 偏移确定，块故障注入可定位）
    fn create_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buf);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, bytes) in entries {
                zip.start_file(*name, options).unwrap();
                std::io::Write::write_all(&mut zip, bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        buf.into_inner()
    }

    // =========================================================================
    // 简报步骤 1 四用例（合同）
    // =========================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn remote_reader_seek_and_cross_block_read_are_exact() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(sequence_bytes(3 * BLOCK_SIZE + 17));
        let cache = Arc::new(RangeBlockCache::new(2 * BLOCK_SIZE));
        let mut reader = RemoteZipReader::new(test_identity(), origin.clone(), cache, runtime);
        reader.seek(SeekFrom::Start((BLOCK_SIZE - 3) as u64)).unwrap();
        let mut out = [0u8; 8];
        reader.read_exact(&mut out).unwrap();
        assert_eq!(out.to_vec(), sequence_slice(BLOCK_SIZE - 3, 8));
        assert_eq!(
            origin.ranges(),
            vec![(0, BLOCK_SIZE as u64), (BLOCK_SIZE as u64, BLOCK_SIZE as u64)]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_same_block_loads_once() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(vec![7; BLOCK_SIZE]);
        let cache = Arc::new(RangeBlockCache::new(32 * BLOCK_SIZE));
        let threads = (0..8)
            .map(|_| {
                let origin = origin.clone();
                let cache = cache.clone();
                let runtime = runtime.clone();
                std::thread::spawn(move || {
                    let mut reader =
                        RemoteZipReader::new(test_identity(), origin, cache, runtime);
                    let mut byte = [0u8; 1];
                    reader.read_exact(&mut byte).unwrap();
                    byte[0]
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            threads.into_iter().map(|t| t.join().unwrap()).collect::<Vec<_>>(),
            vec![7; 8]
        );
        assert_eq!(origin.call_count(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn typed_range_error_survives_io_and_zip_boundaries() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::failing(ArchiveAccessError::Network("offline".into()));
        let input = ArchiveInput::Reader(remote_reader_factory(origin, runtime));
        assert!(matches!(
            ZipBackend.catalog(&input, "", None),
            Err(ArchiveAccessError::Network(_))
        ));
    }

    // =========================================================================
    // clear generation：清空期间完成的加载不得复活 + clear gate 拒绝新 admission
    // =========================================================================

    /// 门控 origin：read_range 进入后阻塞到 release（loader 在途的确定性注入点）
    struct GatedOrigin {
        bytes: Vec<u8>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        started: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl RangeOrigin for GatedOrigin {
        async fn read_range(&self, offset: u64, length: u64) -> Result<Vec<u8>, MaterializeError> {
            self.started.store(true, Ordering::SeqCst);
            let (lock, cv) = &*self.gate;
            let mut open = lock.lock().unwrap();
            while !*open {
                open = cv.wait(open).unwrap();
            }
            let start = offset as usize;
            let end = (offset + length) as usize;
            self.bytes
                .get(start..end)
                .map(|s| s.to_vec())
                .ok_or_else(|| MaterializeError::Network("gated mock range 越界".into()))
        }

        fn size(&self) -> u64 {
            self.bytes.len() as u64
        }
    }

    struct NeverMaterialize;

    #[async_trait::async_trait]
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

    /// 任务 9 Service 全链接线 harness：block LRU 接入 Service 持有的同一
    /// coordinator（经 `service.block_cache()` 取同一实例），clear 命令经
    /// `clear_runtime_caches_while_gated` 同时清 catalog LRU 与块缓存。
    struct BlockingRangeHarness {
        coordinator: Arc<ArchiveCacheCoordinator>,
        runtime: Arc<ArchiveService>,
        cache: Arc<RangeBlockCache>,
        origin: Arc<GatedOrigin>,
        handle: tokio::runtime::Handle,
        gate: Arc<(Mutex<bool>, Condvar)>,
        loader_started: Arc<AtomicBool>,
    }

    impl BlockingRangeHarness {
        fn new(handle: tokio::runtime::Handle) -> Self {
            let coordinator = ArchiveCacheCoordinator::new_shared();
            let service = Arc::new(ArchiveService::with_parts(
                Arc::new(NeverMaterialize),
                coordinator.clone(),
                Arc::new(ZipBackend),
                Arc::new(RarBackend),
                Arc::new(SevenZBackend),
                crate::source::archive::backend::ArchiveLimits::production(),
                Arc::new(tokio::sync::Semaphore::new(512)),
            ));
            let cache = service.block_cache();
            let gate = Arc::new((Mutex::new(false), Condvar::new()));
            let loader_started = Arc::new(AtomicBool::new(false));
            let origin = Arc::new(GatedOrigin {
                bytes: vec![9; BLOCK_SIZE],
                gate: gate.clone(),
                started: loader_started.clone(),
            });
            Self {
                coordinator,
                runtime: service,
                cache,
                origin,
                handle,
                gate,
                loader_started,
            }
        }

        fn spawn_block_load(&self) -> std::thread::JoinHandle<Result<Vec<u8>, ArchiveAccessError>> {
            let origin = self.origin.clone();
            let cache = self.cache.clone();
            let handle = self.handle.clone();
            std::thread::spawn(move || {
                let mut reader = RemoteZipReader::new(test_identity(), origin, cache, handle);
                let mut byte = [0u8; 1];
                reader.read_exact(&mut byte).map_err(remote_io_to_access)?;
                Ok(byte.to_vec())
            })
        }

        fn try_start_loader(&self) -> Result<Vec<u8>, ArchiveAccessError> {
            let mut reader = RemoteZipReader::new(
                test_identity(),
                self.origin.clone(),
                self.cache.clone(),
                self.handle.clone(),
            );
            let mut byte = [0u8; 1];
            reader.read_exact(&mut byte).map_err(remote_io_to_access)?;
            Ok(byte.to_vec())
        }

        fn wait_loader_started(&self) {
            let deadline = Instant::now() + TEST_TIMEOUT;
            while !self.loader_started.load(Ordering::SeqCst) {
                assert!(Instant::now() < deadline, "loader 在超时内未启动");
                std::thread::sleep(Duration::from_millis(2));
            }
        }

        fn release_loader(&self) {
            let (lock, cv) = &*self.gate;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_generation_prevents_late_loader_reinsert() {
        let handle = tokio::runtime::Handle::current();
        let harness = BlockingRangeHarness::new(handle);
        let load = harness.spawn_block_load();
        harness.wait_loader_started();
        let clear_guard = harness.coordinator.begin_clear();
        harness.release_loader();
        assert!(matches!(
            load.join().unwrap(),
            Err(ArchiveAccessError::Cancelled)
        ));
        assert!(harness.coordinator.wait_drained(TEST_TIMEOUT).await);
        harness
            .runtime
            .clear_runtime_caches_while_gated(clear_guard.generation());
        assert_eq!(harness.runtime.block_cache_len(), 0);
        assert!(matches!(
            harness.try_start_loader(),
            Err(ArchiveAccessError::Cancelled)
        ));
        drop(clear_guard);
        assert!(harness.try_start_loader().is_ok());
    }

    // =========================================================================
    // LRU 淘汰 + loader 失败后的 singleflight 恢复
    // =========================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn lru_evicts_least_recently_used_block_and_reloads() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(sequence_bytes(3 * BLOCK_SIZE));
        // 容量恰 1 块：读块 0 → 块 1（淘汰 0）→ 再读块 0（重下）
        let cache = Arc::new(RangeBlockCache::new(BLOCK_SIZE));
        let mut reader = RemoteZipReader::new(test_identity(), origin.clone(), cache.clone(), runtime);
        let mut probe = [0u8; 1];
        reader.seek(SeekFrom::Start(0)).unwrap();
        reader.read_exact(&mut probe).unwrap();
        reader.seek(SeekFrom::Start(BLOCK_SIZE as u64)).unwrap();
        reader.read_exact(&mut probe).unwrap();
        assert_eq!(cache.len(), 1, "容量 1 块：块 0 被块 1 淘汰");
        reader.seek(SeekFrom::Start(1)).unwrap();
        reader.read_exact(&mut probe).unwrap();
        assert_eq!(
            origin.ranges(),
            vec![
                (0, BLOCK_SIZE as u64),
                (BLOCK_SIZE as u64, BLOCK_SIZE as u64),
                (0, BLOCK_SIZE as u64)
            ],
            "被淘汰块重读时重新加载（LRU 生效而非无限缓存）"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn failed_load_releases_singleflight_slot_for_next_caller() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(vec![5; BLOCK_SIZE]);
        // 块 0 定点 Network 失败 → 下一次调用能重新成为 loader（loading 摘除 + notify）
        origin.arm_fail_at(0, ArchiveAccessError::Network("transient".into()));
        let cache = Arc::new(RangeBlockCache::new(32 * BLOCK_SIZE));
        {
            let mut reader =
                RemoteZipReader::new(test_identity(), origin.clone(), cache.clone(), runtime.clone());
            let mut byte = [0u8; 1];
            let err = reader.read_exact(&mut byte).unwrap_err();
            assert!(matches!(remote_io_to_access(err), ArchiveAccessError::Network(_)));
        }
        origin.clear_fail_at();
        let mut reader = RemoteZipReader::new(test_identity(), origin, cache, runtime);
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte).unwrap();
        assert_eq!(byte[0], 5, "失败后 loading 槽位释放，重试成功");
    }

    // =========================================================================
    // 真实边界（payload 阶段，非 open/catalog）：Network / 短读 / Cancelled / Timeout
    // =========================================================================

    /// 2.5 MiB stored payload 的单条目 ZIP：payload 覆盖块 1，central directory
    /// 在尾部块——catalog 只触碰尾部，注入块 1 故障后 read_entry 才会踩到。
    fn payload_zip_bytes() -> Vec<u8> {
        let payload: Vec<u8> = (0..2 * BLOCK_SIZE + BLOCK_SIZE / 2)
            .map(|i| (i % 251) as u8)
            .collect();
        create_stored_zip(&[("page.png", &payload)])
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn payload_block_network_error_survives_read_entry_boundary() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(payload_zip_bytes());
        let input = ArchiveInput::Reader(remote_reader_factory(origin.clone(), runtime));
        let catalog = ZipBackend.catalog(&input, "", None).unwrap();
        assert_eq!(catalog.entries.len(), 1, "catalog（尾部块）先成功");
        // catalog 后注入 payload 块 1 网络故障 → read_entry 恢复 Network（非 Io、非文本判定）
        origin.arm_fail_at(BLOCK_SIZE as u64, ArchiveAccessError::Network("payload offline".into()));
        assert!(matches!(
            ZipBackend.read_entry(&input, "page.png", None, &mut DecodeBudget::unbounded()),
            Err(ArchiveAccessError::Network(_))
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn payload_short_read_maps_to_remote_range_unavailable() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(payload_zip_bytes());
        let input = ArchiveInput::Reader(remote_reader_factory(origin.clone(), runtime));
        ZipBackend.catalog(&input, "", None).unwrap();
        // payload 块 1 短读 1 字节 → loader 复核长度 → RemoteRangeUnavailable（降级白名单首项）
        origin.arm_short_at(BLOCK_SIZE as u64);
        assert!(matches!(
            ZipBackend.read_entry(&input, "page.png", None, &mut DecodeBudget::unbounded()),
            Err(ArchiveAccessError::RemoteRangeUnavailable(_))
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn payload_cancelled_error_stays_cancelled_not_degraded() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(payload_zip_bytes());
        let input = ArchiveInput::Reader(remote_reader_factory(origin.clone(), runtime));
        ZipBackend.catalog(&input, "", None).unwrap();
        // Cancelled 保真穿透（不在降级白名单——任务 10 不得对它物化降级）
        origin.arm_fail_at(BLOCK_SIZE as u64, ArchiveAccessError::Cancelled);
        assert!(matches!(
            ZipBackend.read_entry(&input, "page.png", None, &mut DecodeBudget::unbounded()),
            Err(ArchiveAccessError::Cancelled)
        ));
    }

    /// 载荷段返回 `RemoteZipIoError(Timeout)` marker 的 reader：证明 Timeout 经
    /// marker 包装后在 read_entry 的 payload 阶段恢复为 `ArchiveAccessError::Timeout`
    /// （loader 的 MaterializeError 格子无 Timeout——MediaSource 层已折入 Network；
    /// 此处锁定 marker 路径的类型保真，供任务 10 白名单捕获）。
    struct TimeoutAfterReader {
        inner: std::io::Cursor<Vec<u8>>,
        fail_beyond: u64,
        pos: u64,
    }

    impl TimeoutAfterReader {
        fn new(bytes: Vec<u8>, fail_beyond: u64) -> Self {
            Self { inner: std::io::Cursor::new(bytes), fail_beyond, pos: 0 }
        }
    }

    impl Read for TimeoutAfterReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            // 只拦截「顺序跨越 fail_beyond」的读取（payload 阶段）；
            // check_multidisk / central directory 读取发生在 seek 之后（pos 已越过），放行
            if self.pos < self.fail_beyond && self.pos + buf.len() as u64 > self.fail_beyond {
                return Err(io::Error::new(
                    ErrorKind::Other,
                    RemoteZipIoError(ArchiveAccessError::Timeout("payload slow".into())),
                ));
            }
            let n = self.inner.read(buf)?;
            self.pos += n as u64;
            Ok(n)
        }
    }

    impl Seek for TimeoutAfterReader {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            let p = self.inner.seek(pos)?;
            self.pos = p;
            Ok(p)
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn payload_timeout_marker_survives_read_entry_boundary() {
        let bytes = payload_zip_bytes();
        // 先用干净 Cursor 工厂成功 catalog
        let clean_bytes = bytes.clone();
        let clean: crate::source::archive::backend::ReaderFactory = Arc::new(move || {
            Ok(Box::new(std::io::Cursor::new(clean_bytes.clone()))
                as Box<dyn crate::source::archive::backend::ArchiveReadSeek>)
        });
        let catalog = ZipBackend.catalog(&ArchiveInput::Reader(clean), "", None).unwrap();
        assert_eq!(catalog.entries.len(), 1);
        // 再注入 Timeout marker 工厂：payload 顺序读跨越 1 MiB 处失败
        let injected: crate::source::archive::backend::ReaderFactory = Arc::new(move || {
            Ok(Box::new(TimeoutAfterReader::new(bytes.clone(), BLOCK_SIZE as u64))
                as Box<dyn crate::source::archive::backend::ArchiveReadSeek>)
        });
        assert!(matches!(
            ZipBackend.read_entry(
                &ArchiveInput::Reader(injected),
                "page.png",
                None,
                &mut DecodeBudget::unbounded()
            ),
            Err(ArchiveAccessError::Timeout(_))
        ));
    }

    // =========================================================================
    // Seek i128 边界
    // =========================================================================

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn seek_rejects_negative_and_beyond_u64() {
        let runtime = tokio::runtime::Handle::current();
        let origin = MockRangeOrigin::new(sequence_bytes(BLOCK_SIZE));
        let cache = Arc::new(RangeBlockCache::new(2 * BLOCK_SIZE));
        let mut reader = RemoteZipReader::new(test_identity(), origin, cache, runtime);
        // Start(0) 合法基线
        assert_eq!(reader.seek(SeekFrom::Start(0)).unwrap(), 0);
        // Current 回退为负 → InvalidInput
        assert!(reader.seek(SeekFrom::Current(-1)).unwrap_err().kind() == ErrorKind::InvalidInput);
        // End 负偏移越出 0 → InvalidInput
        assert!(reader
            .seek(SeekFrom::End(-(BLOCK_SIZE as i64) - 1))
            .unwrap_err()
            .kind() == ErrorKind::InvalidInput);
        // Start 超 u64 直接由类型排除；End(0) = size 合法（读返回 EOF）
        assert_eq!(reader.seek(SeekFrom::End(0)).unwrap(), BLOCK_SIZE as u64);
        let mut byte = [0u8; 1];
        assert_eq!(reader.read(&mut byte).unwrap(), 0, "EOF 读返回 0");
    }

    // =========================================================================
    // 生产 origin 适配器：MaterializerRangeOrigin → read_origin_range 委托
    // =========================================================================

    #[tokio::test]
    async fn materializer_range_origin_delegates_and_types_short_read() {
        let mock = std::sync::Arc::new(
            crate::source::archive::materializer::tests::MockOrigin::new(10),
        );
        let (m, _dir, _db) =
            crate::source::archive::materializer::tests::temp_materializer(mock.clone());
        let origin = MaterializerRangeOrigin::new(
            m,
            crate::source::archive::materializer::tests::webdav(""),
            "a.cbz".into(),
            10,
        );
        assert_eq!(origin.size(), 10);
        assert_eq!(origin.read_range(2, 5).await.unwrap(), vec![7u8; 5]);
        // 短读经 read_origin_range 类型化（生产 loader 臂表的首项降级触发）
        *mock.short_next_read.lock().unwrap() = Some(3);
        assert!(matches!(
            origin.read_range(0, 10).await,
            Err(MaterializeError::RemoteRangeUnavailable(_))
        ));
    }
}
