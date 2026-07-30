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
///
/// **字段命名约定**：variant 名 lowercase（TS 端 `type: 'local'`），字段 camelCase
/// （TS 端 `rootPath`）。每个字段用 `#[serde(rename = "...")]` 显式映射，
/// 匹配 TS 接口契约。Tauri 2.x IPC 不自动转换大小写。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SourceDescriptor {
    /// 本地文件系统路径
    Local {
        /// 绝对路径（如 `/Users/me/Documents/comics`）
        #[serde(rename = "rootPath")]
        root_path: String,
    },

    /// 压缩包（CBZ/CBR/ZIP/RAR/7z）
    Archive {
        /// 压缩包文件的绝对路径
        #[serde(rename = "archivePath")]
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
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "originEntryPath")]
        origin_entry_path: Option<String>,
        /// 压缩包在 origin 下的相对路径
        #[serde(default, skip_serializing_if = "Option::is_none", rename = "archiveRelPath")]
        archive_rel_path: Option<String>,
    },

    /// SMB 共享（Phase 7）
    Smb {
        #[serde(rename = "accountId")]
        account_id: i64,
        /// share 名称或 "share/folder" 深层路径
        #[serde(rename = "initialPath")]
        initial_path: String,
        /// 当前所在路径
        path: String,
        #[serde(default = "default_smb_port")]
        port: i32,
    },

    /// WebDAV 服务器（Phase 8）
    WebDav {
        #[serde(rename = "accountId")]
        account_id: i64,
        #[serde(rename = "baseUrl")]
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

#[cfg(test)]
mod tests {
    //! 锁住 SourceDescriptor 与 TS IPC 契约：variant 名 lower，字段名 camelCase。
    //! Tauri 2.x 不自动转换大小写——这一层是模块 #1 manual 验证暴露的契约 bug 的回归测试。

    use super::*;

    #[test]
    fn deserialize_local_from_camelcase_json() {
        // TS 端 `listDirectory({type:'local', rootPath:'C:/x'}, '')` 发出的 payload
        let json = r#"{"type":"local","rootPath":"C:/comics"}"#;
        let d: SourceDescriptor = serde_json::from_str(json).unwrap();
        match d {
            SourceDescriptor::Local { root_path } => assert_eq!(root_path, "C:/comics"),
            _ => panic!("应是 Local variant"),
        }
    }

    #[test]
    fn serialize_local_produces_camelcase_json() {
        let d = SourceDescriptor::Local {
            root_path: "C:/x".into(),
        };
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"rootPath\":\"C:/x\""), "应是 rootPath: {json}");
        assert!(!json.contains("\"root_path\""), "不应有 root_path: {json}");
    }

    #[test]
    fn deserialize_archive_from_camelcase_json() {
        let json = r#"{"type":"archive","archivePath":"C:/x.cbz","entryPrefix":"","format":"cbz"}"#;
        let d: SourceDescriptor = serde_json::from_str(json).unwrap();
        match d {
            SourceDescriptor::Archive { archive_path, entry_prefix, format, .. } => {
                assert_eq!(archive_path, "C:/x.cbz");
                assert_eq!(entry_prefix, "");
                assert_eq!(format, ArchiveFormat::Cbz);
            }
            _ => panic!("应是 Archive variant"),
        }
    }

    #[test]
    fn deserialize_smb_from_camelcase_json() {
        let json = r#"{"type":"smb","accountId":7,"initialPath":"share","path":"folder","port":445}"#;
        let d: SourceDescriptor = serde_json::from_str(json).unwrap();
        match d {
            SourceDescriptor::Smb { account_id, initial_path, path, port } => {
                assert_eq!(account_id, 7);
                assert_eq!(initial_path, "share");
                assert_eq!(path, "folder");
                assert_eq!(port, 445);
            }
            _ => panic!("应是 Smb variant"),
        }
    }

    #[test]
    fn deserialize_webdav_from_camelcase_json() {
        let json = r#"{"type":"webdav","accountId":3,"baseUrl":"https://dav.example.com","path":""}"#;
        let d: SourceDescriptor = serde_json::from_str(json).unwrap();
        match d {
            SourceDescriptor::WebDav { account_id, base_url, path } => {
                assert_eq!(account_id, 3);
                assert_eq!(base_url, "https://dav.example.com");
                assert_eq!(path, "");
            }
            _ => panic!("应是 WebDav variant"),
        }
    }

    #[test]
    fn variant_names_are_lowercase() {
        // TS 端 `type: 'local' | 'archive' | 'smb' | 'webdav'`
        for d in [
            SourceDescriptor::Local { root_path: "/a".into() },
            SourceDescriptor::WebDav { account_id: 1, base_url: "u".into(), path: "p".into() },
        ] {
            let json = serde_json::to_string(&d).unwrap();
            assert!(json.contains("\"type\":\"local\"") || json.contains("\"type\":\"webdav\""));
        }
    }
}