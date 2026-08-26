//! 生产 transport：smb crate 0.11 真实接线（API 已对 registry 源码核对，见计划头部摘要）。
//! 每实例持一个已认证 Client + share 根 UncPath；由连接管理器管生命周期。

use super::transport::{ConnectParams, RawDirEntry, RawStat, SmbTransport, TransportError};
use smb::resource::Resource;
use smb::{Client, ClientConfig, Error as SmbError, FileAccessMask, UncPath};
use std::sync::Arc;

pub struct SmbClientTransport {
    client: Arc<Client>,
    share_root: tokio::sync::OnceCell<UncPath>,
}

impl SmbClientTransport {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Client::new(ClientConfig::default())),
            share_root: tokio::sync::OnceCell::new(),
        }
    }

    async fn tree(&self) -> Result<Arc<smb::Tree>, TransportError> {
        let root = self.share_root.get().ok_or_else(|| TransportError::Disconnected)?;
        self.client.get_tree(root).await.map_err(map_smb_error)
    }

    fn access() -> FileAccessMask {
        // rev1（核对 smb/tree.rs）：Tree::open_existing 第二个参数是 FileAccessMask
        // （非 AccessMask），由 smb 的 pub use smb_fscc::* 顶层 re-export 提供
        let mut m = FileAccessMask::new();
        m.set_generic_read(true);
        m
    }
}

/// smb::Error → TransportError（P1-3 修复：按 smb-0.11.2 error.rs 真实变体核对）。
/// 连接级（触发外层重连一次）：TransportError / ConnectionStopped / InvalidState /
/// NegotiationError / OperationTimeout / IoError（非 NotFound/PermissionDenied kind）。
/// 文件级：NotFound / MissingPermissions / ReceivedErrorMessage 按状态码分派。
fn map_smb_error(e: SmbError) -> TransportError {
    match &e {
        SmbError::TransportError(_) | SmbError::ConnectionStopped
        | SmbError::InvalidState(_) | SmbError::NegotiationError(_)
        | SmbError::OperationTimeout(_, _) => TransportError::Disconnected,
        SmbError::IoError(io) => match io.kind() {
            std::io::ErrorKind::NotFound => TransportError::FileNotFound(io.to_string()),
            std::io::ErrorKind::PermissionDenied => TransportError::PermissionDenied(io.to_string()),
            _ => TransportError::Io(io.to_string()),
        },
        SmbError::NotFound(p) => TransportError::FileNotFound(p.clone()),
        SmbError::MissingPermissions(p) => TransportError::PermissionDenied(p.clone()),
        // 实际签名 ReceivedErrorMessage(u32, ErrorResponse)——Status::U32_* 是 u32 常量，
        // 用 guard 比较（非枚举 match）；分派逻辑独立成纯函数供单测锁死。
        // 实机修正（2026-08-26，SMB NAS 登录失败）：Session Setup 的失败以
        // UnexpectedMessageStatus(u32) 形态上抛（与 ReceivedErrorMessage 并存的
        // crate TODO 语义）——此前落 `_ => Other` 兜底，Logon Failure 被端到端
        // 报成「网络错误」。同样走 map_status_code。
        SmbError::ReceivedErrorMessage(code, _) => map_status_code(*code, e.to_string()),
        SmbError::UnexpectedMessageStatus(code) => map_status_code(*code, e.to_string()),
        _ => TransportError::Other(e.to_string()),
    }
}

