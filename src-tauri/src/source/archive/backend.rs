//! 统一 Archive 后端类型：错误契约、输入抽象、资源上限与受限写入器。
//!
//! RAR/7z + 远程 ZIP 流式读取（任务 3 起）的类型地基：三种 backend（zip/rar/7z）
//! 与 Service 共用此处的错误、限额与工作集预算语义。

use crate::source::descriptor::{ArchiveFormat, MediaEntry};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ArchiveAccessError {
    #[error("压缩包需要密码")]
    PasswordRequired,
    #[error("密码错误")]
    WrongPassword,
    #[error("不支持的压缩算法: {0}")]
    UnsupportedCodec(String),
    #[error("暂不支持分卷压缩包: {0}")]
    MultiVolumeUnsupported(String),
    #[error("压缩包损坏: {0}")]
    CorruptArchive(String),
    #[error("压缩包中没有可阅读图片")]
    EmptyArchive,
    #[error("压缩包超过安全资源上限: {0}")]
    ResourceLimitExceeded(String),
    // Service 内部增长-回退协议 marker，永不跨 IPC（消费规则见任务 7 步骤 4）。
    // 变体级 skip_serializing 的 serde 官方语义是"尝试序列化该变体即报错"——
    // 任何意外把它带到 IPC 边界的路径都会显式失败而非静默漏字段。
    #[serde(skip_serializing)]
    #[error("工作集许可增长失败（Service 内部重排队 marker）")]
    BudgetRetryRequired,
    #[error("压缩包条目不存在: {0}")]
    EntryNotFound(String),
    #[error("远程 Range 不可用: {0}")]
    RemoteRangeUnavailable(String),
    #[error("操作已取消")]
    Cancelled,
    #[error("archive 请求无效: {0}")]
    InvalidRequest(String),
    #[error("IO 错误: {0}")]
    Io(String),
    #[error("网络错误: {0}")]
    Network(String),
    #[error("操作超时: {0}")]
    Timeout(String),
}

#[derive(Debug, Clone)]
pub struct RemoteZipIoError(pub ArchiveAccessError);

impl std::fmt::Display for RemoteZipIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("remote archive IO failed") // 不把路径或第三方错误重复写入 source 文本
    }
}

impl std::error::Error for RemoteZipIoError {}

#[derive(Debug, Clone)]
pub struct LimitedEntryIoError {
    pub limit: u64,
}

impl std::fmt::Display for LimitedEntryIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "archive entry exceeded {} bytes", self.limit)
    }
}

impl std::error::Error for LimitedEntryIoError {}

/// `LimitedEntryWriter` 增长失败（`try_grow` 返回 false）的 retry marker，与终态
/// `LimitedEntryIoError` 区分；backend 经 `map_zip_io_error` 在边界恢复为
/// `ArchiveAccessError::BudgetRetryRequired`（Service 触发增长-回退）。
#[derive(Debug, Clone)]
pub struct BudgetRetryIoError;

impl std::fmt::Display for BudgetRetryIoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("archive entry budget growth failed")
    }
}

impl std::error::Error for BudgetRetryIoError {}

pub trait ArchiveReadSeek: Read + Seek + Send {}
impl<T: Read + Seek + Send> ArchiveReadSeek for T {}

pub type ReaderFactory = Arc<
    dyn Fn() -> Result<Box<dyn ArchiveReadSeek>, ArchiveAccessError> + Send + Sync
>;

pub const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_CATALOG_ENTRIES: usize = 100_000;
pub const MAX_ENTRY_PATH_BYTES: usize = 4_096;

#[derive(Clone)]
pub enum ArchiveInput {
    Path(PathBuf),
    Reader(ReaderFactory),
}

#[derive(Debug, Clone)]
pub struct ArchiveCatalog {
    pub entries: Vec<MediaEntry>,
    // 不携带 first_encrypted_entry：加密元数据只存在于 ArchiveProbe 一个真值源。
}

/// probe 只读容器元数据，不返回条目内容（spec §4.2 四操作之一、§5.3 验证规则的载体）。
#[derive(Debug, Clone, Default)]
pub struct ArchiveProbe {
    pub entry_count: usize,
    /// 图片条目总数（含未加密）：image_count == 0 一律 EmptyArchive（spec §9）
    pub image_count: usize,
    /// entry 名（规范化 `/` 路径）→ 所属 folder 的 dictionary 字节数（仅 7z 非空；
    /// solid folder 内多条目共享同值，无 stream 条目不入表）。Service 读取目标条目时
    /// **按条目查询**，不取全容器最大值——无关 folder 的大 dictionary（如另一目录
    /// 400 MiB）不得误拒当前 1 MiB dictionary 的读取。
    pub entry_dictionaries: HashMap<String, u64>,
    /// 第一个加密图片条目（优先验证对象）
    pub first_encrypted_image: Option<String>,
    /// 无加密图片时回退验证的第一个加密普通文件
    pub first_encrypted_file: Option<String>,
}

