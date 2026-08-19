//! 真实 SMB 接线占位（spec §3）：任务 6 实装 smb crate 接线 + `map_smb_error` 映射。
//! 任务 4 占位：提供最小可编译的 `SmbTransport` impl，所有方法返回 `TransportError::Other`。
//! 任务 6 会用真实 smb crate 接线整体替换此占位实现。

use super::transport::{ConnectParams, RawDirEntry, RawStat, SmbTransport, TransportError};

/// 真实 transport 占位（任务 6 实装）。
pub struct SmbClientTransport;

impl SmbClientTransport {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SmbClientTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl SmbTransport for SmbClientTransport {
    async fn connect(&self, _params: &ConnectParams) -> Result<(), TransportError> {
        Err(TransportError::Other(
            "SmbClientTransport 尚未实装（任务 6 接线）".into(),
        ))
    }
    async fn list(&self, _rel: &str) -> Result<Vec<RawDirEntry>, TransportError> {
        Err(TransportError::Other(
            "SmbClientTransport 尚未实装（任务 6 接线）".into(),
        ))
    }
    async fn read_block_exact(
        &self,
        _rel: &str,
        _offset: u64,
        _buf: &mut [u8],
    ) -> Result<(), TransportError> {
        Err(TransportError::Other(
            "SmbClientTransport 尚未实装（任务 6 接线）".into(),
        ))
    }
    async fn stat(&self, _rel: &str) -> Result<RawStat, TransportError> {
        Err(TransportError::Other(
            "SmbClientTransport 尚未实装（任务 6 接线）".into(),
        ))
    }
}
