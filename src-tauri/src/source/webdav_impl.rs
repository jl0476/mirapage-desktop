//! `WebDavMediaSource` —— WebDAV 服务器
//!
//! Phase 8 实现。当前为 stub。

use crate::source::descriptor::{MediaEntry, SourceDescriptor};
use crate::source::trait_def::{ByteRange, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;

pub struct WebDavMediaSource {
    _private: (),
}

impl WebDavMediaSource {
    pub fn new() -> Self {
        Self { _private: () }
    }
}

impl Default for WebDavMediaSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MediaSource for WebDavMediaSource {
    fn descriptor_type(&self) -> &'static str {
        "webdav"
    }

    async fn list_directory(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<Vec<MediaEntry>> {
        Err(MediaSourceError::NotImplemented(
            "WebDavMediaSource 在 Phase 8 实现（reqwest + PROPFIND）".into(),
        ))
    }

    async fn read_file(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
        _range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        Err(MediaSourceError::NotImplemented(
            "WebDavMediaSource 在 Phase 8 实现".into(),
        ))
    }

    async fn file_count(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<u64> {
        Err(MediaSourceError::NotImplemented(
            "WebDavMediaSource 在 Phase 8 实现".into(),
        ))
    }

    async fn test(&self, _descriptor: &SourceDescriptor) -> Result<()> {
        Err(MediaSourceError::NotImplemented(
            "WebDavMediaSource::test 在 Phase 8 实现".into(),
        ))
    }
}