//! 维护调度核心（spec §5）。
//!
//! 职责：把高频 `mark_history_dirty` 通知防抖合并为单次执行（默认 30s 静默窗口），
//! 同类任务节流（默认 60s 不重复），超上限 110% 时绕过节流立即放行。
//!
//! 设计（借鉴 `thumbnail::scheduler` 的 build/spawn 解耦）：
//! - `build()` 返回 `(MaintenanceHandle, MaintenanceActor)`，**不 spawn**；
//!   生产用 `tauri::async_runtime::spawn(actor.run())`，测试用 `tokio::spawn`。
//! - 防抖用 **generation-token**：每次 `notify_dirty` 自增共享 gen 并起一个 timer（捕获该 gen）；
//!   timer 到期发 `DebounceFired(gen)`。actor 只在 gen 仍是最新时才执行——更早的 stale fire
//!   被忽略。无需 abort handle / JoinHandle 类型统一，无 select! 借用冲突。
//! - 执行体走 `MaintenanceExecutor` trait：生产实现走 spawn_blocking 跑 DB，测试用 Mock。

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};

pub type BoxFut = Pin<Box<dyn Future<Output = ()> + Send>>;

/// 防抖 / 节流时序（可注入小值便于测试）。
#[derive(Debug, Clone, Copy)]
pub struct MaintenanceTiming {
    /// dirty 静默窗口：窗口内多次通知合并为一次执行（spec §5.3，默认 30s）。
    pub debounce: Duration,
    /// 同类任务最小间隔（spec §5.4，默认 60s）。
    pub min_interval: Duration,
}

impl MaintenanceTiming {
    pub const DEFAULT: Self = Self {
        debounce: Duration::from_secs(30),
        min_interval: Duration::from_secs(60),
    };
    /// 测试用：毫秒级，缩短用例耗时。
    pub const TEST: Self = Self {
        debounce: Duration::from_millis(30),
        min_interval: Duration::from_millis(80),
    };
}

/// 节流 / 110% 旁路的纯决策（无 IO，可单测）。
///
/// - `elapsed`：距上次执行的耗时（None 表示从未执行）
/// - `over_limit_110`：历史条数是否已超上限 110%（spec §5.4 允许立即调度）
/// - `min_interval`：同类最小间隔
pub fn should_run_after_debounce(
    elapsed: Option<Duration>,
    over_limit_110: bool,
    min_interval: Duration,
) -> bool {
    match elapsed {
        None => true,
        Some(e) => over_limit_110 || e >= min_interval,
    }
}

/// 执行体抽象（生产 = spawn_blocking 跑 DB；测试 = Mock 计数）。
pub trait MaintenanceExecutor: Send + Sync {
    /// 执行一次维护（历史清理 + 缩略图淘汰等）。返回 BoxFuture<'static>。
    fn execute(&self) -> BoxFut;
    /// 历史条数是否已超上限 110%（spec §5.4 旁路节流）。
    fn is_over_limit_110(&self) -> bool;
}

/// 定时器启动器（生产 tauri::async_runtime::spawn / 测试 tokio::spawn）。
pub type TimerSpawner = Arc<dyn Fn(BoxFut) + Send + Sync>;

/// actor 消息。
enum Msg {
    /// 防抖到期（携带发起时的 generation）。
    DebounceFired(u64),
    /// 立即执行（手动按钮，绕过防抖/节流）。
    RunNow(oneshot::Sender<()>),
}

/// 调用方持有，Send + Clone 友好（可跨 Tauri command 边界）。
pub struct MaintenanceHandle {
    tx: mpsc::UnboundedSender<Msg>,
    gen: Arc<AtomicU64>,
    timing: MaintenanceTiming,
    spawn_timer: TimerSpawner,
}

impl MaintenanceHandle {
    /// 标记 history dirty：自增 gen，起一个 debounce timer。
    /// 窗口内多次调用只有最后一次（最新 gen）的 timer 会被 actor 认可。
    pub fn notify_dirty(&self) {
        let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        let tx = self.tx.clone();
        let dur = self.timing.debounce;
        (self.spawn_timer)(Box::pin(async move {
            tokio::time::sleep(dur).await;
            let _ = tx.send(Msg::DebounceFired(gen));
        }));
    }

