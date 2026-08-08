//! 缩略图服务（§13）：连接调度器、缓存索引、策略与事件。
//!
//! 把可测试的核心逻辑（classify_item / evict_to_limit）抽成接受 `Connection` 的纯函数，
//! `ThumbnailService` 是薄封装，负责调度器、事件发射和 Tauri 状态。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use super::generator::{generate_thumbnail, GenerateRequest, GeneratedThumbnail};
use super::index::{self, ThumbnailCacheRow};
use super::key::{self, CacheKeyInput};
use super::migration::{self, MigrationMode, RealFs};
use super::policy::{self, QualityPolicy, SourceDecision};
use super::scheduler::{self, GenerateFn, GenerationJob, Outcome, QueuedTask, SchedulerConfig, SchedulerHandle};
use super::{Priority, Quality, ThumbnailError, ThumbnailRequestItem, THUMBNAIL_ALGORITHM_VERSION};
use crate::db::Db;
use crate::source::descriptor::SourceDescriptor;
use std::sync::atomic::{AtomicBool, Ordering};

/// 事件名。
pub const EVENT_STATE: &str = "thumbnail://state";
pub const EVENT_CACHE_INFO: &str = "thumbnail://cache-info";
pub const EVENT_MIGRATION_PROGRESS: &str = "thumbnail://migration-progress";

const ORIENTATION_VERSION: u32 = 1;

// ─── 纯辅助函数（可单测）──────────────────────────────────────────────

pub fn quality_str(q: Quality) -> &'static str {
    match q {
        Quality::Standard => "standard",
        Quality::High => "high",
        Quality::Ultra => "ultra",
    }
}

pub fn is_local_descriptor(descriptor: &SourceDescriptor) -> bool {
    matches!(descriptor, SourceDescriptor::Local { .. })
}

/// Local 绝对路径 = root_path join rel_path。
pub fn local_abs_path(root_path: &str, rel_path: &str) -> PathBuf {
    let base = Path::new(root_path);
    if rel_path.is_empty() {
        base.to_path_buf()
    } else {
        base.join(rel_path)
    }
}

/// 单张请求分类结果。
#[derive(Debug, Clone)]
pub enum ItemClass {
    Unsupported,
    UseOriginal,
    Cached {
        cache_key: String,
        cache_abs: PathBuf,
        width: u32,
        height: u32,
    },
    Generate {
        task: QueuedTask,
        cache_abs: PathBuf,
    },
}

/// 对单张图片做缓存命中 / 直用原图 / 生成 分类（不提交调度器）。
/// 调用方需先确认 `is_local_descriptor`，否则不应调用本函数。
#[allow(clippy::too_many_arguments)]
pub fn classify_item(
    conn: &Connection,
    cache_root: &Path,
    descriptor_json: &str,
    abs_source_path: PathBuf,
    item: &ThumbnailRequestItem,
    epoch: u64,
    quality: Quality,
) -> rusqlite::Result<ItemClass> {
    let qp: QualityPolicy = policy::quality_policy(quality);
    // P2-3: target_bucket 不超过该清晰度最大档位（Standard 1536）
    let target_bucket = policy::select_bucket(item.required_width).min(qp.max_bucket);
    let cache_key = key::cache_key(&CacheKeyInput {
        source_descriptor_json: descriptor_json,
        rel_path: &item.source_rel_path,
        source_size: item.file_size,
        source_modified_at: item.modified_at,
        target_bucket,
        quality: quality_str(quality),
        orientation_version: ORIENTATION_VERSION,
        algorithm_version: THUMBNAIL_ALGORITHM_VERSION,
    });

    // 命中缓存（含文件一致性校验）
    if let Some(row) = index::get_verified(conn, &cache_key, cache_root)? {
        return Ok(ItemClass::Cached {
            cache_key: row.cache_key.clone(),
            cache_abs: cache_root.join(&row.cache_rel_path),
            width: row.output_width as u32,
            height: row.output_height as u32,
        });
    }

    // 决策：原图直用 / 生成
    let decision = policy::decide_source(
        item.source_width,
        item.source_height,
        item.file_size,
        target_bucket,
    );
    if matches!(decision, SourceDecision::UseOriginal) {
        return Ok(ItemClass::UseOriginal);
    }

    // 生成
    let source_key = key::source_key(descriptor_json, &item.source_rel_path);
    let cache_rel = key::cache_rel_path(&cache_key);
    let cache_abs = cache_root.join(&cache_rel);
    let pixel_budget = policy::output_pixel_budget(item.source_width, item.source_height);
    // 估算输出高度（粗略，用于内存估算）
    let approx_out_h = if item.source_width == 0 {
        target_bucket
    } else {
        ((target_bucket as u64 * item.source_height as u64) / item.source_width as u64) as u32
    };
    let est_mem = policy::estimated_decode_memory_mb(
        item.source_width,
        item.source_height,
        target_bucket,
        approx_out_h,
    );
    let job = GenerationJob {
        source_bytes: Vec::new(),
        source_path: Some(abs_source_path),
        target_width: target_bucket,
        pixel_budget,
        clarity_floor_width: item.required_width.min(target_bucket),
        webp_quality: qp.webp_quality,
        cache_path: cache_abs.clone(),
    };
    let task = QueuedTask {
        cache_key: cache_key.clone(),
        source_key,
        priority: item.priority,
        epoch,
        estimated_memory_mb: est_mem,
        job,
    };
    Ok(ItemClass::Generate { task, cache_abs })
}

