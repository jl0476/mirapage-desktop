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
}

pub struct MockSmbTransport {
    inner: Mutex<Inner>,
    connected: AtomicBool,
    disconnect_signals: AtomicU32,
}

impl MockSmbTransport {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            connected: AtomicBool::new(false),
            disconnect_signals: AtomicU32::new(0),
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
}
