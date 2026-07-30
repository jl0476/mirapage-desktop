//! `ArchiveMediaSource` —— CBZ / CBR / ZIP / RAR / 7z 压缩包
//!
//! Phase 3 实现。CBZ/ZIP 用 `zip` crate;CBR/RAR 用 `unrar`(RAR5 部分包可能失败,
//! 按 DESIGN §9 缓解);7z 用 `sevenz-rust`(末尾索引,需整包读,远程源场景
//! 先下载到 cacheDir 后再解压)。
//!
//! 设计要点:
//! - 压缩包内容缓存在内存(RAM 限制 OK,因为常见漫画 < 1 GB)
//! - 大文件支持 Range 读取(只解压条目所需字节)
//! - 命名空间:`archive_path` + `entry_prefix` 可定位压缩包内的子目录
//!
//! 解压策略:
//! - `read_file(entry, None)`:整条目解压到 Vec<u8>
//! - `read_file(entry, Some(range))`:整条目解压后切片(desktop 优化:大图按需读取)

use crate::algorithm::mime::is_image;
use crate::source::descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
use crate::source::trait_def::{ByteRange, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};

pub struct ArchiveMediaSource {
    _private: (),
}

impl ArchiveMediaSource {
    pub fn new() -> Self {
        Self { _private: () }
    }

    fn archive_path<'a>(&self, descriptor: &'a SourceDescriptor) -> Option<&'a Path> {
        match descriptor {
            SourceDescriptor::Archive { archive_path, .. } => Some(Path::new(archive_path)),
            _ => None,
        }
    }
}

impl Default for ArchiveMediaSource {
    fn default() -> Self {
        Self::new()
    }
}

fn read_entry_bytes(archive_bytes: &[u8], entry_name: &str, format: ArchiveFormat) -> Result<Vec<u8>> {
    match format {
        ArchiveFormat::Cbz | ArchiveFormat::Zip => {
            use zip::ZipArchive;
            let cursor = Cursor::new(archive_bytes);
            let mut archive = ZipArchive::new(cursor)
                .map_err(|e| MediaSourceError::Other(format!("zip open: {e}")))?;
            let mut entry = archive
                .by_name(entry_name)
                .map_err(|_| MediaSourceError::NotFound(entry_name.to_string()))?;
            let mut out = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut out)
                .map_err(|e| MediaSourceError::Other(format!("zip read: {e}")))?;
            Ok(out)
        }
        ArchiveFormat::Cbr | ArchiveFormat::Rar | ArchiveFormat::SevenZ => Err(
            MediaSourceError::NotImplemented(format!(
                "{:?} 实装见 commands::archive::read_archive_entry",
                format
            )),
        ),
    }
}

/// 列出压缩包内条目(过滤图片)
fn list_archive_entries(archive_bytes: &[u8], format: ArchiveFormat, prefix: &str) -> Result<Vec<MediaEntry>> {
    match format {
        ArchiveFormat::Cbz | ArchiveFormat::Zip => {
            use zip::ZipArchive;
            let cursor = Cursor::new(archive_bytes);
            let mut archive = ZipArchive::new(cursor)
                .map_err(|e| MediaSourceError::Other(format!("zip open: {e}")))?;
            let mut out = Vec::new();
            for i in 0..archive.len() {
                let entry = archive
                    .by_index(i)
                    .map_err(|e| MediaSourceError::Other(format!("zip index: {e}")))?;
                let name = entry.name().to_string();
                if !name.starts_with(prefix) {
                    continue;
                }
                if !is_image(&name) {
                    continue;
                }
                // entry.path() 相对于 entry_prefix 的相对路径
                let relative = if prefix.is_empty() {
                    name.clone()
                } else {
                    name.strip_prefix(prefix)
                        .map(|s| s.trim_start_matches('/').to_string())
                        .unwrap_or_else(|| name.clone())
                };
                let size = entry.size();
                // ZIP 内 DOS timestamp 精度低（2-sec，1980-2107），且 zip 2.4.2 的
                // DateTime 只暴露 year/month/day/... getter，无 timestamp() 方法。
                // 漫画阅读器场景 modified_at 不展示在 UI（archive 条目是内部列表），
                // 留 None 即可。
                let modified_at: Option<i64> = None;
                out.push(MediaEntry {
                    name: relative.clone(),
                    path: relative,
                    is_directory: false,
                    is_archive: false,
                    size,
                    modified_at,
                });
            }
            // 自然排序
            out.sort_by(|a, b| crate::algorithm::natural_compare(&a.name, &b.name));
            Ok(out)
        }
        _ => Err(MediaSourceError::NotImplemented(
            "非 ZIP/CBZ 列表暂不直接支持".into(),
        )),
    }
}

/// 读压缩包到内存(小文件 OK,大文件应考虑 mmap)
fn read_archive_to_bytes(path: &Path) -> Result<Vec<u8>> {
    std::fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => MediaSourceError::NotFound(path.display().to_string()),
        std::io::ErrorKind::PermissionDenied => {
            MediaSourceError::PermissionDenied(path.display().to_string())
        }
        _ => MediaSourceError::Io(e),
    })
}