/// LRU 驱逐：把总量降到 `limit_bytes` 的 80%，跳过 protected_keys。
/// 返回释放字节数。
pub fn evict_to_limit(
    conn: &Connection,
    cache_root: &Path,
    limit_bytes: u64,
    protected_keys: &HashSet<String>,
) -> rusqlite::Result<u64> {
    let total = index::total_bytes(conn)? as u64;
    if total <= limit_bytes {
        return Ok(0);
    }
    let target = (limit_bytes * 8 / 10) as i64; // 80% 水位
    let candidates = index::oldest_until_bytes(conn, target)?;
    let mut freed = 0u64;
    for row in candidates {
        if protected_keys.contains(&row.cache_key) {
            continue;
        }
        let file = cache_root.join(&row.cache_rel_path);
        let _ = std::fs::remove_file(&file);
        freed += row.byte_size as u64;
        index::remove(conn, &row.cache_key)?;
    }
    Ok(freed)
}

/// 生产用生成函数：读 Local 文件（blocking 线程内）-> generate_thumbnail。
fn production_generate_fn() -> GenerateFn {
    Arc::new(|job: GenerationJob| {
        let bytes = match &job.source_path {
            Some(p) => std::fs::read(p)?,
            None => job.source_bytes.clone(),
        };
        let req = GenerateRequest {
            source_bytes: &bytes,
            target_width: job.target_width,
            pixel_budget: job.pixel_budget,
            clarity_floor_width: job.clarity_floor_width,
            webp_quality: job.webp_quality,
            cache_path: &job.cache_path,
        };
        generate_thumbnail(req)
    })
}

// ─── 服务（Tauri managed state）─────────────────────────────────────────

/// 前端批量请求返回项。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestResult {
    pub path: String,
    pub status: String, // "original" | "cached" | "queued" | "failed" | "unsupported"
    pub cache_path: Option<String>,
    pub cache_key: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub error_kind: Option<String>,
}

/// `thumbnail://state` 事件载荷。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEvent {
    pub epoch: u64,
    pub cache_key: String,
    pub path: String,
    pub state: String, // "cached" | "failed" | "stale"
    pub cache_path: Option<String>,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub message: Option<String>,
}

pub struct ThumbnailService {
    app: AppHandle,
    scheduler: SchedulerHandle,
    /// 当前缓存根（可切换：迁移提交后更新）。读写锁，迁移切根时短暂持写锁。
    cache_root: Arc<RwLock<PathBuf>>,
    quality: Arc<RwLock<Quality>>,
    cache_limit_mb: Arc<RwLock<u64>>,
    /// LRU 保护集合：可见 + in-flight cache key，清理时跳过。
    protected_keys: Arc<std::sync::Mutex<HashSet<String>>>,
    /// 当前迁移的取消标志。
    migration_cancel: Arc<std::sync::atomic::AtomicBool>,
    /// 当前/最近一次迁移的 manifest（供 get_migration_state + 启动恢复检测）。
    migration_state: Arc<RwLock<Option<migration::MigrationManifest>>>,
}

impl ThumbnailService {
    pub fn new(
        app: AppHandle,
        cache_root: PathBuf,
        worker_limit: u32,
        memory_budget_mb: u32,
        quality: Quality,
        cache_limit_mb: u64,
    ) -> Self {
        let config = SchedulerConfig {
            worker_limit,
            memory_budget_mb,
            starvation_threshold: std::time::Duration::from_secs(5),
        };
        let scheduler = SchedulerHandle::start(config, production_generate_fn());
        Self {
            app,
            scheduler,
            cache_root: Arc::new(RwLock::new(cache_root)),
            quality: Arc::new(RwLock::new(quality)),
            cache_limit_mb: Arc::new(RwLock::new(cache_limit_mb)),
            protected_keys: Arc::new(std::sync::Mutex::new(HashSet::new())),
            migration_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            migration_state: Arc::new(RwLock::new(None)),
        }
    }

    /// 当前缓存根快照。
    pub fn cache_root(&self) -> PathBuf {
        self.cache_root.read().unwrap().clone()
    }

    /// 设置缓存根（迁移提交后调用）。
    pub fn set_cache_root(&self, root: PathBuf) {
        *self.cache_root.write().unwrap() = root;
    }

