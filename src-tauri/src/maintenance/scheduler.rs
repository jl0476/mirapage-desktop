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

/// 节流纯决策（无 IO，可单测）。同类任务最小间隔——**始终**适用，110% 也不例外
/// （spec §5.4「最多每 60 秒运行一次」）。110% 仅决定「是否跳过防抖立即触发」，
/// 见 `MaintenanceHandle::notify_dirty`；是否真跑仍受本节流约束。
///
/// - `elapsed`：距上次执行的耗时（None 表示从未执行）
/// - `min_interval`：同类最小间隔
pub fn should_run_after_debounce(elapsed: Option<Duration>, min_interval: Duration) -> bool {
    match elapsed {
        None => true,
        Some(e) => e >= min_interval,
    }
}

/// 执行体抽象（生产 = spawn_blocking 跑 DB；测试 = Mock 计数）。
pub trait MaintenanceExecutor: Send + Sync {
    /// 执行一次维护（历史清理 + 缩略图淘汰等）。返回 BoxFuture<'static>。
    fn execute(&self) -> BoxFut;
    /// 历史条数是否已超上限 110%（spec §5.4：超阈时跳过防抖**立即**触发，但仍守 60s 节流）。
    fn is_over_limit_110(&self) -> bool;
}

/// 定时器启动器（生产 tauri::async_runtime::spawn / 测试 tokio::spawn）。
pub type TimerSpawner = Arc<dyn Fn(BoxFut) + Send + Sync>;

/// 110% 判定器（注入：生产走 DB COUNT，测试走 mock 开关）。
pub type OverLimitChecker = Arc<dyn Fn() -> bool + Send + Sync>;

/// actor 消息。
enum Msg {
    /// 防抖到期 / 110% 立即触发（携带发起时的 generation）。
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
    is_over: OverLimitChecker,
}

impl MaintenanceHandle {
    /// 标记 history dirty。
    ///
    /// spec §5.4：若已超上限 110%，**跳过防抖立即**投递 fire（仍受 actor 端 60s 节流约束）；
    /// 否则起一个 debounce timer（窗口内多次调用只有最新 gen 的 timer 被 actor 认可）。
    pub fn notify_dirty(&self) {
        let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        let tx = self.tx.clone();
        if (self.is_over)() {
            // 110%：立即触发（绕防抖），节流由 actor 端 should_run_after_debounce 守
            let _ = tx.send(Msg::DebounceFired(gen));
            return;
        }
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
/// `is_over`：110% 判定器；生产走 DB COUNT，测试走 mock。
pub fn build<E: MaintenanceExecutor>(
    timing: MaintenanceTiming,
    executor: Arc<E>,
    spawn_timer: TimerSpawner,
    is_over: OverLimitChecker,
) -> (MaintenanceHandle, MaintenanceActor<E>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let gen = Arc::new(AtomicU64::new(0));
    let handle = MaintenanceHandle {
        tx,
        gen: gen.clone(),
        timing,
        spawn_timer,
        is_over,
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
                    // 110% 的「立即」已在 notify_dirty 投递时体现（绕防抖）；
                    // 此处只守 60s 同类节流——110% 也不例外（spec §5.4）。
                    let elapsed = self.last_run.map(|t| t.elapsed());
                    if should_run_after_debounce(elapsed, self.timing.min_interval) {
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

    fn checker(over: Arc<std::sync::atomic::AtomicBool>) -> OverLimitChecker {
        Arc::new(move || over.load(Ordering::SeqCst))
    }

    // —— 纯决策 ——

    #[test]
    fn should_run_when_never_run() {
        assert!(should_run_after_debounce(None, Duration::from_secs(60)));
    }

    #[test]
    fn should_skip_within_min_interval() {
        let min = Duration::from_secs(60);
        assert!(!should_run_after_debounce(Some(Duration::from_secs(10)), min));
    }

    #[test]
    fn should_run_after_min_interval() {
        let min = Duration::from_secs(60);
        assert!(should_run_after_debounce(Some(Duration::from_secs(61)), min));
        assert!(should_run_after_debounce(Some(min), min));
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
        let (handle, actor) = build(MaintenanceTiming::TEST, exec, mock_spawn(), checker(over.clone()));
        let _task = tokio::spawn(actor.run());

        for _ in 0..5 {
            handle.notify_dirty();
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "5 次防抖应合并为 1 次执行");
    }

    #[tokio::test]
    async fn throttle_skips_second_run_within_min_interval() {
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
        let (handle, actor) = build(timing, exec, mock_spawn(), checker(over.clone()));
        let _task = tokio::spawn(actor.run());

        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "首次执行");

        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "min_interval 内应节流跳过");

        tokio::time::sleep(Duration::from_millis(150)).await;
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "min_interval 后应恢复执行");
    }

    #[tokio::test]
    async fn over_110_schedules_immediately_but_still_throttled() {
        // spec §5.4：110% 跳过防抖**立即**触发，但仍守 60s 节流。
        // debounce=30ms / min_interval=200ms。
        let timing = MaintenanceTiming {
            debounce: Duration::from_millis(30),
            min_interval: Duration::from_millis(200),
        };
        let calls = Arc::new(AtomicU32::new(0));
        let over = Arc::new(std::sync::atomic::AtomicBool::new(true)); // 一直超 110%
        let exec = Arc::new(MockExec {
            calls: calls.clone(),
            over: over.clone(),
        });
        let (handle, actor) = build(timing, exec, mock_spawn(), checker(over.clone()));
        let _task = tokio::spawn(actor.run());

        // 110%：立即触发（不等 30ms 防抖）。sleep 极短即可观察到执行。
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(5)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "110% 应立即执行（绕防抖）");

        // 紧接着再 dirty：仍立即投递，但 min_interval(200ms) 内 → 节流跳过
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "110% 也受 60s 节流约束");

        // 等 min_interval 过后再 dirty：恢复执行
        tokio::time::sleep(Duration::from_millis(200)).await;
        handle.notify_dirty();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "节流窗口过后应执行");
    }

    #[tokio::test]
    async fn run_now_bypasses_debounce_and_throttle() {
        let calls = Arc::new(AtomicU32::new(0));
        let over = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let exec = Arc::new(MockExec {
            calls: calls.clone(),
            over: over.clone(),
        });
        let (handle, actor) = build(MaintenanceTiming::TEST, exec, mock_spawn(), checker(over.clone()));
        let _task = tokio::spawn(actor.run());

        handle.run_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        handle.run_now().await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "run_now 绕过节流");
    }
}
