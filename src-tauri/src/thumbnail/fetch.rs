//! 远程取源 actor（spec rev3 §3.5 / 计划 rev4/rev5）：
//! - 同步 request() 只 try_submit（非阻塞），actor 后台消费
//! - 并发上限（Arc<Semaphore>）+ 在途字节预算（按 file_size acquire_many_owned 预留、完成归还）
//! - epoch 双检查：取源前（取消的不 fetch）+ 取源后（取消的结果不进解码链）
//! - in-flight 按 cache_key 去重

use crate::source::descriptor::SourceDescriptor;
use crate::thumbnail::scheduler::{GenerationJob, QueuedTask};
use crate::thumbnail::{Priority, ThumbnailRequestItem};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

/// 分类时刻的完整快照（rev5）：取源完成后构造解码任务所需的**全部**上下文。
/// classify_remote() 一次性创建；actor 只透传，不回查索引/不重算参数——
/// 取源期间缓存清理、设置变化均不影响本任务（消除竞态）。
pub struct PreparedRemoteTask {
    pub cache_key: String,
    pub descriptor: SourceDescriptor,
    /// typed 序列化（cache_key 的 key 材料 + CompletionMeta.source_key 用）
    pub descriptor_json: String,
    pub source_rel_path: String,
    /// 字节预算预留依据（ThumbnailRequestItem.file_size）
    pub file_size: u64,
    pub epoch: u64,
    /// 分类时刻 quality 字符串（已进 cache_key，完成时索引行必须记录同一值）
    pub quality: String,
    pub item: ThumbnailRequestItem,
    /// 解码任务模板：分类时刻的策略快照（target_width/pixel_budget/quality/cache_path
    /// 全在 GenerationJob 内）。on_fetched 时填 source_bytes、source_path 置 None。
    pub task_template: QueuedTask,
}

pub struct RemoteFetchRequest {
    pub prepared: PreparedRemoteTask,
}

pub type FetchFn = Arc<
    dyn Fn(SourceDescriptor, String) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send>>
        + Send
        + Sync,
>;
/// rev5：回传完整快照 + bytes（不是裸 key）——service 在此上下文构造解码任务
pub type OnFetched = Arc<dyn Fn(PreparedRemoteTask, Vec<u8>) + Send + Sync>;
pub type OnFailed = Arc<dyn Fn(&PreparedRemoteTask, &str) + Send + Sync>;

pub struct FetchActorConfig {
    pub concurrency: usize,
    /// 在途 bytes 上限（单文件超预算直接失败，不死等）
    pub byte_budget: usize,
    pub fetch: FetchFn,
    /// 快照 + bytes → 组装 GenerationJob 提交 scheduler + emit
    pub on_fetched: OnFetched,
    /// 快照 + 错误 → emit failed（事件带 item.path 关联前端）
    pub on_failed: OnFailed,
}

/// 2026-08-28 bug⑤：ThumbnailService 加 Clone 传导（tx 句柄 + Arc，浅克隆共享 actor）。
#[derive(Clone)]
pub struct RemoteFetchActor {
    tx: tokio::sync::mpsc::UnboundedSender<RemoteFetchRequest>,
    epoch: Arc<AtomicU64>,
}

