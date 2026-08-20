//! 远程 Archive 物化器（M3 spec §4）
//! cache_key = sha256(canonical origin descriptor JSON + '\0' + archive_rel_path)
//! （canonical = typed serde_json::to_string(SourceDescriptor)，migration 013 验证过的形态）

use crate::db::Db;
use crate::source::descriptor::SourceDescriptor;
use crate::source::trait_def::{ByteRange, FileStat, MediaSource, MediaSourceError};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub fn cache_key(origin: &SourceDescriptor, archive_rel_path: &str) -> String {
    let canonical = serde_json::to_string(origin).unwrap_or_default();
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(canonical.as_bytes());
    hasher.update([0u8]); // '\0' 分隔符：descriptor JSON 与 rel 边界不可伪造
    hasher.update(archive_rel_path.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 失效判定（spec §4.2）：size 不同 → 失效；双方 mtime Some 且不同 → 失效；
/// 行 mtime None → size 唯一判据（SMB mtime 缺失场景）保守放行；
/// 行有 mtime 但远端当前 None → 保守失效
pub fn is_stale(row_origin_size: i64, row_origin_mtime: Option<i64>, current: &FileStat) -> bool {
    if row_origin_size != current.size as i64 { return true; }
    match (row_origin_mtime, current.modified_at) {
        (Some(r), Some(c)) => r != c,
        (None, _) => false,
        (Some(_), None) => true,
    }
}

// ===================== ensure_cached 状态机（M3 spec §4；rev2-rev6 语义 baked in） =====================
// - 取消双通道：窗口 epoch 只取消 cancellable=true（预载）任务；cancel_gen 单调自增对所有
//   任务生效，四检查点（每 chunk 前 / 二次 stat 前 / 二次 stat 后 rename 前 / 紧贴 upsert 前）
//   比对，代际变更即中止且不复活（rename 后发现代际变要删文件不上表）
// - sidecar 断点续传四关校验：cache_key 重算 / canonical origin / rel / 快照 size+mtime vs
//   远端 stat / downloaded == .part 长度 / ≤ 远端 size——任一不符弃 .part+sidecar 全量重下
// - rev5 闸门：InflightState { clearing, map } 同一把 tokio async Mutex；「查 clearing + 查重 +
//   注册」单一临界区原子完成；等待者持锁 notified().enable() 预注册再 drop 锁 await（防丢唤醒）
// - DB 连接不跨网络 await：先读行 drop conn → await stat → 重新取连接 touch/删行
// - 失效条件删除（审查修复）：stale 分支 DELETE 按 (cache_key, origin_size, origin_mtime)
//   指纹匹配——落空（0 行）= 行已被并发任务刷新 → 重读行，对手版本对本次 stat 新鲜则
//   touch + 复用返回（免重下），不误删并发刚物化好的新 final 文件

#[derive(Debug, thiserror::Error)]
pub enum MaterializeError {
    #[error("网络错误: {0}")]
    Network(String),
    #[error("远端文件不存在: {0}")]
    NotFound(String),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("其他: {0}")]
    Other(String),
}

/// 简报模板缺失、编译必需：download / 命中路径对 `src.stat(...)` / `src.read_file(...)`
/// 用 `?`，需要 MediaSourceError → MaterializeError 的转换（模板只定义了反方向）
impl From<MediaSourceError> for MaterializeError {
    fn from(e: MediaSourceError) -> Self {
        match e {
            MediaSourceError::Network(s) => MaterializeError::Network(s),
            MediaSourceError::Timeout(s) => MaterializeError::Network(s),
            MediaSourceError::NotFound(s) => MaterializeError::NotFound(s),
            MediaSourceError::Io(io) => MaterializeError::Io(io),
            MediaSourceError::Other(s) => MaterializeError::Other(s),
            other => MaterializeError::Other(other.to_string()),
        }
    }
}

impl From<MaterializeError> for MediaSourceError {
    fn from(e: MaterializeError) -> Self {
        match e {
            MaterializeError::Network(s) => MediaSourceError::Network(s),
            MaterializeError::NotFound(s) => MediaSourceError::NotFound(s),
            MaterializeError::Io(io) => MediaSourceError::Io(io),
            MaterializeError::Other(s) => MediaSourceError::Other(s),
        }
    }
}

const CHUNK: u64 = 4 * 1024 * 1024;

pub struct Materializer {
    webdav: Arc<dyn MediaSource>,
    smb: Arc<dyn MediaSource>,
    db: Db,
    cache_root: std::sync::RwLock<PathBuf>,
    /// in-flight 注册表 + 清空闸门**同一临界区**（rev5：AtomicBool 闸门与注册不原子，
    /// 迟到任务带新代际穿透清空——「查 clearing + 注册 inflight」必须一把锁内完成，
    /// begin_clearing 持同锁先置位再 drain）
    inflight: tokio::sync::Mutex<InflightState>,
    /// 窗口 epoch（rev2 双通道①）：预载切目录推进；仅 cancellable 任务检查
    epoch: std::sync::atomic::AtomicU64,
    /// cancellation generation（rev2 双通道②）：cancel_all() 单调自增；
    /// 预载与强制物化在每 chunk / 二次 stat 后 / rename 前 / upsert 前四检查点比对
    cancel_gen: std::sync::atomic::AtomicU64,
}

/// in-flight 注册表 + 清空闸门（同一把 async Mutex 保护——rev5 TOCTOU 修复）
pub struct InflightState {
    pub clearing: bool,
    pub map: HashMap<String, Arc<tokio::sync::Notify>>,
}

/// sidecar 元数据（rev2 重启续传）：与 .part 同目录同名 + .meta
#[derive(serde::Serialize, serde::Deserialize)]
pub struct PartSidecar {
    pub cache_key: String,            // 身份重算比对（防 .part 被移动/误放）
    pub canonical_origin: String,     // serde_json::to_string(origin)——与 cache_key 输入同源
    pub archive_rel_path: String,
    pub snapshot_size: u64,
    pub snapshot_mtime: Option<i64>,
    pub downloaded: u64,              // 每 chunk 后更新（与 .part 文件长度一致性校验用）
}

pub fn sidecar_path(part_path: &std::path::Path) -> std::path::PathBuf {
    let mut s = part_path.as_os_str().to_os_string();
    s.push(".meta");
    std::path::PathBuf::from(s)
}

/// sidecar 原子写（tmp + rename）——半截 JSON 会被续传校验拒绝，但原子写让这几乎不发生
fn atomic_write_sidecar(part_path: &std::path::Path, sc: &PartSidecar) -> Result<(), MaterializeError> {
    let target = sidecar_path(part_path);
    let tmp = target.with_extension("meta.tmp");
    std::fs::write(&tmp, serde_json::to_vec(sc).map_err(|e| MaterializeError::Other(e.to_string()))?)
        .map_err(MaterializeError::Io)?;
    std::fs::rename(&tmp, &target).map_err(MaterializeError::Io)
}

/// 启动清理（spec §8 rev2）：①part/ 只删 sidecar 缺失/损坏的 .part（**有效 sidecar 保留——
/// 重启续传依据，原「全删 part/」与断点续传冲突已废弃**；一致性验证推迟到下次
/// ensure_cached 的 sidecar 快照 vs 远端 stat，启动时零网络请求）②孤儿缓存文件（表无行）
/// ③超容量淘汰
pub fn startup_cleanup(cache_root: &std::path::Path, db: &Db, limit_bytes: i64) {
    if let Ok(rd) = std::fs::read_dir(cache_root.join("part")) {
        for entry in rd.flatten() {
            let p = entry.path();
            // rev3：只把扩展名恰为 .part 的数据文件当候选——sidecar（.part.meta）与
            // 原子写残留（.meta.tmp）不是 part，绝不当候选（原实现会把 .meta 判为
            // 无 sidecar 的孤儿而误删，下次启动无法续传）
            if p.extension().and_then(|e| e.to_str()) != Some("part") {
                if p.extension().and_then(|e| e.to_str()) == Some("tmp") {
                    let _ = std::fs::remove_file(&p); // 原子写残留可清
                }
                continue;
            }
            // 结构化校验（非仅 JSON 可解析）：六字段齐全且类型正确才保留
            let sidecar_ok = std::fs::read(sidecar_path(&p))
                .ok()
                .and_then(|b| serde_json::from_slice::<PartSidecar>(&b).ok())
                .is_some();
            if !sidecar_ok {
                let _ = std::fs::remove_file(&p); // 无法安全续传的孤儿
                let _ = std::fs::remove_file(sidecar_path(&p));
            }
        }
    }
    let _ = std::fs::create_dir_all(cache_root.join("part"));
    let conn = db.conn();
    let known: std::collections::HashSet<String> = {
        let mut stmt = match conn.prepare("SELECT cache_abs_path FROM archive_cache") { Ok(s) => s, Err(_) => return };
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map(|it| it.filter_map(|v| v.ok()).collect::<Vec<_>>());
        match rows { Ok(v) => v.into_iter().collect(), Err(_) => return }
    };
    if let Ok(rd) = std::fs::read_dir(cache_root) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_file() && !known.contains(&p.display().to_string()) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    let _ = super::dao::evict_to_limit(&conn, limit_bytes, &[]);
}

impl Materializer {
    pub fn new(webdav: Arc<dyn MediaSource>, smb: Arc<dyn MediaSource>, db: Db, cache_root: PathBuf) -> Self {
        Self { webdav, smb, db, cache_root: std::sync::RwLock::new(cache_root),
               inflight: tokio::sync::Mutex::new(InflightState {
                   clearing: false, map: HashMap::new(),
               }),
               epoch: std::sync::atomic::AtomicU64::new(0),
               cancel_gen: std::sync::atomic::AtomicU64::new(0) }   // rev4 补齐（漏初始化=编译失败）
    }

    fn origin_source(&self, origin: &SourceDescriptor) -> Result<&Arc<dyn MediaSource>, MaterializeError> {
        match origin {
            SourceDescriptor::WebDav { .. } => Ok(&self.webdav),
            SourceDescriptor::Smb { .. } => Ok(&self.smb),
            _ => Err(MaterializeError::Other(format!("archive origin 仅支持 webdav/smb，得到 {:?}", origin.type_str()))),
        }
    }

    fn cache_paths(&self, key: &str) -> (PathBuf, PathBuf) {
        let root = self.cache_root.read().unwrap().clone();
        (root.join(format!("{key}.zip")), root.join("part").join(format!("{key}.part")))
    }

    pub fn new_epoch(&self, e: u64) { self.epoch.store(e, std::sync::atomic::Ordering::SeqCst); }
    fn current_epoch(&self) -> u64 { self.epoch.load(std::sync::atomic::Ordering::SeqCst) }

    /// rev2 双通道②：单调自增，新任务取新代际——预载在 clear 后自然恢复
    pub fn cancel_all(&self) { self.cancel_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst); }
    pub fn cancel_generation(&self) -> u64 { self.cancel_gen.load(std::sync::atomic::Ordering::SeqCst) }
    /// rev5 清空闸门（持 inflight 同锁先置位——封死「查闸门→注册」TOCTOU）：
    /// begin = 锁内置 clearing=true 后 cancel_all；此时已注册任务都在 map 里可见，
    /// drain 会等它们；之后任何新 ensure_cached 在同一临界区看到 clearing 被拒
    pub async fn begin_clearing(&self) {
        {
            let mut st = self.inflight.lock().await;
            st.clearing = true;
        }
        self.cancel_all();
    }
    pub async fn end_clearing(&self) {
        self.inflight.lock().await.clearing = false;
    }
    pub fn cache_root(&self) -> PathBuf { self.cache_root.read().unwrap().clone() }
    pub async fn inflight_empty(&self) -> bool { self.inflight.lock().await.map.is_empty() }
    /// clear 用：等待在途任务退出（chunk/检查点粒度快速退出）；超时返回 false
    pub async fn wait_inflight_drained(&self, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        while !self.inflight_empty().await {
            if tokio::time::Instant::now() >= deadline { return false; }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        true
    }

    /// 强制路径（用户打开/阅读）——不可被窗口 epoch 取消，但受 cancellation generation 约束
    pub async fn ensure_cached(
        &self, origin: &SourceDescriptor, archive_rel_path: &str,
    ) -> Result<PathBuf, MaterializeError> {
        self.ensure_cached_inner(origin, archive_rel_path, false).await
    }

    /// 预载路径——窗口 epoch 与 generation 双通道均可取消
    pub async fn ensure_cached_cancellable(
        &self, origin: &SourceDescriptor, archive_rel_path: &str,
    ) -> Result<PathBuf, MaterializeError> {
        self.ensure_cached_inner(origin, archive_rel_path, true).await
    }

    async fn ensure_cached_inner(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, cancellable: bool,
    ) -> Result<PathBuf, MaterializeError> {
        let key = cache_key(origin, archive_rel_path);
        // 1. 表命中 → stat 失效判定
        //    rev4：Db 是 Mutex 包裹的连接——先读行后立刻 drop conn，再 await 远端 stat
        //    （持连接跨网络 await 会锁住整个数据库）；touch/删除时重新获取连接
        {
            let row = {
                let conn = self.db.conn();
                super::dao::get(&conn, &key).map_err(|e| MaterializeError::Other(e.to_string()))?
            };
            if let Some(row) = row {
                let src = self.origin_source(origin)?;
                let cur = src.stat(origin, archive_rel_path).await?;
                if !is_stale(row.origin_size, row.origin_mtime, &cur) {
                    let conn = self.db.conn();
                    let _ = super::dao::touch(&conn, &key);
                    return Ok(PathBuf::from(&row.cache_abs_path));
                }
                // 失效：条件删除（审查修复）——仅当表行仍是本调用者读到的 stale 版本时
                // 才拥有失效权（删行 + 删文件）。竞态：B 读 v1 行 → await stat 窗口内
                // A 完成整套 v2 下载（upsert 刷新行；final 同 key 同路径）；旧的无条件
                // DELETE + remove_file 会误删 A 的 v2 文件并留下指向已删文件的 v2 表行
                // （命中路径 stat 判新鲜直接返回不存在路径，永不自愈）。条件 DELETE 落空
                // （0 行）= 行已被刷新：重读行，对 B 手头 stat 新鲜 → touch + 直接返回
                // （免重下）；仍 stale（远端又变）或行不存在 → 继续走下载（rename 在
                // Windows 用 MOVEFILE_REPLACE_EXISTING，残留 final 可被原子替换）
                let won = {
                    let conn = self.db.conn();
                    super::dao::delete_if_version_match(&conn, &key, row.origin_size, row.origin_mtime)
                        .map_err(|e| MaterializeError::Other(e.to_string()))?
                };
                if won {
                    let _ = std::fs::remove_file(&row.cache_abs_path);
                } else {
                    let rerow = {
                        let conn = self.db.conn();
                        super::dao::get(&conn, &key).map_err(|e| MaterializeError::Other(e.to_string()))?
                    };
                    if let Some(rerow) = rerow {
                        if !is_stale(rerow.origin_size, rerow.origin_mtime, &cur) {
                            let conn = self.db.conn();
                            let _ = super::dao::touch(&conn, &key);
                            return Ok(PathBuf::from(&rerow.cache_abs_path));
                        }
                    }
                    // 仍 stale（远端又变）或行不存在 → 继续走下载
                }
            }
        }
        // 2. 准入闸门 + in-flight 去重 + 注册——**同一把锁的单一临界区**（rev5）：
        //    rev4 的入口 AtomicBool 检查与此处注册之间有 TOCTOU 窗口（clear 在间隙
        //    begin_clearing 并观察到空表，本任务随后带新代际注册下载穿透清空）。
        //    现在「查 clearing + 查重 + 注册」原子完成；begin_clearing 持同锁置位，
        //    任何并发 ensure_cached 要么先注册（map 可见，drain 会等）、要么看到
        //    clearing=true 被拒——不存在中间态。Notified 仍持锁 enable() 预注册
        //    （rev4 丢唤醒修复保留）。
        let mut registered = false;
        {
            let mut st = self.inflight.lock().await;
            if st.clearing {
                return Err(MaterializeError::Other("cache clearing in progress".into()));
            }
            if let Some(notify) = st.map.get(&key).cloned() {
                let mut notified = notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable(); // 持锁预注册——此后 notify_waiters 不可能丢失
                drop(st);
                notified.await;
                let conn = self.db.conn();
                if let Some(row) = super::dao::get(&conn, &key)
                    .map_err(|e| MaterializeError::Other(e.to_string()))? {
                    return Ok(PathBuf::from(&row.cache_abs_path));
                }
                return Err(MaterializeError::Other("等待的物化任务未产出结果".into()));
            }
            st.map.insert(key.clone(), Arc::new(tokio::sync::Notify::new()));
            registered = true;
        }
        let _ = registered; // 调试期可断言；注册成功才走到下载
        // 3. 下载（退出时 notify + 移除 in-flight）——key 传借用（download 收 &str，
        //    且此处后续还要用 key 清理 inflight，不能 move）
        let result = self.download(origin, archive_rel_path, &key, cancellable).await;
        {
            let mut st = self.inflight.lock().await;
            if let Some(n) = st.map.remove(&key) { n.notify_waiters(); }
        }
        result
    }

    async fn download(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, key: &str, cancellable: bool,
    ) -> Result<PathBuf, MaterializeError> {
        let src = self.origin_source(origin)?;
        let (final_path, part_path) = self.cache_paths(key);
        std::fs::create_dir_all(part_path.parent().unwrap())
            .map_err(MaterializeError::Io)?;
        // 重试 ≤1（rename 前二次 stat 不一致 → 弃 .part 重下新版本）
        for attempt in 0..=1 {
            // 快照 stat
            let snap = src.stat(origin, archive_rel_path).await?;
            // 断点续传（rev2 严格校验）：.part 存在 → 先验 sidecar，四关全过才续传
            let mut offset: u64 = 0;
            if let Ok(meta) = std::fs::metadata(&part_path) {
                let have = meta.len();
                let canonical = serde_json::to_string(origin).unwrap_or_default();
                let sc_path = sidecar_path(&part_path);
                let resume_ok = std::fs::read(&sc_path).ok()
                    .and_then(|b| serde_json::from_slice::<PartSidecar>(&b).ok())
                    .map(|sc| {
                        sc.cache_key == key
                            && sc.canonical_origin == canonical
                            && sc.archive_rel_path == archive_rel_path
                            && sc.snapshot_size == snap.size
                            && sc.snapshot_mtime == snap.modified_at   // 快照 vs 远端 stat 一致
                            && sc.downloaded == have                   // sidecar 记账 vs 文件长度
                            && have <= snap.size
                    })
                    .unwrap_or(false);
                if !resume_ok {
                    // 身份/快照/记账任一不符（含 sidecar 缺失损坏、远端已换文件）→ 弃重下
                    let _ = std::fs::remove_file(&part_path);
                    let _ = std::fs::remove_file(&sc_path);
                } else {
                    offset = have; // 从 .part 当前偏移续传（重启恢复亦走此路径）
                }
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&part_path)
                .map_err(MaterializeError::Io)?;
            use std::io::Write;
            // sidecar 初始化（rev2）：身份 + 本次快照 + 当前 downloaded（续传起点=offset）；
            // 原子写（tmp+rename）防半截 JSON——侧函数 atomic_write_sidecar 实现
            atomic_write_sidecar(&part_path, &PartSidecar {
                cache_key: key.into(),
                canonical_origin: serde_json::to_string(origin).unwrap_or_default(),
                archive_rel_path: archive_rel_path.into(),
                snapshot_size: snap.size,
                snapshot_mtime: snap.modified_at,
                downloaded: offset,
            })?;
            let epoch_at_start = self.current_epoch();
            let gen_at_start = self.cancel_generation();
            while offset < snap.size {
                // 检查点 ①（双通道取消 rev2）：generation 对强制路径也生效（清空缓存必须能停）；
                // epoch 检查仅 cancellable（预载）任务。注意此处不删 .part——预载取消保留
                // 断点（同 key 后续强制物化可续传），清空路径的取消（②③④）才删 part+sidecar
                if self.cancel_generation() != gen_at_start
                    || (cancellable && self.current_epoch() != epoch_at_start) {
                    return Err(MaterializeError::Other("cancelled".into()));
                }
                let len = CHUNK.min(snap.size - offset);
                let chunk = src.read_file(origin, archive_rel_path,
                    Some(ByteRange::new(offset, len))).await?;
                if chunk.len() as u64 != len {
                    return Err(MaterializeError::Network("chunk 短读（Range 强契约被违反）".into()));
                }
                f.write_all(&chunk).map_err(MaterializeError::Io)?;
                offset += len;
                // sidecar downloaded 记账随每个 chunk 更新（原子写）——重启续传的进度真值
                atomic_write_sidecar(&part_path, &PartSidecar {
                    cache_key: key.into(),
                    canonical_origin: serde_json::to_string(origin).unwrap_or_default(),
                    archive_rel_path: archive_rel_path.into(),
                    snapshot_size: snap.size,
                    snapshot_mtime: snap.modified_at,
                    downloaded: offset,
                })?;
                emit_progress(key, archive_rel_path, offset, snap.size, "downloading");
            }
            drop(f);
            // 检查点 ②（rev2）：二次 stat 前——generation 变更（清空缓存）→ 中止
            if self.cancel_generation() != gen_at_start {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(sidecar_path(&part_path));
                return Err(MaterializeError::Other("cancelled by cache clear".into()));
            }
            let recheck = src.stat(origin, archive_rel_path).await?;
            if recheck.size != snap.size || recheck.modified_at != snap.modified_at {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(sidecar_path(&part_path));
                if attempt == 0 { continue; } // 按新版本重排队一次
                return Err(MaterializeError::Other("远端在下载期间持续变更".into()));
            }
            // 检查点 ③（rev2）：二次 stat 的 await 之后、rename 前再查（stat 期间可能 clear）
            if self.cancel_generation() != gen_at_start {
                let _ = std::fs::remove_file(&part_path);
                let _ = std::fs::remove_file(sidecar_path(&part_path));
                return Err(MaterializeError::Other("cancelled by cache clear".into()));
            }
            std::fs::rename(&part_path, &final_path).map_err(MaterializeError::Io)?;
            let _ = std::fs::remove_file(sidecar_path(&part_path)); // ready 后 sidecar 无用
            // 表行（ready）——byte_size 复核 == origin_size
            let byte_size = std::fs::metadata(&final_path).map_err(MaterializeError::Io)?.len();
            if byte_size != snap.size {
                let _ = std::fs::remove_file(&final_path);
                return Err(MaterializeError::Other(format!("物化文件大小不符 {byte_size} != {}", snap.size)));
            }
            // 检查点 ④（rev2）：紧贴 upsert 前最后一查——rename 后若 generation 已变，
            // 删文件不上表（宁可丢一次物化也不「复活」缓存）
            if self.cancel_generation() != gen_at_start {
                let _ = std::fs::remove_file(&final_path);
                return Err(MaterializeError::Other("cancelled by cache clear".into()));
            }
            {
                let conn = self.db.conn();
                super::dao::upsert(&conn, &super::dao::NewCacheRow {
                    cache_key: key.into(),
                    origin_kind: origin.type_str().into(),
                    archive_rel_path: archive_rel_path.into(),
                    origin_size: snap.size as i64,
                    origin_mtime: snap.modified_at,
                    cache_abs_path: final_path.display().to_string(),
                    byte_size: byte_size as i64,
                }).map_err(|e| MaterializeError::Other(e.to_string()))?;
            }
            emit_progress(key, archive_rel_path, snap.size, snap.size, "ready");
            return Ok(final_path);
        }
        unreachable!("重试循环恰好 2 轮")
    }
}

/// M3 spec §5：ArchiveMediaSource 三方法经 `Materialize` trait 注入物化能力
/// （生产装配在 factory；trait 定义在 `crate::source::archive_impl`）
#[async_trait::async_trait]
impl crate::source::archive_impl::Materialize for Materializer {
    async fn ensure_cached(
        &self, origin: &SourceDescriptor, archive_rel_path: &str,
    ) -> std::result::Result<PathBuf, MediaSourceError> {
        // 显式 inherent 方法调用——trait 方法同名，避免无限递归。
        // `From<MaterializeError> for MediaSourceError` 保类型：NotFound→NotFound /
        // Network→Network / Io→Io / Other→Other（审查修复：错误语义不扁平化成 String）
        Materializer::ensure_cached(self, origin, archive_rel_path)
            .await
            .map_err(|e| e.into())
    }
}

/// 进度事件（非阻塞；模式同 thumbnail://progress）
fn emit_progress(cache_key: &str, rel: &str, downloaded: u64, total: u64, phase: &str) {
    // lib.rs 全局 AppHandle 的 OnceLock；未初始化（单测）静默跳过
    if let Some(app) = crate::progress_emitter() {
        use tauri::Emitter;
        let _ = app.emit("archive://progress", serde_json::json!({
            "cacheKey": cache_key, "relPath": rel,
            "downloaded": downloaded, "totalBytes": total, "phase": phase,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::descriptor::SourceDescriptor;
    use crate::source::trait_def::FileStat;
    use crate::source::descriptor::MediaEntry;
    use crate::source::trait_def::{MediaSource, MediaSourceError, ByteRange};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc as StdArc;

    fn webdav(path: &str) -> SourceDescriptor {
        SourceDescriptor::WebDav { account_id: 7, base_url: "https://d/x".into(), path: path.into() }
    }

    #[test]
    fn cache_key_stable_and_discriminating() {
        let k1 = cache_key(&webdav(""), "books/a.cbz");
        assert_eq!(k1, cache_key(&webdav(""), "books/a.cbz"), "同 origin+rel 同 key");
        assert_ne!(k1, cache_key(&webdav(""), "books/b.cbz"), "不同 rel 分 key");
        assert_ne!(k1, cache_key(&webdav("sub"), "books/a.cbz"), "不同 origin path 分 key");
        assert_eq!(k1.len(), 64, "sha256 hex");
    }

    #[test]
    fn is_stale_matrix() {
        let base = FileStat { size: 100, modified_at: Some(1000) };
        assert!(!is_stale(100, Some(1000), &base), "完全一致 → 新鲜");
        assert!(is_stale(200, Some(1000), &base), "size 变 → 失效");
        assert!(is_stale(100, Some(2000), &base), "mtime 变 → 失效");
        assert!(!is_stale(100, None, &base), "行 mtime None（物化时源没给）→ size 唯一判据，放行");
        assert!(is_stale(100, Some(1000), &FileStat { size: 100, modified_at: None }),
                "行有 mtime 但远端现在没有 → 保守失效（源行为变化）");
    }

    /// 内存 mock 源：stat/read 可编程 + 调用计数 + 错误注入
    struct MockOrigin {
        stat_size: std::sync::Mutex<u64>,
        stat_mtime: std::sync::Mutex<Option<i64>>,
        bytes: std::sync::Mutex<Vec<u8>>,
        read_calls: AtomicUsize,
        stat_calls: AtomicUsize,
        fail_next_read: std::sync::atomic::AtomicBool,
        /// 每次 read 前延迟（慢源：取消 / in-flight 去重用例）
        read_delay_ms: std::sync::Mutex<u64>,
        /// 记录每次 read 的 (offset, length)（续传 / 全量重下断言）
        last_ranges: std::sync::Mutex<Vec<(u64, u64)>>,
        /// 第 N 次 stat（1-based）把远端切到新版本字节（rename 前二次 stat 发现远端变更）
        flip_on_stat: std::sync::Mutex<Option<(usize, Vec<u8>, Option<i64>)>>,
        /// 第 N 次 stat（1-based）触发旁路副作用后消费（测试模拟：stat 网络窗口内并发
        /// 任务完成物化——刷新表行 + 写 final 文件；失效竞态修复用例的确定性注入点）
        interject_on_stat: std::sync::Mutex<Option<(usize, Box<dyn Fn() + Send + Sync>)>>,
    }

    impl MockOrigin {
        fn new(size: u64) -> Self {
            Self {
                stat_size: std::sync::Mutex::new(size),
                stat_mtime: std::sync::Mutex::new(Some(1000)),
                bytes: std::sync::Mutex::new(vec![7u8; size as usize]),
                read_calls: AtomicUsize::new(0),
                stat_calls: AtomicUsize::new(0),
                fail_next_read: std::sync::atomic::AtomicBool::new(false),
                read_delay_ms: std::sync::Mutex::new(0),
                last_ranges: std::sync::Mutex::new(Vec::new()),
                flip_on_stat: std::sync::Mutex::new(None),
                interject_on_stat: std::sync::Mutex::new(None),
            }
        }
    }

    #[async_trait::async_trait]
    impl MediaSource for MockOrigin {
        fn descriptor_type(&self) -> &'static str { "mock" }
        async fn list_directory(&self, _: &SourceDescriptor, _: &str)
            -> crate::source::trait_def::Result<Vec<MediaEntry>> {
            Err(MediaSourceError::NotImplemented("mock".into()))
        }
        async fn read_file(&self, _: &SourceDescriptor, _: &str, range: Option<ByteRange>)
            -> crate::source::trait_def::Result<Vec<u8>> {
            if self.fail_next_read.swap(false, Ordering::SeqCst) {
                return Err(MediaSourceError::Network("injected".into()));
            }
            self.read_calls.fetch_add(1, Ordering::SeqCst);
            let delay = *self.read_delay_ms.lock().unwrap();
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            let bytes = self.bytes.lock().unwrap();
            match range {
                Some(r) => {
                    self.last_ranges.lock().unwrap().push((r.offset, r.length));
                    let start = r.offset as usize;
                    let end = (r.offset + r.length) as usize;
                    match bytes.get(start..end) {
                        Some(slice) => Ok(slice.to_vec()),
                        None => Err(MediaSourceError::Network(
                            format!("mock range 越界 {start}..{end} > {}", bytes.len()))),
                    }
                }
                None => Ok(bytes.clone()),
            }
        }
        async fn file_count(&self, _: &SourceDescriptor, _: &str)
            -> crate::source::trait_def::Result<u64> { Ok(0) }
        async fn stat(&self, _: &SourceDescriptor, _: &str)
            -> crate::source::trait_def::Result<FileStat> {
            let n = self.stat_calls.fetch_add(1, Ordering::SeqCst) + 1;
            let fire = { self.flip_on_stat.lock().unwrap().as_ref().map(|(at, _, _)| n == *at) };
            if fire == Some(true) {
                let (_, new_bytes, new_mtime) = self.flip_on_stat.lock().unwrap().take().unwrap();
                *self.bytes.lock().unwrap() = new_bytes.clone();
                *self.stat_size.lock().unwrap() = new_bytes.len() as u64;
                *self.stat_mtime.lock().unwrap() = new_mtime;
            }
            let inject = { self.interject_on_stat.lock().unwrap().as_ref().map(|(at, _)| n == *at) };
            if inject == Some(true) {
                let (_, f) = self.interject_on_stat.lock().unwrap().take().unwrap();
                f();
            }
            Ok(FileStat { size: *self.stat_size.lock().unwrap(),
                          modified_at: *self.stat_mtime.lock().unwrap() })
        }
        async fn test(&self, _: &SourceDescriptor)
            -> crate::source::trait_def::Result<()> { Ok(()) }
    }

    /// tempdir 建 cache_root + part/；内存库跑 migrations；webdav 槽位注入 mock。
    /// tempdir 本身就是 RAII guard（Drop 清理目录），直接放进返回元组。
    fn temp_materializer(origin: StdArc<MockOrigin>)
        -> (Materializer, tempfile::TempDir, crate::db::Db) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("part")).unwrap();
        let db = crate::db::Db::open_in_memory().unwrap();
        let m = Materializer::new(origin, StdArc::new(MockOrigin::new(0)), db.clone(),
                                  dir.path().to_path_buf());
        (m, dir, db)
    }

    /// 等到 mock 源至少被读了 n 次（测试前置：确认下载真的在途，代际/epoch 已捕获）
    async fn wait_reads(mock: &MockOrigin, at_least: usize) {
        for _ in 0..400 {
            if mock.read_calls.load(Ordering::SeqCst) >= at_least { return; }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("mock 源在 2s 内未达到 {at_least} 次 read（测试前置失败）");
    }

    /// 取走（并清空）read range 记录——子场景断言自清洁，互不串扰
    fn take_ranges(mock: &MockOrigin) -> Vec<(u64, u64)> {
        std::mem::take(&mut *mock.last_ranges.lock().unwrap())
    }

    /// 手工铺 .part（+ 可选 sidecar）——续传用例的磁盘前置态
    fn write_part(m: &Materializer, origin: &SourceDescriptor, rel: &str,
                  part_bytes: &[u8], sidecar: Option<&PartSidecar>) -> PathBuf {
        let key = cache_key(origin, rel);
        let (_, part_path) = m.cache_paths(&key);
        std::fs::create_dir_all(part_path.parent().unwrap()).unwrap();
        std::fs::write(&part_path, part_bytes).unwrap();
        if let Some(sc) = sidecar {
            std::fs::write(sidecar_path(&part_path), serde_json::to_vec(sc).unwrap()).unwrap();
        }
        part_path
    }

    #[tokio::test]
    async fn download_then_hit_then_revalidate() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        let p1 = m.ensure_cached(&webdav(""), "a.cbz").await.unwrap();
        assert!(p1.exists() && p1.extension().map(|e| e == "zip").unwrap_or(false));
        // 二次调用秒回：不再下载
        let before = mock.read_calls.load(Ordering::SeqCst);
        let _p2 = m.ensure_cached(&webdav(""), "a.cbz").await.unwrap();
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), before,
                   "命中不再读源（只 stat 失效判定）");
    }

    #[tokio::test]
    async fn remote_change_invalidates() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, db) = temp_materializer(mock.clone());
        m.ensure_cached(&webdav(""), "a.cbz").await.unwrap();
        *mock.stat_size.lock().unwrap() = 20;              // 远端变更
        *mock.bytes.lock().unwrap() = vec![7u8; 20];
        let p = m.ensure_cached(&webdav(""), "a.cbz").await.unwrap(); // 失效重下
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 20, "新文件 20 字节");
        let key = cache_key(&webdav(""), "a.cbz");
        let conn = db.conn();
        let row = crate::source::archive::dao::get(&conn, &key).unwrap().unwrap();
        assert_eq!(row.origin_size, 20, "表行 origin_size == 20");
    }

    /// 审查修复主场景（确定性注入，不靠竞态时序）：B 读 v1 行 → stat 网络窗口内「A」
    /// 完成 v2 物化（upsert v2 行 + final 替换 v2 字节）→ B 的条件 DELETE 以 v1 指纹
    /// 落空（0 行）→ 重读 v2 行对 B 手头 stat 新鲜 → touch + 直接返回——不重下、不误删
    #[tokio::test]
    async fn stale_lose_delete_race_reuses_fresh_row() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let rel = "race.cbz";
        let key = cache_key(&origin, rel);
        // v1 物化完成（表 v1 行 size=10/mtime=1000 + final 10 字节）
        m.ensure_cached(&origin, rel).await.unwrap();
        let reads_after_v1 = mock.read_calls.load(Ordering::SeqCst);
        // 远端切 v2（size 20 / mtime 2000 / 字节 [7;20]）
        *mock.stat_size.lock().unwrap() = 20;
        *mock.stat_mtime.lock().unwrap() = Some(2000);
        *mock.bytes.lock().unwrap() = vec![7u8; 20];
        let (final_path, _) = m.cache_paths(&key);
        // 注入：B 的步骤 1 stat（下一次 stat）窗口内模拟 A 完成 v2——final 写 v2 字节 + upsert v2 行
        let db2 = db.clone();
        let fp = final_path.clone();
        let key2 = key.clone();
        let next_stat = mock.stat_calls.load(Ordering::SeqCst) + 1;
        *mock.interject_on_stat.lock().unwrap() = Some((next_stat, Box::new(move || {
            std::fs::write(&fp, vec![7u8; 20]).unwrap();
            let conn = db2.conn();
            crate::source::archive::dao::upsert(&conn, &crate::source::archive::dao::NewCacheRow {
                cache_key: key2.clone(),
                origin_kind: "webdav".into(),
                archive_rel_path: rel.into(),
                origin_size: 20,
                origin_mtime: Some(2000),
                cache_abs_path: fp.display().to_string(),
                byte_size: 20,
            }).unwrap();
        })));
        let p = m.ensure_cached(&origin, rel).await.unwrap();
        assert_eq!(p, final_path, "返回 v2 行的 cache_abs_path");
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 20], "v2 final 未被误删");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), reads_after_v1,
                   "免重下（零 read——条件删除落空后复用新鲜行）");
        let conn = db.conn();
        let row = crate::source::archive::dao::get(&conn, &key).unwrap().unwrap();
        assert_eq!(row.origin_size, 20, "v2 表行保留（未被旧指纹清掉）");
    }

    #[tokio::test]
    async fn rename_guard_requeues_once() {
        let mock = StdArc::new(MockOrigin::new(10));
        // 下载中途换版本：第 2 次 stat（rename 前二次校验）返回不同 size → 弃 .part 按新版本重排一次
        *mock.flip_on_stat.lock().unwrap() = Some((2, vec![9u8; 20], Some(1000)));
        let (m, _g, db) = temp_materializer(mock.clone());
        let p = m.ensure_cached(&webdav(""), "a.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![9u8; 20], "最终 ready 文件是「新版本」字节");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 2, "初次下载 + 重排一次（重试 ≤1）");
        assert_eq!(mock.stat_calls.load(Ordering::SeqCst), 4, "两轮「快照 stat + 二次 stat」");
        let key = cache_key(&webdav(""), "a.cbz");
        let conn = db.conn();
        let row = crate::source::archive::dao::get(&conn, &key).unwrap().unwrap();
        assert_eq!(row.origin_size, 20, "上表的是新版本快照");
    }

    #[tokio::test]
    async fn resume_from_part() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let valid_sidecar = |key: &str, rel: &str, downloaded: u64, size: u64, mtime: Option<i64>| PartSidecar {
            cache_key: key.into(),
            canonical_origin: serde_json::to_string(&origin).unwrap(),
            archive_rel_path: rel.into(),
            snapshot_size: size,
            snapshot_mtime: mtime,
            downloaded,
        };

        // ① .part(5/10) + 有效 sidecar + 远端一致 → 只读后 5 字节
        let key1 = cache_key(&origin, "r1.cbz");
        let part1 = write_part(&m, &origin, "r1.cbz", &[7u8; 5],
                               Some(&valid_sidecar(&key1, "r1.cbz", 5, 10, Some(1000))));
        let p = m.ensure_cached(&origin, "r1.cbz").await.unwrap();
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 1, "只读一次");
        assert_eq!(take_ranges(&mock), &[(5, 5)],
                   "续传从 offset 5 读后 5 字节");
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 10]);
        assert!(!sidecar_path(&part1).exists(), "ready 后 sidecar 删除");
        // ② sidecar 异常 → 弃 .part+sidecar 全量重下（各一子场景）
        // ②a sidecar 缺失
        write_part(&m, &origin, "r2.cbz", &[7u8; 5], None);
        let p = m.ensure_cached(&origin, "r2.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 10]);
        assert_eq!(take_ranges(&mock), &[(0, 10)],
                   "②a sidecar 缺失 → 弃 .part 全量重下");

        // ②b JSON 损坏
        let part3 = write_part(&m, &origin, "r3.cbz", &[7u8; 5], None);
        std::fs::write(sidecar_path(&part3), b"{corrupt").unwrap();
        let p = m.ensure_cached(&origin, "r3.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 10]);
        assert_eq!(take_ranges(&mock), &[(0, 10)],
                   "②b JSON 损坏 → 全量重下");

        // ②c cache_key 不符（.part 被移动/误放）
        write_part(&m, &origin, "r4.cbz", &[7u8; 5],
                   Some(&valid_sidecar("deadbeef", "r4.cbz", 5, 10, Some(1000))));
        let p = m.ensure_cached(&origin, "r4.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 10]);
        assert_eq!(take_ranges(&mock), &[(0, 10)],
                   "②c cache_key 不符 → 全量重下");

        // ②d downloaded != .part 长度（记账与文件不一致）
        let key5 = cache_key(&origin, "r5.cbz");
        write_part(&m, &origin, "r5.cbz", &[7u8; 5],
                   Some(&valid_sidecar(&key5, "r5.cbz", 3, 10, Some(1000))));
        let p = m.ensure_cached(&origin, "r5.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 10]);
        assert_eq!(take_ranges(&mock), &[(0, 10)],
                   "②d 记账不符 → 全量重下");

        // ③ sidecar 快照 mtime 与远端现值不符（同 size 换文件）→ 弃重下
        let key6 = cache_key(&origin, "r6.cbz");
        write_part(&m, &origin, "r6.cbz", &[7u8; 5],
                   Some(&valid_sidecar(&key6, "r6.cbz", 5, 10, Some(2000))));
        let p = m.ensure_cached(&origin, "r6.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 10]);
        assert_eq!(take_ranges(&mock), &[(0, 10)],
                   "③ 快照 mtime 不符 → 全量重下");

        // ④ 远端截断（stat size < .part 长度）→ 弃重下（按截断后 size 全量）
        *mock.stat_size.lock().unwrap() = 5;
        let key7 = cache_key(&origin, "r7.cbz");
        write_part(&m, &origin, "r7.cbz", &[7u8; 10],
                   Some(&valid_sidecar(&key7, "r7.cbz", 10, 10, Some(1000))));
        let p = m.ensure_cached(&origin, "r7.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 5], "按截断后的远端 size 全量重下");
        assert_eq!(take_ranges(&mock), &[(0, 5)],
                   "④ 远端截断 → 弃 .part 从 0 重下");

        // ⑤ sidecar 快照与远端一致（size/mtime 双匹配）但 downloaded == have > 远端 size
        //    （size=5、downloaded=7、.part 实长 7）——前几关全过，`have <= snap.size`
        //    作为唯一拒绝条件生效 → 弃重下（审查 minor #3：防 append 模式 offset 越界写）
        let key8 = cache_key(&origin, "r8.cbz");
        write_part(&m, &origin, "r8.cbz", &[7u8; 7],
                   Some(&valid_sidecar(&key8, "r8.cbz", 7, 5, Some(1000))));
        let p = m.ensure_cached(&origin, "r8.cbz").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), vec![7u8; 5], "按远端 size 全量重下");
        assert_eq!(take_ranges(&mock), &[(0, 5)],
                   "⑤ downloaded > 远端 size（快照字段全匹配）→ 弃 .part 全量重下");
    }

    #[tokio::test]
    async fn cancel_all_stops_forced_download_without_revive() {
        let mock = StdArc::new(MockOrigin::new(10));
        *mock.read_delay_ms.lock().unwrap() = 200;
        let (m, _g, db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let key = cache_key(&origin, "a.cbz");
        let (final_path, part_path) = m.cache_paths(&key);
        let m = StdArc::new(m);

        // 慢源强制 ensure_cached 进行中调 cancel_all() → 任务在检查点中止
        let h = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached(&o, "a.cbz").await }
        });
        wait_reads(&mock, 1).await; // 确认已在下载中（gen_at_start 已捕获）
        m.cancel_all();             // rev2 双通道②：强制任务也受 generation 约束
        assert!(h.await.unwrap().is_err(), "强制下载被代际取消");
        {
            let conn = db.conn();
            assert!(crate::source::archive::dao::get(&conn, &key).unwrap().is_none(), "表无行");
        }
        assert!(!final_path.exists(), "final_path 不存在（不复活）");
        assert!(!part_path.exists(), ".part 已清（清空路径删 part+sidecar）");
        // 新 ensure_cached 正常工作（代际恢复：新任务取新代际）
        let p = m.ensure_cached(&origin, "a.cbz").await.unwrap();
        assert!(p.exists());
        let conn = db.conn();
        assert!(crate::source::archive::dao::get(&conn, &key).unwrap().is_some(), "新任务正常上表");
    }

    #[tokio::test]
    async fn inflight_dedup_two_waiters() {
        let mock = StdArc::new(MockOrigin::new(10));
        *mock.read_delay_ms.lock().unwrap() = 100;
        let (m, _g, _db) = temp_materializer(mock.clone());
        let m = StdArc::new(m);
        let origin = webdav("");
        let h1 = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached(&o, "a.cbz").await }
        });
        let h2 = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached(&o, "a.cbz").await }
        });
        let (r1, r2) = tokio::join!(h1, h2);
        let p1 = r1.unwrap().unwrap();
        let p2 = r2.unwrap().unwrap();
        assert_eq!(p1, p2, "两个等待者拿到同一路径");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 1,
                   "read_calls 只有一次全量序列");
        assert!(p1.exists());
    }

    #[tokio::test]
    async fn network_error_keeps_part() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, db) = temp_materializer(mock.clone());
        mock.fail_next_read.store(true, Ordering::SeqCst);
        let origin = webdav("");
        assert!(m.ensure_cached(&origin, "a.cbz").await.is_err());
        let key = cache_key(&origin, "a.cbz");
        let (_, part_path) = m.cache_paths(&key);
        assert!(part_path.exists(), ".part 保留（供续传）");
        assert!(sidecar_path(&part_path).exists(), "sidecar 保留");
        let conn = db.conn();
        assert!(crate::source::archive::dao::get(&conn, &key).unwrap().is_none(), "表无行");
    }

    /// 六字段合法 sidecar 工厂（cleanup 只做结构化校验，字段值无需语义真实）
    fn cleanup_sidecar(key: &str, downloaded: u64) -> PartSidecar {
        PartSidecar {
            cache_key: key.into(),
            canonical_origin: "{}".into(),
            archive_rel_path: "books/a.cbz".into(),
            snapshot_size: 10,
            snapshot_mtime: Some(1000),
            downloaded,
        }
    }

    /// 空表内存库 + tempdir cache root（startup_cleanup 用例共用前置）
    fn cleanup_fixture() -> (tempfile::TempDir, crate::db::Db) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("part")).unwrap();
        (dir, crate::db::Db::open_in_memory().unwrap())
    }

    #[test]
    fn startup_cleanup_removes_orphans_and_parts() {
        // tempdir：无表行的 {k2}.zip（孤儿 ready）+ 有表行的 {k3}.zip + 无 sidecar 的 part/{k4}.part
        let (dir, db) = cleanup_fixture();
        let root = dir.path();
        std::fs::write(root.join("k2.zip"), b"orphan").unwrap();
        let k3 = root.join("k3.zip");
        std::fs::write(&k3, b"known").unwrap();
        std::fs::write(root.join("part").join("k4.part"), b"partial").unwrap();
        {
            let conn = db.conn();
            crate::source::archive::dao::upsert(&conn, &crate::source::archive::dao::NewCacheRow {
                cache_key: "k3".into(),
                origin_kind: "webdav".into(),
                archive_rel_path: "books/a.cbz".into(),
                origin_size: 6,
                origin_mtime: Some(1000),
                cache_abs_path: k3.display().to_string(),
                byte_size: 6,
            }).unwrap();
        }
        startup_cleanup(root, &db, i64::MAX);
        assert!(!root.join("k2.zip").exists(), "孤儿 ready（表无行）删除");
        assert!(root.join("k3.zip").exists(), "表行对应的 k3.zip 保留");
        assert!(!root.join("part").join("k4.part").exists(), "无 sidecar 的 .part 删除");
    }

    /// rev6 终审建议：重启续传不得被启动清理误伤（rev3 修过的方向守卫——
    /// 旧实现枚举到 .part.meta 拼出 .part.part.meta 判失败，把有效 sidecar 删了）
    #[test]
    fn startup_cleanup_keeps_resumable_part_with_valid_sidecar() {
        let (dir, db) = cleanup_fixture();
        let part = dir.path().join("part");
        // ① k1.part（半截 5 字节）+ 有效 k1.part.meta（六字段 PartSidecar，downloaded=5）
        //    → 两者均保留——重启续传可用（下次 ensure_cached 四关校验通过后从 5 续传）
        std::fs::write(part.join("k1.part"), b"12345").unwrap();
        std::fs::write(part.join("k1.part.meta"),
            serde_json::to_vec(&cleanup_sidecar("k1", 5)).unwrap()).unwrap();
        // ② k2.part 无 sidecar → 删
        std::fs::write(part.join("k2.part"), b"12345").unwrap();
        // ③ k3.part + 损坏 sidecar（半截 JSON）→ 删两者
        std::fs::write(part.join("k3.part"), b"12345").unwrap();
        std::fs::write(part.join("k3.part.meta"), b"{\"cache_key\": \"k3\"").unwrap();
        // ④ k4.part.meta 单独存在（.part 已 rename 走，sidecar 残留）→ 非候选不处理
        //    （保留；正常路径 ready 时已顺手删，此为极端残留）
        std::fs::write(part.join("k4.part.meta"),
            serde_json::to_vec(&cleanup_sidecar("k4", 10)).unwrap()).unwrap();

        startup_cleanup(dir.path(), &db, i64::MAX);
        assert!(part.join("k1.part").exists() && part.join("k1.part.meta").exists(),
            "① 有效 sidecar 的 .part+sidecar 均保留（重启续传依据）");
        assert!(!part.join("k2.part").exists(), "② 无 sidecar 的 .part 删除");
        assert!(!part.join("k3.part").exists() && !part.join("k3.part.meta").exists(),
            "③ 损坏 sidecar → .part+sidecar 均删除");
        assert!(part.join("k4.part.meta").exists(), "④ 孤儿 sidecar 非候选保留");
    }

    /// rev6 方向守卫：目录只有 .meta/.meta.tmp（无 .part）时 cleanup 不误删 sidecar
    #[test]
    fn startup_cleanup_ignores_meta_files_as_part_candidates() {
        let (dir, db) = cleanup_fixture();
        let part = dir.path().join("part");
        // part/ 只有 k5.part.meta（无 k5.part）→ 保留
        let sc = serde_json::to_vec(&cleanup_sidecar("k5", 5)).unwrap();
        std::fs::write(part.join("k5.part.meta"), &sc).unwrap();
        // k6.part.meta.tmp（原子写残留）→ 删除
        std::fs::write(part.join("k6.part.meta.tmp"), &sc).unwrap();

        startup_cleanup(dir.path(), &db, i64::MAX);
        assert!(part.join("k5.part.meta").exists(),
            "无 .part 对应的 sidecar 不是候选，不被误删（旧实现方向反了会删）");
        assert!(!part.join("k6.part.meta.tmp").exists(), "原子写残留 .tmp 清除");
    }

    /// 双通道语义补测：窗口 epoch 只取消预载（cancellable）任务，强制物化不受 epoch 影响
    #[tokio::test]
    async fn epoch_cancels_preload_only_force_unaffected() {
        let mock = StdArc::new(MockOrigin::new(super::CHUNK + 5)); // 两 chunk：第二块前 loop 检查点可命中
        *mock.read_delay_ms.lock().unwrap() = 150;
        let (m, _g, _db) = temp_materializer(mock.clone());
        let m = StdArc::new(m);
        let origin = webdav("");

        // 预载任务：窗口 epoch 推进 → 第二 chunk 前中止（.part 保留供续传）
        let h = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached_cancellable(&o, "a.cbz").await }
        });
        wait_reads(&mock, 1).await;
        m.new_epoch(1);
        assert!(h.await.unwrap().is_err(), "预载任务被窗口 epoch 取消");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 1, "第一 chunk 后即中止");

        // 强制任务：同 key 从 .part 续传剩余 5 字节；epoch 再推进也不影响（只有 generation 能停）
        let h2 = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached(&o, "a.cbz").await }
        });
        wait_reads(&mock, 2).await;
        m.new_epoch(2);
        let p = h2.await.unwrap().unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().len(), super::CHUNK + 5);
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 2, "续传只补读剩余字节，未全量重下");
    }
}
