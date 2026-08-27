//! 可编程 mock transport（spec §7 测试策略）：脚本化响应 + 调用记录 + 错误注入。
//! 连接管理器 / source 实装的全部单测基座。

use super::transport::{ConnectParams, RawDirEntry, RawStat, SmbTransport, TransportError};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

#[derive(Default)]
struct Inner {
    lists: HashMap<String, Vec<RawDirEntry>>,
    stats: HashMap<String, RawStat>,
    list_calls: HashMap<String, u32>,
    connect_calls: AtomicU32,
    fail_all: Option<TransportError>,
    fail_once: Option<TransportError>,
    /// bytes 脚本：read_block_exact 从 offset 切片（不足即 Err——模拟短读/EOF 早到）
    bytes: Vec<u8>,
    /// 远程读取闸门测试钩子（spec §11.6）：read 延迟 / read 挂起 / stat 挂起
    read_delay_ms: Option<u64>,
    hang_reads: bool,
    hang_stats: bool,
}

pub struct MockSmbTransport {
    inner: Mutex<Inner>,
    connected: AtomicBool,
    disconnect_signals: AtomicU32,
    read_inflight: AtomicU32,
    max_read_inflight: AtomicU32,
}

impl MockSmbTransport {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            connected: AtomicBool::new(false),
            disconnect_signals: AtomicU32::new(0),
            read_inflight: AtomicU32::new(0),
            max_read_inflight: AtomicU32::new(0),
        }
    }

    pub fn script_list(&self, rel: &str, entries: Vec<RawDirEntry>) {
        self.inner.lock().unwrap().lists.insert(rel.to_string(), entries);
    }

    pub fn script_stat(&self, rel: &str, stat: RawStat) {
        self.inner.lock().unwrap().stats.insert(rel.to_string(), stat);
    }

    pub fn script_bytes(&self, bytes: &[u8]) {
        self.inner.lock().unwrap().bytes = bytes.to_vec();
    }

    /// 全部操作注入错误（连接级场景）；错误触发时 disconnect 信号 +1（重连测试观察点）。
    pub fn set_fail_all(&self, e: TransportError) {
        let mut g = self.inner.lock().unwrap();
        g.fail_all = Some(e);
    }

    /// 下一次操作注入一次性错误（重试一次成功场景）。
    pub fn set_fail_once(&self, e: TransportError) {
        let mut g = self.inner.lock().unwrap();
        g.fail_once = Some(e);
    }

    pub fn connect_calls(&self) -> u32 {
        self.inner.lock().unwrap().connect_calls.load(Ordering::SeqCst)
    }

    pub fn list_calls(&self, rel: &str) -> u32 {
        *self.inner.lock().unwrap().list_calls.get(rel).unwrap_or(&0)
    }

    pub fn disconnect_signals(&self) -> u32 {
        self.disconnect_signals.load(Ordering::SeqCst)
    }

    // ─── 远程读取闸门测试钩子（spec §11.6）───

    pub fn set_read_delay(&self, d: std::time::Duration) {
        self.inner.lock().unwrap().read_delay_ms = Some(d.as_millis() as u64);
    }

    pub fn set_read_hang(&self, on: bool) {
        self.inner.lock().unwrap().hang_reads = on;
    }

    /// stat 挂起独立标志（任务 6 stat 超时测试用；与 read 挂起分开，避免语义互扰）。
    pub fn set_read_hang_stat(&self, on: bool) {
        self.inner.lock().unwrap().hang_stats = on;
    }

    pub fn max_read_inflight(&self) -> u32 {
        self.max_read_inflight.load(Ordering::SeqCst)
    }

    fn take_injected(&self) -> Option<TransportError> {
        let mut g = self.inner.lock().unwrap();
        if g.fail_all.is_some() {
            return g.fail_all.clone();
        }
        g.fail_once.take()
    }
}