impl RemoteFetchActor {
    pub fn spawn(cfg: FetchActorConfig) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<RemoteFetchRequest>();
        let epoch = Arc::new(AtomicU64::new(0));
        let permits = Arc::new(Semaphore::new(cfg.concurrency));
        let budget = Arc::new(Semaphore::new(cfg.byte_budget));
        let inflight: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let budget_total = cfg.byte_budget as u64;
        // setup() 同步上下文构造：必须走 tauri::async_runtime（裸 tokio::spawn
        // 在无 reactor 时 panic「no reactor running」——2026-08-19 实机首发撞过；
        // 与 service.rs scheduler 的 spawn 同款，见其 482 行注释）
        tauri::async_runtime::spawn({
            let (epoch, permits, budget, inflight) =
                (epoch.clone(), permits.clone(), budget.clone(), inflight.clone());
            async move {
                while let Some(req) = rx.recv().await {
                    let prepared = req.prepared;
                    if epoch.load(Ordering::SeqCst) != prepared.epoch {
                        continue; // 入队即过期
                    }
                    {
                        let mut g = inflight.lock().await;
                        if g.contains(&prepared.cache_key) {
                            continue;
                        }
                        g.insert(prepared.cache_key.clone());
                    }
                    let (permits, budget, inflight, epoch) = (
                        permits.clone(),
                        budget.clone(),
                        inflight.clone(),
                        epoch.clone(),
                    );
                    let fetch = cfg.fetch.clone();
                    let on_fetched = cfg.on_fetched.clone();
                    let on_failed = cfg.on_failed.clone();
                    tokio::spawn(async move {
                        let want = prepared.file_size.max(1) as u32;
                        if prepared.file_size > budget_total {
                            // 单文件超预算：快速失败，不占预算也不死等
                            inflight.lock().await.remove(&prepared.cache_key);
                            on_failed(&prepared, "file exceeds remote fetch byte budget");
                            return;
                        }
                        // 并发 + 字节预算双闸（Arc clone 后 acquire_owned/many_owned）
                        let (p1, p2) = match tokio::join!(
                            Arc::clone(&permits).acquire_owned(),
                            Arc::clone(&budget).acquire_many_owned(want),
                        ) {
                            (Ok(a), Ok(b)) => (a, b),
                            _ => return, // semaphore closed
                        };
                        if epoch.load(Ordering::SeqCst) != prepared.epoch {
                            inflight.lock().await.remove(&prepared.cache_key);
                            return; // 未开始即取消：不 fetch
                        }
                        let res = (fetch)(prepared.descriptor.clone(), prepared.source_rel_path.clone()).await;
                        drop((p1, p2)); // 归还预算与并发
                        inflight.lock().await.remove(&prepared.cache_key);
                        match res {
                            Ok(bytes) => {
                                if epoch.load(Ordering::SeqCst) == prepared.epoch {
                                    // file_size 是目录枚举的可信元数据；此处只作实际响应的硬上限，
                                    // 不重记已归还的在途预算，避免到手 bytes 反向影响调度账本。
                                    if bytes.len() as u64 > budget_total {
                                        on_failed(&prepared, "response exceeds remote fetch byte budget");
                                    } else {
                                        on_fetched(prepared, bytes); // 取源后再查：取消的结果不进解码链（整快照回传）
                                    }
                                }
                            }
                            Err(e) => {
                                if epoch.load(Ordering::SeqCst) == prepared.epoch {
                                    on_failed(&prepared, &e);
                                }
                            }
                        }
                    });
                }
            }
        });
        Self { tx, epoch }
    }

    /// 同步入队（request() 内调用；send 失败=actor 已停，忽略）
    pub fn try_submit(&self, req: RemoteFetchRequest) {
        let _ = self.tx.send(req);
    }

    pub fn new_epoch(&self, e: u64) {
        self.epoch.store(e, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;

    fn req(key: &str, size: u64, epoch: u64) -> RemoteFetchRequest {
        let item = ThumbnailRequestItem {
            path: format!("{key}.jpg"),
            source_rel_path: format!("{key}.jpg"),
            file_size: size,
            modified_at: None,
            source_width: 100,
            source_height: 100,
            required_width: 64,
            priority: Priority::Visible,
        };
        RemoteFetchRequest {
            prepared: PreparedRemoteTask {
                cache_key: key.into(),
                descriptor: SourceDescriptor::WebDav {
                    account_id: 1,
                    base_url: "https://x".into(),
                    path: String::new(),
                },
                descriptor_json: String::new(),
                source_rel_path: format!("{key}.jpg"),
                file_size: size,
                epoch,
                quality: "high".into(),
                item,
                task_template: QueuedTask {
                    cache_key: key.into(),
                    source_key: String::new(),
                    priority: Priority::Visible,
                    epoch,
                    estimated_memory_mb: 1,
                    job: GenerationJob {
                        source_bytes: Vec::new(),
                        source_path: None,
                        target_width: 64,
                        pixel_budget: 1000,
                        clarity_floor_width: 64,
                        webp_quality: 80.0,
                        cache_path: PathBuf::from(format!("C:/cache/{key}.webp")),
                        on_progress: None,
                        abort: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    },
                },
            },
        }
    }

    /// 回归（2026-08-19 实机首发撞过）：setup() 同步上下文（无 tokio reactor）构造 actor
    /// 不得 panic——spawn 曾用裸 tokio::spawn，#[tokio::test] 全绿但 app 首启即炸。
    /// 生产 spawn 必须与 service.rs scheduler 同款走 tauri::async_runtime::spawn。
    #[test]
    fn actor_spawn_works_outside_tokio_context() {
        let _actor = RemoteFetchActor::spawn(FetchActorConfig {
            concurrency: 1,
            byte_budget: 1024,
            fetch: Arc::new(|_d: SourceDescriptor, _p: String| {
                Box::pin(async move { Ok(Vec::new()) })
            }),
            on_fetched: Arc::new(|_p: PreparedRemoteTask, _b: Vec<u8>| {}),
            on_failed: Arc::new(|_p: &PreparedRemoteTask, _e: &str| {}),
        });
    }

    /// 并发上限 + 未开始任务被 epoch 取消（不调 fetch） + 在途完成结果不进回调链
    #[tokio::test]
    async fn concurrency_limited_and_epoch_cancels_pending_and_drops_results() {
        let started = Arc::new(AtomicUsize::new(0)); // fetch 实际进入数
        let peak = Arc::new(AtomicUsize::new(0));
        let hold = Arc::new(tokio::sync::Notify::new()); // 受控 barrier：fetch 挂起等放行
        let (decode_tx, mut decode_rx) = tokio::sync::mpsc::unbounded_channel::<(String, Vec<u8>)>();

        let started_c = started.clone();
        let peak_c = peak.clone();
        let hold_c = hold.clone();
        let fetch: FetchFn = Arc::new(move |_d: SourceDescriptor, _p: String| {
            let (started_c, peak_c, hold_c) = (started_c.clone(), peak_c.clone(), hold_c.clone());
            Box::pin(async move {
                let now = started_c.fetch_add(1, Ordering::SeqCst) + 1;
                peak_c.fetch_max(now, Ordering::SeqCst);
                hold_c.notified().await; // 挂起直到测试放行
                started_c.fetch_sub(1, Ordering::SeqCst);
                Ok(vec![1u8, 2, 3])
            })
        });

        let actor = RemoteFetchActor::spawn(FetchActorConfig {
            concurrency: 2,
            byte_budget: 1_000_000,
            fetch,
            on_fetched: {
                let decode_tx = decode_tx.clone();
                Arc::new(move |p: PreparedRemoteTask, bytes: Vec<u8>| {
                    let _ = decode_tx.send((p.cache_key, bytes));
                })
            },
            on_failed: Arc::new(|_: &PreparedRemoteTask, _: &str| {}),
        });

        // 6 个任务全部 try_submit（同步、立即返回）——两个占满并发，4 个排队
        // （先对齐 epoch：生产路径 service.new_epoch 会同步转发到 actor，任务才不会被入队即弃）
        actor.new_epoch(1);
        for i in 0..6 {
            actor.try_submit(req(&format!("k{i}"), 10, 1));
        }

        // 等 2 个进入 fetch（在 barrier 挂起）
        for _ in 0..200 {
            if started.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(started.load(Ordering::SeqCst), 2, "并发上限 2 生效");
        assert_eq!(peak.load(Ordering::SeqCst), 2);

        // 切目录：epoch 1 → 2。随后放行 barrier——
        actor.new_epoch(2);
        hold.notify_waiters();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // 在途 2 个完成但结果被丢弃（epoch 已变）；排队 4 个永远不开始
        assert!(decode_rx.try_recv().is_err(), "在途完成结果不得进解码链");
        assert_eq!(started.load(Ordering::SeqCst), 0);
        // 再等一轮，确认剩余 4 个未 fetch
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(peak.load(Ordering::SeqCst), 2, "取消后排队任务不得启动 fetch");
    }

    /// 字节预算：单文件超预算直接失败；两个文件合计超预算则串行
    #[tokio::test]
    async fn byte_budget_reserves_and_rejects_oversize() {
        let started = Arc::new(AtomicUsize::new(0));
        let (fail_tx, mut fail_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let hold = Arc::new(tokio::sync::Notify::new());
        let started_c = started.clone();
        let hold_c = hold.clone();
        let fetch: FetchFn = Arc::new(move |_: SourceDescriptor, _: String| {
            let (started_c, hold_c) = (started_c.clone(), hold_c.clone());
            Box::pin(async move {
                started_c.fetch_add(1, Ordering::SeqCst);
                hold_c.notified().await;
                Ok(vec![0u8; 4])
            })
        });
        let actor = RemoteFetchActor::spawn(FetchActorConfig {
            concurrency: 8, // 并发放大，只考察字节预算
            byte_budget: 10, // 每文件 8 字节 → 同时最多 1 个
            fetch,
            on_fetched: Arc::new(|_: PreparedRemoteTask, _: Vec<u8>| {}),
            on_failed: {
                let fail_tx = fail_tx.clone();
                Arc::new(move |p: &PreparedRemoteTask, _: &str| {
                    let _ = fail_tx.send(p.cache_key.to_string());
                })
            },
        });
        actor.new_epoch(1);
        actor.try_submit(req("big", 100, 1)); // 超预算 → 直接失败回调
        actor.try_submit(req("a", 8, 1));
        actor.try_submit(req("b", 8, 1));
        for _ in 0..200 {
            if fail_rx.try_recv().is_ok() {
                break; // big 的失败到达
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        // a 占满 8/10 预算，b 必须等 a 完成才能开始
        for _ in 0..200 {
            if started.load(Ordering::SeqCst) >= 1 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(started.load(Ordering::SeqCst), 1, "字节预算内只允许 1 个在途");
        hold.notify_waiters(); // 放行 a → b 才能开始
        for _ in 0..200 {
            if started.load(Ordering::SeqCst) >= 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        hold.notify_waiters();
        assert_eq!(started.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn actual_response_over_budget_fails_before_decode() {
        let (fetched_tx, mut fetched_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let (failed_tx, mut failed_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let fetch: FetchFn = Arc::new(|_: SourceDescriptor, _: String| {
            Box::pin(async { Ok(vec![0u8; 11]) })
        });
        let actor = RemoteFetchActor::spawn(FetchActorConfig {
            concurrency: 1,
            byte_budget: 10,
            fetch,
            on_fetched: Arc::new(move |p: PreparedRemoteTask, _: Vec<u8>| {
                let _ = fetched_tx.send(p.cache_key);
            }),
            on_failed: Arc::new(move |p: &PreparedRemoteTask, _: &str| {
                let _ = failed_tx.send(p.cache_key.to_string());
            }),
        });
        actor.new_epoch(1);
        actor.try_submit(req("underreported", 1, 1));
        let failed = tokio::time::timeout(std::time::Duration::from_secs(1), failed_rx.recv())
            .await
            .expect("超预算响应必须失败")
            .expect("失败回调必须携带任务");
        assert_eq!(failed, "underreported");
        assert!(fetched_rx.try_recv().is_err(), "超预算 bytes 不得进入解码链");
    }
}
