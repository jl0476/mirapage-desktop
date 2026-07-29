//! `SourceDescriptor` 枚举 + `MediaEntry` 数据结构
//!
//! **设计原则**：所有字段都是 String / Long / Int，与 MiraPage Android 的
//! `SourceDescriptorJson.encode()` 字节级兼容（未来可做 Android ↔ Desktop 备份互导）。

use serde::{Deserialize, Serialize};

/// 压缩包格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveFormat {
    Cbz,   // ZIP 容器
    Cbr,   // RAR 容器
    Zip,   // 独立 ZIP
    Rar,   // 独立 RAR
    SevenZ, // 7z
}

impl ArchiveFormat {
    /// 从扩展名推断（不含前导 `.`，小写）
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_lowercase().as_str() {
            "cbz" => Some(Self::Cbz),
            "cbr" => Some(Self::Cbr),
            "zip" => Some(Self::Zip),
            "rar" => Some(Self::Rar),
            "7z" => Some(Self::SevenZ),
            _ => None,
        }
    }

    /// MIME 类型 / 显示名
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Cbz => "CBZ (Comic Book ZIP)",
            Self::Cbr => "CBR (Comic Book RAR)",
            Self::Zip => "ZIP Archive",
            Self::Rar => "RAR Archive",
            Self::SevenZ => "7-Zip Archive",
        }
    }
}

/// 媒体源描述符（前端通过 JSON 传来）
///
/// 与 MiraPage Android `SourceDescriptor` 语义对齐：
/// - Local：本地文件系统路径（绝对路径）
/// - Archive：压缩包（本地或缓存目录内）
/// - Smb：SMB 网络共享（Phase 7 启用）
/// - WebDav：WebDAV 服务器（Phase 8 启用）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SourceDescriptor {
    /// 本地文件系统路径
    Local {
        /// 绝对路径（如 `/Users/me/Documents/comics`）
        root_path: String,
    },

    /// 压缩包（CBZ/CBR/ZIP/RAR/7z）
    Archive {
        /// 压缩包文件的绝对路径
        archive_path: String,
        /// 压缩包内的子目录（可选；空 = 根条目）
        #[serde(default)]
        entry_prefix: String,
        /// 压缩包格式
        format: ArchiveFormat,
        /// 原始源（Local/Smb）；None = 压缩包本身就是书
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<Box<SourceDescriptor>>,
        /// 原始源下的压缩包相对路径（用于 history/progress key 对齐）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin_entry_path: Option<String>,
        /// 压缩包在 origin 下的相对路径
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archive_rel_path: Option<String>,
    },

    /// SMB 共享（Phase 7）
    Smb {
        account_id: i64,
        /// share 名称或 "share/folder" 深层路径
        initial_path: String,
        /// 当前所在路径
        path: String,
        #[serde(default = "default_smb_port")]
        port: i32,
    },

    /// WebDAV 服务器（Phase 8）
    WebDav {
        account_id: i64,
        base_url: String,
        path: String,
    },
}

fn default_smb_port() -> i32 {
    445
}

impl SourceDescriptor {
    /// 用于 SourceKeyer 的稳定 cache key 前缀
    pub fn id(&self) -> String {
        match self {
            Self::Local { root_path } => format!("local://{}", root_path),
            Self::Archive { archive_path, .. } => format!("archive://{}", archive_path),
            Self::Smb { account_id, initial_path, path, port } => {
                format!("smb://{}@{}:{}{}{}", account_id, initial_path, port, initial_path, path)
            }
            Self::WebDav { account_id, base_url, path } => {
                format!("webdav://{}@{}{}", account_id, base_url, path)
            }
        }
    }

    /// 类型字符串（"local" / "archive" / "smb" / "webdav"）
    pub fn type_str(&self) -> &'static str {
        match self {
            Self::Local { .. } => "local",
            Self::Archive { .. } => "archive",
            Self::Smb { .. } => "smb",
            Self::WebDav { .. } => "webdav",
        }
    }
}

/// 目录项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaEntry {
    /// 显示名（含扩展名）
    pub name: String,
    /// 相对父目录的路径
    pub path: String,
    /// 是否目录
    pub is_directory: bool,
    /// 是否压缩包
    #[serde(default)]
    pub is_archive: bool,
    /// 文件大小（字节，目录时为 0）
    #[serde(default)]
    pub size: u64,
    /// 最后修改时间（Unix 时间戳，秒）
    #[serde(default)]
    pub modified_at: Option<i64>,
}