pub trait ArchiveBackend: Send + Sync {
    /// `prefix` 与 catalog 同语义：`image_count`/`first_encrypted_*` 限定当前视图；
    /// `entry_count` 是**全容器**条目计数（资源限额基线），不受 prefix 影响。
    fn probe(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveProbe, ArchiveAccessError>;
    fn catalog(
        &self,
        input: &ArchiveInput,
        prefix: &str,
        password: Option<&[u8]>,
    ) -> Result<ArchiveCatalog, ArchiveAccessError>;
    fn read_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
        budget: &mut DecodeBudget,
    ) -> Result<Vec<u8>, ArchiveAccessError>;
    fn stat_entry(
        &self,
        input: &ArchiveInput,
        entry: &str,
        password: Option<&[u8]>,
    ) -> Result<u64, ArchiveAccessError>;
}

pub fn backend_kind(format: ArchiveFormat) -> &'static str {
    match format {
        ArchiveFormat::Cbz | ArchiveFormat::Zip => "zip",
        ArchiveFormat::Cbr | ArchiveFormat::Rar => "rar",
        ArchiveFormat::SevenZ => "7z",
    }
}

/// 资源上限集合（spec §4.5），backend 与 Service 共用同一份。
/// 生产值：entry 512 MiB、catalog 100,000 条、路径 4,096 bytes、
/// dictionary 512 MiB、工作集 512 MiB。
#[derive(Debug, Clone)]
pub struct ArchiveLimits {
    pub max_entry_bytes: u64,
    pub max_catalog_entries: usize,
    pub max_entry_path_bytes: usize,
    pub max_dict_bytes: u64,
    pub workspace_budget_bytes: u64,
}

impl ArchiveLimits {
    pub fn production() -> Self {
        Self {
            max_entry_bytes: 512 * 1024 * 1024,
            max_catalog_entries: 100_000,
            max_entry_path_bytes: 4_096,
            max_dict_bytes: 512 * 1024 * 1024,
            workspace_budget_bytes: 512 * 1024 * 1024,
        }
    }

    /// 测试构造的唯一入口：默认与生产值相同，每个用例只缩小自己验证的维度。
    /// Rust 无函数重载——全仓库只允许此签名，不得再出现 `for_test(8)` 形态；
    /// 也不得把无关维度默认设小：那会让用例命中错误分支，断言碰巧通过而失去意义
    ///（如工作集用例的 dict/entry 被截断在先、"应成功"分支反而失败）。
    pub fn for_test() -> Self {
        Self::production()
    }

    pub fn entry_bytes(mut self, v: u64) -> Self { self.max_entry_bytes = v; self }
    pub fn entry_count(mut self, v: usize) -> Self { self.max_catalog_entries = v; self }
    pub fn path_bytes(mut self, v: usize) -> Self { self.max_entry_path_bytes = v; self }
    pub fn dict_bytes(mut self, v: u64) -> Self { self.max_dict_bytes = v; self }
    pub fn budget_bytes(mut self, v: u64) -> Self { self.workspace_budget_bytes = v; self }
}

/// `read_entry` 的工作集预算句柄（Service 构造、backend 消费、整体 move 进
/// `spawn_blocking`）。**显式持有**初始与追加的 `OwnedSemaphorePermit`——许可的
/// RAII 记账以这些字段为真实持有者，drop budget 即统一释放；`try_grow` 同步非阻塞
/// （`try_acquire_many_owned`），匹配 RAR FFI callback 的同步约束。越过 `output_cap`
/// 的终态判断由 writer 自行完成（返回 `ResourceLimitExceeded`），`try_grow` 失败才
/// 触发 `BudgetRetryRequired` 回退路径。permit 粒度 = 1 MiB。
pub struct DecodeBudget {
    pub entry_dict: u64,
    /// 输出上限 = workspace_budget - entry_dict；**不是任务总许可**
    /// （总记账 = entry_dict + output_reserved，按 permit 粒度向上取整）
    pub output_cap: u64,
    output_reserved: u64,
    permits: Vec<tokio::sync::OwnedSemaphorePermit>,
    semaphore: Arc<tokio::sync::Semaphore>,
}

