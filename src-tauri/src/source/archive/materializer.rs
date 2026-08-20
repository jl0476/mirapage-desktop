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

/// 命中路径磁盘一致性校验（终审 P1-3）：缓存文件存在且长度 == 表行 byte_size。
/// OS 清缓存 / 用户删文件 / 截断损坏 → false（悬空行，调用方条件删行后重物化）。
fn cache_file_matches(row: &super::dao::CacheRow) -> bool {
    std::fs::metadata(&row.cache_abs_path)
        .map(|m| m.len() == row.byte_size as u64)
        .unwrap_or(false)
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

/// chunk 大小（pub(crate)：prefetch 测试构造跨 chunk 源用）
pub(crate) const CHUNK: u64 = 4 * 1024 * 1024;

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

/// `.part` 用量统计（终审二批 P1-2 / spec §12「.part 目录计入用量统计」）：
/// 遍历 `part/` 下扩展名恰为 `.part` 的数据文件（排除 `.part.meta` sidecar 与
/// `.meta.tmp` 原子写残留），返回（条数, 总字节）。纯 fs 读，无 DB / 无副作用。
pub fn parts_usage(cache_root: &std::path::Path) -> (usize, u64) {
    let mut count = 0usize;
    let mut bytes = 0u64;
    let Ok(rd) = std::fs::read_dir(cache_root.join("part")) else { return (0, 0); };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("part") { continue; }
        count += 1;
        if let Ok(md) = std::fs::metadata(&p) { bytes += md.len(); }
    }
    (count, bytes)
}

/// 容量预算执行（终审二批 P1-2；download upsert 钩子与 startup_cleanup 共用）：
/// total = ready SUM + `.part` 字节。total ≤ limit → no-op；超限**先淘汰 `.part`**
/// （mtime 最旧序——连续取消预载/网络失败留下的半截下载最先让位；跳过 protected
/// key 对应的 `{key}.part`——in-flight 写入中，删了破断点续传；删 `.part` 连带
/// `.meta`）到 80% 水位或无候选；仍超 → ready 行 LRU（`evict_to_limit`，目标 =
/// 水位 - 剩余 `.part` 字节，total 口径一致）。返回淘汰条数（parts + ready）。
pub fn enforce_budget(
    cache_root: &std::path::Path,
    conn: &rusqlite::Connection,
    limit_bytes: i64,
    protected: &[String],
) -> usize {
    let ready_bytes: i64 = super::dao::usage(conn).map(|(_, b)| b).unwrap_or(0);
    let (_, part_bytes) = parts_usage(cache_root);
    let mut current = ready_bytes + part_bytes as i64;
    if current <= limit_bytes { return 0; }
    let target = limit_bytes.saturating_mul(8) / 10; // 80% 水位
    let mut evicted = 0usize;
    // phase 1：.part 最旧优先（protected key 的 {key}.part 跳过）
    if part_bytes > 0 {
        let mut cands: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(cache_root.join("part")) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().and_then(|x| x.to_str()) != Some("part") { continue; }
                // 文件名 {key}.part——file_stem 即 cache key（sha256 hex 无点，无歧义）
                let key = p.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if protected.iter().any(|pk| pk == key) { continue; }
                if let Ok(md) = std::fs::metadata(&p) {
                    let mtime = md.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    cands.push((mtime, md.len(), p));
                }
            }
        }
        cands.sort_by_key(|(m, _, _)| *m);
        for (_, size, p) in cands {
            if current <= target { break; }
            if std::fs::remove_file(&p).is_ok() {
                let _ = std::fs::remove_file(sidecar_path(&p)); // sidecar 连带
                current -= size as i64;
                evicted += 1;
            }
        }
    }
    // phase 2：仍超 → ready 行 LRU；目标 = 水位 - 剩余 .part（total 口径压到水位）
    if current > target {
        let (_, remain_parts) = parts_usage(cache_root);
        let ready_target = (target - remain_parts as i64).max(0);
        if let Ok(n) = super::dao::evict_to_limit(conn, ready_target, protected) {
            evicted += n;
        }
    }
    evicted
}

/// sidecar 原子写（tmp + rename）——半截 JSON 会被续传校验拒绝，但原子写让这几乎不发生
fn atomic_write_sidecar(part_path: &std::path::Path, sc: &PartSidecar) -> Result<(), MaterializeError> {
    let target = sidecar_path(part_path);
    let tmp = target.with_extension("meta.tmp");
    std::fs::write(&tmp, serde_json::to_vec(sc).map_err(|e| MaterializeError::Other(e.to_string()))?)
        .map_err(MaterializeError::Io)?;
    std::fs::rename(&tmp, &target).map_err(MaterializeError::Io)
}