#[async_trait::async_trait]
impl SmbTransport for MockSmbTransport {
    async fn connect(&self, _params: &ConnectParams) -> Result<(), TransportError> {
        self.inner.lock().unwrap().connect_calls.fetch_add(1, Ordering::SeqCst);
        self.connected.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn list(&self, rel: &str) -> Result<Vec<RawDirEntry>, TransportError> {
        if let Some(e) = self.take_injected() {
            if e.is_connection_level() {
                self.connected.store(false, Ordering::SeqCst);
                self.disconnect_signals.fetch_add(1, Ordering::SeqCst);
            }
            return Err(e);
        }
        let mut g = self.inner.lock().unwrap();
        *g.list_calls.entry(rel.to_string()).or_insert(0) += 1;
        g.lists.get(rel).cloned().ok_or_else(|| TransportError::FileNotFound(rel.to_string()))
    }

    async fn read_block_exact(&self, _rel: &str, offset: u64, buf: &mut [u8]) -> Result<(), TransportError> {
        if let Some(e) = self.take_injected() {
            if e.is_connection_level() {
                self.connected.store(false, Ordering::SeqCst);
                self.disconnect_signals.fetch_add(1, Ordering::SeqCst);
            }
            return Err(e);
        }
        // 挂起/延迟钩子（挂起仅靠外层 timeout 取消）：锁内只读决策，
        // guard 生命周期封闭在无 await 块内（显式 drop 后跨 await 仍会被
        // generator Send 分析保守判死——读出枚举再执行）
        enum Throttle {
            None,
            Delay(u64),
            Hang,
        }
        let throttle = {
            let g = self.inner.lock().unwrap();
            if g.hang_reads {
                Throttle::Hang
            } else if let Some(ms) = g.read_delay_ms {
                Throttle::Delay(ms)
            } else {
                Throttle::None
            }
        };
        match throttle {
            Throttle::Hang => std::future::pending::<()>().await,
            Throttle::Delay(ms) => {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await
            }
            Throttle::None => {}
        }
        // 在途计数只包真实切片段：挂起的读占外层 gate permit，不计 inflight
        let cur = self.read_inflight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_read_inflight.fetch_max(cur, Ordering::SeqCst);
        struct InflightGuard<'a>(&'a AtomicU32);
        impl Drop for InflightGuard<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _guard = InflightGuard(&self.read_inflight);
        let g = self.inner.lock().unwrap();
        let start = offset as usize;
        let end = start.checked_add(buf.len()).ok_or_else(|| TransportError::InvalidPath("offset overflow".into()))?;
        // 脚本数据不足（EOF 早到/文件变小）→ Err（Range 强契约，禁止短读）
        if end > g.bytes.len() {
            return Err(TransportError::Disconnected); // EOF 早到按连接级处理，触发外层重连兜底
        }
        buf.copy_from_slice(&g.bytes[start..end]);
        Ok(())
    }

    async fn stat(&self, rel: &str) -> Result<RawStat, TransportError> {
        if let Some(e) = self.take_injected() {
            return Err(e);
        }
        if self.inner.lock().unwrap().hang_stats {
            std::future::pending::<()>().await;
        }
        let g = self.inner.lock().unwrap();
        g.stats.get(rel).cloned().ok_or_else(|| TransportError::FileNotFound(rel.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> ConnectParams {
        ConnectParams {
            host: "h".into(), port: 445, share: "media".into(),
            username: Some("u".into()), password: Some("p".into()),
            initial_path: "media".into(),
        }
    }

    #[tokio::test]
    async fn scripted_list_and_call_recording() {
        let m = MockSmbTransport::new();
        m.script_list("comics", vec![RawDirEntry {
            name: "v1".into(), is_directory: true, size: 0, modified_unix_secs: 100,
        }]);
        m.connect(&params()).await.unwrap();
        let entries = m.list("comics").await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "v1");
        assert_eq!(m.connect_calls(), 1);
        assert_eq!(m.list_calls("comics"), 1);
    }

    #[tokio::test]
    async fn read_exact_fails_when_script_short() {
        let m = MockSmbTransport::new();
        m.script_bytes(b"abcdef"); // 6 字节
        let mut buf = vec![0u8; 10];
        // 脚本数据不足 buf —— Err（而不是静默短读）
        assert!(m.read_block_exact("f", 0, &mut buf).await.is_err());
    }

    #[tokio::test]
    async fn error_injection_and_disconnect_mode() {
        let m = MockSmbTransport::new();
        m.set_fail_all(TransportError::Disconnected);
        assert!(m.list("x").await.is_err());
        // 注入 Disconnected 后 list 触发 disconnect_signals+1（重连测试观察点）
        assert_eq!(m.disconnect_signals(), 1);
    }

    #[tokio::test]
    async fn read_delay_and_inflight_tracking() {
        let m = MockSmbTransport::new();
        m.script_bytes(&[0u8; 8]);
        m.set_read_delay(std::time::Duration::from_millis(30));
        let mut buf = vec![0u8; 8];
        m.read_block_exact("f", 0, &mut buf).await.unwrap();
        assert_eq!(m.max_read_inflight(), 1);
    }

    #[tokio::test]
    async fn read_hang_never_returns() {
        let m = MockSmbTransport::new();
        m.script_bytes(&[0u8; 8]);
        m.set_read_hang(true);
        let mut buf = vec![0u8; 8];
        // 50ms 内必无返回（挂起）；不直接 await 到死，用 timeout 观察
        let r = tokio::time::timeout(std::time::Duration::from_millis(50), m.read_block_exact("f", 0, &mut buf)).await;
        assert!(r.is_err(), "挂起读应超时");
    }
}
