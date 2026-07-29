//! `SmbMediaSource` —— SMB 网络共享
//!
//! Phase 7 实现。当前为 stub。

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
        _descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<Vec<MediaEntry>> {
        Err(MediaSourceError::NotImplemented(
            "SmbMediaSource 在 Phase 7 实现（smb-rs）".into(),
        ))
    }

    async fn read_file(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
        _range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        Err(MediaSourceError::NotImplemented(
            "SmbMediaSource 在 Phase 7 实现（smb-rs）".into(),
        ))
    }

    async fn file_count(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<u64> {
        Err(MediaSourceError::NotImplemented(
            "SmbMediaSource 在 Phase 7 实现".into(),
        ))
    }

    async fn test(&self, _descriptor: &SourceDescriptor) -> Result<()> {
        Err(MediaSourceError::NotImplemented(
            "SmbMediaSource::test 在 Phase 7 实现".into(),
        ))
    }
}