    pub fn set_runtime_config(&self, worker_limit: u32, memory_budget_mb: u32, quality: Quality) {
        self.scheduler.set_config(worker_limit, memory_budget_mb);
        *self.quality.write().unwrap() = quality;
    }

    /// P1-4: 缓存容量运行时生效（设置页改完即时推送，无需重启）。
    pub fn set_cache_limit_mb(&self, limit_mb: u64) {
        *self.cache_limit_mb.write().unwrap() = limit_mb;
    }

    pub fn new_epoch(&self, epoch: u64) {
        self.scheduler.new_epoch(epoch);
    }

    pub fn set_fast_scrolling(&self, fast: bool) {
        self.scheduler.set_fast_scrolling(fast);
    }

    /// 批量请求。Local 命中/直用/排队；非 Local 返回 unsupported。
    pub fn request(
        &self,
        descriptor: &SourceDescriptor,
        items: &[ThumbnailRequestItem],
        epoch: u64,
        visible_cache_keys: &[String],
    ) -> Vec<RequestResult> {
        let descriptor_json = match serde_json::to_string(descriptor) {
            Ok(s) => s,
            Err(_) => {
                return items
                    .iter()
                    .map(|i| err_result(&i.path, "serialize_failed"))
                    .collect();
            }
        };
        let local = is_local_descriptor(descriptor);
        let root_path = match descriptor {
            SourceDescriptor::Local { root_path } => root_path.clone(),
            _ => String::new(),
        };
        let quality = *self.quality.read().unwrap();
        // 快照当前缓存根（迁移切根时更新；request 内一致使用此快照）
        let cache_root = self.cache_root();

        let mut results = Vec::with_capacity(items.len());
        // 收集需要生成的任务（先全部分类，再统一提交，避免持锁跨 await）
        // (task, cache_abs, item) —— item 携带完整源元数据供 CompletionMeta/build_row
        let mut to_submit: Vec<(QueuedTask, PathBuf, ThumbnailRequestItem)> = Vec::new();

        {
            let db = self.app.state::<Db>();
            let conn = db.conn();
            // 访问时间批量刷新（可见 key 的 LRU 保护）+ P1-6 更新保护集合
            if !visible_cache_keys.is_empty() {
                let _ = index::touch_many(&conn, visible_cache_keys, now_secs());
            }
            {
                let mut pk = self.protected_keys.lock().unwrap();
                pk.clear();
                for k in visible_cache_keys {
                    pk.insert(k.clone());
                }
            }
            for item in items {
                if !local {
                    results.push(RequestResult {
                        path: item.path.clone(),
                        status: "unsupported".into(),
                        ..unset(&item.path)
                    });
                    continue;
                }
                // P1-1: 用 source_rel_path（含 currentPath 前缀）定位文件，而非 UI path
                let abs = local_abs_path(&root_path, &item.source_rel_path);
                match classify_item(
                    &conn,
                    &cache_root,
                    &descriptor_json,
                    abs,
                    item,
                    epoch,
                    quality,
                ) {
                    Ok(ItemClass::Unsupported) => results.push(RequestResult {
                        path: item.path.clone(),
                        status: "unsupported".into(),
                        ..unset(&item.path)
                    }),
                    Ok(ItemClass::UseOriginal) => results.push(RequestResult {
                        path: item.path.clone(),
                        status: "original".into(),
                        ..unset(&item.path)
                    }),
                    Ok(ItemClass::Cached {
                        cache_key,
                        cache_abs,
                        width,
                        height,
                    }) => results.push(RequestResult {
                        path: item.path.clone(),
                        status: "cached".into(),
                        cache_path: Some(cache_abs.to_string_lossy().into()),
                        cache_key: Some(cache_key),
                        width: Some(width),
                        height: Some(height),
                        error_kind: None,
                    }),
                    Ok(ItemClass::Generate { task, cache_abs }) => {
                        let ck = task.cache_key.clone();
                        // P1-6: in-flight key 加入保护集合，避免生成期间被 LRU 清理
                        {
                            let mut pk = self.protected_keys.lock().unwrap();
                            pk.insert(ck.clone());
                        }
                        to_submit.push((task, cache_abs, item.clone()));
                        results.push(RequestResult {
                            path: item.path.clone(),
                            status: "queued".into(),
                            cache_path: None,
                            cache_key: Some(ck),
                            width: None,
                            height: None,
                            error_kind: None,
                        });
                    }
                    Err(e) => results.push(err_result(&item.path, &e.to_string())),
                }
            }
        }

        // 提交生成任务 + 挂完成回调
        for (task, cache_abs, item) in to_submit {
            let cache_key = task.cache_key.clone();
            let target_bucket = task.job.target_width;
            let rx = self.scheduler.submit(task);
            let app = self.app.clone();
            let root_for_completion = cache_root.clone();
            let cache_limit = *self.cache_limit_mb.read().unwrap() * 1_000_000;
            spawn_completion(app, rx, CompletionMeta {
                epoch,
                cache_key,
                ui_path: item.path.clone(),
                source_rel_path: item.source_rel_path.clone(),
                cache_abs,
                cache_root: root_for_completion,
                cache_limit,
                protected_keys: self.protected_keys.clone(),
                source_key: key::source_key(&descriptor_json, &item.source_rel_path),
                source_size: item.file_size,
                source_modified_at: item.modified_at,
                source_width: item.source_width,
                source_height: item.source_height,
                quality: quality_str(quality).to_string(),
                target_bucket,
            });
        }
        results
    }