/// 启动清理（spec §8 rev2 + 终审 P1-3）：①part/ 只删 sidecar 缺失/损坏的 .part（**有效 sidecar 保留——
/// 重启续传依据，原「全删 part/」与断点续传冲突已废弃**；一致性验证推迟到下次
/// ensure_cached 的 sidecar 快照 vs 远端 stat，启动时零网络请求）②孤儿缓存文件（表无行）
/// ③反向扫表——表行文件缺失/长度不符 byte_size 的悬空行删除（正向孤儿扫的补集修复）
/// ④超容量淘汰（80% 水位，终审 P2-1；P1-2 起 total 含 .part，见 enforce_budget）
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
    // 反向扫表（终审 P1-3）：表行对应文件缺失或长度不符 byte_size = 悬空行 → 删行
    // （+尽力删错长度文件）。此前只有正向扫文件（表无行的文件删），悬空行每次
    // 命中都返回不存在路径、永不自愈——启动时反向修复一次。
    {
        let dangling: Vec<(String, String)> = {
            let mut stmt = match conn.prepare(
                "SELECT cache_key, cache_abs_path, byte_size FROM archive_cache") {
                Ok(s) => s, Err(_) => return,
            };
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
            }).map(|it| it.filter_map(|v| v.ok())
                .filter(|(_, abs, size)| std::fs::metadata(abs)
                    .map(|m| m.len() != *size as u64)
                    .unwrap_or(true)) // 文件缺失 → 悬空
                .map(|(k, abs, _)| (k, abs))
                .collect::<Vec<_>>());
            match rows { Ok(v) => v, Err(_) => return }
        };
        for (k, abs) in dangling {
            let _ = conn.execute("DELETE FROM archive_cache WHERE cache_key = ?1",
                                 rusqlite::params![k]);
            let _ = std::fs::remove_file(abs); // 错长度文件尽力删（缺失时落空无害）
        }
    }
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
    // 超容量淘汰（终审 P2-1 + 终审二批 P1-2）：total = ready SUM + .part 字节，
    // 回收到 80% 水位；.part 最旧优先（启动时无 in-flight，protected 为空）
    let _ = enforce_budget(cache_root, &conn, limit_bytes, &[]);
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

    /// 单调推进（终审 P1-4）：仅 e > current 时生效——IPC 乱序迟到的旧窗口 epoch
    /// 不得回退当前值（旧 new_epoch 无条件 store，旧窗口可覆盖新窗口取消语义）。
    pub fn advance_epoch(&self, e: u64) {
        self.epoch.fetch_max(e, std::sync::atomic::Ordering::SeqCst);
    }
    /// pub：prefetch 批次循环逐 rel 启动前比对（任务 8 审查修复——「待开始任务丢弃」；
    /// 终审 P1-4 后批内任务身份由 ensure_cached_cancellable 的 expected_epoch 显式携带，
    /// 此查保留为快速短路）
    pub fn current_epoch(&self) -> u64 { self.epoch.load(std::sync::atomic::Ordering::SeqCst) }

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
    /// 元数据预载（M3 任务 8 / spec §7）：仅 stat origin 远端——结果弃用，
    /// 预热 SMB/WebDAV 连接缓存，不落任何状态（YAGNI）
    pub async fn stat_origin(
        &self, origin: &SourceDescriptor, rel: &str,
    ) -> Result<FileStat, MaterializeError> {
        let src = self.origin_source(origin)?;
        src.stat(origin, rel).await.map_err(|e| e.into())
    }
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
        self.ensure_cached_inner(origin, archive_rel_path, None).await
    }

    /// 预载路径——窗口 epoch 与 generation 双通道均可取消。expected_epoch 是任务
    /// **诞生时刻**（notify_window 的批次 epoch）的身份，全程显式携带（终审 P1-4：
    /// 身份不从环境读——旧实现 download 内捕获 current_epoch，批次循环检查与调用
    /// 间隙推进的 epoch 被新任务当自己的身份完整下载，竞态结构性消除）。
    pub async fn ensure_cached_cancellable(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, expected_epoch: u64,
    ) -> Result<PathBuf, MaterializeError> {
        self.ensure_cached_inner(origin, archive_rel_path, Some(expected_epoch)).await
    }

    async fn ensure_cached_inner(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, expected_epoch: Option<u64>,
    ) -> Result<PathBuf, MaterializeError> {
        let key = cache_key(origin, archive_rel_path);
        // 0. 格式闸门（最终审查 I1；spec §1 非目标：RAR/7z 远程物化不做）——cbz/zip
        //    之外直接拒绝：旧行为「整包下载完后 list_archive_entries 才 NotImplemented」
        //    既浪费整包下载，masonry 预载按 is_archive 过滤更会后台静默白下永远读不出
        //    的文件。RAR/7z 实装模块放开此处。
        match crate::source::descriptor::ArchiveFormat::from_extension(
            std::path::Path::new(archive_rel_path).extension().and_then(|e| e.to_str()).unwrap_or("")) {
            Some(crate::source::descriptor::ArchiveFormat::Cbz)
            | Some(crate::source::descriptor::ArchiveFormat::Zip) => {}
            _ => return Err(MaterializeError::Other(format!("远程物化仅支持 cbz/zip：{archive_rel_path}"))),
        }
        // waiter 接管循环（终审 P1-1）：「查表 → 注册/等待」包进 loop——waiter 醒来
        // 表无行时不再直接报「未产出结果」：强制调用方（用户双击打开）无条件重走
        // 查表 + 抢 owner（接管续传，cancellable=false 不受 epoch 影响）；cancellable
        // 调用方 epoch 已变 → Err("cancelled")，epoch 未变（owner 网络错误等）→ 接管
        // 一次。上限 5 轮防病态 ping-pong（正常路径 1-2 轮）。
        for _round in 0..5 {
            // 1. 表命中 → stat 失效判定 + 磁盘一致性校验（终审 P1-3）
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
                        // P1-3：命中不止看表——文件必须存在且长度 == byte_size（OS 清
                        // 缓存 / 用户删文件 / 截断损坏 → 悬空行自愈，不再每次命中都
                        // 返回不存在路径）。不符 → 条件删行（指纹匹配防误删并发新行）
                        // + 尽力删文件 → continue 重物化。
                        if cache_file_matches(&row) {
                            let conn = self.db.conn();
                            let _ = super::dao::touch(&conn, &key);
                            return Ok(PathBuf::from(&row.cache_abs_path));
                        }
                        let won = {
                            let conn = self.db.conn();
                            super::dao::delete_if_version_match(&conn, &key, row.origin_size, row.origin_mtime)
                                .map_err(|e| MaterializeError::Other(e.to_string()))?
                        };
                        if won {
                            let _ = std::fs::remove_file(&row.cache_abs_path);
                        }
                        continue; // 重物化（行已删，下轮查表落空直达注册）
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
                                if cache_file_matches(&rerow) {
                                    let conn = self.db.conn();
                                    let _ = super::dao::touch(&conn, &key);
                                    return Ok(PathBuf::from(&rerow.cache_abs_path));
                                }
                                // P1-3：rerow 同样做磁盘校验——不符则条件删行（不误删
                                // 并发更新行）后走下载，由新任务的 upsert 修复表
                                let won2 = {
                                    let conn = self.db.conn();
                                    super::dao::delete_if_version_match(&conn, &key, rerow.origin_size, rerow.origin_mtime)
                                        .map_err(|e| MaterializeError::Other(e.to_string()))?
                                };
                                if won2 {
                                    let _ = std::fs::remove_file(&rerow.cache_abs_path);
                                }
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
            //    终审 P1-4：cancellable 任务在注册前比对 expected_epoch——身份过时
            //    （窗口已推进）直接拒，不注册不下载（旧实现会在 download 内把新
            //    epoch 捕获成自己的身份，完整下载整包）。
            let gen_at_start = {
                let mut st = self.inflight.lock().await;
                if st.clearing {
                    return Err(MaterializeError::Other("cache clearing in progress".into()));
                }
                if let Some(expected) = expected_epoch {
                    if self.current_epoch() != expected {
                        return Err(MaterializeError::Other("cancelled".into()));
                    }
                }
                if let Some(notify) = st.map.get(&key).cloned() {
                    let mut notified = notify.notified();
                    tokio::pin!(notified);
                    notified.as_mut().enable(); // 持锁预注册——此后 notify_waiters 不可能丢失
                    drop(st);
                    notified.await;
                    // 醒来：owner 已退出（成功 / 取消 / 网络错误）。查表——
                    let woke_row = {
                        let conn = self.db.conn();
                        super::dao::get(&conn, &key)
                            .map_err(|e| MaterializeError::Other(e.to_string()))?
                    };
                    if let Some(row) = woke_row {
                        if cache_file_matches(&row) {
                            return Ok(PathBuf::from(&row.cache_abs_path));
                        }
                        // 行在但文件悬空（P1-3 自愈）：条件删行 + 尽力删文件后走接管
                        let won = {
                            let conn = self.db.conn();
                            super::dao::delete_if_version_match(&conn, &key, row.origin_size, row.origin_mtime)
                                .map_err(|e| MaterializeError::Other(e.to_string()))?
                        };
                        if won {
                            let _ = std::fs::remove_file(&row.cache_abs_path);
                        }
                    }
                    // 表无行（或悬空行已清）→ P1-1 接管判定：
                    // - 强制调用方：无条件 continue 重走「查表 → 抢 owner」（接管续传，
                    //   cancellable=false 不受 epoch 影响）
                    // - cancellable 调用方：epoch 已变 → Err("cancelled")（旧窗口任务
                    //   不复活）；epoch 未变（owner 是网络错误等非取消退出）→ 接管一次
                    if let Some(expected) = expected_epoch {
                        if self.current_epoch() != expected {
                            return Err(MaterializeError::Other("cancelled".into()));
                        }
                    }
                    continue;
                }
                st.map.insert(key.clone(), Arc::new(tokio::sync::Notify::new()));
                // 与 in-flight 注册在同一临界区捕获：clear 若先抢到锁，
                // clearing 会拒绝本任务；若本任务先注册，clear 后续推进
                // generation 必然能被 download 观测，不留注册后、stat 前窗口。
                self.cancel_generation()
            };
            // 3. 下载（退出时 notify + 移除 in-flight）——key 传借用（download 收 &str，
            //    且此处后续还要用 key 清理 inflight，不能 move）
            let result = self.download(origin, archive_rel_path, &key, expected_epoch, gen_at_start).await;
            let notify = {
                let mut st = self.inflight.lock().await;
                let notify = st.map.remove(&key);
                // 取消/网络错误会保留可续传的 .part；错误退出也必须立即
                // 执行容量预算，否则反复失败会在本次会话内无上限占盘。当前 key
                // 已从 map 移除，其残片可被回收；持锁到回收完成，防止同 key
                // waiter 被唤醒或新 owner 注册后，残片又在写入时被删。
                if result.is_err() {
                    let limit_bytes = {
                        let conn = self.db.conn();
                        (crate::setting_u64(&conn, "archive_cache_max_mb", 2048)
                            .saturating_mul(1024 * 1024))
                            .min(i64::MAX as u64) as i64
                    };
                    let protected: Vec<String> = st.map.keys().cloned().collect();
                    let conn = self.db.conn();
                    let _ = enforce_budget(&self.cache_root(), &conn, limit_bytes, &protected);
                }
                notify
            };
            if let Some(n) = notify { n.notify_waiters(); }
            return result;
        }
        Err(MaterializeError::Other("物化循环未收敛".into()))
    }

    async fn download(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, key: &str,
        expected_epoch: Option<u64>, gen_at_start: u64,
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
            // 终审 P1-4：身份不再从环境读——cancellable 任务的 epoch 全程比
            // expected_epoch（任务诞生时刻由调用方显式传入），旧 epoch_at_start
            // 捕获已删（间隙推进的 epoch 会被新任务当自己的身份，竞态结构性消除）
            while offset < snap.size {
                // 检查点 ①（双通道取消 rev2）：generation 对强制路径也生效（清空缓存必须能停）；
                // epoch 检查仅 cancellable（预载）任务。注意此处不删 .part——预载取消保留
                // 断点（同 key 后续强制物化可续传），清空路径的取消（②③④）才删 part+sidecar
                if self.cancel_generation() != gen_at_start
                    || expected_epoch.is_some_and(|e| self.current_epoch() != e) {
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
            // 回收钩子（最终审查 I2 + 终审 P2-1 + 终审二批 P1-2）：upsert 成功后立即
            // 执行容量预算（total = ready + .part，80% 水位）——此前容量上限只在
            // startup_cleanup 执行，一次会话滚过几十个大 CBZ（预载放大）可无限超限
            // 直到重启（spec §12 风险对策三件套「容量上限 + LRU + 启动清理」全量生效）；
            // P1-2 起 .part 同受预算约束（连续取消预载/网络失败的半截下载不再无上限
            // 占盘）。错误吞掉：回收失败不影响本次物化返回。conn 短作用域且不跨
            // await（任务 6 死锁教训——inflight 锁的 await 在取 conn 之前完成）；
            // 在途 key 全量 protected（含本任务自身：不自删，也不删并发任务的
            // final 与 .part）。
            {
                let limit_bytes = {
                    let conn = self.db.conn();
                    (crate::setting_u64(&conn, "archive_cache_max_mb", 2048)
                        .saturating_mul(1024 * 1024))
                        .min(i64::MAX as u64) as i64
                };
                let protected: Vec<String> = {
                    let st = self.inflight.lock().await;
                    st.map.keys().cloned().collect()
                };
                let conn = self.db.conn();
                let _ = enforce_budget(&self.cache_root(), &conn, limit_bytes, &protected);
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
pub(crate) mod tests {
    use super::*;
    use crate::source::descriptor::SourceDescriptor;
    use crate::source::trait_def::FileStat;
    use crate::source::descriptor::MediaEntry;
    use crate::source::trait_def::{MediaSource, MediaSourceError, ByteRange};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc as StdArc;

    pub(crate) fn webdav(path: &str) -> SourceDescriptor {
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
    /// （pub(crate)：prefetch 测试复用——MockOrigin + temp_materializer + wait_reads）
    pub(crate) struct MockOrigin {
        pub(crate) stat_size: std::sync::Mutex<u64>,
        pub(crate) stat_mtime: std::sync::Mutex<Option<i64>>,
        pub(crate) bytes: std::sync::Mutex<Vec<u8>>,
        pub(crate) read_calls: AtomicUsize,
        pub(crate) stat_calls: AtomicUsize,
        fail_next_read: std::sync::atomic::AtomicBool,
        /// 每次 read 前延迟（慢源：取消 / in-flight 去重用例）
        pub(crate) read_delay_ms: std::sync::Mutex<u64>,
        /// 记录每次 read 的 (offset, length)（续传 / 全量重下断言）
        last_ranges: std::sync::Mutex<Vec<(u64, u64)>>,
        /// 第 N 次 stat（1-based）把远端切到新版本字节（rename 前二次 stat 发现远端变更）
        flip_on_stat: std::sync::Mutex<Option<(usize, Vec<u8>, Option<i64>)>>,
        /// 第 N 次 stat（1-based）触发旁路副作用后消费（测试模拟：stat 网络窗口内并发
        /// 任务完成物化——刷新表行 + 写 final 文件；失效竞态修复用例的确定性注入点）
        interject_on_stat: std::sync::Mutex<Option<(usize, Box<dyn Fn() + Send + Sync>)>>,
    }

    impl MockOrigin {
        pub(crate) fn new(size: u64) -> Self {
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
    pub(crate) fn temp_materializer(origin: StdArc<MockOrigin>)
        -> (Materializer, tempfile::TempDir, crate::db::Db) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("part")).unwrap();
        let db = crate::db::Db::open_in_memory().unwrap();
        let m = Materializer::new(origin, StdArc::new(MockOrigin::new(0)), db.clone(),
                                  dir.path().to_path_buf());
        (m, dir, db)
    }

    /// 等到 mock 源至少被读了 n 次（测试前置：确认下载真的在途，代际/epoch 已捕获）
    pub(crate) async fn wait_reads(mock: &MockOrigin, at_least: usize) {
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

    /// 最终审查 I1：格式闸门——cbz/zip 之外的远程物化请求（cbr/rar/7z/无扩展名）
    /// 在下载前直接拒绝（零 stat / 零 read / 零缓存产出）。旧行为：整包下载完成后
    /// `list_archive_entries` 才对 Rar/SevenZ 报 NotImplemented；masonry 预载按
    /// is_archive 过滤更会后台静默白下永远读不出来的文件（spec §1 非目标）。
    #[tokio::test]
    async fn remote_unsupported_format_rejected_before_download() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, dir, db) = temp_materializer(mock.clone());
        let origin = webdav("");
        for rel in ["book.cbr", "book.rar", "book.7z", "noext"] {
            let err = m.ensure_cached(&origin, rel).await.unwrap_err();
            assert!(matches!(err, MaterializeError::Other(_)), "{rel} 应被 Other 拒绝");
        }
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 0, "零 read（下载前拒绝）");
        assert_eq!(mock.stat_calls.load(Ordering::SeqCst), 0, "零 stat（查表前拒绝）");
        for rel in ["book.cbr", "book.rar", "book.7z", "noext"] {
            let key = cache_key(&origin, rel);
            {
                let conn = db.conn();
                assert!(crate::source::archive::dao::get(&conn, &key).unwrap().is_none(),
                        "{rel} 表无行");
            }
            let (final_path, part_path) = m.cache_paths(&key);
            assert!(!final_path.exists() && !part_path.exists(), "{rel} 无缓存文件");
        }
        // dir 仅用于持有 tempdir 生命周期（下划线消费避免未用警告）
        let _ = dir.path();
    }

    /// 最终审查 I2：upsert 后回收钩子——download 成功上表后立即回收（终审 P2-1 起
    /// 经 enforce_budget 回收到 80% 水位），容量上限不再只靠 startup_cleanup
    /// （一次会话滚过几十个大 CBZ 可无限超限到重启）。
    /// 限值 1MB；mock 包各 1.5MB：A 物化时自身在途 protected 不自删；B 物化后
    /// total 3MB > 1MB → 水位目标 0.8MB → 淘汰 A（freed 1.5MB < need 2.2MB）后
    /// 仅剩 B 且 B 在途 protected 无可淘汰 → A 删 B 留，与 limit 边缘旧语义期望一致。
    #[tokio::test]
    async fn upsert_triggers_evict_over_limit() {
        let mock = StdArc::new(MockOrigin::new(1_500_000));
        let (m, _dir, db) = temp_materializer(mock.clone());
        {
            let conn = db.conn();
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('archive_cache_max_mb', '1')",
                []).unwrap();
        }
        let origin = webdav("");
        let key_a = cache_key(&origin, "a.cbz");
        let key_b = cache_key(&origin, "b.cbz");
        let (final_a, _) = m.cache_paths(&key_a);
        let (final_b, _) = m.cache_paths(&key_b);

        // A：total 1.5MB 已超 1MB 限值，但 A 自身在途 protected → 保留
        let pa = m.ensure_cached(&origin, "a.cbz").await.unwrap();
        assert!(pa.exists(), "A 物化成功");
        {
            let conn = db.conn();
            assert!(crate::source::archive::dao::get(&conn, &key_a).unwrap().is_some(), "A 行在");
        }
        // B：upsert 后 total 3MB → 回收钩子淘汰 A（B 在途 protected 保留）
        let pb = m.ensure_cached(&origin, "b.cbz").await.unwrap();
        assert!(pb.exists(), "B 物化成功");
        assert!(!final_a.exists(), "A 缓存文件被 upsert 后回收钩子删除");
        assert!(final_b.exists(), "B 缓存文件保留");
        let conn = db.conn();
        assert!(crate::source::archive::dao::get(&conn, &key_a).unwrap().is_none(),
                "表无 A 行");
        assert!(crate::source::archive::dao::get(&conn, &key_b).unwrap().is_some(),
                "B 行保留");
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
        std::fs::write(&k3, b"known!").unwrap(); // 6 字节——与行 byte_size=6 一致（终审 P1-3 反向扫表长度校验）
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

    /// setup 死锁回归（task-6 审查修复）：lib.rs setup 闭包原实现持 conn guard 横跨
    /// startup_cleanup（内部再次 db.conn()）——同线程对同一非重入 Arc<Mutex<Connection>>
    /// 二次加锁，真实 app 启动即 hang。setup 闭包 cargo test 不执行（盲区），此用例
    /// 在可执行处锁死「先读 settings → drop guard → 再 cleanup」组合模式：guard 横跨
    /// 调用的话本用例会死锁挂起而非静默通过，同时断言清理语义（孤儿删除）不变。
    #[test]
    fn startup_cleanup_after_setting_read_guard_released_no_deadlock() {
        let (dir, db) = cleanup_fixture();
        let root = dir.path();
        std::fs::write(root.join("orphan.zip"), b"orphan").unwrap();

        // 镜像 lib.rs setup 修复后片段：限值读取收内层作用域，guard 先释放再清理
        let limit_bytes = {
            let conn = db.conn();
            crate::setting_u64(&conn, "archive_cache_max_mb", 2048)
                .saturating_mul(1024 * 1024)
                .min(i64::MAX as u64) as i64
        };
        assert_eq!(limit_bytes, 2048 * 1024 * 1024, "默认档 2 GiB（settings 表无该行）");

        startup_cleanup(root, &db, limit_bytes);
        assert!(!root.join("orphan.zip").exists(),
            "guard 已释放，cleanup 正常拿锁执行 + 孤儿删除语义不变");
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
            async move { m.ensure_cached_cancellable(&o, "a.cbz", 0).await }
        });
        wait_reads(&mock, 1).await;
        m.advance_epoch(1);
        assert!(h.await.unwrap().is_err(), "预载任务被窗口 epoch 取消");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 1, "第一 chunk 后即中止");

        // 强制任务：同 key 从 .part 续传剩余 5 字节；epoch 再推进也不影响（只有 generation 能停）
        let h2 = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached(&o, "a.cbz").await }
        });
        wait_reads(&mock, 2).await;
        m.advance_epoch(2);
        let p = h2.await.unwrap().unwrap();
        assert_eq!(std::fs::metadata(&p).unwrap().len(), super::CHUNK + 5);
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 2, "续传只补读剩余字节，未全量重下");
    }

    /// 终审 P1-4：advance_epoch 单调推进——IPC 乱序迟到的旧 epoch 不得回退当前值
    /// （旧 new_epoch 无条件 store，前端乱序可让旧窗口覆盖新窗口）。
    #[tokio::test]
    async fn advance_epoch_ignores_stale_lower_value() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        m.advance_epoch(5);
        m.advance_epoch(3); // 迟到的旧窗口（乱序 IPC）
        assert_eq!(m.current_epoch(), 5, "epoch 单调推进——旧值不回退");
    }

    /// 终审 P1-4：注册前身份检查——任务诞生时刻的 expected_epoch 已过时（窗口已推进）
    /// 则立即 Err("cancelled") 且零网络读。旧实现（download 内捕获 epoch_at_start）
    /// 会把新 epoch 当自己的身份完整下载：prefetch 批次循环检查与调用间隙推进的
    /// epoch 全部落空，旧批次任务永不被取消。
    #[tokio::test]
    async fn expected_epoch_stale_rejected_at_registration() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        m.advance_epoch(2);
        let err = m.ensure_cached_cancellable(&origin, "a.cbz", 1).await.unwrap_err();
        assert!(matches!(err, MaterializeError::Other(ref s) if s == "cancelled"),
                "注册前身份拒绝（非进入下载后再取消），实际 {err:?}");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 0, "零 read（旧实现捕获新 epoch 完整下载）");
        assert_eq!(mock.stat_calls.load(Ordering::SeqCst), 0, "零 stat（无表行走查表路径，直接拒）");
        assert!(m.inflight_empty().await, "未注册 inflight");
    }

    /// 终审 P1-1：强制 waiter 接管被 epoch 取消的预载 owner——预载取消后同 key 的
    /// 强制调用方（用户双击打开）醒来发现表无行，不得继承「未产出结果」错误，
    /// 应重走查表 + 抢 owner 续传（.part 复用，只补剩余 chunk）。
    #[tokio::test]
    async fn forced_waiter_takes_over_cancelled_preload_owner() {
        let mock = StdArc::new(MockOrigin::new(super::CHUNK + 5)); // 两 chunk
        *mock.read_delay_ms.lock().unwrap() = 150;
        let (m, _g, _db) = temp_materializer(mock.clone());
        let m = StdArc::new(m);
        let origin = webdav("");

        // 任务 1：预载 owner（expected=1）——先推进 epoch 到 1（生产路径 notify_window
        // 先 advance_epoch 再 spawn，任务诞生时 current == expected），chunk 1 在途后
        // 确认已注册并进入下载
        m.advance_epoch(1);
        let h1 = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached_cancellable(&o, "a.cbz", 1).await }
        });
        wait_reads(&mock, 1).await;
        // 任务 2：强制调用方——注册时 owner 在途 → 成为 waiter（短暂 sleep 确保注册顺序）
        let h2 = tokio::spawn({
            let m = m.clone();
            let o = origin.clone();
            async move { m.ensure_cached(&o, "a.cbz").await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        // 窗口推进 → 预载 owner 在第二 chunk 前的检查点被取消（.part 保留）
        m.advance_epoch(2);
        assert!(h1.await.unwrap().is_err(), "预载 owner 被 epoch 取消");
        // 旧实现：waiter 醒来表无行直接 Err——强制打开继承预载取消结果
        let p = h2.await.unwrap().unwrap();
        assert!(p.exists(), "waiter 接管成为新 owner，物化成功");
        assert_eq!(std::fs::metadata(&p).unwrap().len(), super::CHUNK + 5);
        assert_eq!(take_ranges(&mock), &[(0, super::CHUNK), (super::CHUNK, 5)],
                   "接管从 .part 续传——只补读剩余 5 字节，未全量重下");
    }

    /// 终审 P1-3：命中路径磁盘一致性校验——表行 stat 新鲜但缓存文件被 OS 清掉 /
    /// 用户删除 → 悬空行不得每次命中都返回不存在路径，应条件删行后重物化自愈。
    #[tokio::test]
    async fn hit_path_missing_file_rematerializes() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let p1 = m.ensure_cached(&origin, "a.cbz").await.unwrap();
        std::fs::remove_file(&p1).unwrap(); // 模拟外部删除
        let reads_before = mock.read_calls.load(Ordering::SeqCst);
        let p2 = m.ensure_cached(&origin, "a.cbz").await.unwrap();
        assert_eq!(p2, p1, "同一 cache 路径重物化");
        assert!(p2.exists() && p2.is_file(), "返回的路径真实存在");
        assert!(mock.read_calls.load(Ordering::SeqCst) > reads_before, "触发重新下载");
        assert_eq!(std::fs::metadata(&p2).unwrap().len(), 10);
    }

    /// 终审 P1-3：命中路径长度校验——文件存在但被截断 / 损坏（len != byte_size）
    /// 同样视为悬空：条件删行 + 尽力删文件 → 重物化。
    #[tokio::test]
    async fn hit_path_truncated_file_rematerializes() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _g, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let p1 = m.ensure_cached(&origin, "a.cbz").await.unwrap();
        std::fs::write(&p1, b"12345").unwrap(); // 截断到 5 字节（长度不符）
        let reads_before = mock.read_calls.load(Ordering::SeqCst);
        let p2 = m.ensure_cached(&origin, "a.cbz").await.unwrap();
        assert_eq!(p2, p1);
        assert_eq!(std::fs::metadata(&p2).unwrap().len(), 10, "重物化产出完整文件");
        assert!(mock.read_calls.load(Ordering::SeqCst) > reads_before, "触发重新下载");
    }

    /// 终审 P2-1：upsert 后回收钩子回收到 80% 水位——4 包各 1.2MB + limit 4MB：
    /// 第 4 包 upsert 后 total 4.8MB > 4MB → 目标 3.2MB → 淘汰 a+b（各 1.2MB，
    /// 2.4MB ≤ 3.2MB 停）。旧语义（目标=limit）只淘汰 a（3.6MB ≤ 4MB 即停）——
    /// 本用例以「b 也被淘汰」钉死水位语义。秒级 last_accessed_at 手工排序保 LRU 确定性。
    #[tokio::test]
    async fn upsert_hook_evicts_to_80pct_watermark() {
        let mock = StdArc::new(MockOrigin::new(1_200_000));
        let (m, _dir, db) = temp_materializer(mock.clone());
        {
            let conn = db.conn();
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('archive_cache_max_mb', '4')",
                []).unwrap();
        }
        let origin = webdav("");
        let keys: Vec<String> = ["a", "b", "c", "d"].iter()
            .map(|n| cache_key(&origin, &format!("{n}.cbz"))).collect();
        let finals: Vec<PathBuf> = keys.iter()
            .map(|k| m.cache_paths(k).0).collect();
        // a/b/c 先物化（total 3.6MB ≤ 4MB 不触发回收），手工排访问时间
        for (i, name) in ["a.cbz", "b.cbz", "c.cbz"].iter().enumerate() {
            m.ensure_cached(&origin, name).await.unwrap();
            let conn = db.conn();
            conn.execute("UPDATE archive_cache SET last_accessed_at = ?1 WHERE cache_key = ?2",
                rusqlite::params![((i + 1) * 100) as i64, keys[i]]).unwrap();
        }
        // d：upsert 后 total 4.8MB > 4MB → 目标 3.2MB → 淘汰 a(100)+b(200)，剩 c+d=2.4MB
        let pd = m.ensure_cached(&origin, "d.cbz").await.unwrap();
        assert!(pd.exists(), "d 物化成功");
        assert!(!finals[0].exists(), "a（最旧）被淘汰");
        assert!(!finals[1].exists(), "b 也被淘汰——回收到 80% 水位而非 limit 边缘");
        assert!(finals[2].exists() && finals[3].exists(), "c/d 保留");
        let conn = db.conn();
        assert!(crate::source::archive::dao::get(&conn, &keys[0]).unwrap().is_none(), "a 行删");
        assert!(crate::source::archive::dao::get(&conn, &keys[1]).unwrap().is_none(), "b 行删");
        let (_, bytes) = crate::source::archive::dao::usage(&conn).unwrap();
        assert_eq!(bytes, 2_400_000, "剩余总量 = 80% 水位（2 × 1.2MB）");
    }

    /// 终审 P1-3：startup_cleanup 反向扫表——表行对应文件缺失（悬空行）→ 删行；
    /// 文件存在但长度不符 byte_size → 删行 + 删文件；完好行不受影响。
    #[test]
    fn startup_cleanup_removes_dangling_rows() {
        let (dir, db) = cleanup_fixture();
        let root = dir.path();
        let good = root.join("k9.zip");
        std::fs::write(&good, b"0123456789").unwrap();
        let badlen = root.join("k8.zip");
        std::fs::write(&badlen, b"short").unwrap(); // 5 字节，行宣称 10
        {
            let conn = db.conn();
            for (k, abs, size) in [
                ("k7", root.join("k7.zip").display().to_string(), 10), // 文件缺失
                ("k8", badlen.display().to_string(), 10),               // 长度不符
                ("k9", good.display().to_string(), 10),                 // 完好
            ] {
                crate::source::archive::dao::upsert(&conn, &crate::source::archive::dao::NewCacheRow {
                    cache_key: k.into(),
                    origin_kind: "webdav".into(),
                    archive_rel_path: "books/a.cbz".into(),
                    origin_size: 10,
                    origin_mtime: Some(1000),
                    cache_abs_path: abs,
                    byte_size: size,
                }).unwrap();
            }
        }
        startup_cleanup(root, &db, i64::MAX);
        let conn = db.conn();
        assert!(crate::source::archive::dao::get(&conn, "k7").unwrap().is_none(),
                "悬空行（文件缺失）删除");
        assert!(crate::source::archive::dao::get(&conn, "k8").unwrap().is_none(),
                "错长度行删除");
        assert!(!badlen.exists(), "错长度文件一并删除");
        assert!(crate::source::archive::dao::get(&conn, "k9").unwrap().is_some(),
                "完好行保留");
        assert!(good.exists(), "完好文件保留");
    }

    // ─── 终审二批 P1-2：.part 计入容量预算（parts_usage / enforce_budget）───

    /// 设置文件 mtime（确定性排序用；File::set_times 稳定于 Rust 1.75）
    fn set_mtime(path: &std::path::Path, t: std::time::SystemTime) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    /// parts_usage 只统计扩展名恰为 .part 的数据文件——.part.meta（sidecar）与
    /// .meta.tmp（原子写残留）不是 part，不计条数也不计字节。
    #[test]
    fn parts_usage_only_counts_part_files() {
        let (dir, db) = cleanup_fixture();
        let _ = db;
        let part = dir.path().join("part");
        std::fs::write(part.join("a.part"), [0u8; 10]).unwrap();
        std::fs::write(part.join("a.part.meta"), [0u8; 50]).unwrap();
        std::fs::write(part.join("b.part.meta.tmp"), [0u8; 30]).unwrap();
        std::fs::write(part.join("c.txt"), [0u8; 7]).unwrap();
        let (count, bytes) = parts_usage(dir.path());
        assert_eq!((count, bytes), (1, 10),
                   "只计 a.part；sidecar/.tmp/.txt 均不计");
        // part/ 目录不存在 → (0, 0) 而非报错
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(parts_usage(empty.path()), (0, 0));
    }

    /// 取消/失败路径不会走 ready upsert，但刚写入的 `.part` 同样必须立即受容量预算
    /// 约束；否则快速滚动反复取消预载时，只能等下次成功物化或重启才会回收。
    #[tokio::test]
    async fn cancelled_download_enforces_part_budget_immediately() {
        let mock = StdArc::new(MockOrigin::new(CHUNK + 5));
        *mock.read_delay_ms.lock().unwrap() = 100;
        let (m, dir, db) = temp_materializer(mock.clone());
        {
            let conn = db.conn();
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('archive_cache_max_mb', '1')",
                [],
            ).unwrap();
        }
        let origin = webdav("");
        let m = StdArc::new(m);
        m.advance_epoch(1);
        let task = tokio::spawn({
            let m = m.clone();
            let origin = origin.clone();
            async move { m.ensure_cached_cancellable(&origin, "cancelled.cbz", 1).await }
        });

        wait_reads(&mock, 1).await;
        m.advance_epoch(2);
        assert!(task.await.unwrap().is_err(), "旧窗口预载被取消");
        assert_eq!(parts_usage(dir.path()), (0, 0),
                   "4MB 取消残片超过 1MB 上限，应在错误退出时立即回收");
    }

    /// 取消代际必须在 in-flight 注册的同一临界区捕获。若推迟到
    /// `download` 内首次 stat 之后才捕获，clear 在该窗口推进的新代际
    /// 会被误当成任务起点，已登记任务将漏取消并继续整包下载。
    #[tokio::test]
    async fn cancellation_between_registration_and_first_stat_is_observed() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _dir, _db) = temp_materializer(mock.clone());
        let m = StdArc::new(m);
        let weak = StdArc::downgrade(&m);
        *mock.interject_on_stat.lock().unwrap() = Some((1, Box::new(move || {
            weak.upgrade().unwrap().cancel_all();
        })));

        assert!(m.ensure_cached(&webdav(""), "cancel-before-read.cbz").await.is_err(),
                "注册后、首次 stat 期间推进的代际必须取消旧任务");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 0,
                   "应在首个 chunk 前取消，不得继续下载");
    }

    /// in-flight 注册的 key 对应 .part 不被预算淘汰（写入中，删了会破断点续传）；
    /// 未保护的更旧 .part 优先被删。
    #[test]
    fn inflight_part_protected_from_budget_eviction() {
        let (dir, db) = cleanup_fixture();
        let root = dir.path();
        let part = root.join("part");
        let kprot = part.join("kprot.part");
        let kfree = part.join("kfree.part");
        std::fs::write(&kprot, [0u8; 300]).unwrap();
        std::fs::write(kprot.with_extension("part.meta"), b"{}").unwrap();
        std::fs::write(&kfree, [0u8; 200]).unwrap();
        std::fs::write(kfree.with_extension("part.meta"), b"{}").unwrap();
        let now = std::time::SystemTime::now();
        set_mtime(&kprot, now - std::time::Duration::from_secs(3600)); // 更旧但 protected
        set_mtime(&kfree, now);
        let conn = db.conn();
        let n = enforce_budget(root, &conn, 100, &["kprot".to_string()]);
        assert_eq!(n, 1, "只淘汰 1 个 .part（kfree）");
        assert!(kprot.exists(), "protected 的 .part 保留（in-flight 写入中）");
        assert!(kprot.with_extension("part.meta").exists(), "protected 的 sidecar 保留");
        assert!(!kfree.exists(), "未保护的 .part 被删");
        assert!(!kfree.with_extension("part.meta").exists(), "连带删 sidecar");
        assert_eq!(parts_usage(root), (1, 300));
    }

    /// 主场景：2 个 ready 包（真物化）+ 2 个手工 .part+sidecar（一旧一新）+ 限值压小
    /// → 物化第 3 包的 upsert 钩子触发 enforce_budget → 最旧 .part 连带 .meta 被删、
    /// 新 .part 与全部 ready 保留、total ≤ 80% 水位。
    /// 数字：包各 1MB；part_old 2.5MB（mtime -1h）/ part_new 100KB（now）；
    /// limit 5MB → 水位 4MB。c 钩子时 total = 3 + 2.6 = 5.6MB > 5MB → 删 part_old
    /// → 3.1MB ≤ 4MB 停（phase 2 不触发，ready 全保留）。
    #[tokio::test]
    async fn parts_counted_in_budget_and_evicted() {
        let mock = StdArc::new(MockOrigin::new(1_000_000));
        let (m, dir, db) = temp_materializer(mock.clone());
        let root = dir.path().to_path_buf();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('archive_cache_max_mb', '5')",
                []).unwrap();
        }
        let origin = webdav("");
        // a/b 先物化（各 1MB；钩子 total 2MB ≤ 5MB no-op）
        m.ensure_cached(&origin, "a.cbz").await.unwrap();
        m.ensure_cached(&origin, "b.cbz").await.unwrap();
        // 手工 .part + 有效 sidecar（预算执行不校验 sidecar，真实态构造）
        let sidecar_for = |rel: &str| {
            let key = cache_key(&origin, rel);
            PartSidecar {
                cache_key: key,
                canonical_origin: serde_json::to_string(&origin).unwrap(),
                archive_rel_path: rel.into(),
                snapshot_size: 10,
                snapshot_mtime: Some(1000),
                downloaded: 1,
            }
        };
        let part_old = write_part(&m, &origin, "old.cbz", &vec![0u8; 2_500_000],
                                  Some(&sidecar_for("old.cbz")));
        let part_new = write_part(&m, &origin, "new.cbz", &vec![0u8; 100_000],
                                  Some(&sidecar_for("new.cbz")));
        let now = std::time::SystemTime::now();
        set_mtime(&part_old, now - std::time::Duration::from_secs(3600));
        set_mtime(&part_new, now);
        // c 物化 → upsert 钩子：total 5.6MB > 5MB → 淘汰 part_old → 3.1MB ≤ 4MB 水位
        let pc = m.ensure_cached(&origin, "c.cbz").await.unwrap();
        assert!(pc.exists(), "c 物化成功");
        assert!(!part_old.exists(), "最旧 .part 被删");
        assert!(!sidecar_path(&part_old).exists(), "最旧 .part 的 sidecar 连带删除");
        assert!(part_new.exists() && sidecar_path(&part_new).exists(),
                "新 .part + sidecar 保留");
        let finals: Vec<_> = ["a.cbz", "b.cbz", "c.cbz"].iter()
            .map(|rel| m.cache_paths(&cache_key(&origin, rel)).0).collect();
        for f in &finals { assert!(f.exists(), "ready 全保留（未到 phase 2）: {}", f.display()); }
        let conn = db.conn();
        let (_, ready_bytes) = crate::source::archive::dao::usage(&conn).unwrap();
        assert_eq!(ready_bytes, 3_000_000);
        let (_, part_bytes) = parts_usage(&root);
        assert_eq!(part_bytes, 100_000, "仅剩 part_new");
        assert!(ready_bytes + part_bytes as i64 <= 5 * 1024 * 1024 * 8 / 10,
                "total ≤ 80% 水位");
    }

    // ─── 终审二批 P2-3：物化 → 解压 → 读 entry 端到端（真 ZIP 字节）───

    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

    /// 内存构造真 ZIP（条目乱序写入——断言 list 的自然排序，非容器序）
    fn build_zip_bytes(names: &[&str]) -> Vec<u8> {
        use std::io::Write;
        let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
        for name in names {
            w.start_file::<_, ()>(name, opts.clone()).unwrap();
            w.write_all(&PNG_MAGIC).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    /// 端到端：MockOrigin 源字节 = 真 ZIP → ArchiveMediaSource（物化器真实现）
    /// list_directory（自然排序）/ read_file（PNG magic）/ stat（解压后 size）全链。
    async fn e2e_list_read_stat(format: crate::source::descriptor::ArchiveFormat, rel: &str) {
        let zip_bytes = build_zip_bytes(&["p10.png", "p1.png", "p2.png"]);
        let mock = StdArc::new(MockOrigin::new(zip_bytes.len() as u64));
        *mock.bytes.lock().unwrap() = zip_bytes;
        let (m, _dir, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let descriptor = SourceDescriptor::Archive {
            archive_path: format!("https://d/x/{rel}"),
            entry_prefix: String::new(),
            format,
            origin: Some(Box::new(origin)),
            origin_entry_path: Some(rel.into()),
            archive_rel_path: Some(rel.into()),
        };
        let src = crate::source::archive_impl::ArchiveMediaSource::new(
            StdArc::new(m) as StdArc<dyn crate::source::archive_impl::Materialize>);
        // list：物化（真下载 mock 字节 → final）+ 解压列条目 + 自然排序
        let entries = src.list_directory(&descriptor, "").await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["p1.png", "p2.png", "p10.png"],
                   "自然排序（p2 < p10），非容器写入序");
        // read：entry 解压字节 == 写入的 PNG magic
        let bytes = src.read_file(&descriptor, "p2.png", None).await.unwrap();
        assert_eq!(&bytes[..8], &PNG_MAGIC, "entry 字节解压无损");
        // stat：entry 解压后 size（8），非 ZIP 容器 size
        let st = src.stat(&descriptor, "p2.png").await.unwrap();
        assert_eq!(st.size, 8);
        // 二次调用走命中路径（零 read）——物化产物被复用
        let reads_before = mock.read_calls.load(Ordering::SeqCst);
        let again = src.read_file(&descriptor, "p1.png", None).await.unwrap();
        assert_eq!(&again[..8], &PNG_MAGIC);
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), reads_before,
                   "命中路径零网络 read");
    }

    #[tokio::test]
    async fn e2e_materialize_then_list_read_stat_cbz() {
        e2e_list_read_stat(crate::source::descriptor::ArchiveFormat::Cbz, "book.cbz").await;
    }

    #[tokio::test]
    async fn e2e_materialize_then_list_read_stat_zip_variant() {
        e2e_list_read_stat(crate::source::descriptor::ArchiveFormat::Zip, "book.zip").await;
    }
}