    /// 立即执行（手动）。等待完成。
    pub async fn run_now(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Msg::RunNow(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

/// actor（被 `run()` 驱动）。`build()` 构造，调用方负责 spawn。
pub struct MaintenanceActor<E: MaintenanceExecutor> {
    rx: mpsc::UnboundedReceiver<Msg>,
    gen: Arc<AtomicU64>,
    timing: MaintenanceTiming,
    executor: Arc<E>,
    last_run: Option<Instant>,
}

/// 构造 handle + actor（不 spawn）。
///
/// `spawn_timer`：生产传 `Arc::new(|f| { let _ = tauri::async_runtime::spawn(f); })`，
/// 测试传 `Arc::new(|f| { let _ = tokio::spawn(f); })`。
pub fn build<E: MaintenanceExecutor>(
    timing: MaintenanceTiming,
    executor: Arc<E>,
    spawn_timer: TimerSpawner,
) -> (MaintenanceHandle, MaintenanceActor<E>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let gen = Arc::new(AtomicU64::new(0));
    let handle = MaintenanceHandle {
        tx,
        gen: gen.clone(),
        timing,
        spawn_timer,
    };
    let actor = MaintenanceActor {
        rx,
        gen,
        timing,
        executor,
        last_run: None,
    };
    (handle, actor)
}

impl<E: MaintenanceExecutor> MaintenanceActor<E> {
    pub async fn run(mut self) {
        while let Some(msg) = self.rx.recv().await {
            match msg {
                Msg::DebounceFired(gen) => {
                    // stale fire：更新 gen 到来后，旧 timer 的 gen 已落后
                    if gen != self.gen.load(Ordering::SeqCst) {
                        continue;
                    }
                    let elapsed = self.last_run.map(|t| t.elapsed());
                    let over = self.executor.is_over_limit_110();
                    if should_run_after_debounce(elapsed, over, self.timing.min_interval) {
                        self.executor.execute().await;
                        self.last_run = Some(Instant::now());
                    }
                }
                Msg::RunNow(reply) => {
                    self.executor.execute().await;
                    self.last_run = Some(Instant::now());
                    let _ = reply.send(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU32;

    /// 计数执行的 mock executor。`over` 控制 is_over_limit_110。
    struct MockExec {
        calls: Arc<AtomicU32>,
        over: Arc<std::sync::atomic::AtomicBool>,
    }
    impl MaintenanceExecutor for MockExec {
        fn execute(&self) -> BoxFut {
            let c = self.calls.clone();
            Box::pin(async move {
                c.fetch_add(1, Ordering::SeqCst);
            })
        }
        fn is_over_limit_110(&self) -> bool {
            self.over.load(Ordering::SeqCst)
        }
    }

    fn mock_spawn() -> TimerSpawner {
        Arc::new(|f: BoxFut| {
            let _ = tokio::spawn(f);
        })
    }

    // —— 纯决策 ——

    #[test]
    fn should_run_when_never_run() {
        assert!(should_run_after_debounce(None, false, Duration::from_secs(60)));
    }

    #[test]
    fn should_skip_within_min_interval_unless_over_110() {
        let min = Duration::from_secs(60);
        assert!(!should_run_after_debounce(Some(Duration::from_secs(10)), false, min));
        // 超过 110% 旁路节流
        assert!(should_run_after_debounce(Some(Duration::from_secs(10)), true, min));
    }

    #[test]
    fn should_run_after_min_interval() {
        let min = Duration::from_secs(60);
        assert!(should_run_after_debounce(Some(Duration::from_secs(61)), false, min));
        assert!(should_run_after_debounce(Some(min), false, min));
    }

    // —— 时序：防抖合并 ——

    #[tokio::test]
    async fn debounce_coalesces_rapid_dirty_into_one_run() {
        let calls = Arc::new(AtomicU32::new(0));
        let over = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let exec = Arc::new(MockExec {
            calls: calls.clone(),
            over: over.clone(),
        });
        let (handle, actor) = build(MaintenanceTiming::TEST, exec, mock_spawn());
        let _task = tokio::spawn(actor.run());

        // 30s 窗口内连续 5 次 dirty（gen 1..5），只有最后一个 timer 的 gen 匹配
        for _ in 0..5 {
            handle.notify_dirty();
        }
        // 等 debounce + 执行
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "5 次防抖应合并为 1 次执行");
    }

    #[tokio::test]
    async fn throttle_skips_second_run_within_min_interval() {
        // 用足够余量避免计时抖动：debounce 30ms / min_interval 200ms
        let timing = MaintenanceTiming {
            debounce: Duration::from_millis(30),
            min_interval: Duration::from_millis(200),
        };
        let calls = Arc::new(AtomicU32::new(0));
        let over = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let exec = Arc::new(MockExec {
            calls: calls.clone(),
            over: over.clone(),
        });
        let (handle, actor) = build(timing, exec, mock_spawn());
        let _task = tokio::spawn(actor.run());

        // 第一次：fire 在 ~30ms → 执行
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "首次执行");

        // 第二次 dirty 紧随：fire 在 ~130ms，距上次执行 ~100ms < 200ms → 节流跳过
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "min_interval 内应节流跳过"
        );

        // 等 min_interval 过后再 dirty：恢复执行
        tokio::time::sleep(Duration::from_millis(150)).await; // 距上次执行已 ~250ms
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "min_interval 后应恢复执行"
        );
    }

    #[tokio::test]
    async fn over_110_bypasses_throttle() {
        let calls = Arc::new(AtomicU32::new(0));
        let over = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let exec = Arc::new(MockExec {
            calls: calls.clone(),
            over: over.clone(),
        });
        let (handle, actor) = build(MaintenanceTiming::TEST, exec, mock_spawn());
        let _task = tokio::spawn(actor.run());

        over.store(true, Ordering::SeqCst);
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "首次（110%）");

        // 110% + min_interval 内 → 仍放行（旁路节流）
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "110% 应旁路节流立即放行");
    }

    #[tokio::test]
    async fn run_now_bypasses_debounce_and_throttle() {
        let calls = Arc::new(AtomicU32::new(0));
        let over = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let exec = Arc::new(MockExec {
            calls: calls.clone(),
            over,
        });
        let (handle, actor) = build(MaintenanceTiming::TEST, exec, mock_spawn());
        let _task = tokio::spawn(actor.run());

        // run_now 立即执行，不等 debounce
        handle.run_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // 紧接着第二次 run_now（无视节流）
        handle.run_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "run_now 绕过节流");
    }
}