/// NT 状态码 u32 → TransportError（纯函数，可全常量覆盖测试）。
/// 常量名以 smb-msg 实际导出为准（编译期裁决：缺的常量删除对应臂，落 Other 兜底）。
///
/// 核对（smb-msg-0.11.2/src/header.rs）：
/// - `AccessDenied` → U32_ACCESS_DENIED
/// - `ObjectNameNotFound` → U32_OBJECT_NAME_NOT_FOUND
/// - `ObjectPathNotFound` → U32_OBJECT_PATH_NOT_FOUND
/// - `NetworkNameDeleted` → U32_NETWORK_NAME_DELETED
/// - `UserSessionDeleted` → U32_USER_SESSION_DELETED
/// - `NetworkSessionExpired` → U32_NETWORK_SESSION_EXPIRED（无 SessionExpired 变体）
/// - 无 ConnectionDisconnected 变体（删除对应臂）
///
/// Status 经 smb 顶层 `pub use smb_msg::*` re-export，**不在 smb::msg 子模块**。
fn map_status_code(code: u32, ctx: String) -> TransportError {
    use smb::Status as S;
    match code {
        c if c == S::U32_OBJECT_NAME_NOT_FOUND || c == S::U32_OBJECT_PATH_NOT_FOUND => {
            TransportError::FileNotFound(ctx)
        }
        c if c == S::U32_ACCESS_DENIED => TransportError::PermissionDenied(ctx),
        // LogonFailure 无 U32_ 常量（smb-msg 只定义枚举值）——枚举 as u32 比较。
        // 实机形态：用户名/密码错误时 Session Setup 返回 0xC000006D。
        c if c == S::LogonFailure as u32 => TransportError::PermissionDenied(ctx),
        c if c == S::U32_NETWORK_NAME_DELETED
            || c == S::U32_NETWORK_SESSION_EXPIRED
            || c == S::U32_USER_SESSION_DELETED => TransportError::Disconnected,
        _ => TransportError::Other(ctx),
    }
}

/// FileIdBothDirectoryInformation 公共字段（file_name/file_attributes/end_of_file/last_write_time）
/// 的中立抽取——避开 source.rs 直接依赖 smb-fscc 类型。
///
/// rev5 字段名修正：smb-fscc macro `query_dir_type!` 展开后是 `file_attributes`
/// （不是 `attributes`），`file_name` 类型是 `SizedWideString`（无 `as_str/to_string`，
/// 走 `String::try_from`）。
fn to_raw(info: &smb::FileIdBothDirectoryInformation) -> RawDirEntry {
    // FileTime 无 unix_100ns 访问器（rev3 修正）——用 since_epoch()（相对 1601 的 Duration）
    let since1601_100ns = info.last_write_time.since_epoch().as_nanos() as u64 / 100;
    let name = String::try_from(info.file_name.clone()).unwrap_or_default();
    RawDirEntry {
        name,
        // rev6 修正：FileAttributes::directory 是 `pub directory: bool` 字段，
        // 但通过 `bitfield 宏` 暴露了同名方法 `directory(&self) -> bool`
        // （method 版本更明确，bitfield 字段访问也合法——这里走 method 优先）
        is_directory: info.file_attributes.directory(),
        size: info.end_of_file,
        modified_unix_secs: super::transport::file_time_to_unix_secs(since1601_100ns).unwrap_or(0),
    }
}

#[async_trait::async_trait]
impl SmbTransport for SmbClientTransport {
    async fn connect(&self, params: &ConnectParams) -> Result<(), TransportError> {
        // P1-2 修复：smb crate 的端口经 server 字符串承载——TransportUtils::parse_socket_address
        // 对无 ':' 的 endpoint 补 ":0" 后由 TcpTransport::default_port() 落到 445；
        // 非 445 端口必须显式拼 "host:port"（已核对 smb-transport utils.rs/tcp.rs 源码）。
        let server = if params.port == 445 {
            params.host.clone()
        } else {
            format!("{}:{}", params.host, params.port)
        };
        let unc = UncPath::new(&server)
            .and_then(|u| u.with_share(&params.share))
            .map_err(|e| TransportError::InvalidPath(e.to_string()))?;
        self.client
            .share_connect(
                &unc,
                params.username.as_deref().unwrap_or("guest"),
                params.password.clone().unwrap_or_default(),
            )
            .await
            .map_err(map_smb_error)?;
        self.share_root.set(unc).ok(); // 幂等：重复 connect 保留首个
        Ok(())
    }

