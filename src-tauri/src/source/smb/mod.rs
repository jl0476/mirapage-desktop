//! SMB 协议层（module3.3.0）：transport 抽象 / 连接管理 / source 实装 / 真实接线。
pub mod connection;
pub mod mock_transport;
pub mod path;
pub mod real_transport;
pub mod source;
pub mod transport;