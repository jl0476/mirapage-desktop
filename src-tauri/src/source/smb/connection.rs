//! SMB 连接管理器（spec §3）：accountId → transport 复用 + TTL 懒回收 + 连接级重连。
//!
//! 两阶段锁（spec §3 P1-1）：std::sync::MutexGuard 不得跨 await——
//! 阶段 1 锁内查/TTL 清理/命中直返（锁在 await 前释放），阶段 2 无锁建连，阶段 3 短锁写回。
//! 并发去重（P1 修订）：后到者复用先到者（多花一次建连握手，正确性无损）。

use super::transport::{ConnectParams, RawDirEntry, RawStat, SmbTransport, TransportError};
use crate::credentials::CredentialStore;
use crate::db::Db;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// transport 工厂：返回已 connect 的 transport（生产=真实 smb 接线；测试=mock 计数）。
pub type TransportFactory = Arc<
    dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Arc<dyn SmbTransport>> + Send>>
        + Send
        + Sync,
>;

struct ManagedTransport {
    transport: Arc<dyn SmbTransport>,
    last_used: Instant,
}

pub struct SmbConnectionManager {
    db: Db,
    creds: Arc<dyn CredentialStore>,
    factory: TransportFactory,
    ttl: Duration,
    slots: Mutex<HashMap<i64, ManagedTransport>>,
}

pub struct SmbAccountRow {
    pub host: String,
    pub port: i64,
    pub share: Option<String>,
    pub username: Option<String>,
    pub initial_path: String,
}

impl SmbConnectionManager {
    /// 生产构造：真实 transport 工厂 + 5 分钟 TTL（spec §3 常量）。
    pub fn new_production(db: Db, creds: Arc<dyn CredentialStore>) -> Self {
        Self::new(db, creds, real_factory(), Duration::from_secs(5 * 60))
    }

