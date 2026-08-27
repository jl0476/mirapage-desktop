//! 全局远程读取两阶段闸门（spec 2026-08-26 §5）。
//! 阶段① enter/enter_conn_only：并发 permit（发请求前拿）；
//! 阶段② reserve_bytes：字节 permit（响应头后按 Content-Length ×2 记账拿）。
//! 两类 permit 全 RAII，错误/超时/panic 路径天然释放。

use crate::source::trait_def::MediaSourceError;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

pub const REMOTE_GATE_CONCURRENCY: usize = 8;
pub const REMOTE_GATE_BYTES: usize = 512 * 1024 * 1024;
pub const REMOTE_GATE_ACCOUNT_MULTIPLIER: usize = 2;
pub const GATE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);

const GATE_BUSY: &str = "远程读取闸门繁忙";

pub struct RemoteGate {
    permits: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    acquire_timeout: Duration,
}

/// 阶段① permit（含后续 reserve_bytes 所需的预算句柄与超时配置）。
pub struct RemotePermit {
    bytes: Arc<Semaphore>,
    acquire_timeout: Duration,
    _conn: OwnedSemaphorePermit,
}

/// stat/HEAD 专用：仅并发 permit，无字节 reservation（无 body）。
pub struct ConnOnlyPermit {
    _conn: OwnedSemaphorePermit,
}

/// 阶段② permit：字节预算记账（载荷 × REMOTE_GATE_ACCOUNT_MULTIPLIER）。
pub struct ByteReservation {
    _bytes: OwnedSemaphorePermit,
}

impl RemoteGate {
    pub fn new(concurrency: usize, bytes: usize, acquire_timeout: Duration) -> Self {
        Self {
            permits: Arc::new(Semaphore::new(concurrency)),
            bytes: Arc::new(Semaphore::new(bytes)),
            acquire_timeout,
        }
    }

    /// 全局共享单例（factory 用；测试一律用 new 注入，不触碰本单例——防并行串扰）。
    pub fn global_arc() -> Arc<Self> {
        static GLOBAL: std::sync::OnceLock<Arc<RemoteGate>> = std::sync::OnceLock::new();
        GLOBAL
            .get_or_init(|| {
                Arc::new(Self::new(
                    REMOTE_GATE_CONCURRENCY,
                    REMOTE_GATE_BYTES,
                    GATE_ACQUIRE_TIMEOUT,
                ))
            })
            .clone()
    }

    /// 阶段①（默认 acquire 超时）。
    pub async fn enter(&self) -> Result<RemotePermit, MediaSourceError> {
        self.enter_timeout(self.acquire_timeout).await
    }

    pub async fn enter_timeout(&self, d: Duration) -> Result<RemotePermit, MediaSourceError> {
        let conn = tokio::time::timeout(d, Arc::clone(&self.permits).acquire_owned())
            .await
            .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?
            .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?;
        Ok(RemotePermit {
            bytes: Arc::clone(&self.bytes),
            acquire_timeout: self.acquire_timeout,
            _conn: conn,
        })
    }

    /// stat/HEAD 专用阶段①（无字节）。
    pub async fn enter_conn_only(&self) -> Result<ConnOnlyPermit, MediaSourceError> {
        let conn = tokio::time::timeout(
            self.acquire_timeout,
            Arc::clone(&self.permits).acquire_owned(),
        )
        .await
        .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?
        .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（并发）")))?;
        Ok(ConnOnlyPermit { _conn: conn })
    }
}

impl RemotePermit {
    /// 阶段②：accounted 是**记账值**（载荷 ×2，调用方算好传入）。
    pub async fn reserve_bytes(&self, accounted: u32) -> Result<ByteReservation, MediaSourceError> {
        let bytes = tokio::time::timeout(
            self.acquire_timeout,
            Arc::clone(&self.bytes).acquire_many_owned(accounted),
        )
        .await
        .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（字节预算）")))?
        .map_err(|_| MediaSourceError::Network(format!("{GATE_BUSY}（字节预算）")))?;
        Ok(ByteReservation { _bytes: bytes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn concurrency_limit_blocks_and_releases() {
        let g = RemoteGate::new(1, 1 << 30, Duration::from_millis(50));
        let p1 = g.enter().await.unwrap();
        assert!(g.enter().await.is_err(), "第 2 个 permit 应闸忙");
        drop(p1);
        assert!(g.enter().await.is_ok(), "drop 后应可再入");
    }

    #[tokio::test]
    async fn byte_budget_blocks_and_releases() {
        let g = RemoteGate::new(2, 100, Duration::from_millis(50));
        let p1 = g.enter().await.unwrap();
        let p2 = g.enter().await.unwrap();
        let r1 = p1.reserve_bytes(80).await.unwrap();
        assert!(p2.reserve_bytes(50).await.is_err(), "80+50 > 100 应闸忙");
        drop(r1);
        assert!(p2.reserve_bytes(50).await.is_ok(), "归还后应可再入");
    }

    #[tokio::test]
    async fn conn_only_uses_same_permits() {
        let g = RemoteGate::new(1, 1 << 30, Duration::from_millis(50));
        let p = g.enter().await.unwrap();
        assert!(g.enter_conn_only().await.is_err(), "conn_only 与 enter 共用并发池");
        drop(p);
        assert!(g.enter_conn_only().await.is_ok());
    }
}
