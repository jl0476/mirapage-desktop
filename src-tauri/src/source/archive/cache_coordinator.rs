//! `ArchiveCacheCoordinator`（任务 7）：catalog LRU、后续 block LRU、Materializer
//! ready cache hit 与物理下载共用的**单一原子准入闸** + 清空代次（generation）。
//!
//! - `admit()` 在同一短临界区内检查 `clearing` 并递增 active 计数，返回同步 Drop 的
//!   [`AdmissionGuard`]——所有 cache 查询与加载**必须先 admission 再查 cache**，禁止
//!   两个串行 gate 与 async Drop。
//! - `begin_clear()` 原子置 `clearing`、推进单调 generation 并返回同步 Drop 的
//!   [`ClearGuard`]（Drop 复位 gate，覆盖 return/panic 路径）；`wait_drained(timeout)`
//!   是独立 async 方法，等 active admission 排空。
//! - loader 在提交（写 cache）前用 guard 携带的 generation 与 `generation()` 复核，
//!   清空期间完成的加载不得复活已清数据。

use crate::source::archive::backend::ArchiveAccessError;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

#[derive(Default)]
struct CoordinatorState {
    clearing: bool,
    generation: u64,
    active: usize,
}

pub struct ArchiveCacheCoordinator {
    state: Mutex<CoordinatorState>,
    drained: Notify,
}

impl Default for ArchiveCacheCoordinator {
    fn default() -> Self {
        Self { state: Mutex::new(CoordinatorState::default()), drained: Notify::new() }
    }
}

impl ArchiveCacheCoordinator {
    /// 便捷共享构造（admit/begin_clear 需要 `&Arc<Self>` 接收者）。
    pub fn new_shared() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 当前单调代次（每次 begin_clear 递增）。
    pub fn generation(&self) -> u64 {
        self.state.lock().unwrap().generation
    }

    /// 准入：clearing 期间返回 `Cancelled`；否则在同一临界区内递增 active 并返回
    /// 同步 Drop 的 guard（Drop 递减计数并 notify，唤醒 wait_drained）。
    pub fn admit(self: &Arc<Self>) -> Result<AdmissionGuard, ArchiveAccessError> {
        let generation = {
            let mut state = self.state.lock().unwrap();
            if state.clearing {
                return Err(ArchiveAccessError::Cancelled);
            }
            state.active += 1;
            state.generation
        };
        Ok(AdmissionGuard { coordinator: Some(Arc::clone(self)), generation })
    }

    /// 原子开闸清空：置 clearing、推进 generation。返回的 [`ClearGuard`] Drop 时同步
    /// 复位 gate（不实现 async Drop）；物理清理只能在 guard 存活且 `wait_drained`
    /// 返回 true 后执行。
    pub fn begin_clear(self: &Arc<Self>) -> ClearGuard {
        let generation = {
            let mut state = self.state.lock().unwrap();
            state.clearing = true;
            state.generation += 1;
            state.generation
        };
        ClearGuard { coordinator: Arc::clone(self), generation }
    }

    /// 等 active admission 排空（带超时）。返回 false = 超时仍有在途准入。
    pub async fn wait_drained(&self, timeout: std::time::Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // 先注册唤醒兴趣再检查计数：与 AdmissionGuard Drop 的
            // "递减 → notify_waiters" 顺序配合，不丢唤醒。
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.lock().unwrap().active == 0 {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return false;
            }
        }
    }

    fn release_admission(&self) {
        self.state.lock().unwrap().active -= 1;
        self.drained.notify_waiters();
    }

    fn end_clear(&self) {
        self.state.lock().unwrap().clearing = false;
    }
}

/// 一次准入的 RAII 记账：Drop 同步递减 active 并 notify。
pub struct AdmissionGuard {
    coordinator: Option<Arc<ArchiveCacheCoordinator>>,
    generation: u64,
}

impl AdmissionGuard {
    /// 准入时刻的代次——loader 写 cache 前与 `coordinator.generation()` 复核。
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for AdmissionGuard {
    fn drop(&mut self) {
        if let Some(coordinator) = self.coordinator.take() {
            coordinator.release_admission();
        }
    }
}

/// 清空闸的 RAII guard：存活期间拒绝新准入；Drop 同步复位 gate。
pub struct ClearGuard {
    coordinator: Arc<ArchiveCacheCoordinator>,
    generation: u64,
}

impl ClearGuard {
    /// 本次清空的代次（传给 `clear_runtime_caches_while_gated`）。
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl Drop for ClearGuard {
    fn drop(&mut self) {
        self.coordinator.end_clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::archive::backend::ArchiveAccessError;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn admit_is_rejected_while_clearing_and_drains_on_drop() {
        let coordinator = ArchiveCacheCoordinator::new_shared();
        let clear_guard = coordinator.begin_clear();
        assert!(matches!(
            coordinator.admit(),
            Err(ArchiveAccessError::Cancelled)
        ));
        drop(clear_guard);
        let admission = coordinator.admit().unwrap();
        drop(admission);
        assert!(coordinator.wait_drained(Duration::from_millis(500)).await);
    }

    #[tokio::test]
    async fn wait_drained_times_out_while_admission_held_then_recovers() {
        let coordinator = ArchiveCacheCoordinator::new_shared();
        let admission = coordinator.admit().unwrap();
        assert!(!coordinator.wait_drained(Duration::from_millis(50)).await);
        drop(admission);
        assert!(coordinator.wait_drained(Duration::from_millis(500)).await);
    }

    #[test]
    fn begin_clear_bumps_generation_and_drop_reopens_gate() {
        let coordinator = ArchiveCacheCoordinator::new_shared();
        let first = coordinator.begin_clear();
        assert_eq!(first.generation(), 1);
        drop(first);
        let second = coordinator.begin_clear();
        assert_eq!(second.generation(), 2);
        drop(second);
        assert!(coordinator.admit().is_ok());
    }
}
