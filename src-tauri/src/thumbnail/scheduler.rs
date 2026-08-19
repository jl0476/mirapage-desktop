//! 缩略图生成调度器（§5 §8）。
//!
//! 一个 tokio actor 持有 pending 队列、in-flight 去重表、当前 worker 数与预计内存。
//! 真正的生成调用包在 `tokio::task::spawn_blocking`，不占 Tokio 异步 worker。
//!
//! 调度条件（§8.3）：
//! ```text
//! can_start = running_jobs < worker_limit
//!     && (running_memory + estimated_memory <= budget || running_jobs == 0);
//! ```
//!
//! - 优先级 visible > ahead > behind > idle；同级按提交顺序。
//! - 同 cache_key 只跑一次，多订阅者收同一结果（in-flight 去重）。
//! - 新 epoch 到达：旧 epoch 未开始任务标 stale（订阅者收 Stale）；已开始任务允许完成
//!   并写缓存，但其订阅者收 Stale（不发 Cached UI 更新）。
//! - 快速滚动期间不启动 idle。
//! - 老化：等待超过阈值的任务优先级提升，避免被连续高优先级任务永久饥饿。
//! - 设置变更只影响下一次调度，不中断正在编码的任务。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::generator::GeneratedThumbnail;
use super::{GenPhase, Priority, ThumbnailError};
use crate::log;

/// 默认老化阈值（等待超过此值的任务优先级提升）。
const DEFAULT_STARVATION_THRESHOLD: Duration = Duration::from_secs(5);

/// 生成函数：接收 job，阻塞执行，返回元数据或错误。生产实现读 source_bytes 调
/// `generator::generate_thumbnail`；测试用可控 channel fake。
pub type GenerateFn =
    Arc<dyn Fn(GenerationJob) -> Result<GeneratedThumbnail, ThumbnailError> + Send + Sync>;

/// 一次生成的全部输入（owned，便于跨 spawn_blocking 边界）。
/// Local 源走 `source_path`（blocking 线程内 std::fs::read）；其它源可填 `source_bytes`。
/// 注意：不 derive Debug（round-1 P1-2）——`on_progress` 的 `Arc<dyn Fn>` 不实现
/// Debug；手写 impl 跳过该字段（`ItemClass`/`QueuedTask` 的 Debug 派生依赖于此）。
#[derive(Clone)]
pub struct GenerationJob {
    pub source_bytes: Vec<u8>,
    pub source_path: Option<PathBuf>,
    pub target_width: u32,
    pub pixel_budget: u32,
    pub clarity_floor_width: u32,
    pub webp_quality: f32,
    pub cache_path: PathBuf,
    /// 阶段进度回调（generate 阶段边界调用）。None 时 generator 静默（测试用）。
    /// 第一参 GenPhase 为当前阶段，第二参 u64 = generate 开始到本阶段的累计毫秒
    /// （由 generate_thumbnail 内 t0 计算，见 spec §3.5 决策 B）。闭包内捕获
    /// cache_key/ui_path/epoch/AppHandle 并 `let _ = app.emit(EVENT_PROGRESS, ...)`，
    /// 禁止同步 IO / Db 锁（emit 非阻塞）。
    pub on_progress: Option<Arc<dyn Fn(GenPhase, u64) + Send + Sync>>,
}

impl std::fmt::Debug for GenerationJob {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GenerationJob")
            .field("source_bytes", &self.source_bytes.len())
            .field("source_path", &self.source_path)
            .field("target_width", &self.target_width)
            .field("pixel_budget", &self.pixel_budget)
            .field("clarity_floor_width", &self.clarity_floor_width)
            .field("webp_quality", &self.webp_quality)
            .field("cache_path", &self.cache_path)
            .field("on_progress", &self.on_progress.is_some())
            .finish()
    }
}

/// 提交到调度器的任务。
#[derive(Debug, Clone)]
pub struct QueuedTask {
    pub cache_key: String,
    pub source_key: String,
    pub priority: Priority,
    pub epoch: u64,
    pub estimated_memory_mb: u32,
    pub job: GenerationJob,
}

/// 订阅者收到的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// 生成成功（缓存已写）。
    Cached(GeneratedThumbnail),
    /// 生成失败。
    Failed(String),
    /// 因 epoch 变更被取消（未开始或旧 epoch 完成但不发 UI 更新）。
    Stale,
}

/// 调度器运行时配置。
#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    pub worker_limit: u32,
    pub memory_budget_mb: u32,
    pub starvation_threshold: Duration,
}
impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            worker_limit: 2,
            memory_budget_mb: 128,
            starvation_threshold: DEFAULT_STARVATION_THRESHOLD,
        }
    }
}

