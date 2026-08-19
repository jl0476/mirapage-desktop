//! SMB 传输层抽象（spec §3）：trait + 原始类型 + 错误分类。
//! 生产实现在 real_transport.rs（包 smb crate）；测试用 mock_transport.rs。

/// SMB 传输错误。is_connection_level() 决定连接管理器的重连策略（spec §3）。
#[derive(Debug, Clone, thiserror::Error)]
pub enum TransportError {
    #[error("连接已断开")]
    Disconnected,
    #[error("IO 错误: {0}")]
    Io(String),
    #[error("操作超时")]
    Timeout,
    #[error("文件不存在: {0}")]
    FileNotFound(String),
    #[error("权限被拒绝: {0}")]
    PermissionDenied(String),
    #[error("路径非法: {0}")]
    InvalidPath(String),
    #[error("SMB 错误: {0}")]
    Other(String),
}

impl TransportError {
    /// 连接级错误（传输断开/IO/超时）→ 剔除连接重建重试一次；
    /// 文件级（NotFound/权限/路径）→ 直接上抛。
    pub fn is_connection_level(&self) -> bool {
        matches!(self, TransportError::Disconnected | TransportError::Io(_) | TransportError::Timeout)
    }
}

/// 建连参数（连接管理器从 DB+keyring 解出后传入 transport）
#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: i32,
    pub share: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// initial_path 首段必须等于 share（根路径契约，source 侧同款校验在 path.rs）
    pub initial_path: String,
}

/// 目录项原始形态（MediaEntry 映射前的中立类型，is_archive 判定在 source 层）
#[derive(Debug, Clone)]
pub struct RawDirEntry {
    pub name: String,
    pub is_directory: bool,
    pub size: u64,
    /// Unix 秒；0 = 源未提供
    pub modified_unix_secs: i64,
}

#[derive(Debug, Clone)]
pub struct RawStat {
    pub size: u64,
    pub modified_unix_secs: Option<i64>,
}

/// Windows FILETIME（100ns since 1601-01-01）→ Unix 秒；0（源未提供）→ None。
/// 纯整数换算，不依赖 smb-dtyp（生产接线处直接传 u64 字段值）。
pub fn file_time_to_unix_secs(file_time_100ns: u64) -> Option<i64> {
    if file_time_100ns == 0 {
        return None;
    }
    const EPOCH_DIFF_100NS: u64 = 116_444_736_000_000_000; // 1601→1970
    file_time_100ns
        .checked_sub(EPOCH_DIFF_100NS)
        .map(|v| (v / 10_000_000) as i64)
}

/// SMB 传输抽象：connect 一次后可重复调用 list/read_block_exact/stat。
#[async_trait::async_trait]
pub trait SmbTransport: Send + Sync {
    /// 建立认证连接（含 share 树连接）。重复调用返回 Ok（幂等）。
    async fn connect(&self, params: &ConnectParams) -> Result<(), TransportError>;

    /// 列目录（rel 相对 initial_path 的 '/' 分隔路径；返回自然序未保证——排序在 source 层）。
    async fn list(&self, rel: &str) -> Result<Vec<RawDirEntry>, TransportError>;

    /// 恰好读满 buf（Range 强契约：不足即 Err，禁止短读返回——EOF 早到按 Disconnected 处理
    /// 以触发外层重连一次的兜底语义）。
    async fn read_block_exact(&self, rel: &str, offset: u64, buf: &mut [u8]) -> Result<(), TransportError>;

    /// stat 单个文件。
    async fn stat(&self, rel: &str) -> Result<RawStat, TransportError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_level_classification() {
        // 连接级：传输断开 / IO / 超时 / 会话失效 —— 可重连
        assert!(TransportError::Disconnected.is_connection_level());
        assert!(TransportError::Io("read fail".into()).is_connection_level());
        assert!(TransportError::Timeout.is_connection_level());
        // 文件级：NotFound / 权限 / 路径违规 —— 重连无意义
        assert!(!TransportError::FileNotFound("x".into()).is_connection_level());
        assert!(!TransportError::PermissionDenied("x".into()).is_connection_level());
        assert!(!TransportError::InvalidPath("x".into()).is_connection_level());
        assert!(!TransportError::Other("x".into()).is_connection_level());
    }

    #[test]
    fn file_time_zero_maps_to_none() {
        assert_eq!(file_time_to_unix_secs(0), None);
        // 2026-01-01 00:00:00 UTC ≈ 13385082240（FILETIME 100ns）
        assert!(file_time_to_unix_secs(133_850_822_400_000_000).is_some());
    }
}