    async fn list(&self, rel: &str) -> Result<Vec<RawDirEntry>, TransportError> {
        use futures_util::StreamExt;
        let tree = self.tree().await?;
        let unc_rel = rel.replace('/', "\\");
        let resource: Resource = tree
            .open_existing(&unc_rel, Self::access())
            .await
            .map_err(map_smb_error)?;
        // P1 修复（终审）：URL 指向文件等类型不符时 unwrap_dir 会 panic（网络输入不可信）——
        // is_dir 先判类型（判定后 unwrap 不再 panic），不符返回受控 FileNotFound
        if !resource.is_dir() {
            return Err(TransportError::FileNotFound(format!("不是目录: {rel}")));
        }
        let dir = Arc::new(resource.unwrap_dir());
        // rev1 修正：Directory::query 是 `pub fn query(this: &Arc<Self>, pattern)` 返回 impl Future
        let mut stream = smb::Directory::query::<smb::FileIdBothDirectoryInformation>(&dir, "*")
            .await
            .map_err(map_smb_error)?;
        let mut out = Vec::new();
        while let Some(item) = stream.next().await {
            let info = item.map_err(map_smb_error)?;
            // 实机修正（2026-08-26，群晖等 NAS）：FSCC 语义上服务器「可以不返回」
            // "." / ".."，但实际实现普遍返回——必须在此过滤（Local/WebDAV 不会产生
            // 伪条目，SMB 不过滤会出现两个幽灵目录）；空名防御跳过
            let name = String::try_from(info.file_name.clone())
                .map_err(|e| TransportError::Io(e.to_string()))?;
            if name.is_empty() || name == "." || name == ".." {
                continue;
            }
            out.push(to_raw(&info));
        }
        Ok(out)
    }

    async fn read_block_exact(
        &self,
        rel: &str,
        offset: u64,
        buf: &mut [u8],
    ) -> Result<(), TransportError> {
        let tree = self.tree().await?;
        let resource = tree
            .open_existing(&rel.replace('/', "\\"), Self::access())
            .await
            .map_err(map_smb_error)?;
        // P1 修复（终审）：同 list——类型不符返回受控错误而非 panic
        if !resource.is_file() {
            return Err(TransportError::FileNotFound(format!("不是文件: {rel}")));
        }
        let file = resource.unwrap_file();
        // read_block 短读语义（返回实读数，EOF=0）→ 循环填满；EOF 早到=文件变小 → Disconnected
        // 触发外层重连一次兜底（spec §3.1 强契约：请求区间必须恰好）
        let mut filled = 0usize;
        while filled < buf.len() {
            let got = file
                .read_block(&mut buf[filled..], offset + filled as u64, None, false)
                .await
                // P1 修复（终审）：读块期间的 io 错误按 kind 分派——
                // NotFound→404 / PermissionDenied→403（map_smb_error 内 IoError 分支同款），
                // 其余才落 Io 连接级触发重连；此前一刀切 Io 把权限/不存在错误
                // 误升级成「断线重连 + 最终 502」。
                .map_err(|e| map_smb_error(SmbError::IoError(e)))?;
            if got == 0 {
                return Err(TransportError::Disconnected);
            }
            filled += got;
        }
        Ok(())
    }

    async fn stat(&self, rel: &str) -> Result<RawStat, TransportError> {
        let tree = self.tree().await?;
        let resource = tree
            .open_existing(&rel.replace('/', "\\"), Self::access())
            .await
            .map_err(map_smb_error)?;
        // P1-1（rev3）：FileStandardInformation 属 FileInformation 家族——只有
        // allocation_size/end_of_file/链接数/布尔标记，**没有 mtime**（mtime 字段在
        // DirectoryInformation 家族）。size 走 query_info::<FileStandardInformation>()；
        // mtime 走 ResourceHandle::modified() -> time::PrimitiveDateTime
        // （smb Cargo.toml 依赖 time 0.3.45；assume_utc/unix_timestamp 是 0.3 标准方法）。
        //
        // rev6 实装路径修正：`File` 自身 Deref 到 `ResourceHandle`（resource/file.rs line ~30），
        // 所以 `query_info/handle/modified` 三方法在 File 上直接可用（Deref 自动解引用）。
        // P1 修复（终审）：同 list/read——类型不符返回受控错误而非 panic
        if !resource.is_file() {
            return Err(TransportError::FileNotFound(format!("不是文件: {rel}")));
        }
        // `unwrap_file` 消耗 Resource 产出 File——先 query_info 拿 size，再 modified 拿时间。
        let file = resource.unwrap_file();
        let std_info: smb::FileStandardInformation = file
            .query_info()
            .await
            .map_err(map_smb_error)?;
        let modified_unix_secs = file.modified().assume_utc().unix_timestamp();
        Ok(RawStat {
            size: std_info.end_of_file,
            modified_unix_secs: Some(modified_unix_secs),
        })
    }
}