enum Command {
    Submit {
        task: QueuedTask,
        reply: oneshot::Sender<Outcome>,
    },
    NewEpoch {
        epoch: u64,
    },
    SetConfig {
        worker_limit: u32,
        memory_budget_mb: u32,
    },
    SetFastScrolling {
        fast: bool,
    },
    /// 触发一次调度扫描（测试用 / 周期 tick）。
    Pump,
    /// 取消全部未开始任务（清空缓存/维护用）：bump epoch，drain pending 发 Stale；
    /// in-flight 任务完成时因 epoch < current 自动变 Stale（不写索引）。
    CancelAll,
    Completed {
        cache_key: String,
        epoch: u64,
        est_memory_mb: u32,
        result: Result<GeneratedThumbnail, ThumbnailError>,
    },
    Shutdown,
}

struct Pending {
    task: QueuedTask,
    subscribers: Vec<oneshot::Sender<Outcome>>,
    enqueued_at: Instant,
    seq: u64,
}

struct InFlight {
    subscribers: Vec<oneshot::Sender<Outcome>>,
}

/// 调度器句柄。drop 时发送 Shutdown。
#[derive(Clone)]
pub struct SchedulerHandle {
    tx: mpsc::UnboundedSender<Command>,
}

impl SchedulerHandle {
    /// 构建调度器（handle + actor），**不 spawn**。调用方负责在合适的 runtime 上 spawn `actor.run()`：
    /// 测试用 `tokio::spawn`（#[tokio::test] 上下文），生产 service 用 `tauri::async_runtime::spawn`
    /// （setup() 同步上下文里 `tokio::spawn` 会 panic「no reactor running」）。
    pub fn build(config: SchedulerConfig, generate: GenerateFn) -> (Self, Actor) {
        let (tx, rx) = mpsc::unbounded_channel();
        let handle = SchedulerHandle { tx: tx.clone() };
        let actor = Actor {
            rx,
            tx,
            generate,
            worker_limit: config.worker_limit,
            memory_budget_mb: config.memory_budget_mb,
            starvation_threshold: config.starvation_threshold,
            pending: Vec::new(),
            inflight: HashMap::new(),
            running_count: 0,
            running_memory: 0,
            current_epoch: 0,
            max_task_epoch: 0,
            fast_scrolling: false,
            seq: 0,
        };
        (handle, actor)
    }

    /// 便捷启动（在已有 tokio runtime 上下文里用，如 #[tokio::test]）。
    /// 生产代码（setup 同步上下文）用 `build` + `tauri::async_runtime::spawn`。
    pub fn start(config: SchedulerConfig, generate: GenerateFn) -> Self {
        let (handle, actor) = Self::build(config, generate);
        tokio::spawn(actor.run());
        handle
    }

    pub fn submit(&self, task: QueuedTask) -> oneshot::Receiver<Outcome> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let _ = self.tx.send(Command::Submit { task, reply: reply_tx });
        reply_rx
    }

    pub fn new_epoch(&self, epoch: u64) {
        let _ = self.tx.send(Command::NewEpoch { epoch });
    }

    pub fn set_config(&self, worker_limit: u32, memory_budget_mb: u32) {
        let _ = self.tx.send(Command::SetConfig {
            worker_limit,
            memory_budget_mb,
        });
    }

    pub fn set_fast_scrolling(&self, fast: bool) {
        let _ = self.tx.send(Command::SetFastScrolling { fast });
    }

    pub fn pump(&self) {
        let _ = self.tx.send(Command::Pump);
    }

    /// P2-2: 取消全部未开始任务（清空缓存/维护用）。in-flight 任务完成后自动 Stale。
    pub fn cancel_all(&self) {
        let _ = self.tx.send(Command::CancelAll);
    }
}