fn permit_count(bytes: u64) -> u32 {
    // 钳位 ≥1：零声明 + 零 dict 的条目也持最小许可（任务 7 "≥ 1 permit" 合同），
    // 谎报输出从 0 水位起首次 try_grow 即走增长路径。
    (((bytes + 1024 * 1024 - 1) / (1024 * 1024)).max(1)) as u32
}

impl DecodeBudget {
    /// Service 生产构造（async：初始许可需等待）：入口即执行声明预检——
    /// `declared.checked_add(entry_dict)` 溢出或超过 workspace_budget 直接 Err
    ///（终态 ResourceLimitExceeded，Service 步骤① 由本构造承载），
    /// 通过后 acquire 初始 permit（ceil(sum / 1 MiB) 个）并持有。
    pub async fn for_limits(
        limits: &ArchiveLimits,
        declared: u64,
        entry_dict: u64,
        semaphore: Arc<tokio::sync::Semaphore>,
    ) -> Result<Self, ArchiveAccessError> {
        let sum = declared
            .checked_add(entry_dict)
            .filter(|v| *v <= limits.workspace_budget_bytes)
            .ok_or_else(|| {
                ArchiveAccessError::ResourceLimitExceeded(
                    "declared + dictionary exceeds workspace budget".into(),
                )
            })?;
        // semaphore 从不显式 close，此分支仅防御 drop 竞态——单元变体，不带诊断串
        let permit = Arc::clone(&semaphore)
            .acquire_many_owned(permit_count(sum))
            .await
            .map_err(|_| ArchiveAccessError::Cancelled)?;
        Ok(Self {
            entry_dict,
            output_cap: limits.workspace_budget_bytes - entry_dict,
            output_reserved: declared,
            permits: vec![permit],
            semaphore,
        })
    }

    /// 同步非阻塞追加：差额 permit 立即并入 `permits` 持有（不持有即释放，记账失真）。
    /// 水位单调：`new_output_reserved <= output_reserved` 直接返回 true——初始水位等于
    /// declared（可能很大），首个小 chunk 的调用不得把水位改小、使字段值脱离已持 permits。
    pub fn try_grow(&mut self, new_output_reserved: u64) -> bool {
        if new_output_reserved <= self.output_reserved {
            return true;
        }
        let held = permit_count(self.entry_dict + self.output_reserved);
        let needed = permit_count(self.entry_dict + new_output_reserved);
        if needed > held {
            match Arc::clone(&self.semaphore).try_acquire_many_owned(needed - held) {
                Ok(permit) => self.permits.push(permit),
                Err(_) => return false,
            }
        }
        self.output_reserved = new_output_reserved;
        true
    }

    /// 测试直连 backend 时使用：1 TiB 虚拟信号量、单个 permit、grow 恒可满足、
    /// 不做预检（Service 生产路径永不构造它；dict/entry 声明值检查独立于 budget）。
    pub fn unbounded() -> Self {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1 << 20));
        let permit = Arc::clone(&semaphore).try_acquire_owned().unwrap();
        Self {
            entry_dict: 0,
            output_cap: u64::MAX,
            output_reserved: 0,
            permits: vec![permit],
            semaphore,
        }
    }
}

/// 测试便捷构造：`output_cap = cap`、许可近似无限（1 TiB 虚拟信号量）的 budget。
/// `LimitedEntryWriter::with_budget` 文档所指的 `budget_with_output_cap(cap)`。
#[cfg(test)]
pub fn budget_with_output_cap(cap: u64) -> DecodeBudget {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(1 << 20));
    let permit = Arc::clone(&semaphore).try_acquire_owned().unwrap();
    DecodeBudget {
        entry_dict: 0,
        output_cap: cap,
        output_reserved: 0,
        permits: vec![permit],
        semaphore,
    }
}

/// 受工作集预算约束的单条目写入器：单一 `Vec<u8>` + 受控增量扩容（不做
/// "分块缓冲 + 交付合并"——合并会在旧 chunks 释放前同时持有约 2×total，仍处
/// budget 生命周期却只按 total 计费）。不触发 Rust 默认几何倍增，也不存在二次
/// 合并分配。**已知限制**：`try_reserve_exact` 不是精确分配合同，allocator 实际
/// 物理分配可超过请求值——预算约束的是请求的 capacity（记账值），不宣称物理
/// RSS ≤ 预算；测试断言 记账 capacity + dictionary ≤ workspace_budget。
pub struct LimitedEntryWriter {
    buf: Vec<u8>,
    budget: DecodeBudget,
}