impl Default for SmbClientTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_classification_variants() {
        // P1-3：可构造变体逐一锁定（网络行为靠 spike/验收）
        assert!(matches!(
            map_smb_error(SmbError::TransportError(smb::transport::TransportError::NotConnected)),
            TransportError::Disconnected
        ));
        assert!(matches!(
            map_smb_error(SmbError::ConnectionStopped),
            TransportError::Disconnected
        ));
        assert!(matches!(
            map_smb_error(SmbError::InvalidState("s".into())),
            TransportError::Disconnected
        ));
        assert!(matches!(
            map_smb_error(SmbError::NotFound("x".into())),
            TransportError::FileNotFound(_)
        ));
        assert!(matches!(
            map_smb_error(SmbError::MissingPermissions("p".into())),
            TransportError::PermissionDenied(_)
        ));
        let io_nf = SmbError::IoError(std::io::Error::new(std::io::ErrorKind::NotFound, "nf"));
        assert!(matches!(map_smb_error(io_nf), TransportError::FileNotFound(_)));
    }

    /// 终审 P1-2 回归：读块期间的 io 错误按 kind 分派（非一刀切连接级）。
    /// read_block_exact 的 map_err 走 map_smb_error(SmbError::IoError(e))——
    /// PermissionDenied → 文件级 403（不触发重连）；Other kind 才落 Io 连接级。
    #[test]
    fn read_block_io_error_kind_dispatch_not_all_connection_level() {
        let pd = SmbError::IoError(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied mid-read",
        ));
        let mapped = map_smb_error(pd);
        assert!(matches!(mapped, TransportError::PermissionDenied(_)));
        assert!(
            !mapped.is_connection_level(),
            "权限错误不得触发断线重连（此前一刀切 Io 致 502）"
        );

        let other = SmbError::IoError(std::io::Error::new(
            std::io::ErrorKind::Other,
            "conn reset mid-read",
        ));
        assert!(matches!(map_smb_error(other), TransportError::Io(_)));
    }

    #[test]
    fn status_code_dispatch_full_coverage() {
        // map_status_code 纯函数：状态码分派全锁定（u32 直构，零网络）
        use smb::Status as S;
        assert!(matches!(
            map_status_code(S::U32_OBJECT_NAME_NOT_FOUND, "c".into()),
            TransportError::FileNotFound(_)
        ));
        assert!(matches!(
            map_status_code(S::U32_OBJECT_PATH_NOT_FOUND, "c".into()),
            TransportError::FileNotFound(_)
        ));
        assert!(matches!(
            map_status_code(S::U32_ACCESS_DENIED, "c".into()),
            TransportError::PermissionDenied(_)
        ));
        // 实机回归（2026-08-26）：Logon Failure（0xC000006D，用户名/密码错误）
        // 必须归 PermissionDenied（→ MediaSourceError::PermissionDenied/403 →
        // 前端 auth 档），不得落 Network 误导排查方向。enum as u32（无 U32_ 常量）。
        assert!(matches!(
            map_status_code(S::LogonFailure as u32, "c".into()),
            TransportError::PermissionDenied(_)
        ));
        // Session Setup 失败以 UnexpectedMessageStatus 形态上抛（与
        // ReceivedErrorMessage 并存）——两个变体都必须走 map_status_code
        assert!(matches!(
            map_smb_error(SmbError::UnexpectedMessageStatus(S::LogonFailure as u32)),
            TransportError::PermissionDenied(_)
        ));
        assert!(matches!(
            map_status_code(S::U32_NETWORK_NAME_DELETED, "c".into()),
            TransportError::Disconnected
        ));
        assert!(matches!(
            map_status_code(S::U32_NETWORK_SESSION_EXPIRED, "c".into()),
            TransportError::Disconnected
        ));
        assert!(matches!(
            map_status_code(0xC000_0001, "c".into()),
            TransportError::Other(_)
        )); // 未知码兜底
    }
}