impl Drop for SchedulerHandle {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

pub struct Actor {
    rx: mpsc::UnboundedReceiver<Command>,
    tx: mpsc::UnboundedSender<Command>,
    generate: GenerateFn,
    worker_limit: u32,
    memory_budget_mb: u32,
    starvation_threshold: Duration,
    pending: Vec<Pending>,
    inflight: HashMap<String, InFlight>,
    running_count: u32,
    running_memory: u64,
    current_epoch: u64,
    /// 曾提交过的最大 task epoch，cancel_all 时据此 bump current_epoch 使全部任务变 stale。
    max_task_epoch: u64,
    fast_scrolling: bool,
    seq: u64,
}

impl Actor {
    pub async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd {
                Command::Shutdown => break,
                Command::Submit { task, reply } => self.handle_submit(task, reply),
                Command::NewEpoch { epoch } => self.handle_new_epoch(epoch),
                Command::SetConfig {
                    worker_limit,
                    memory_budget_mb,
                } => {
                    self.worker_limit = worker_limit;
                    self.memory_budget_mb = memory_budget_mb;
                }
                Command::SetFastScrolling { fast } => self.fast_scrolling = fast,
                Command::Pump => {}
                Command::CancelAll => self.handle_cancel_all(),
                Command::Completed {
                    cache_key,
                    epoch,
                    est_memory_mb,
                    result,
                } => self.handle_completed(cache_key, epoch, est_memory_mb, result),
            }
            self.try_schedule();
        }
    }

    fn handle_submit(&mut self, task: QueuedTask, reply: oneshot::Sender<Outcome>) {
        // in-flight 去重：同 cache_key 已在跑 -> 订阅
        if let Some(inf) = self.inflight.get_mut(&task.cache_key) {
            log::write_log(
                "DEBUG",
                "thumbnail",
                &format!(
                    "scheduler submit DEDUP_INFLIGHT cacheKey={} priority={:?} epoch={} inFlightSubs={}",
                    task.cache_key,
                    task.priority,
                    task.epoch,
                    inf.subscribers.len()
                ),
            );
            inf.subscribers.push(reply);
            return;
        }
        // pending 去重：同 cache_key 已排队 -> 订阅
        if let Some(p) = self.pending.iter_mut().find(|p| p.task.cache_key == task.cache_key) {
            log::write_log(
                "DEBUG",
                "thumbnail",
                &format!(
                    "scheduler submit DEDUP_PENDING cacheKey={} priority={:?} epoch={} pendingSubs={}",
                    task.cache_key,
                    task.priority,
                    task.epoch,
                    p.subscribers.len()
                ),
            );
            // 同 cache_key 重提交：只提升优先级（min，只升不降），不换 epoch/job ——
            // 同 key 意味着参数等价；旧 epoch 的 pending 会被 new_epoch drain，不会
            // 出现"旧 epoch pending 存活 + 新 epoch 同 key 重提交"的时序。
            if task.priority < p.task.priority {
                log::write_log(
                    "INFO",
                    "thumbnail",
                    &format!(
                        "scheduler submit PROMOTE cacheKey={} {} -> {}",
                        task.cache_key, p.task.priority, task.priority
                    ),
                );
                p.task.priority = task.priority;
            }
            p.subscribers.push(reply);
            return;
        }
        self.seq += 1;
        if task.epoch > self.max_task_epoch {
            self.max_task_epoch = task.epoch;
        }
        self.pending.push(Pending {
            task: task.clone(),
            subscribers: vec![reply],
            enqueued_at: Instant::now(),
            seq: self.seq,
        });
        log::write_log(
            "INFO",
            "thumbnail",
            &format!(
                "scheduler submit ENQUEUE cacheKey={} priority={:?} epoch={} estMemMb={} queueDepth={} inflight={}",
                task.cache_key,
                task.priority,
                task.epoch,
                task.estimated_memory_mb,
                self.pending.len(),
                self.inflight.len()
            ),
        );
    }

    fn handle_new_epoch(&mut self, epoch: u64) {
        let prev = self.current_epoch;
        self.current_epoch = epoch;
        // 旧 epoch 未开始任务标 stale，移除并通知订阅者
        let mut i = 0;
        let mut stale_n = 0usize;
        while i < self.pending.len() {
            if self.pending[i].task.epoch < epoch {
                let p = self.pending.remove(i);
                stale_n += 1;
                for s in p.subscribers {
                    let _ = s.send(Outcome::Stale);
                }
            } else {
                i += 1;
            }
        }
        log::write_log(
            "INFO",
            "thumbnail",
            &format!(
                "scheduler new_epoch old={} new={} stalePending={} inflightSurvivors={}",
                prev, epoch, stale_n, self.inflight.len()
            ),
        );
        // in-flight 保留（让其完成写缓存）；完成时按 epoch 决定是否发 Cached。
    }

    /// P2-2: 清空缓存/维护用。bump 内部 epoch 使所有现存任务（pending + in-flight）
    /// 的 epoch 都 < current：pending 立即 drain 发 Stale；in-flight 完成时自动 Stale
    /// （spawn_completion 的 Stale 分支不写索引，避免清空后被后台任务重新写回）。
    fn handle_cancel_all(&mut self) {
        // bump 到超过所有曾提交任务的 epoch，使 pending + in-flight 全部变 stale。
        let prev = self.current_epoch;
        self.current_epoch = self.max_task_epoch.wrapping_add(1);
        let drained = std::mem::take(&mut self.pending);
        let drained_n = drained.len();
        for p in drained {
            for s in p.subscribers {
                let _ = s.send(Outcome::Stale);
            }
        }
        log::write_log(
            "INFO",
            "thumbnail",
            &format!(
                "scheduler cancel_all prevEpoch={} newEpoch={} drainedPending={} inflightWillStale={}",
                prev, self.current_epoch, drained_n, self.inflight.len()
            ),
        );
    }

    fn handle_completed(
        &mut self,
        cache_key: String,
        epoch: u64,
        est_memory_mb: u32,
        result: Result<GeneratedThumbnail, ThumbnailError>,
    ) {
        if let Some(inf) = self.inflight.remove(&cache_key) {
            self.running_count = self.running_count.saturating_sub(1);
            self.running_memory = self.running_memory.saturating_sub(est_memory_mb as u64);
            let outcome = match result {
                Ok(g) => Outcome::Cached(g),
                Err(e) => Outcome::Failed(e.to_string()),
            };
            // 旧 epoch 已开始任务：完成写缓存，但不发 Cached（发 Stale）。
            let effective = if epoch >= self.current_epoch {
                outcome
            } else {
                Outcome::Stale
            };
            log::write_log(
                "DEBUG",
                "thumbnail",
                &format!(
                    "scheduler completed cacheKey={} epoch={} effective={:?} subs={} runningNow={}/{}",
                    cache_key,
                    epoch,
                    effective,
                    inf.subscribers.len(),
                    self.running_count,
                    self.worker_limit
                ),
            );
            for s in inf.subscribers {
                let _ = s.send(effective.clone());
            }
        }
    }

    fn try_schedule(&mut self) {
        loop {
            if self.running_count >= self.worker_limit {
                break;
            }
            let now = Instant::now();
            let Some(idx) = self.find_admissible(now) else { break };
            let pending = self.pending.remove(idx);
            let cache_key = pending.task.cache_key.clone();
            let epoch = pending.task.epoch;
            let est_mb = pending.task.estimated_memory_mb;
            let job = pending.task.job;
            let subscribers = pending.subscribers;
            let worker_id = self.running_count;

            self.inflight.insert(
                cache_key.clone(),
                InFlight { subscribers },
            );
            self.running_count += 1;
            self.running_memory += est_mb as u64;

            let tx = self.tx.clone();
            let gen = self.generate.clone();
            let ck = cache_key.clone();
            log::write_log(
                "INFO",
                "thumbnail",
                &format!(
                    "scheduler start worker={} cacheKey={} epoch={} estMemMb={} running={}/{}",
                    worker_id, cache_key, epoch, est_mb, self.running_count, self.worker_limit
                ),
            );
            let t0 = std::time::Instant::now();
            tokio::spawn(async move {
                // P0 防御: spawn_blocking 在独立阻塞线程池跑生成（image/webp 阻塞 IO），
                // 即使 image/webp 抛 panic 也不会杀掉 spawn 任务（tokio::spawn 任务 panic
                // 默认让进程 abort）。JoinError::is_panic() 捕获后转 Failed outcome 让
                // 前端能 retry。Async runtime 自身 panic 由外层 catch_unwind 兜底。
                let join_result = tokio::task::spawn_blocking(move || gen(job)).await;
                let elapsed_ms = t0.elapsed().as_millis();
                let result = match join_result {
                    Ok(Ok(g)) => Ok(g),
                    Ok(Err(e)) => Err(e),
                    Err(je) => {
                        if je.is_panic() {
                            // spawn_blocking 内部 panic
                            let msg = format!("worker_panic: spawn_blocking join error");
                            log::write_log(
                                "ERROR",
                                "thumbnail",
                                &format!(
                                    "scheduler worker PANIC worker={} cacheKey={} msg={} durationMs={}",
                                    worker_id, ck, msg, elapsed_ms
                                ),
                            );
                            eprintln!(
                                "[scheduler] worker {} PANIC cacheKey={} msg={} durationMs={}",
                                worker_id, ck, msg, elapsed_ms
                            );
                            Err(ThumbnailError::Invalid(msg))
                        } else {
                            Err(ThumbnailError::Invalid(format!("join error: {je}")))
                        }
                    }
                };
                match &result {
                    Ok(_) => log::write_log(
                        "INFO",
                        "thumbnail",
                        &format!(
                            "scheduler worker DONE worker={} cacheKey={} result=cached durationMs={}",
                            worker_id, ck, elapsed_ms
                        ),
                    ),
                    Err(e) => log::write_log(
                        "WARN",
                        "thumbnail",
                        &format!(
                            "scheduler worker DONE worker={} cacheKey={} result=failed err={} durationMs={}",
                            worker_id, ck, e, elapsed_ms
                        ),
                    ),
                }
                let _ = tx.send(Command::Completed {
                    cache_key: ck,
                    epoch,
                    est_memory_mb: est_mb,
                    result,
                });
            });
        }
    }

    /// 找下一个可启动的 pending 索引：先看老化任务（等待超阈值的最旧者），
    /// 否则按优先级 + 提交顺序，跳过不满足内存 / 快速滚动 idle 的任务。
    fn find_admissible(&self, now: Instant) -> Option<usize> {
        // 1. 老化：等待超过阈值的最旧任务优先（即便优先级低）。
        let mut starved_best: Option<usize> = None;
        for (i, p) in self.pending.iter().enumerate() {
            if now.duration_since(p.enqueued_at) > self.starvation_threshold {
                if let Some(b) = starved_best {
                    if p.seq < self.pending[b].seq {
                        starved_best = Some(i);
                    }
                } else {
                    starved_best = Some(i);
                }
            }
        }
        if let Some(i) = starved_best {
            if self.can_admit(&self.pending[i]) {
                return Some(i);
            }
        }
        // 2. 正常：优先级高 -> 提交早；跳过不可接纳者。
        let mut order: Vec<usize> = (0..self.pending.len()).collect();
        order.sort_by(|&a, &b| {
            self.pending[a]
                .task
                .priority
                .cmp(&self.pending[b].task.priority)
                .then_with(|| self.pending[a].seq.cmp(&self.pending[b].seq))
        });
        for i in order {
            if self.can_admit(&self.pending[i]) {
                return Some(i);
            }
        }
        None
    }

    fn can_admit(&self, p: &Pending) -> bool {
        if self.fast_scrolling && p.task.priority == Priority::Idle {
            return false;
        }
        let est = p.task.estimated_memory_mb as u64;
        self.running_memory + est <= self.memory_budget_mb as u64 || self.running_count == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 测试 fake：每个 job 通过 channel 交给测试，测试用 reply 回结果（控制完成时机）。
    type JobRx = mpsc::UnboundedReceiver<(GenerationJob, oneshot::Sender<Result<GeneratedThumbnail, ThumbnailError>>)>;

    fn setup(config: SchedulerConfig) -> (SchedulerHandle, JobRx) {
        let (job_tx, job_rx) = mpsc::unbounded_channel();
        let job_tx = Arc::new(job_tx);
        let gen: GenerateFn = Arc::new(move |job: GenerationJob| {
            let (reply_tx, reply_rx) = oneshot::channel();
            if job_tx.send((job, reply_tx)).is_err() {
                return Err(ThumbnailError::Invalid("test channel closed".into()));
            }
            reply_rx
                .blocking_recv()
                .unwrap_or_else(|_| Err(ThumbnailError::Invalid("reply dropped".into())))
        });
        let handle = SchedulerHandle::start(config, gen);
        (handle, job_rx)
    }

    fn job_for(key: &str) -> GenerationJob {
        GenerationJob {
            source_bytes: Vec::new(),
            source_path: None,
            target_width: 512,
            pixel_budget: 3_000_000,
            clarity_floor_width: 0,
            webp_quality: 82.0,
            cache_path: PathBuf::from(format!("/tmp/{key}.webp")),
            on_progress: None,
        }
    }

    fn task(key: &str, priority: Priority, epoch: u64, mem_mb: u32) -> QueuedTask {
        QueuedTask {
            cache_key: key.to_string(),
            source_key: "src".to_string(),
            priority,
            epoch,
            estimated_memory_mb: mem_mb,
            job: job_for(key),
        }
    }

    fn ok_thumb() -> GeneratedThumbnail {
        GeneratedThumbnail {
            width: 512,
            height: 768,
            byte_size: 1000,
        }
    }

    async fn recv_job(rx: &mut JobRx) -> (GenerationJob, oneshot::Sender<Result<GeneratedThumbnail, ThumbnailError>>) {
        tokio::time::timeout(Duration::from_millis(1000), rx.recv())
            .await
            .expect("timeout waiting for job")
            .expect("channel closed")
    }

    /// module3.0.11：on_progress 闭包随 job 透传到 generate 闭包（scheduler 不吞字段）。
    #[tokio::test]
    async fn on_progress_closure_is_passed_to_generate() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        let mut t = task("prog", Priority::Visible, 1, 10);
        let phase_log: Arc<std::sync::Mutex<Vec<u8>>> = Arc::default();
        let log_cb = phase_log.clone();
        t.job.on_progress = Some(Arc::new(move |_p: GenPhase, _el: u64| {
            log_cb.lock().unwrap().push(1);
        }));
        let r = handle.submit(t);
        let (job, reply) = recv_job(&mut rx).await;
        // generate 闭包内触发 on_progress（模拟 scheduler 真实调用）
        if let Some(cb) = &job.on_progress {
            cb(GenPhase::Decoding, 0);
        }
        assert_eq!(phase_log.lock().unwrap().len(), 1);
        let _ = reply.send(Ok(ok_thumb()));
        assert!(matches!(r.await.unwrap(), Outcome::Cached(_)));
    }

    async fn assert_no_job(rx: &mut JobRx) {
        let r = tokio::time::timeout(Duration::from_millis(60), rx.recv()).await;
        assert!(r.is_err(), "expected no job to start, but got one");
    }

    #[tokio::test]
    async fn priority_order_visible_ahead_behind_idle() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        // 先用一个 holder 占住唯一 worker，确保 4 个任务先全部入队再调度
        let _holder_r = handle.submit(task("holder", Priority::Visible, 1, 10));
        let (_hjob, hreply) = recv_job(&mut rx).await;
        // 提交顺序故意乱：idle, behind, ahead, visible
        let r_idle = handle.submit(task("idle", Priority::Idle, 1, 10));
        let r_behind = handle.submit(task("behind", Priority::Behind, 1, 10));
        let r_ahead = handle.submit(task("ahead", Priority::Ahead, 1, 10));
        let r_visible = handle.submit(task("visible", Priority::Visible, 1, 10));
        // 释放 worker -> 按优先级跑
        let _ = hreply.send(Ok(ok_thumb()));

        let mut order = Vec::new();
        for _ in 0..4 {
            let (job, reply) = recv_job(&mut rx).await;
            order.push(job.cache_path.to_string_lossy().to_string());
            let _ = reply.send(Ok(ok_thumb()));
        }
        assert_eq!(
            order,
            vec![
                "/tmp/visible.webp".to_string(),
                "/tmp/ahead.webp".to_string(),
                "/tmp/behind.webp".to_string(),
                "/tmp/idle.webp".to_string(),
            ]
        );
        for r in [r_visible, r_ahead, r_behind, r_idle] {
            assert!(matches!(r.await.unwrap(), Outcome::Cached(_)));
        }
    }

    #[tokio::test]
    async fn same_priority_fifo() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        let rs: Vec<_> = ["a", "b", "c"]
            .into_iter()
            .map(|k| handle.submit(task(k, Priority::Visible, 1, 10)))
            .collect();
        let mut order = Vec::new();
        for _ in 0..3 {
            let (job, reply) = recv_job(&mut rx).await;
            order.push(job.cache_path.to_string_lossy().to_string());
            let _ = reply.send(Ok(ok_thumb()));
        }
        assert_eq!(order, vec!["/tmp/a.webp", "/tmp/b.webp", "/tmp/c.webp"]);
        for r in rs {
            assert!(matches!(r.await.unwrap(), Outcome::Cached(_)));
        }
    }

    #[tokio::test]
    async fn dedup_same_cache_key_runs_once_multi_subscribers() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 2,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        let r1 = handle.submit(task("k", Priority::Visible, 1, 10));
        // 第一个 job 启动（持有不回），保持 in-flight
        let (_job1, reply1) = recv_job(&mut rx).await;
        // 第二个相同 key 提交 -> 订阅，不应启动新 job
        let r2 = handle.submit(task("k", Priority::Visible, 1, 10));
        assert_no_job(&mut rx).await;
        // 完成第一个 -> 两个订阅者都收 Cached
        let _ = reply1.send(Ok(ok_thumb()));
        let o1 = r1.await.unwrap();
        let o2 = r2.await.unwrap();
        assert!(matches!(o1, Outcome::Cached(_)));
        assert!(matches!(o2, Outcome::Cached(_)));
    }

    #[tokio::test]
    async fn new_epoch_cancels_unstarted_stale() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        // 占住唯一 worker
        let _holder = handle.submit(task("holder", Priority::Visible, 1, 10));
        let (_hjob, hreply) = recv_job(&mut rx).await;
        // 旧 epoch 任务排队（未开始）
        let r_old = handle.submit(task("old", Priority::Ahead, 1, 10));
        assert_no_job(&mut rx).await;
        // 新 epoch -> 旧任务 stale
        handle.new_epoch(2);
        assert!(matches!(r_old.await.unwrap(), Outcome::Stale));
        // 旧任务不应被启动
        assert_no_job(&mut rx).await;
        let _ = hreply.send(Ok(ok_thumb()));
    }

    #[tokio::test]
    async fn started_task_completes_but_old_epoch_no_cached() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 2,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        // epoch 1 任务启动（已开始）
        let r_old = handle.submit(task("old", Priority::Visible, 1, 10));
        let (_job, reply) = recv_job(&mut rx).await;
        // 新 epoch 到达（任务已在跑，不中断）
        handle.new_epoch(2);
        // 完成生成（缓存已写）-> 旧 epoch 订阅者收 Stale（非 Cached）
        let _ = reply.send(Ok(ok_thumb()));
        let o = r_old.await.unwrap();
        assert!(matches!(o, Outcome::Stale), "old epoch should get Stale, got {o:?}");
    }

    #[tokio::test]
    async fn worker_cap_two_concurrent() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 2,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        let _r1 = handle.submit(task("a", Priority::Visible, 1, 10));
        let _r2 = handle.submit(task("b", Priority::Visible, 1, 10));
        let _r3 = handle.submit(task("c", Priority::Visible, 1, 10));
        // 只有 2 个 job 启动
        let (j1, reply1) = recv_job(&mut rx).await;
        let (_j2, reply2) = recv_job(&mut rx).await;
        assert_no_job(&mut rx).await; // 第 3 个不启动
        // 完成一个 -> 第 3 个启动
        let _ = reply1.send(Ok(ok_thumb()));
        let (_j3, _reply3) = recv_job(&mut rx).await;
        let _ = reply2.send(Ok(ok_thumb()));
        let _ = j1;
    }

    #[tokio::test]
    async fn memory_budget_prevents_two_100mb_under_128() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 2,
            memory_budget_mb: 128,
            starvation_threshold: Duration::from_secs(60),
        });
        let _r1 = handle.submit(task("a", Priority::Visible, 1, 100));
        let _r2 = handle.submit(task("b", Priority::Visible, 1, 100));
        let (_ja, reply_a) = recv_job(&mut rx).await;
        // 第二个 100MB 不应与第一个并行
        assert_no_job(&mut rx).await;
        // 完成第一个 -> 第二个启动
        let _ = reply_a.send(Ok(ok_thumb()));
        let (_jb, reply_b) = recv_job(&mut rx).await;
        let _ = reply_b.send(Ok(ok_thumb()));
    }

    #[tokio::test]
    async fn oversized_task_runs_exclusively() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 2,
            memory_budget_mb: 128,
            starvation_threshold: Duration::from_secs(60),
        });
        // 180MB 超过 128 预算，但 running==0 允许独占
        let r = handle.submit(task("big", Priority::Visible, 1, 180));
        let (_job, reply) = recv_job(&mut rx).await;
        let _ = reply.send(Ok(ok_thumb()));
        assert!(matches!(r.await.unwrap(), Outcome::Cached(_)));
    }

    #[tokio::test]
    async fn dedup_pending_promotes_idle_to_visible_during_fast_scroll() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        let _holder = handle.submit(task("holder", Priority::Visible, 1, 10));
        let (_holder_job, holder_reply) = recv_job(&mut rx).await;
        handle.set_fast_scrolling(true);

        let idle = handle.submit(task("same", Priority::Idle, 1, 10));
        let visible = handle.submit(task("same", Priority::Visible, 1, 10));
        let _ = holder_reply.send(Ok(ok_thumb()));

        let (job, reply) = recv_job(&mut rx).await;
        assert_eq!(job.cache_path.to_string_lossy(), "/tmp/same.webp");
        let _ = reply.send(Ok(ok_thumb()));
        assert!(matches!(idle.await.unwrap(), Outcome::Cached(_)));
        assert!(matches!(visible.await.unwrap(), Outcome::Cached(_)));
    }
    #[tokio::test]
    async fn dedup_pending_does_not_demote_visible_to_idle() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        let _holder = handle.submit(task("holder", Priority::Visible, 1, 10));
        let (_holder_job, holder_reply) = recv_job(&mut rx).await;
        handle.set_fast_scrolling(true);

        let visible = handle.submit(task("same", Priority::Visible, 1, 10));
        // 低优先级重提交不得把高优先级 pending 降级回去，
        // 否则快速滚动下完全复现 Idle 卡死 bug。
        let idle = handle.submit(task("same", Priority::Idle, 1, 10));
        let _ = holder_reply.send(Ok(ok_thumb()));

        let (job, reply) = recv_job(&mut rx).await;
        assert_eq!(job.cache_path.to_string_lossy(), "/tmp/same.webp");
        let _ = reply.send(Ok(ok_thumb()));
        assert!(matches!(visible.await.unwrap(), Outcome::Cached(_)));
        assert!(matches!(idle.await.unwrap(), Outcome::Cached(_)));
    }

    #[tokio::test]
    async fn fast_scrolling_blocks_idle() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 2,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        handle.set_fast_scrolling(true);
        let _r_idle = handle.submit(task("idle", Priority::Idle, 1, 10));
        let _r_vis = handle.submit(task("vis", Priority::Visible, 1, 10));
        // visible 启动，idle 不启动
        let (jv, reply_v) = recv_job(&mut rx).await;
        assert_eq!(jv.cache_path.to_string_lossy(), "/tmp/vis.webp");
        assert_no_job(&mut rx).await;
        // 关闭快速滚动 + 完成可见 -> idle 启动
        handle.set_fast_scrolling(false);
        let _ = reply_v.send(Ok(ok_thumb()));
        let (ji, _reply_i) = recv_job(&mut rx).await;
        assert_eq!(ji.cache_path.to_string_lossy(), "/tmp/idle.webp");
    }

    /// P2-2: cancel_all 使排队任务立即 Stale，in-flight 任务完成后 Stale（不写索引）。
    #[tokio::test]
    async fn cancel_all_makes_pending_and_inflight_stale() {
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 1,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_secs(60),
        });
        // holder 占住唯一 worker（held 不完成）
        let r_holder = handle.submit(task("h", Priority::Visible, 1, 10));
        let (_j, reply) = recv_job(&mut rx).await;
        // queued 任务（worker 满，未开始）
        let r_q = handle.submit(task("q", Priority::Visible, 1, 10));
        assert_no_job(&mut rx).await;
        // cancel_all：queued 立即 Stale
        handle.cancel_all();
        assert!(matches!(r_q.await.unwrap(), Outcome::Stale));
        // holder 完成后也 Stale（epoch 已 bump，不再发 Cached）
        let _ = reply.send(Ok(ok_thumb()));
        assert!(matches!(r_holder.await.unwrap(), Outcome::Stale));
    }

    #[tokio::test(start_paused = true)]
    async fn starvation_boosts_waiting_ahead() {
        // worker=2：两个 visible 占满 worker（持有），ahead 与 v3 排队。
        // 推进时间超过老化阈值后，释放一个 worker，应先跑 ahead（老化优先）而非 v3。
        let (handle, mut rx) = setup(SchedulerConfig {
            worker_limit: 2,
            memory_budget_mb: 1024,
            starvation_threshold: Duration::from_millis(100),
        });
        let _ = handle.submit(task("v1", Priority::Visible, 1, 10));
        let _ = handle.submit(task("v2", Priority::Visible, 1, 10));
        let (_jv1, reply_v1) = recv_job(&mut rx).await;
        let (_jv2, reply_v2) = recv_job(&mut rx).await;
        // ahead 先于 v3 排队，但 visible 优先级更高
        let _r_ahead = handle.submit(task("ahead", Priority::Ahead, 1, 10));
        let _r_v3 = handle.submit(task("v3", Priority::Visible, 1, 10));
        // 让 actor 先把 ahead/v3 入队（记录 enqueued_at = T0），再推进时间
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;
        // 推进时间超过老化阈值，使 ahead / v3 都老化（ahead 更旧，优先）
        tokio::time::advance(Duration::from_millis(150)).await;
        handle.pump();
        // 释放一个 worker -> 应启动 ahead（老化优先）而非 v3
        let _ = reply_v1.send(Ok(ok_thumb()));
        let (next, _next_reply) = recv_job(&mut rx).await;
        assert_eq!(
            next.cache_path.to_string_lossy(),
            "/tmp/ahead.webp",
            "starved ahead should run before v3"
        );
        let _ = reply_v2.send(Ok(ok_thumb()));
    }
}
