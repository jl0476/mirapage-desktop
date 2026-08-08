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
use super::{Priority, ThumbnailError};

/// 默认老化阈值（等待超过此值的任务优先级提升）。
const DEFAULT_STARVATION_THRESHOLD: Duration = Duration::from_secs(5);

/// 生成函数：接收 job，阻塞执行，返回元数据或错误。生产实现读 source_bytes 调
/// `generator::generate_thumbnail`；测试用可控 channel fake。
pub type GenerateFn =
    Arc<dyn Fn(GenerationJob) -> Result<GeneratedThumbnail, ThumbnailError> + Send + Sync>;

/// 一次生成的全部输入（owned，便于跨 spawn_blocking 边界）。
#[derive(Debug, Clone)]
pub struct GenerationJob {
    pub source_bytes: Vec<u8>,
    pub target_width: u32,
    pub pixel_budget: u32,
    pub clarity_floor_width: u32,
    pub webp_quality: f32,
    pub cache_path: PathBuf,
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
pub struct SchedulerHandle {
    tx: mpsc::UnboundedSender<Command>,
}

impl SchedulerHandle {
    /// 启动调度器 actor，返回句柄。
    pub fn start(config: SchedulerConfig, generate: GenerateFn) -> Self {
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
            fast_scrolling: false,
            seq: 0,
        };
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
}

impl Drop for SchedulerHandle {
    fn drop(&mut self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

struct Actor {
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
    fast_scrolling: bool,
    seq: u64,
}

impl Actor {
    async fn run(mut self) {
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
            inf.subscribers.push(reply);
            return;
        }
        // pending 去重：同 cache_key 已排队 -> 订阅
        if let Some(p) = self.pending.iter_mut().find(|p| p.task.cache_key == task.cache_key) {
            p.subscribers.push(reply);
            return;
        }
        self.seq += 1;
        self.pending.push(Pending {
            task,
            subscribers: vec![reply],
            enqueued_at: Instant::now(),
            seq: self.seq,
        });
    }

    fn handle_new_epoch(&mut self, epoch: u64) {
        self.current_epoch = epoch;
        // 旧 epoch 未开始任务标 stale，移除并通知订阅者
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].task.epoch < epoch {
                let p = self.pending.remove(i);
                for s in p.subscribers {
                    let _ = s.send(Outcome::Stale);
                }
            } else {
                i += 1;
            }
        }
        // in-flight 保留（让其完成写缓存）；完成时按 epoch 决定是否发 Cached。
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

            self.inflight.insert(
                cache_key.clone(),
                InFlight { subscribers },
            );
            self.running_count += 1;
            self.running_memory += est_mb as u64;

            let tx = self.tx.clone();
            let gen = self.generate.clone();
            let ck = cache_key.clone();
            tokio::spawn(async move {
                let result = tokio::task::spawn_blocking(move || gen(job)).await;
                let result = match result {
                    Ok(Ok(g)) => Ok(g),
                    Ok(Err(e)) => Err(e),
                    Err(je) => Err(ThumbnailError::Invalid(format!("join error: {je}"))),
                };
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
            target_width: 512,
            pixel_budget: 3_000_000,
            clarity_floor_width: 0,
            webp_quality: 82.0,
            cache_path: PathBuf::from(format!("/tmp/{key}.webp")),
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
