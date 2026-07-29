//! `ArchiveMediaSource` —— CBZ / CBR / ZIP / RAR / 7z 压缩包
//!
//! Phase 3 实现。当前为 stub（trait 签名已就位，方法返回 `NotImplemented`）。
//! 完整实现见 `DESIGN.md` §5 Phase 3。

use crate::source::descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
use crate::source::trait_def::{ByteRange, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use std::path::PathBuf;

pub struct ArchiveMediaSource {
    _private: (),
}

impl ArchiveMediaSource {
    pub fn new() -> Self {
        Self { _private: () }
    }
}

impl Default for ArchiveMediaSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MediaSource for ArchiveMediaSource {
    fn descriptor_type(&self) -> &'static str {
        "archive"
    }

    async fn list_directory(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<Vec<MediaEntry>> {
        Err(MediaSourceError::NotImplemented(
            "ArchiveMediaSource::list_directory 在 Phase 3 实现".into(),
        ))
    }

    async fn read_file(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
        _range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        Err(MediaSourceError::NotImplemented(
            "ArchiveMediaSource::read_file 在 Phase 3 实现".into(),
        ))
    }

    async fn file_count(
        &self,
        _descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<u64> {
        Err(MediaSourceError::NotImplemented(
            "ArchiveMediaSource::file_count 在 Phase 3 实现".into(),
        ))
    }

    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()> {
        match descriptor {
            SourceDescriptor::Archive { archive_path, format, .. } => {
                let p = PathBuf::from(archive_path);
                if !p.exists() {
                    return Err(MediaSourceError::NotFound(archive_path.clone()));
                }
                // 检查扩展名与 format 一致
                let ext = p
                    .extension()
                    .and_then(|e| e.to_str())
                    .and_then(ArchiveFormat::from_extension);
                if ext != Some(*format) {
                    return Err(MediaSourceError::Other(format!(
                        "扩展名与 format 不匹配: 期望 {:?}, 实际 {:?}",
                        format, ext
                    )));
                }
                Ok(())
            }
            _ => Err(MediaSourceError::NotImplemented(
                "ArchiveMediaSource::test 仅处理 Archive descriptor".into(),
            )),
        }
    }
}