//! `SmbMediaSource` —— SMB 协议层实装（module3.3.0，spec M2 §4）。

use crate::source::descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
use crate::source::smb::connection::SmbConnectionManager;
use crate::source::trait_def::{ByteRange, FileStat, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use std::sync::Arc;

/// 单次 read_file 全量上限（建议 3：异常 stat 防御，对齐 media LRU 256MB）
const MAX_SMB_READ_BYTES: usize = 256 * 1024 * 1024;

pub struct SmbMediaSource {
    manager: Arc<SmbConnectionManager>,
}

impl SmbMediaSource {
    pub fn new(manager: Arc<SmbConnectionManager>) -> Self {
        Self { manager }
    }

    /// (account_id, initial_path)。descriptor.path 不参与路径拼接（P0：方法参数即完整路径）。
    fn extract<'a>(&self, descriptor: &'a SourceDescriptor) -> Option<(i64, &'a str)> {
        match descriptor {
            SourceDescriptor::Smb { account_id, initial_path, .. } => Some((*account_id, initial_path.as_str())),
            _ => None,
        }
    }

    fn transport_err(e: crate::source::smb::transport::TransportError) -> MediaSourceError {
        use crate::source::smb::transport::TransportError as TE;
        match e {
            TE::FileNotFound(p) => MediaSourceError::NotFound(p),
            TE::PermissionDenied(p) => MediaSourceError::PermissionDenied(p),
            TE::InvalidPath(p) => MediaSourceError::PathEscape(p),
            other => MediaSourceError::Network(other.to_string()), // 连接级/超时/IO → 502
        }
    }
}

/// RawDirEntry → MediaEntry（is_archive 按扩展名，对齐 local.rs / webdav M3 补丁）
fn map_entry(raw: crate::source::smb::transport::RawDirEntry) -> MediaEntry {
    let is_archive = !raw.is_directory
        && ArchiveFormat::from_extension(
            std::path::Path::new(&raw.name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or(""),
        )
        .is_some();
    MediaEntry {
        name: raw.name.clone(),
        path: raw.name,
        is_directory: raw.is_directory,
        is_archive,
        size: raw.size,
        modified_at: if raw.modified_unix_secs == 0 {
            None
        } else {
            Some(raw.modified_unix_secs)
        },
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
        path: &str,
    ) -> Result<Vec<MediaEntry>> {
        let (account_id, initial_path) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("SmbMediaSource 仅处理 Smb descriptor".into())
        })?;
        let rel = validated_rel(initial_path, path)?;
        let raws = self
            .manager
            .list(account_id, initial_path, &rel)
            .await
            .map_err(Self::transport_err)?;
        let mut entries: Vec<MediaEntry> = raws.into_iter().map(map_entry).collect();
        entries.sort_by(|a, b| crate::algorithm::natural_compare(&a.name, &b.name));
        Ok(entries)
    }

    async fn read_file(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        let (account_id, initial_path) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("SmbMediaSource 仅处理 Smb descriptor".into())
        })?;
        let rel = validated_rel(initial_path, path)?;
        let total = match range {
            None => {
                let st = self
                    .manager
                    .stat(account_id, initial_path, &rel)
                    .await
                    .map_err(Self::transport_err)?;
                // 建议 3 修复：u64→usize 显式检查 + 巨量钳制（异常/恶意 stat 防御；
                // 256MB 对齐 media LRU 容量——正常图片远小于此）
                usize::try_from(st.size)
                    .map_err(|_| MediaSourceError::Network(format!("文件过大: {}", st.size)))?
            }
            Some(r) => usize::try_from(r.length)
                .map_err(|_| MediaSourceError::Network(format!("区间过大: {}", r.length)))?,
        };
        if total > MAX_SMB_READ_BYTES {
            return Err(MediaSourceError::Network(format!(
                "读取超过上限 {} 字节",
                MAX_SMB_READ_BYTES
            )));
        }
        let mut buf = vec![0u8; total];
        self.manager
            .read_block_exact(
                account_id,
                initial_path,
                &rel,
                range.map(|r| r.offset).unwrap_or(0),
                &mut buf,
            )
            .await
            .map_err(Self::transport_err)?;
        Ok(buf)
    }

    async fn file_count(&self, descriptor: &SourceDescriptor, path: &str) -> Result<u64> {
        let entries = self.list_directory(descriptor, path).await?;
        Ok(entries
            .iter()
            .filter(|e| !e.is_directory && !e.is_archive)
            .count() as u64)
    }

    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()> {
        match descriptor {
            SourceDescriptor::Smb {
                account_id,
                initial_path,
                ..
            } => {
                // 根路径契约由 manager.resolve_params 内的 share_root_matches 把关；
                // 真握手 = 建连 + 列 initial_path 根一次（rel = initial_path）
                let rel = validated_rel(initial_path, "")?;
                self.manager
                    .list(*account_id, initial_path, &rel)
                    .await
                    .map_err(Self::transport_err)?;
                Ok(())
            }
            _ => Err(MediaSourceError::NotImplemented(
                "SmbMediaSource::test 仅处理 Smb descriptor".into(),
            )),
        }
    }

    async fn stat(&self, descriptor: &SourceDescriptor, path: &str) -> Result<FileStat> {
        let (account_id, initial_path) = self.extract(descriptor).ok_or_else(|| {
            MediaSourceError::NotImplemented("SmbMediaSource 仅处理 Smb descriptor".into())
        })?;
        let rel = validated_rel(initial_path, path)?;
        let raw = self
            .manager
            .stat(account_id, initial_path, &rel)
            .await
            .map_err(Self::transport_err)?;
        Ok(FileStat {
            size: raw.size,
            modified_at: raw.modified_unix_secs,
        })
    }
}