    /// 重试：以 visible 优先级重新排队（不删缓存索引）。
    pub fn retry(
        &self,
        descriptor: &SourceDescriptor,
        item: &ThumbnailRequestItem,
        epoch: u64,
    ) -> RequestResult {
        self.resubmit(descriptor, item, epoch, false, "queued")
    }

    /// 强制重建：先删缓存文件 + 索引，再以 visible 重新生成。
    pub fn regenerate(
        &self,
        descriptor: &SourceDescriptor,
        item: &ThumbnailRequestItem,
        epoch: u64,
    ) -> RequestResult {
        self.resubmit(descriptor, item, epoch, true, "queued")
    }

    fn resubmit(
        &self,
        descriptor: &SourceDescriptor,
        item: &ThumbnailRequestItem,
        epoch: u64,
        delete_cache: bool,
        queued_status: &str,
    ) -> RequestResult {
        if !is_local_descriptor(descriptor) {
            return RequestResult {
                path: item.path.clone(),
                status: "unsupported".into(),
                ..unset(&item.path)
            };
        }
        let descriptor_json = serde_json::to_string(descriptor).unwrap_or_default();
        let root_path = match descriptor {
            SourceDescriptor::Local { root_path } => root_path.clone(),
            _ => String::new(),
        };
        let quality = *self.quality.read().unwrap();
        let cache_root = self.cache_root();
        let abs = local_abs_path(&root_path, &item.source_rel_path);

        // 强制重建：删除旧缓存
        if delete_cache {
            let qp = policy::quality_policy(quality);
            let target_bucket = policy::select_bucket(item.required_width).min(qp.max_bucket);
            let ck = key::cache_key(&CacheKeyInput {
                source_descriptor_json: &descriptor_json,
                rel_path: &item.source_rel_path,
                source_size: item.file_size,
                source_modified_at: item.modified_at,
                target_bucket,
                quality: quality_str(quality),
                orientation_version: ORIENTATION_VERSION,
                algorithm_version: THUMBNAIL_ALGORITHM_VERSION,
            });
            let rel = key::cache_rel_path(&ck);
            let db = self.app.state::<Db>();
            let conn = db.conn();
            let _ = std::fs::remove_file(cache_root.join(&rel));
            let _ = index::remove(&conn, &ck);
        }

        // 重新分类并以 visible 强制入队
        let task = {
            let db = self.app.state::<Db>();
            let conn = db.conn();
            match classify_item(
                &conn,
                &cache_root,
                &descriptor_json,
                abs,
                item,
                epoch,
                quality,
            ) {
                Ok(ItemClass::Generate { mut task, cache_abs }) => {
                    task.priority = Priority::Visible;
                    Some((task, cache_abs))
                }
                Ok(ItemClass::Cached {
                    cache_key,
                    cache_abs,
                    width,
                    height,
                }) => {
                    return RequestResult {
                        path: item.path.clone(),
                        status: "cached".into(),
                        cache_path: Some(cache_abs.to_string_lossy().into()),
                        cache_key: Some(cache_key),
                        width: Some(width),
                        height: Some(height),
                        error_kind: None,
                    };
                }
                Ok(_) => None,
                Err(_) => None,
            }
        };
        let Some((task, cache_abs)) = task else {
            return RequestResult {
                path: item.path.clone(),
                status: "original".into(),
                ..unset(&item.path)
            };
        };
        let cache_key = task.cache_key.clone();
        let target_bucket = task.job.target_width;
        // P1-6: in-flight key 加入保护集合
        {
            let mut pk = self.protected_keys.lock().unwrap();
            pk.insert(cache_key.clone());
        }
        let rx = self.scheduler.submit(task);
        let app = self.app.clone();
        let cache_root = cache_root.clone();
        let cache_limit = *self.cache_limit_mb.read().unwrap() * 1_000_000;
        spawn_completion(app, rx, CompletionMeta {
            epoch,
            cache_key: cache_key.clone(),
            ui_path: item.path.clone(),
            source_rel_path: item.source_rel_path.clone(),
            cache_abs,
            cache_root,
            cache_limit,
            protected_keys: self.protected_keys.clone(),
            source_key: key::source_key(&descriptor_json, &item.source_rel_path),
            source_size: item.file_size,
            source_modified_at: item.modified_at,
            source_width: item.source_width,
            source_height: item.source_height,
            quality: quality_str(quality).to_string(),
            target_bucket,
        });
        RequestResult {
            path: item.path.clone(),
            status: queued_status.into(),
            cache_path: None,
            cache_key: Some(cache_key),
            width: None,
            height: None,
            error_kind: None,
        }
    }

