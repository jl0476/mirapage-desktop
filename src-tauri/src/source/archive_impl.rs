//! `ArchiveMediaSource` —— CBZ / CBR / ZIP / RAR / 7z 五格式**薄适配器**（任务 7 起）
//!
//! 所有读取经共享 `ArchiveService`（格式分派 / 会话密码库 / catalog LRU / 工作集
//! 预算 / 唯一 cache coordinator，合同见 `source::archive::service`）；本类型只做
//! `MediaSource` trait 到 service 的转发与 Range 切片。
//!
//! 设计要点:
//! - `archive_path` + `entry_prefix` 可定位压缩包内的子目录（service 内部拼接）
//! - `read_file(entry, None)`:整条目解压;`read_file(entry, Some(range))`:整条目
//!   解压后切片(desktop 优化:大图按需读取;Range 强契约——溢出/越界一律报错)

use crate::source::archive::backend::ArchiveAccessError;
use crate::source::archive::service::ArchiveService;
use crate::source::descriptor::{ArchiveFormat, MediaEntry, SourceDescriptor};
use crate::source::trait_def::{ByteRange, MediaSource, MediaSourceError, Result};
use async_trait::async_trait;
use std::path::PathBuf;

/// 物化抽象（生产 = source::archive::materializer::Materializer；测试 = mock）
///
/// 错误类型化（审查修复 + 任务 8 收紧）：直接返回 `MaterializeError` 而非
/// MediaSourceError/String——NotFound/Network 保类型，FormatMismatch/Cancelled 由
/// Service 边界按变体映射（InvalidRequest / Cancelled），不被 `to_string()` 扁平化。
#[async_trait]
pub trait Materialize: Send + Sync {
    async fn ensure_cached(
        &self, origin: &SourceDescriptor, archive_rel_path: &str, format: ArchiveFormat,
    ) -> std::result::Result<PathBuf, crate::source::archive::materializer::MaterializeError>;
}

pub struct ArchiveMediaSource {
    service: std::sync::Arc<ArchiveService>,
}

impl ArchiveMediaSource {
    pub fn new(service: std::sync::Arc<ArchiveService>) -> Self {
        Self { service }
    }
}

