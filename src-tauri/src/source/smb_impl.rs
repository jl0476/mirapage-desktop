//! `SmbMediaSource` —— SMB 协议层
//!
//! Phase 7 实现。DESIGN §5 Phase 7:
//! - `smb` crate(原 smb-rs 重命名)0.11+
//! - 复用 `accounts` 表 + keyring 凭据加密
//! - 实现 `MediaSource` trait(替换 stub,UI 无需改动)
//!
//! 协议要点:
//! - UNC 路径:`\\server\share\path\to\file`
//! - 列目录:`QueryDirectory` info 或 `Find` 第一级
//! - 读文件:`File::read` 流式 / Range 字节
//!
//! 因 smb 0.11 是新发布的 API,具体接口可能与文档稍有差异,
//! 实际使用请参考 https://docs.rs/smb/0.11/smb/ 。这里根据
//! afiffon/smb-rs 仓库 README 给出最常用 API 形状。

use crate::source::descriptor::{MediaEntry, SourceDescriptor};
use crate::source::trait_def::{ByteRange, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;

pub struct SmbMediaSource {
    _private: (),
}

impl SmbMediaSource {
    pub fn new() -> Self {
        Self { _private: () }
    }

    fn extract<'a>(&self, descriptor: &'a SourceDescriptor) -> Option<(i64, &'a str, &'a str)> {
        match descriptor {
            SourceDescriptor::Smb {
                account_id,
                initial_path,
                path,
                ..
            } => Some((*account_id, initial_path.as_str(), path.as_str())),
            _ => None,
        }
    }
}

impl Default for SmbMediaSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MediaSource for SmbMediaSource {
    fn descriptor_type(&self) -> &'static str {
        "smb"
    }

    async fn list_directory(
        &self,
        descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<Vec<MediaEntry>> {
        // TODO(Phase 7 full impl): 凭据从 accounts 表+keyring 取,
        // smb::Client::new(smb::ClientConfig { ... }).share(...).list_dir(path)
        let _ = self.extract(descriptor);
        Err(MediaSourceError::NotImplemented(
            "SMB 完整实现:smb 0.11 API — 凭据查询 + Client 连接 + QueryDirectory 调用方见 smb_impl.rs 注释".into(),
        ))
    }

    async fn read_file(
        &self,
        _descriptor: &SourceDescriptor,
        path: &str,
        _range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        // 典型路径:
        // let client = smb::Client::new(config).await?;
        // let share = client.share(r"\\server\share").await?;
        // let mut file = share.open_file(path, smb::FileMode::OpenReadOnly).await?;
        // let bytes = file.read_all().await?;
        Err(MediaSourceError::NotImplemented(format!(
            "SMB read {}:smb 0.11 OpenFile + read_all 待接",
            path
        )))
    }

    async fn file_count(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<u64> {
        let entries = self.list_directory(descriptor, path).await?;
        Ok(entries
            .iter()
            .filter(|e| !e.is_directory && !e.is_archive)
            .count() as u64)
    }

    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()> {
        match descriptor {
            SourceDescriptor::Smb { account_id, initial_path, port, .. } => {
                // 简易探测:NMB 端口 139/445 TCP 握手。
                // 真实项目应走 smb::Client::new + share connect,
                // 现在给一个端口可用性 stub。
                use std::net::{TcpStream, ToSocketAddrs};
                let host = initial_path
                    .trim_start_matches(r"\\")
                    .split(['\\', '/'])
                    .next()
                    .unwrap_or("");
                let addr = format!("{}:{}", host, port);
                // TcpStream::connect_timeout 只接受 &SocketAddr（不像 connect 接受
                // ToSocketAddrs），先用 to_socket_addrs() 把 String 解析为 SocketAddr。
                let socket_addr = addr
                    .to_socket_addrs()
                    .map_err(|e| MediaSourceError::Network(format!("resolve {}: {}", addr, e)))?
                    .next()
                    .ok_or_else(|| {
                        MediaSourceError::Network(format!("no address for {}", addr))
                    })?;
                let stream = TcpStream::connect_timeout(
                    &socket_addr,
                    std::time::Duration::from_secs(5),
                )
                .map_err(|e| MediaSourceError::Network(format!("tcp {}: {}", addr, e)))?;
                drop(stream);
                let _ = account_id;
                Ok(())
            }
            _ => Err(MediaSourceError::NotImplemented(
                "SmbMediaSource::test 仅处理 Smb descriptor".into(),
            )),
        }
    }
}