    /// 缓存统计：总字节、文件数。
    pub fn cache_info(&self) -> (u64, u64) {
        let db = self.app.state::<Db>();
        let conn = db.conn();
        let total = index::total_bytes(&conn).unwrap_or(0) as u64;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM thumbnail_cache", [], |r| r.get(0))
            .unwrap_or(0);
        (total, count as u64)
    }

    /// 清空缓存：删全部文件 + 索引（不删根目录）。
    /// P2-2: 先 cancel_all 使排队/in-flight 任务变 Stale（完成后不写索引），避免清空后被后台任务重新写回。
    pub fn clear(&self) {
        // 取消全部未开始任务 + 让 in-flight 完成后不发 Cached（不写索引）
        self.scheduler.cancel_all();
        // 清空保护集合
        self.protected_keys.lock().unwrap().clear();
        let db = self.app.state::<Db>();
        let conn = db.conn();
        // 取所有 rel_path，删文件
        let rels: Vec<String> = {
            let mut stmt = match conn.prepare("SELECT cache_rel_path FROM thumbnail_cache") {
                Ok(s) => s,
                Err(_) => return,
            };
            stmt.query_map([], |r| r.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(Result::ok).collect())
                .unwrap_or_default()
        };
        for rel in rels {
            let _ = std::fs::remove_file(self.cache_root().join(rel));
        }
        let _ = index::clear_all(&conn);
        let _ = self.app.emit(EVENT_CACHE_INFO, serde_json::json!({"bytes":0,"count":0}));
    }

    // ─── 缓存位置迁移（§11）──────────────────────────────────────────────

    /// 校验目标目录是否可作为新缓存根。
    pub fn validate_cache_location(&self, target: &Path) -> Result<(), String> {
        let root = self.cache_root();
        let fs = RealFs;
        migration::validate_target(&root, target, &fs).map_err(|e| e.to_string())
    }

    /// 当前/最近一次迁移状态（启动恢复检测 + 进度查询）。
    pub fn migration_state(&self) -> Option<migration::MigrationManifest> {
        self.migration_state.read().unwrap().clone()
    }

    /// 启动/继续迁移。cancel_all 暂停生成；spawn_blocking 跑 run_migration；
    /// 成功后切 cache_root + commit（Move 删源）；进度通过 thumbnail://migration-progress 事件。
    pub fn start_migration(&self, target: PathBuf, mode: MigrationMode) {
        let app = self.app.clone();
        let source = self.cache_root();
        let target_clone = target.clone();
        let cancel = self.migration_cancel.clone();
        let state = self.migration_state.clone();
        let cache_root_lock = self.cache_root.clone();
        cancel.store(false, Ordering::Relaxed);
        // 暂停生成（排队/in-flight 变 stale，不再写索引）
        self.scheduler.cancel_all();

        tokio::task::spawn_blocking(move || {
            let fs = RealFs;
            // 先校验
            if let Err(e) = migration::validate_target(&source, &target, &fs) {
                let _ = app.emit(EVENT_MIGRATION_PROGRESS, serde_json::json!({"phase":"failed","error":e.to_string()}));
                return;
            }
            let app_for_progress = app.clone();
            let state_for_progress = state.clone();
            let mut on_progress = |m: &migration::MigrationManifest| {
                *state_for_progress.write().unwrap() = Some(m.clone());
                let _ = app_for_progress.emit(EVENT_MIGRATION_PROGRESS, serde_json::json!({
                    "phase": format!("{:?}", m.phase).to_lowercase(),
                    "completed": m.completed.len(),
                    "totalFiles": m.total_files,
                    "copiedBytes": m.copied_bytes,
                    "totalBytes": m.total_bytes,
                }));
            };
            let result = migration::run_migration(&source, &target, mode, &fs, &cancel, &mut on_progress);
            match result {
                Ok(m) if m.phase == migration::MigrationPhase::Completed => {
                    // 提交：切根 + 持久化设置 + commit（删源/删 manifest）
                    *cache_root_lock.write().unwrap() = target_clone.clone();
                    // 持久化新缓存根到 settings（重启后从新位置加载）
                    if let Some(db) = app.try_state::<crate::db::Db>() {
                        let conn = db.conn();
                        let _ = conn.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
                            rusqlite::params!["fb_thumbnail_cache_root", target_clone.to_string_lossy()],
                        );
                    }
                    let _ = migration::commit_migration(&source, &target_clone, mode, &fs);
                    *state.write().unwrap() = None;
                    let _ = app.emit(EVENT_MIGRATION_PROGRESS, serde_json::json!({"phase":"completed"}));
                }
                Ok(_) | Err(migration::MigrationError::Cancelled) => {
                    // 取消（手动或启动恢复后再次取消）：根保持旧位置
                    let _ = app.emit(EVENT_MIGRATION_PROGRESS, serde_json::json!({"phase":"cancelled"}));
                }
                Err(e) => {
                    *state.write().unwrap() = None;
                    let _ = app.emit(EVENT_MIGRATION_PROGRESS, serde_json::json!({"phase":"failed","error":e.to_string()}));
                }
            }
        });
    }

    /// 取消当前迁移（run_migration 在下一个文件边界退出）。
    pub fn cancel_migration(&self) {
        self.migration_cancel.store(true, Ordering::Relaxed);
    }

    /// 回滚：删 target 副本 + manifest，根保持旧位置。
    pub fn rollback_migration(&self, target: PathBuf) -> Result<(), String> {
        let fs = RealFs;
        migration::rollback_migration(&target, &fs).map_err(|e| e.to_string())?;
        *self.migration_state.write().unwrap() = None;
        Ok(())
    }
}