    pub fn new(
        db: Db,
        creds: Arc<dyn CredentialStore>,
        factory: TransportFactory,
        ttl: Duration,
    ) -> Self {
        Self {
            db,
            creds,
            factory,
            ttl,
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// 测试观察器：当前存活连接数（并发去重断言用）。
    #[cfg(test)]
    pub fn slot_count(&self) -> usize {
        self.slots.lock().unwrap().len()
    }

    /// 查 account 行 + keyring 密码 → ConnectParams。share NULL / 契约不符即错误。
    fn resolve_params(
        &self,
        account_id: i64,
        initial_path: &str,
    ) -> Result<ConnectParams, TransportError> {
        let (host, port, share, username) = {
            let conn = self.db.conn();
            conn.query_row(
                "SELECT host, port, share, username FROM account WHERE id = ?1 AND type = 'smb'",
                rusqlite::params![account_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .map_err(|_| {
                TransportError::FileNotFound(format!("smb account {account_id} 不存在"))
            })?
        };
        // 读侧归一（兼容存量脏行：share 曾以 `/Other1` 形态入库，UNC 拼接即
        // 畸形共享名 → Object Name Not Found）——与 upsert 写侧归一同语义
        let share = share.map(|s| s.trim_matches(['/', '\\']).to_string()).filter(|s| !s.is_empty());
        super::path::share_root_matches(initial_path, share.as_deref())
            .map_err(|e| TransportError::InvalidPath(e.to_string()))?;
        let port = port.unwrap_or(445);
        if !(1..=65535).contains(&port) {
            return Err(TransportError::InvalidPath(format!("端口越界: {port}")));
        }
        let password = self
            .creds
            .get_password(&crate::credentials::account_key("smb", account_id))
            .map_err(TransportError::Io)?;
        Ok(ConnectParams {
            host,
            port: port as i32,
            share: share.unwrap_or_default(),
            username,
            password,
            initial_path: initial_path.to_string(),
        })
    }

    /// **两阶段（P1 修复）**：std MutexGuard 不得跨 await（async_trait 要求 Send；
    /// 且连接慢时不能阻塞其他账户的缓存读取/回收）。
    /// 阶段 1 锁内查/回收 → 释放锁建连 → 阶段 2 短锁写回（并发去重：后到者复用先到者）。
    async fn get_or_connect(
        &self,
        account_id: i64,
        initial_path: &str,
    ) -> Result<Arc<dyn SmbTransport>, TransportError> {
        let params = self.resolve_params(account_id, initial_path)?;
        // 阶段 1：锁内——TTL 懒回收 + 命中直返（锁在 await 前释放）
        let existing = {
            let mut slots = self.slots.lock().unwrap();
            let now = Instant::now();
            slots.retain(|_, m| now.duration_since(m.last_used) < self.ttl);
            match slots.get_mut(&account_id) {
                Some(m) => {
                    m.last_used = now;
                    Some(m.transport.clone())
                }
                None => None,
            }
        }; // MutexGuard 在此 drop
        if let Some(t) = existing {
            return Ok(t);
        }
        // 阶段 2：无锁建连（慢连接不阻塞其他账户）
        let transport = (self.factory)().await;
        transport.connect(&params).await?;
        // 阶段 3：短锁写回。并发建连去重：竞态后到者发现自己已存在 → 丢弃新建实例
        // （多花一次建连握手，正确性无损——两实例行为等价），复用先到者。
        let mut slots = self.slots.lock().unwrap();
        if let Some(m) = slots.get_mut(&account_id) {
            m.last_used = Instant::now();
            return Ok(m.transport.clone());
        }
        slots.insert(
            account_id,
            ManagedTransport {
                transport: transport.clone(),
                last_used: Instant::now(),
            },
        );
        Ok(transport)
    }

    /// 连接级错误 → 剔除重建重试一次（spec §3）；文件级直接上抛。
    fn evict(&self, account_id: i64) {
        self.slots.lock().unwrap().remove(&account_id);
    }

    /// 对外摘槽（spec §7：source 层读超时后调用——transport 状态未知，下次重建）。
    pub fn invalidate(&self, account_id: i64) {
        self.evict(account_id);
    }

    // ─── 对 source 层的操作面 ───

    pub async fn list(
        &self,
        account_id: i64,
        initial_path: &str,
        rel: &str,
    ) -> Result<Vec<RawDirEntry>, TransportError> {
        match self
            .get_or_connect(account_id, initial_path)
            .await?
            .list(rel)
            .await
        {
            Ok(v) => Ok(v),
            Err(e) if e.is_connection_level() => {
                self.evict(account_id);
                self.get_or_connect(account_id, initial_path)
                    .await?
                    .list(rel)
                    .await
            }
            Err(e) => Err(e),
        }
    }

    pub async fn read_block_exact(
        &self,
        account_id: i64,
        initial_path: &str,
        rel: &str,
        offset: u64,
        buf: &mut [u8],
    ) -> Result<(), TransportError> {
        match self
            .get_or_connect(account_id, initial_path)
            .await?
            .read_block_exact(rel, offset, buf)
            .await
        {
            Ok(()) => Ok(()),
            Err(e) if e.is_connection_level() => {
                self.evict(account_id);
                self.get_or_connect(account_id, initial_path)
                    .await?
                    .read_block_exact(rel, offset, buf)
                    .await
            }
            Err(e) => Err(e),
        }
    }

    pub async fn stat(
        &self,
        account_id: i64,
        initial_path: &str,
        rel: &str,
    ) -> Result<RawStat, TransportError> {
        match self
            .get_or_connect(account_id, initial_path)
            .await?
            .stat(rel)
            .await
        {
            Ok(v) => Ok(v),
            Err(e) if e.is_connection_level() => {
                self.evict(account_id);
                self.get_or_connect(account_id, initial_path)
                    .await?
                    .stat(rel)
                    .await
            }
            Err(e) => Err(e),
        }
    }
}

/// 生产工厂（real_transport.rs 任务 6 实装；此处前置声明保持本任务可编译测试）。
fn real_factory() -> TransportFactory {
    Arc::new(|| {
        Box::pin(async {
            Arc::new(super::real_transport::SmbClientTransport::new()) as Arc<dyn SmbTransport>
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialStore, MemoryStore};
    use crate::source::smb::mock_transport::MockSmbTransport;
    use crate::source::smb::transport::{ConnectParams, RawDirEntry, RawStat, TransportError};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// 工厂产物登记器：计数建了多少个 transport 实例（断言 TTL 回收 / 重连重建）
    struct FactoryLog {
        created: Mutex<Vec<Arc<MockSmbTransport>>>,
    }

    fn manager_with_log(ttl: Duration) -> (SmbConnectionManager, Arc<FactoryLog>) {
        let db = crate::db::Db::open_in_memory().unwrap();
        let creds = Arc::new(MemoryStore::new());
        let log = Arc::new(FactoryLog {
            created: Mutex::new(vec![]),
        });
        let log2 = log.clone();
        let factory: TransportFactory = Arc::new(move || {
            let t = Arc::new(MockSmbTransport::new());
            log2.created.lock().unwrap().push(t.clone());
            Box::pin(async move { t as Arc<dyn SmbTransport> })
        });
        // 账户行：share=media，密码进 keyring
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password)
                 VALUES ('nas', 'smb', '192.168.1.1', 445, 'media', 'u', NULL)",
                [],
            )
            .unwrap();
        }
        creds.set_password("smb-1", "p").unwrap();
        let mgr = SmbConnectionManager::new(db, creds, factory, ttl);
        (mgr, log)
    }

    #[tokio::test]
    async fn same_account_reuses_transport_until_ttl() {
        // ttl 足够长：两次调用同一 transport（建 1 个实例）
        let (mgr, log) = manager_with_log(Duration::from_secs(300));
        mgr.list(1, "media", "comics").await.unwrap_err(); // 未脚本化 → FileNotFound，但 transport 已建
        mgr.list(1, "media", "comics").await.unwrap_err();
        assert_eq!(log.created.lock().unwrap().len(), 1, "TTL 内复用同一连接");
    }

    #[tokio::test]
    async fn ttl_expiry_recreates_transport() {
        // ttl 极短：第一次调用后 sleep 超时，第二次重建
        let (mgr, log) = manager_with_log(Duration::from_millis(10));
        mgr.stat(1, "media", "f").await.unwrap_err();
        tokio::time::sleep(Duration::from_millis(30)).await;
        mgr.stat(1, "media", "f").await.unwrap_err();
        assert_eq!(log.created.lock().unwrap().len(), 2, "TTL 过期后懒重建");
    }

    #[tokio::test]
    async fn connection_level_error_reconnects_once_and_succeeds() {
        let (mgr, log) = manager_with_log(Duration::from_secs(300));
        let r1 = mgr.list(1, "media", "comics").await;
        // 第一次：新建 transport，未脚本化 → FileNotFound（文件级，不重建）
        assert!(matches!(r1, Err(TransportError::FileNotFound(_))));
        assert_eq!(log.created.lock().unwrap().len(), 1);
        // 给当前实例注入一次性连接级错误：下一次调用应重建（实例+1）并成功执行
        let cur = log.created.lock().unwrap()[0].clone();
        cur.set_fail_once(TransportError::Disconnected);
        let r2 = mgr.list(1, "media", "comics").await;
        assert!(
            matches!(r2, Err(TransportError::FileNotFound(_))),
            "重连后到达文件层错误"
        );
        assert_eq!(
            log.created.lock().unwrap().len(),
            2,
            "连接级错误剔除重建"
        );
    }

    #[tokio::test]
    async fn file_level_error_does_not_reconnect() {
        let (mgr, log) = manager_with_log(Duration::from_secs(300));
        mgr.list(1, "media", "nope").await.unwrap_err(); // FileNotFound
        mgr.list(1, "media", "nope").await.unwrap_err();
        assert_eq!(log.created.lock().unwrap().len(), 1, "文件级错误不重建");
    }

    /// P1-2（rev3）：确定性并发测试——mock factory 用 Barrier 挂住建连，
    /// 确保两个请求都越过阶段 1（slot 未命中）后才放行，然后断言最终 slot 收敛为 1。
    #[tokio::test]
    async fn concurrent_connect_deduplicates_to_one_slot() {
        use std::sync::atomic::{AtomicU32, Ordering};
        use tokio::sync::Barrier;

        let db = crate::db::Db::open_in_memory().unwrap();
        let creds = Arc::new(MemoryStore::new());
        creds.set_password("smb-1", "p").unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password)
                 VALUES ('nas', 'smb', '192.168.1.1', 445, 'media', 'u', NULL)",
                [],
            )
            .unwrap();
        }
        // Barrier(2)：工厂闭包内 await——两个请求都进入建连阶段（各自过了阶段 1 的 slot miss）
        // 之后才一起放行。若只有一个请求建连，另一个 await 永远凑不齐 → 测试超时失败。
        let barrier = Arc::new(Barrier::new(2));
        let created = Arc::new(AtomicU32::new(0));
        let factory: TransportFactory = {
            let barrier = barrier.clone();
            let created = created.clone();
            Arc::new(move || {
                let barrier = barrier.clone();
                let created = created.clone();
                Box::pin(async move {
                    let m = Arc::new(MockSmbTransport::new());
                    created.fetch_add(1, Ordering::SeqCst);
                    barrier.wait().await; // 挂住直到第二个建连请求到达
                    m as Arc<dyn SmbTransport>
                })
            })
        };
        let mgr = SmbConnectionManager::new(db, creds, factory, Duration::from_secs(300));

        let (a, b) = tokio::join!(mgr.stat(1, "media", "f"), mgr.stat(1, "media", "f"));
        // 未脚本化 → FileNotFound（两请求都走通了完整链路到 transport）
        assert!(matches!(a, Err(TransportError::FileNotFound(_))));
        assert!(matches!(b, Err(TransportError::FileNotFound(_))));
        // 策略断言（后到者复用先到者）：两请求各自建连（2 实例），但 slot 收敛为 1
        assert_eq!(
            created.load(Ordering::SeqCst),
            2,
            "Barrier 放行证明两请求都越过阶段 1（各自建连）"
        );
        assert_eq!(mgr.slot_count(), 1, "阶段 3 写回去重：slot 单份");
    }

    #[tokio::test]
    async fn missing_account_row_errors() {
        let (mgr, _) = manager_with_log(Duration::from_secs(300));
        let r = mgr.list(999, "media", "x").await;
        assert!(r.is_err());
    }

    /// invalidate（公开摘槽，spec §7）：行为断言——建连后 invalidate，
    /// 下次操作走 factory 重建（created +1）。
    #[tokio::test]
    async fn invalidate_removes_slot_forcing_reconnect() {
        let (mgr, log) = manager_with_log(Duration::from_secs(300));
        mgr.list(1, "media", "comics").await.unwrap_err(); // 建连（FileNotFound 文件级）
        assert_eq!(log.created.lock().unwrap().len(), 1);
        mgr.invalidate(1);
        mgr.list(1, "media", "comics").await.unwrap_err();
        assert_eq!(log.created.lock().unwrap().len(), 2, "摘槽后下次操作重建连接");
    }
}
