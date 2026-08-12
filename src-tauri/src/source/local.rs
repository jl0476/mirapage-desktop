//! `LocalMediaSource` —— 本地文件系统
//!
//! Phase 1 实现。基于 `tokio::fs` 异步 IO。

use crate::source::descriptor::{MediaEntry, SourceDescriptor};
use crate::source::trait_def::{ByteRange, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use std::path::PathBuf;
use tokio::fs;

pub struct LocalMediaSource {
    _private: (),
}

impl LocalMediaSource {
    pub fn new() -> Self {
        Self { _private: () }
    }

    /// 拼接本地绝对路径（路径身份修复 2026-08-12: join 前校验 source-relative path）。
    ///
    /// 绝对路径只允许出现在 `descriptor.rootPath`；`path` 必须 source-relative。
    /// 校验失败返回 `PathEscape`，避免 Windows `PathBuf::join(root, absoluteChild)`
    /// 丢弃 root 导致子路径逃逸 source 边界。
    fn resolve_path(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> std::result::Result<PathBuf, MediaSourceError> {
        match descriptor {
            SourceDescriptor::Local { root_path } => {
                let norm = crate::algorithm::validate_source_relative(path)
                    .map_err(|e| MediaSourceError::PathEscape(format!("{:?}: {}", e, path)))?;
                Ok(PathBuf::from(root_path).join(&norm))
            }
            SourceDescriptor::Archive { archive_path, entry_prefix, .. } => {
                // Archive 描述符的 read_file 直接返回压缩包条目；list_directory
                // 也走 ArchiveMediaSource。LocalMediaSource 不应处理 Archive。
                let mut p = PathBuf::from(archive_path);
                if !entry_prefix.is_empty() {
                    p = p.join(entry_prefix);
                }
                Ok(p)
            }
            _ => Ok(PathBuf::new()), // Smb / WebDav 不由 LocalMediaSource 处理
        }
    }
}

impl Default for LocalMediaSource {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl MediaSource for LocalMediaSource {
    fn descriptor_type(&self) -> &'static str {
        "local"
    }

    async fn list_directory(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<Vec<MediaEntry>> {
        let full_path = self.resolve_path(descriptor, path)?;
        let mut entries = fs::read_dir(&full_path)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => MediaSourceError::NotFound(full_path.display().to_string()),
                std::io::ErrorKind::PermissionDenied => MediaSourceError::PermissionDenied(full_path.display().to_string()),
                _ => MediaSourceError::Io(e),
            })?;

        let mut result = Vec::new();
        while let Some(entry) = entries.next_entry().await.map_err(MediaSourceError::Io)? {
            let metadata = entry.metadata().await.map_err(MediaSourceError::Io)?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = metadata.is_dir();
            let size = if is_dir { 0 } else { metadata.len() };
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            let is_archive = !is_dir && crate::source::descriptor::ArchiveFormat::from_extension(
                std::path::Path::new(&name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or(""),
            )
            .is_some();

            result.push(MediaEntry {
                name,
                path: entry.path().strip_prefix(&full_path).unwrap_or(&entry.path()).to_string_lossy().to_string(),
                is_directory: is_dir,
                is_archive,
                size,
                modified_at,
            });
        }

        // 自然排序（委托给 algorithm::natural_sort）
        result.sort_by(|a, b| crate::algorithm::natural_compare(&a.name, &b.name));

        Ok(result)
    }

    async fn read_file(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        let full_path = self.resolve_path(descriptor, path)?;
        let mut file = fs::File::open(&full_path).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => MediaSourceError::NotFound(full_path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => MediaSourceError::PermissionDenied(full_path.display().to_string()),
            _ => MediaSourceError::Io(e),
        })?;

        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        match range {
            None => {
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).await.map_err(MediaSourceError::Io)?;
                Ok(buf)
            }
            Some(range) => {
                file.seek(std::io::SeekFrom::Start(range.offset))
                    .await
                    .map_err(MediaSourceError::Io)?;
                let mut buf = vec![0u8; range.length as usize];
                file.read_exact(&mut buf).await.map_err(MediaSourceError::Io)?;
                Ok(buf)
            }
        }
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
            SourceDescriptor::Local { root_path } => {
                let p = PathBuf::from(root_path);
                if !p.exists() {
                    return Err(MediaSourceError::NotFound(root_path.clone()));
                }
                if !p.is_dir() {
                    return Err(MediaSourceError::Other(format!(
                        "路径不是目录: {}",
                        root_path
                    )));
                }
                Ok(())
            }
            _ => Err(MediaSourceError::NotImplemented(
                "LocalMediaSource::test 仅处理 Local descriptor".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::descriptor::SourceDescriptor;

    fn local_desc(root: &str) -> SourceDescriptor {
        SourceDescriptor::Local { root_path: root.to_string() }
    }

    // 路径身份修复 (2026-08-12, spec §6.3): resolve_path join 前校验 source-relative。
    // 绝对/UNC/../子路径必须拒绝, 且不访问 root 外文件（校验在 join 前 short-circuit）。

    #[test]
    fn resolve_path_accepts_root_empty() {
        let src = LocalMediaSource::new();
        let p = src.resolve_path(&local_desc("C:/comics"), "").unwrap();
        assert!(p.to_string_lossy().contains("comics"));
    }

    #[test]
    fn resolve_path_accepts_relative_subdir() {
        let src = LocalMediaSource::new();
        let p = src.resolve_path(&local_desc("C:/comics"), "sub/vol01").unwrap();
        assert!(p.to_string_lossy().ends_with("sub/vol01"));
    }

    #[test]
    fn resolve_path_rejects_drive_absolute() {
        // F:/WallPaper 不能逃逸 C:/comics 的 root (Windows join 会丢弃 root)
        let src = LocalMediaSource::new();
        let err = src.resolve_path(&local_desc("C:/comics"), "F:/WallPaper").unwrap_err();
        assert!(matches!(err, MediaSourceError::PathEscape(_)));
    }

    #[test]
    fn resolve_path_rejects_unix_absolute() {
        let src = LocalMediaSource::new();
        let err = src.resolve_path(&local_desc("C:/comics"), "/etc/passwd").unwrap_err();
        assert!(matches!(err, MediaSourceError::PathEscape(_)));
    }

    #[test]
    fn resolve_path_rejects_unc() {
        let src = LocalMediaSource::new();
        let err = src.resolve_path(&local_desc("C:/comics"), "\\\\server\\share").unwrap_err();
        assert!(matches!(err, MediaSourceError::PathEscape(_)));
    }

    #[test]
    fn resolve_path_rejects_dotdot() {
        let src = LocalMediaSource::new();
        let err = src.resolve_path(&local_desc("C:/comics"), "../escape").unwrap_err();
        assert!(matches!(err, MediaSourceError::PathEscape(_)));
    }
}