struct CompletionMeta {
    epoch: u64,
    cache_key: String,
    /// UI key（前端 entry.path），事件 `path` 字段用它。
    ui_path: String,
    /// 相对 source root 路径，索引 rel_path 用。
    source_rel_path: String,
    cache_abs: PathBuf,
    cache_root: PathBuf,
    cache_limit: u64,
    /// LRU 保护集合（可见 + in-flight），清理时跳过。
    protected_keys: Arc<std::sync::Mutex<HashSet<String>>>,
    // 索引元数据（P2-1）
    source_key: String,
    source_size: u64,
    source_modified_at: Option<i64>,
    source_width: u32,
    source_height: u32,
    quality: String,
    target_bucket: u32,
}

fn spawn_completion(app: AppHandle, rx: tokio::sync::oneshot::Receiver<Outcome>, meta: CompletionMeta) {
    tokio::spawn(async move {
        let outcome = match rx.await {
            Ok(o) => o,
            Err(_) => return, // 调度器关闭
        };
        // 完成后从 in-flight 保护集合移除（短暂保护由本次 evict 的 protected 传入）
        {
            let mut pk = meta.protected_keys.lock().unwrap();
            pk.remove(&meta.cache_key);
        }
        let db = app.state::<Db>();
        let conn = db.conn();
        match outcome {
            Outcome::Cached(g) => {
                // 写索引（完整元数据）
                let row = build_row(&meta, &g);
                let _ = index::upsert(&conn, &row);
                // P1-6: LRU 驱逐，保护可见 + 本次刚完成 key
                let mut protected = meta.protected_keys.lock().unwrap().clone();
                protected.insert(meta.cache_key.clone());
                let _ = evict_to_limit(&conn, &meta.cache_root, meta.cache_limit, &protected);
                // P1-2: 事件 path 用 ui_path（前端 entry.path），而非绝对磁盘路径
                let _ = app.emit(
                    EVENT_STATE,
                    StateEvent {
                        epoch: meta.epoch,
                        cache_key: meta.cache_key,
                        path: meta.ui_path,
                        state: "cached".into(),
                        cache_path: Some(meta.cache_abs.to_string_lossy().into_owned()),
                        output_width: Some(g.width),
                        output_height: Some(g.height),
                        message: None,
                    },
                );
            }
            Outcome::Failed(msg) => {
                let _ = app.emit(
                    EVENT_STATE,
                    StateEvent {
                        epoch: meta.epoch,
                        cache_key: meta.cache_key,
                        path: meta.ui_path,
                        state: "failed".into(),
                        cache_path: None,
                        output_width: None,
                        output_height: None,
                        message: Some(msg),
                    },
                );
            }
            Outcome::Stale => {
                // 旧 epoch：不发 UI 更新。
            }
        }
    });
}

/// 构造完整索引行（P2-1：填真实元数据而非空值）。
fn build_row(meta: &CompletionMeta, g: &GeneratedThumbnail) -> ThumbnailCacheRow {
    let cache_rel = meta
        .cache_abs
        .file_name()
        .map(|f| {
            let mut s = meta
                .cache_abs
                .parent()
                .and_then(|p| p.file_name())
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !s.is_empty() {
                s.push('/');
            }
            s.push_str(&f.to_string_lossy());
            s
        })
        .unwrap_or_default();
    let now = now_secs();
    ThumbnailCacheRow {
        cache_key: meta.cache_key.clone(),
        source_key: meta.source_key.clone(),
        rel_path: meta.source_rel_path.clone(),
        source_size: Some(meta.source_size as i64),
        source_modified_at: meta.source_modified_at,
        source_width: Some(meta.source_width as i64),
        source_height: Some(meta.source_height as i64),
        orientation: None, // generator 当前不回传 orientation；后续如回传再填
        target_bucket: meta.target_bucket as i64,
        quality: meta.quality.clone(),
        cache_rel_path: cache_rel,
        output_width: g.width as i64,
        output_height: g.height as i64,
        byte_size: g.byte_size as i64,
        created_at: now,
        last_accessed_at: now,
    }
}