#[async_trait]
impl MediaSource for ArchiveMediaSource {
    fn descriptor_type(&self) -> &'static str {
        "archive"
    }

    async fn list_directory(
        &self,
        descriptor: &SourceDescriptor,
        _path: &str,
    ) -> Result<Vec<MediaEntry>> {
        let (archive_path, entry_prefix, format) = match descriptor {
            SourceDescriptor::Archive { archive_path, entry_prefix, format, .. } => (
                PathBuf::from(archive_path),
                entry_prefix.clone(),
                *format,
            ),
            _ => {
                return Err(MediaSourceError::NotImplemented(
                    "ArchiveMediaSource::list_directory 仅处理 Archive descriptor".into(),
                ));
            }
        };
        let bytes = tokio::fs::read(&archive_path).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => MediaSourceError::NotFound(archive_path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => {
                MediaSourceError::PermissionDenied(archive_path.display().to_string())
            }
            _ => MediaSourceError::Io(e.into()),
        })?;
        list_archive_entries(&bytes, format, &entry_prefix)
    }

    async fn read_file(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        let (archive_path, entry_prefix, format) = match descriptor {
            SourceDescriptor::Archive { archive_path, entry_prefix, format, .. } => (
                PathBuf::from(archive_path),
                entry_prefix.clone(),
                *format,
            ),
            _ => {
                return Err(MediaSourceError::NotImplemented(
                    "ArchiveMediaSource::read_file 仅处理 Archive descriptor".into(),
                ));
            }
        };
        let bytes = tokio::fs::read(&archive_path).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => MediaSourceError::NotFound(archive_path.display().to_string()),
            std::io::ErrorKind::PermissionDenied => {
                MediaSourceError::PermissionDenied(archive_path.display().to_string())
            }
            _ => MediaSourceError::Io(e.into()),
        })?;
        let entry_name = if entry_prefix.is_empty() {
            path.to_string()
        } else {
            format!("{}/{}", entry_prefix.trim_end_matches('/'), path)
        };
        let full = read_entry_bytes(&bytes, &entry_name, format)?;
        match range {
            None => Ok(full),
            Some(r) => {
                let start = (r.offset as usize).min(full.len());
                let end = ((r.offset + r.length) as usize).min(full.len());
                Ok(full[start..end].to_vec())
            }
        }
    }

    async fn file_count(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<u64> {
        let entries = self.list_directory(descriptor, path).await?;
        Ok(entries.len() as u64)
    }

    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()> {
        match descriptor {
            SourceDescriptor::Archive { archive_path, format, .. } => {
                let p = PathBuf::from(archive_path);
                if !p.exists() {
                    return Err(MediaSourceError::NotFound(archive_path.clone()));
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    /// 创建一个临时 ZIP 包含若干条目,返回路径
    fn create_test_cbz(entries: &[&str]) -> std::path::PathBuf {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.cbz");
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
        for name in entries {
            zip.start_file::<_, ()>(name, opts.clone()).unwrap();
            // 写入 PNG magic bytes 占位
            zip.write_all(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']).unwrap();
        }
        zip.finish().unwrap();
        // 返回 path 并保留 dir(tempdir leak by intent for tests)
        std::mem::forget(dir);
        path
    }

    #[test]
    fn list_cbz_returns_image_entries_only_sorted() {
        let path = create_test_cbz(&["page1.jpg", "page10.jpg", "page2.jpg", "README.txt"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = ArchiveMediaSource::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let entries = rt.block_on(src.list_directory(&descriptor, "")).unwrap();
        // 应过滤掉 README.txt,保留 3 张图
        assert_eq!(entries.len(), 3);
        // 自然排序
        assert_eq!(entries[0].name, "page1.jpg");
        assert_eq!(entries[1].name, "page2.jpg");
        assert_eq!(entries[2].name, "page10.jpg");
    }

    #[test]
    fn read_cbz_entry_returns_zip_entry_bytes() {
        let path = create_test_cbz(&["page1.png"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = ArchiveMediaSource::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let bytes = rt.block_on(src.read_file(&descriptor, "page1.png", None)).unwrap();
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']);
    }

    #[test]
    fn read_cbz_entry_with_range_slices_bytes() {
        let path = create_test_cbz(&["page1.png"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = ArchiveMediaSource::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let bytes = rt.block_on(src.read_file(&descriptor, "page1.png", Some(ByteRange::new(0, 4)))).unwrap();
        assert_eq!(bytes.len(), 4);
        assert_eq!(bytes[0], 0x89);
    }

    #[test]
    fn read_cbz_missing_entry_returns_not_found() {
        let path = create_test_cbz(&["page1.png"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = ArchiveMediaSource::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(src.read_file(&descriptor, "missing.png", None));
        assert!(matches!(res, Err(MediaSourceError::NotFound(_))));
    }

    #[test]
    fn file_count_matches_list_size() {
        let path = create_test_cbz(&["page1.png", "page2.png", "page3.png"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = ArchiveMediaSource::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let count = rt.block_on(src.file_count(&descriptor, "")).unwrap();
        assert_eq!(count, 3);
    }

    #[test]
    fn test_rejects_format_extension_mismatch() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("wrong.zip"); // 扩展名是 zip 但 descriptor 是 cbz
        std::fs::File::create(&path).unwrap();
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = ArchiveMediaSource::new();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(src.test(&descriptor));
        assert!(res.is_err());
        std::mem::forget(dir);
    }
}