/// ArchiveAccessError → MediaSourceError：`EntryNotFound` 保留 NotFound 语义
/// （media:// 404 合同，任务 2 特征测试锁定）；`Network`/`Timeout` 保真同名变体
/// （502/超时分类，物化错误穿透回归锁定）；其余类型化进 `Archive` 变体
/// （`#[from]`），由协议层按变体分类。
fn map_backend_error(e: ArchiveAccessError) -> MediaSourceError {
    match e {
        ArchiveAccessError::EntryNotFound(name) => MediaSourceError::NotFound(name),
        ArchiveAccessError::Network(s) => MediaSourceError::Network(s),
        ArchiveAccessError::Timeout(s) => MediaSourceError::Timeout(s),
        other => MediaSourceError::Archive(other),
    }
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
        self.service.list(descriptor).await.map_err(map_backend_error)
    }

    async fn read_file(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>> {
        let full = self
            .service
            .read(descriptor, path)
            .await
            .map_err(map_backend_error)?;
        match range {
            None => Ok(full),
            Some(r) => {
                let end = r.offset.checked_add(r.length).ok_or_else(|| {
                    MediaSourceError::Other("archive range overflow".into())
                })?;
                if end > full.len() as u64 {
                    return Err(MediaSourceError::Other("archive range exceeds entry size".into()));
                }
                let start = r.offset as usize;
                let end = end as usize;
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

    /// entry stat（spec rev3 §3.1）：返回压缩包内条目**解压后** size——语义是
    /// 「压缩包内这张图」，不是容器（容器 stat 由 M3 materializer 对 origin 调）。
    async fn stat(
        &self,
        descriptor: &SourceDescriptor,
        path: &str,
    ) -> Result<crate::source::trait_def::FileStat> {
        let size = self
            .service
            .stat_entry_size(descriptor, path)
            .await
            .map_err(map_backend_error)?;
        Ok(crate::source::trait_def::FileStat {
            size,
            modified_at: None, // DOS 时间精度低且无消费方（spec rev3）
        })
    }

    async fn test(&self, descriptor: &SourceDescriptor) -> Result<()> {
        // 远程 origin 有意不接物化（M3 spec §5 只列 list/read/stat 三方法）；
        // 虚拟路径 exists() 必 false 返 NotFound 属预期
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
    use crate::source::archive::materializer::MaterializeError;
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

    /// 恒失败物化 mock——origin None 用例不应触达物化路径
    struct NeverMaterialize;

    #[async_trait]
    impl Materialize for NeverMaterialize {
        async fn ensure_cached(
            &self,
            _origin: &SourceDescriptor,
            _archive_rel_path: &str,
            _format: ArchiveFormat,
        ) -> std::result::Result<PathBuf, MaterializeError> {
            Err(MaterializeError::Other("mock 无物化".into()))
        }
    }

    fn never_source() -> ArchiveMediaSource {
        test_source(std::sync::Arc::new(NeverMaterialize))
    }

    /// 测试构造：mock 物化器 + 独立 coordinator 包成真 service——薄适配器测试
    /// 与生产同一条转发路径（backend 用生产 ZipBackend/RarBackend/SevenZBackend）
    fn test_source(materializer: std::sync::Arc<dyn Materialize>) -> ArchiveMediaSource {
        ArchiveMediaSource::new(std::sync::Arc::new(ArchiveService::new(
            materializer,
            crate::source::archive::cache_coordinator::ArchiveCacheCoordinator::new_shared(),
        )))
    }

    /// 本地直开 descriptor 构造 helper（origin None / 空 entry_prefix）
    fn archive_descriptor(path: PathBuf, format: ArchiveFormat) -> SourceDescriptor {
        SourceDescriptor::Archive {
            archive_path: path.display().to_string(),
            entry_prefix: String::new(),
            format,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        }
    }

    /// 固定路径物化 mock——ensure_cached 返回预置 ZIP 路径并记录调用次数
    struct FixedMaterialize {
        path: PathBuf,
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl Materialize for FixedMaterialize {
        async fn ensure_cached(
            &self,
            _origin: &SourceDescriptor,
            _archive_rel_path: &str,
            _format: ArchiveFormat,
        ) -> std::result::Result<PathBuf, MaterializeError> {
            self.calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(self.path.clone())
        }
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
        let src = never_source();
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
        let src = never_source();
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
        let src = never_source();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let bytes = rt.block_on(src.read_file(&descriptor, "page1.png", Some(ByteRange::new(0, 4)))).unwrap();
        assert_eq!(bytes.len(), 4);
        assert_eq!(bytes[0], 0x89);
    }

    #[test]
    fn read_cbz_entry_rejects_range_beyond_entry() {
        let path = create_test_cbz(&["page1.png"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = never_source();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let result = rt.block_on(src.read_file(&descriptor, "page1.png", Some(ByteRange::new(4, 8))));
        assert!(result.is_err(), "Range 强契约不允许静默返回短数据");
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
        let src = never_source();
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
        let src = never_source();
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
        let src = never_source();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let res = rt.block_on(src.test(&descriptor));
        assert!(res.is_err());
        std::mem::forget(dir);
    }

    #[tokio::test]
    async fn stat_returns_entry_uncompressed_size() {
        let path = create_test_cbz(&["p1.png", "p2.png"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = never_source();
        let st = src.stat(&descriptor, "p1.png").await.unwrap();
        // PNG magic 8 字节（spec rev3 §3.1：entry 解压后 size，非 ZIP 容器 size）
        assert_eq!(st.size, 8);
        assert_eq!(st.modified_at, None);
        assert!(src.stat(&descriptor, "missing.png").await.is_err());
    }

    /// M3 spec §5：origin Some → 物化路径被使用，虚拟 archive_path 不触 fs
    #[tokio::test]
    async fn remote_origin_goes_through_materializer() {
        let path = create_test_cbz(&["page1.jpg", "page2.jpg", "README.txt"]);
        let mock = std::sync::Arc::new(FixedMaterialize {
            path,
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        // archive_path 是虚拟 URL——fs 上不存在，成功只能来自物化返回的路径
        let descriptor = SourceDescriptor::Archive {
            archive_path: "https://d/x/a.cbz".into(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: Some(Box::new(SourceDescriptor::WebDav {
                account_id: 1,
                base_url: "https://d/x".into(),
                path: String::new(),
            })),
            origin_entry_path: Some("a.cbz".into()),
            archive_rel_path: Some("a.cbz".into()),
        };
        let src = test_source(mock.clone());
        let entries = src.list_directory(&descriptor, "").await.unwrap();
        // 物化路径被使用：ZIP 内 3 条目过滤 README.txt 后剩 2 图
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "page1.jpg");
        assert_eq!(entries[1].name, "page2.jpg");
        assert_eq!(
            mock.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "ensure_cached 恰被调一次"
        );
    }

    /// M3 spec §5：origin None 现状路径零回归——本地直开不触物化
    /// （恒失败 mock 下若误走物化路径会立即报错）
    #[tokio::test]
    async fn local_origin_unchanged() {
        let path = create_test_cbz(&["p1.png", "p2.png"]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.to_string_lossy().to_string(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let src = never_source();
        let entries = src.list_directory(&descriptor, "").await.unwrap();
        assert_eq!(entries.len(), 2);
    }

    /// 错误注入物化 mock——返回预置 MaterializeError（NotFound/Network）
    struct FailingMaterialize {
        err: MaterializeError,
    }

    #[async_trait]
    impl Materialize for FailingMaterialize {
        async fn ensure_cached(
            &self,
            _origin: &SourceDescriptor,
            _archive_rel_path: &str,
            _format: ArchiveFormat,
        ) -> std::result::Result<PathBuf, MaterializeError> {
            Err(match &self.err {
                MaterializeError::NotFound(s) => MaterializeError::NotFound(s.clone()),
                MaterializeError::Network(s) => MaterializeError::Network(s.clone()),
                other => panic!("mock 只支持 NotFound/Network 注入, 得到 {other:?}"),
            })
        }
    }

    fn remote_descriptor() -> SourceDescriptor {
        SourceDescriptor::Archive {
            archive_path: "https://d/x/a.cbz".into(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: Some(Box::new(SourceDescriptor::WebDav {
                account_id: 1,
                base_url: "https://d/x".into(),
                path: String::new(),
            })),
            origin_entry_path: Some("a.cbz".into()),
            archive_rel_path: Some("a.cbz".into()),
        }
    }

    /// 审查修复回归：Materialize 错误类型化——mock 返回 NotFound/Network 时
    /// `list_directory` 收到**同变体**错误（类型保真穿透），不被扁平化成 Other
    /// （media:// 协议层 error_to_status 依赖变体映 404/502 而非一律 500）
    #[tokio::test]
    async fn remote_materializer_error_type_preserved() {
        for err in [
            MaterializeError::NotFound("gone".into()),
            MaterializeError::Network("unreachable".into()),
        ] {
            // 期望变体先于 move 捕获
            let expect_not_found = matches!(err, MaterializeError::NotFound(_));
            let src = test_source(std::sync::Arc::new(FailingMaterialize { err }));
            let res = src.list_directory(&remote_descriptor(), "").await;
            let type_preserved = match res {
                Err(MediaSourceError::NotFound(_)) if expect_not_found => true,
                Err(MediaSourceError::Network(_)) if !expect_not_found => true,
                _ => false,
            };
            assert!(
                type_preserved,
                "物化错误应类型保真穿透（NotFound↔404 / Network↔502）, 实际 {res:?}"
            );
        }
    }

    /// 特征测试：子目录前缀（entry_prefix）+ Unicode 条目名 + 非图片过滤 +
    /// 严格 Range 切片 + entry stat——锁定 ZIP 读取契约，供后续路径化重构对齐
    #[tokio::test]
    async fn zip_contract_nested_unicode_filter_range_and_stat() {
        let path = create_test_cbz(&[
            "章节一/第01页.png",
            "章节一/第02页.jpg",
            "章节一/readme.txt",
            "章节二/第03页.png",
        ]);
        let descriptor = SourceDescriptor::Archive {
            archive_path: path.display().to_string(),
            entry_prefix: "章节一".into(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        let source = never_source();
        let entries = source.list_directory(&descriptor, "").await.unwrap();
        assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
                   vec!["第01页.png", "第02页.jpg"]);
        let stat = source.stat(&descriptor, "第01页.png").await.unwrap();
        assert_eq!(stat.size, 8);
        assert_eq!(stat.modified_at, None);
        let slice = source.read_file(
            &descriptor,
            "第01页.png",
            Some(ByteRange { offset: 1, length: 3 }),
        ).await.unwrap();
        assert_eq!(slice, vec![b'P', b'N', b'G']);
    }

    /// 特征测试：Range offset 加法溢出与末尾越界都必须报错
    /// （Range 强契约：不允许静默返回短数据或 panic）
    #[tokio::test]
    async fn zip_contract_range_overflow_and_end_overrun_fail() {
        let path = create_test_cbz(&["page.png"]);
        let descriptor = archive_descriptor(path, ArchiveFormat::Cbz);
        let source = never_source();
        assert!(source.read_file(
            &descriptor,
            "page.png",
            Some(ByteRange { offset: u64::MAX, length: 1 }),
        ).await.is_err());
        assert!(source.read_file(
            &descriptor,
            "page.png",
            Some(ByteRange { offset: 7, length: 2 }),
        ).await.is_err());
    }
}