fn unset(path: &str) -> RequestResult {
    RequestResult {
        path: path.to_string(),
        status: String::new(),
        cache_path: None,
        cache_key: None,
        width: None,
        height: None,
        error_kind: None,
    }
}

fn err_result(path: &str, msg: &str) -> RequestResult {
    RequestResult {
        path: path.to_string(),
        status: "failed".into(),
        cache_path: None,
        cache_key: None,
        width: None,
        height: None,
        error_kind: Some(msg.to_string()),
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    fn open() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        conn
    }

    fn item(path: &str, w: u32, h: u32, size: u64, required: u32) -> ThumbnailRequestItem {
        ThumbnailRequestItem {
            path: path.to_string(),
            // 默认 source_rel_path = path（根目录场景）；子目录测试单独覆盖。
            source_rel_path: path.to_string(),
            file_size: size,
            modified_at: Some(100),
            source_width: w,
            source_height: h,
            required_width: required,
            priority: Priority::Visible,
        }
    }

    #[test]
    fn classify_use_original_for_small_image() {
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        // 800x600=0.48MP, 500KB, required 1024 -> bucket 1024, 直用条件全满足
        let cls = classify_item(
            &conn,
            dir.path(),
            r#"{"type":"local","rootPath":"D:/x"}"#,
            PathBuf::from("D:/x/a.jpg"),
            &item("a.jpg", 800, 600, 500_000, 1024),
            1,
            Quality::High,
        )
        .unwrap();
        assert!(matches!(cls, ItemClass::UseOriginal));
    }

    #[test]
    fn classify_generate_for_large_image() {
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        // 4000x3000=12MP, 5MB -> Generate
        let cls = classify_item(
            &conn,
            dir.path(),
            r#"{"type":"local","rootPath":"D:/x"}"#,
            PathBuf::from("D:/x/big.jpg"),
            &item("big.jpg", 4000, 3000, 5_000_000, 1024),
            1,
            Quality::High,
        )
        .unwrap();
        match cls {
            ItemClass::Generate { task, cache_abs } => {
                assert!(!task.cache_key.is_empty());
                assert!(cache_abs.starts_with(dir.path()));
                assert!(task.job.source_path.is_some());
            }
            _ => panic!("expected Generate"),
        }
    }

    #[test]
    fn classify_cached_when_file_and_index_exist() {
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        // 先按大图分类得到 cache_key + cache_abs，造文件 + 索引，再分类应命中
        let cls = classify_item(
            &conn,
            dir.path(),
            r#"{"type":"local","rootPath":"D:/x"}"#,
            PathBuf::from("D:/x/big.jpg"),
            &item("big.jpg", 4000, 3000, 5_000_000, 1024),
            1,
            Quality::High,
        )
        .unwrap();
        let (cache_key, cache_abs) = match cls {
            ItemClass::Generate { task, cache_abs } => (task.cache_key, cache_abs),
            _ => panic!("expected Generate first"),
        };
        // 造缓存文件
        std::fs::create_dir_all(cache_abs.parent().unwrap()).unwrap();
        std::fs::write(&cache_abs, b"webp").unwrap();
        // 写索引
        let rel = key::cache_rel_path(&cache_key);
        let row = ThumbnailCacheRow {
            cache_key: cache_key.clone(),
            source_key: "s".into(),
            rel_path: "big.jpg".into(),
            source_size: None,
            source_modified_at: None,
            source_width: None,
            source_height: None,
            orientation: None,
            target_bucket: 1024,
            quality: "high".into(),
            cache_rel_path: rel,
            output_width: 1024,
            output_height: 768,
            byte_size: 4,
            created_at: 1,
            last_accessed_at: 1,
        };
        index::upsert(&conn, &row).unwrap();

        let cls2 = classify_item(
            &conn,
            dir.path(),
            r#"{"type":"local","rootPath":"D:/x"}"#,
            PathBuf::from("D:/x/big.jpg"),
            &item("big.jpg", 4000, 3000, 5_000_000, 1024),
            1,
            Quality::High,
        )
        .unwrap();
        assert!(matches!(cls2, ItemClass::Cached { .. }));
    }

    #[test]
    fn classify_cache_key_changes_with_quality() {
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        let c1 = classify_item(
            &conn,
            dir.path(),
            r#"{"type":"local","rootPath":"D:/x"}"#,
            PathBuf::from("D:/x/big.jpg"),
            &item("big.jpg", 4000, 3000, 5_000_000, 1024),
            1,
            Quality::High,
        )
        .unwrap();
        let c2 = classify_item(
            &conn,
            dir.path(),
            r#"{"type":"local","rootPath":"D:/x"}"#,
            PathBuf::from("D:/x/big.jpg"),
            &item("big.jpg", 4000, 3000, 5_000_000, 1024),
            1,
            Quality::Ultra,
        )
        .unwrap();
        let k1 = match c1 {
            ItemClass::Generate { task, .. } => task.cache_key,
            _ => panic!(),
        };
        let k2 = match c2 {
            ItemClass::Generate { task, .. } => task.cache_key,
            _ => panic!(),
        };
        assert_ne!(k1, k2, "different quality -> different cache key");
    }

    #[test]
    fn evict_to_limit_removes_oldest_files() {
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        // 三行各 100B，limit 200 -> 降到 160 (200*0.8)，删最旧 1 行（释放到 <=160）
        for (k, t) in [("aa00", 1i64), ("bb00", 2), ("cc00", 3)] {
            let rel = key::cache_rel_path(k);
            let abs = dir.path().join(&rel);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(&abs, b"x").unwrap();
            let row = ThumbnailCacheRow {
                cache_key: k.into(),
                source_key: "s".into(),
                rel_path: "p".into(),
                source_size: None,
                source_modified_at: None,
                source_width: None,
                source_height: None,
                orientation: None,
                target_bucket: 512,
                quality: "high".into(),
                cache_rel_path: rel,
                output_width: 512,
                output_height: 512,
                byte_size: 100,
                created_at: t,
                last_accessed_at: t,
            };
            index::upsert(&conn, &row).unwrap();
        }
        let freed = evict_to_limit(&conn, dir.path(), 200, &HashSet::new()).unwrap();
        assert!(freed >= 100, "should free at least one file");
        assert!(index::total_bytes(&conn).unwrap() <= 160);
    }

    #[test]
    fn local_abs_path_joins_root_and_rel() {
        let p = local_abs_path("D:/imgs", "sub/a.jpg");
        assert!(p.to_string_lossy().ends_with("sub/a.jpg"));
        assert!(p.to_string_lossy().contains("imgs"));
    }

    /// P1-1 回归：子目录场景 cache_key 与 abs 路径必须用 source_rel_path（含 currentPath 前缀），
    /// 而非 UI path（entry.path）。否则后端读 root/a.jpg 而非 root/normal/a.jpg。
    #[test]
    fn classify_subdir_uses_source_rel_path_for_key_and_abs() {
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        let sd = r#"{"type":"local","rootPath":"D:/root"}"#;
        // 子目录：UI path=a.jpg，source_rel_path=normal/a.jpg
        let mut it = item("a.jpg", 4000, 3000, 5_000_000, 1024);
        it.source_rel_path = "normal/a.jpg".to_string();
        let abs = local_abs_path("D:/root", "normal/a.jpg");
        let cls = classify_item(&conn, dir.path(), sd, abs, &it, 1, Quality::High).unwrap();
        let task = match cls {
            ItemClass::Generate { task, .. } => task,
            _ => panic!("expected Generate"),
        };
        // cache_key 基于 source_rel_path
        let expected_key = key::cache_key(&CacheKeyInput {
            source_descriptor_json: sd,
            rel_path: "normal/a.jpg",
            source_size: 5_000_000,
            source_modified_at: Some(100),
            target_bucket: 1024,
            quality: "high",
            orientation_version: ORIENTATION_VERSION,
            algorithm_version: THUMBNAIL_ALGORITHM_VERSION,
        });
        assert_eq!(task.cache_key, expected_key, "cache_key must derive from source_rel_path");
        // abs 路径含 normal 前缀（读到 root/normal/a.jpg 而非 root/a.jpg）
        let abs_str = task.job.source_path.as_ref().unwrap().to_string_lossy().into_owned();
        assert!(abs_str.contains("normal"), "abs path must include subdir: {abs_str}");
        // 根目录同名文件 key 不同 -> 子目录隔离
        let root_cls = classify_item(
            &conn, dir.path(), sd,
            local_abs_path("D:/root", "a.jpg"),
            &item("a.jpg", 4000, 3000, 5_000_000, 1024),
            1, Quality::High,
        ).unwrap();
        let root_task = match root_cls {
            ItemClass::Generate { task, .. } => task,
            _ => panic!("expected Generate"),
        };
        assert_ne!(task.cache_key, root_task.cache_key, "subdir vs root must differ");
    }

    /// P2-3 回归：Standard 清晰度 max_bucket=1536，高 DPR 下不应生成 2048。
    #[test]
    fn classify_standard_quality_caps_bucket_at_1536() {
        let conn = open();
        let dir = tempfile::tempdir().unwrap();
        let sd = r#"{"type":"local","rootPath":"D:/root"}"#;
        // required_width 2048 -> select_bucket(2048)=2048，但 Standard max=1536 -> 截到 1536
        let cls = classify_item(
            &conn, dir.path(), sd,
            local_abs_path("D:/root", "big.jpg"),
            &item("big.jpg", 4000, 3000, 5_000_000, 2048),
            1, Quality::Standard,
        ).unwrap();
        let task = match cls {
            ItemClass::Generate { task, .. } => task,
            _ => panic!("expected Generate"),
        };
        assert_eq!(task.job.target_width, 1536, "Standard must cap at 1536");
    }
}