impl LimitedEntryWriter {
    /// 以 DecodeBudget 构造（budget 持 output_cap 与许可）；测试用 budget_with_output_cap(cap)
    /// 便捷构造一个 output_cap=cap、许可无限的 budget。
    pub fn with_budget(budget: DecodeBudget) -> Self {
        Self { buf: Vec::new(), budget }
    }

    /// 扩容决策单测步骤：为即将写入的 incoming_len 字节执行①–⑤（计费 + try_reserve_exact），
    /// 成功返回 (预算目标 capacity, Vec 当前真实 capacity)；不复制数据。**fallible 接口**：
    /// ① 的溢出/越限与 ④ 的增长失败分别返回携带 `LimitedEntryIoError`/`BudgetRetryIoError`
    /// marker 的 `io::Error`，⑤ `try_reserve_exact` 失败原样上抛——`write_all` 内部经 `?`
    /// 复用同一错误链，任何调用点都不得 unwrap（不可信归档的越限与许可竞争是常态输入，
    /// panic 会吞掉 Service 重排队协议所需的 marker）。
    pub fn ensure_capacity_for_write(&mut self, incoming_len: usize) -> std::io::Result<(u64, u64)> {
        // ① 溢出或超过 output_cap → 终态 marker（backend 边界恢复为 ResourceLimitExceeded）
        let required = (self.buf.len() as u64)
            .checked_add(incoming_len as u64)
            .filter(|v| *v <= self.budget.output_cap)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    LimitedEntryIoError { limit: self.budget.output_cap },
                )
            })?;
        // ② 扩容目标：**首次分配**（capacity == 0）按 max(required, min(1 MiB, output_cap))
        //    起步——小条目首块也拿 1 MiB 记账步长（任务 3 合同：fresh 600 KiB → 1 MiB）；
        //    **已有分配**时按 required 精确推进（任务 4 合同：len=512 KiB/capacity=1 MiB
        //    再预检 768 KiB → 目标恰为 1280 KiB，不因闲余步长翻倍到 2 MiB）。两合同在
        //    "required > capacity 时 target 必须完整覆盖本次 incoming"上一致（① 由 required
        //    保证；RAR callback 单次整块 p2 同样被 required 一次覆盖）。backend 调用方
        //    （zip read_entry）在解压前用声明大小做**单次**整段 ensure，分块写入全部落入
        //    既有 capacity，不触发逐块重分配；谎报头部的增长仍受 output_cap 终态拒绝。
        let current_capacity = self.buf.capacity() as u64;
        let target = if current_capacity == 0 {
            required.max((1024 * 1024).min(self.budget.output_cap))
        } else {
            required
        };
        // ④ 先 try_grow 计费（水位单调，≤ 已声明水位直接 true）；增长失败 → retry marker
        //    （backend 边界恢复为 BudgetRetryRequired，Service 触发增长-回退）
        if !self.budget.try_grow(target) {
            return Err(std::io::Error::new(std::io::ErrorKind::Other, BudgetRetryIoError));
        }
        // ⑤ additional 相对当前 len 而非 capacity：len < capacity 时传 目标 - capacity
        //    可能完全不扩容，随后写入触发未计费的隐式扩容绕过预算；分配失败原样上抛
        //    （OutOfMemory 携带原始 TryReserveError，不与两个 marker 混淆）
        let additional = target as usize - self.buf.len();
        if let Err(e) = self.buf.try_reserve_exact(additional) {
            return Err(std::io::Error::new(std::io::ErrorKind::OutOfMemory, e));
        }
        Ok((target, self.buf.capacity() as u64))
    }

    pub fn current_len(&self) -> usize {
        self.buf.len()
    }

    /// 交付缓冲区（backend `read_entry` 的返回载荷）：消费 writer，预算许可随之一并
    /// 释放（读取已完成，输出字节转入调用方所有，不再按 permit 记账）。
    pub fn finish(self) -> Vec<u8> {
        self.buf
    }

    /// 内部先 ensure（? 传播 marker）再复制；ensure 已保证 capacity ≥ len + incoming，
    /// extend 不触发未计费扩容。
    pub fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        self.ensure_capacity_for_write(buf.len())?;
        self.buf.extend_from_slice(buf);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_error_serializes_as_stable_tagged_shape() {
        let value = serde_json::to_value(
            ArchiveAccessError::UnsupportedCodec("PPMd".into()),
        ).unwrap();
        assert_eq!(value, serde_json::json!({
            "kind": "unsupportedCodec",
            "message": "PPMd"
        }));
        assert_eq!(
            serde_json::to_value(ArchiveAccessError::PasswordRequired).unwrap(),
            serde_json::json!({ "kind": "passwordRequired" })
        );
        // 内部 marker 的序列化守卫：skip_serializing 变体一旦被带到 IPC 边界即报错
        assert!(serde_json::to_value(ArchiveAccessError::BudgetRetryRequired).is_err());
    }

    #[test]
    fn limited_writer_grows_in_mib_steps_and_covers_large_incoming() {
        // 首次扩容：capacity 0 → 目标 = min(0 + 1 MiB, cap) = 1 MiB（记账值，不受分配器超额影响）
        let mut writer = LimitedEntryWriter::with_budget(budget_with_output_cap(5 * 1024 * 1024));
        let (target, real) = writer.ensure_capacity_for_write(600 * 1024).unwrap();
        assert_eq!(target, 1024 * 1024);
        assert!(real >= target);
        // RAR callback 单次整块 incoming 远超 1 MiB：扩容目标必须一次覆盖 required
        let mut writer = LimitedEntryWriter::with_budget(budget_with_output_cap(8 * 1024 * 1024));
        let (target, _) = writer.ensure_capacity_for_write(3 * 1024 * 1024).unwrap();
        assert_eq!(target, 3 * 1024 * 1024);
    }

    #[test]
    fn limited_writer_rejects_over_cap_with_terminal_marker() {
        let mut writer = LimitedEntryWriter::with_budget(budget_with_output_cap(1024 * 1024));
        let err = writer.ensure_capacity_for_write(1024 * 1024 + 1).unwrap_err();
        let marker = err.get_ref().unwrap().downcast_ref::<LimitedEntryIoError>().unwrap();
        assert_eq!(marker.limit, 1024 * 1024);
    }

    #[test]
    fn limited_writer_write_all_accounts_len_with_byte_exact_tail() {
        let mut writer = LimitedEntryWriter::with_budget(budget_with_output_cap(2 * 1024 * 1024));
        writer.write_all(b"hello").unwrap();
        assert_eq!(writer.current_len(), 5);
        // 尾块按字节精确计费：output_cap 非 MiB 对齐也能写满最后一字节
        let mut tail = LimitedEntryWriter::with_budget(budget_with_output_cap(1024 * 1024 + 512));
        let full = vec![0u8; 1024 * 1024 + 512];
        tail.write_all(&full).unwrap();
        assert_eq!(tail.current_len(), full.len());
        // 再多 1 字节 → 终态 marker（不是 retry marker）
        let err = tail.write_all(&[0u8]).unwrap_err();
        assert!(err.get_ref().unwrap().downcast_ref::<LimitedEntryIoError>().is_some());
    }

    #[tokio::test]
    async fn limited_writer_reports_retry_marker_when_budget_cannot_grow() {
        let limits = ArchiveLimits::for_test().budget_bytes(8 * 1024 * 1024);
        // 信号量恰好只剩初始 permit（acquire 后无闲余）：try_grow 必然失败 → retry marker
        let semaphore = Arc::new(tokio::sync::Semaphore::new(1));
        let budget = DecodeBudget::for_limits(&limits, 0, 0, semaphore).await.unwrap();
        let mut writer = LimitedEntryWriter::with_budget(budget);
        let err = writer.ensure_capacity_for_write(2 * 1024 * 1024).unwrap_err();
        assert!(err.get_ref().unwrap().downcast_ref::<BudgetRetryIoError>().is_some());
    }

    #[tokio::test]
    async fn decode_budget_for_limits_prechecks_and_try_grow_is_monotonic() {
        let limits = ArchiveLimits::for_test().budget_bytes(4 * 1024 * 1024);
        // declared + entry_dict 超过 workspace budget → 终态 ResourceLimitExceeded
        // （DecodeBudget 未实现 Debug，用 match 而非 unwrap_err 取错误）
        let err = match DecodeBudget::for_limits(
            &limits,
            3 * 1024 * 1024,
            2 * 1024 * 1024,
            Arc::new(tokio::sync::Semaphore::new(64)),
        )
        .await
        {
            Err(e) => e,
            Ok(_) => panic!("declared + dict 超 workspace budget 应被预检拒绝"),
        };
        assert!(matches!(err, ArchiveAccessError::ResourceLimitExceeded(_)));
        // 水位单调：不高于已声明水位的 try_grow 直接成功且不追加许可
        let mut budget = DecodeBudget::for_limits(
            &limits,
            1024 * 1024,
            0,
            Arc::new(tokio::sync::Semaphore::new(64)),
        )
        .await
        .unwrap();
        assert!(budget.try_grow(512 * 1024));
        assert_eq!(budget.output_reserved, 1024 * 1024);
        assert_eq!(budget.output_cap, 4 * 1024 * 1024);
    }
}