/// **路径契约（P0 修复）**：方法 path 参数 = 相对 initial_path 入口的完整路径
/// （对齐 WebDAV 语义——webdav_impl 忽略 descriptor.path、只用方法参数拼 base_url；
/// fileBrowser fetch 传完整 currentPath、loader 传 book.absolutePath，均为完整路径）。
/// descriptor.path 是同信息的冗余双承载（身份记录），**不参与拼接**。
/// transport rel 语义 = 相对 share = initial_path 前缀 + 方法 path。
fn validated_rel(initial_path: &str, path: &str) -> Result<String> {
    let norm = crate::algorithm::validate_source_relative(path)
        .map_err(|e| MediaSourceError::PathEscape(format!("{:?}: {}", e, path)))?;
    let joined = crate::source::smb::path::unc_rel(initial_path, &norm);
    // unc_rel 产出 '\' 分隔（相对 share）——转回 '/' 供 transport 层统一消费
    Ok(joined.replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{CredentialStore, MemoryStore};
    use crate::source::smb::connection::SmbConnectionManager;
    use crate::source::smb::mock_transport::MockSmbTransport;
    use crate::source::smb::transport::{RawDirEntry, RawStat, TransportError};
    use std::sync::Arc;
    use std::time::Duration;

    fn make_source() -> (SmbMediaSource, Arc<MockSmbTransport>) {
        let db = crate::db::Db::open_in_memory().unwrap();
        let creds = Arc::new(MemoryStore::new());
        creds.set_password("smb-1", "p").unwrap();
        {
            let conn = db.conn();
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password)
                 VALUES ('nas', 'smb', '192.168.1.1', 445, 'media', 'u', NULL)",
                [],
            )
            .unwrap();
        }
        let mock = Arc::new(MockSmbTransport::new());
        let mock2 = mock.clone();
        let factory: crate::source::smb::connection::TransportFactory = Arc::new(move || {
            let m = mock2.clone();
            Box::pin(async move { m as Arc<dyn crate::source::smb::transport::SmbTransport> })
        });
        let mgr = SmbConnectionManager::new(db, creds, factory, Duration::from_secs(300));
        (SmbMediaSource::new(Arc::new(mgr)), mock)
    }

    fn smb_desc(initial: &str, path: &str) -> SourceDescriptor {
        SourceDescriptor::Smb {
            account_id: 1,
            initial_path: initial.into(),
            path: path.into(),
            port: 445,
        }
    }

    fn raw(name: &str, is_dir: bool, size: u64) -> RawDirEntry {
        RawDirEntry {
            name: name.into(),
            is_directory: is_dir,
            size,
            modified_unix_secs: 86400,
        }
    }

    #[tokio::test]
    async fn list_maps_entries_with_archive_flag_and_sort() {
        let (src, mock) = make_source();
        // rel 相对 share = initial_path("media") + 方法 path("v1")
        mock.script_list(
            "media/v1",
            vec![
                raw("page10.jpg", false, 5),
                raw("page2.jpg", false, 4),
                raw("sub", true, 0),
                raw("book.cbz", false, 100),
            ],
        );
        let entries = src
            .list_directory(&smb_desc("media", "v1"), "v1")
            .await
            .unwrap();
        // 自然排序（page2 < page10，book.cbz < page*），目录在前由 UI 层管
        // （source 只保自然序——对齐 local.rs）
        assert_eq!(
            entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            ["book.cbz", "page2.jpg", "page10.jpg", "sub"]
        );
        let cbz = entries.iter().find(|e| e.name == "book.cbz").unwrap();
        assert!(cbz.is_archive, "cbz 扩展名 → is_archive（对齐 local.rs）");
        let sub = entries.iter().find(|e| e.name == "sub").unwrap();
        assert!(sub.is_directory && sub.size == 0);
        assert_eq!(entries[0].modified_at, Some(86400));
    }

    #[tokio::test]
    async fn read_file_range_exact_or_error() {
        let (src, mock) = make_source();
        mock.script_bytes(b"0123456789");
        // 无 range 分支先 stat 拿全量 size——脚本必须配（rel 相对 share 含 initial_path 前缀）
        // 方法 path="f.bin" → rel = unc_rel("media","f.bin") = "media/f.bin"
        mock.script_stat(
            "media/f.bin",
            RawStat {
                size: 10,
                modified_unix_secs: None,
            },
        );
        let d = smb_desc("media", "v1");
        let full = src.read_file(&d, "f.bin", None).await.unwrap();
        assert_eq!(full, b"0123456789");
        let mut part = src
            .read_file(&d, "f.bin", Some(ByteRange::new(2, 4)))
            .await
            .unwrap();
        assert_eq!(part, b"2345");
        part = src
            .read_file(&d, "f.bin", Some(ByteRange::new(0, 10)))
            .await
            .unwrap();
        assert_eq!(part, b"0123456789");
        // 越界（超脚本数据）→ Err（Range 强契约）
        assert!(src
            .read_file(&d, "f.bin", Some(ByteRange::new(8, 10)))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn stat_maps_to_file_stat() {
        let (src, mock) = make_source();
        mock.script_stat(
            "media/v1/f.bin",
            RawStat {
                size: 42,
                modified_unix_secs: Some(123),
            },
        );
        let st = src.stat(&smb_desc("media", "v1"), "v1/f.bin").await.unwrap();
        assert_eq!(st.size, 42);
        assert_eq!(st.modified_at, Some(123));
    }

    // ─── P0 回归：initial_path 前缀必须进 transport rel（深层入口）───

    #[tokio::test]
    async fn deep_initial_path_root_list_includes_prefix() {
        let (src, mock) = make_source();
        // 账户 share=media、入口 media/comics：根目录列表（方法 path=""）→ rel="media/comics"
        mock.script_list("media/comics", vec![raw("v1", true, 0)]);
        let entries = src
            .list_directory(&smb_desc("media/comics", ""), "")
            .await
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "v1");
    }

    #[tokio::test]
    async fn deep_initial_path_subdirectory_join() {
        let (src, mock) = make_source();
        mock.script_list("media/comics/v1", vec![raw("001.jpg", false, 7)]);
        let entries = src
            .list_directory(&smb_desc("media/comics", ""), "v1")
            .await
            .unwrap();
        assert_eq!(entries[0].name, "001.jpg");
    }

    #[tokio::test]
    async fn deep_initial_path_read_joins_prefix() {
        let (src, mock) = make_source();
        mock.script_bytes(b"0123456789");
        let d = smb_desc("media/comics", "");
        let part = src
            .read_file(&d, "v1/001.jpg", Some(ByteRange::new(2, 4)))
            .await
            .unwrap();
        assert_eq!(part, b"2345");
        // read 走 stat 拿全量（无 range 时）——此处 range 路径不依赖 stat 脚本
    }

    #[tokio::test]
    async fn path_escape_rejected_before_transport() {
        let (src, mock) = make_source();
        // 方法 path="../escape" → validate_source_relative 返回 Err(DotDot)
        // → mapped to MediaSourceError::PathEscape，不触 transport
        assert!(matches!(
            src.list_directory(&smb_desc("media", ""), "../escape")
                .await,
            Err(MediaSourceError::PathEscape(_))
        ));
        assert_eq!(mock.list_calls("escape"), 0, "越界路径不触 transport");
    }

    #[tokio::test]
    async fn test_lists_root_and_requires_share() {
        let (src, mock) = make_source();
        mock.script_list("media", vec![raw("comics", true, 0)]);
        src.test(&smb_desc("media", "")).await.unwrap();
        // initial_path 首段 ≠ share → 配置错误
        assert!(src.test(&smb_desc("wrong", "")).await.is_err());
    }

    // 确保 TransportError::Io 也是连接级（防御：连接级/文件级分类边界）
    #[tokio::test]
    async fn connection_level_io_errors_bubble_as_network() {
        let (src, mock) = make_source();
        // set_fail_all 让所有 transport 调用返回 IO 错误（连接级）
        mock.set_fail_all(TransportError::Io("socket reset".into()));
        let r = src.list_directory(&smb_desc("media", ""), "").await;
        // IO 是连接级 → 外层重连一次（mock 仍失败）→ 顶层拿到 Network 文案
        assert!(matches!(r, Err(MediaSourceError::Network(_))));
    }
}