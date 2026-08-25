//! archive-msrv-smoke：新增归档依赖子集的 Rust 1.75 MSRV 正向证明（任务 14）。
//!
//! 主仓库全树 1.75 被预存在的 `smb → aead`（edition2024）阻断，本 crate 以隔离
//! 依赖图实际编译并调用 zip / unrar_sys / sevenz-rust / lzma-rust / aes / cbc /
//! zeroize 的关键 API；测试断言锁文件钉版与关键类型可用，防止裸 `cargo update`
//! 顶破钉版后静默漂移。CI 在 `verify.yml` 用 `cargo +1.75.0 check` 编译本 crate
//!（见 `.github/workflows/verify.yml` MSRV 步骤）。

#![allow(dead_code)]

use std::io::Cursor;

/// zip：`ZipArchive::new` + 条目计数（读侧 API 面，含 aes-crypto feature）。
fn zip_api_surface(bytes: &[u8]) -> Result<usize, zip::result::ZipError> {
    let archive = zip::ZipArchive::new(Cursor::new(bytes))?;
    Ok(archive.len())
}

/// unrar_sys：C++ 内核链接性证明。`RARGetDllVersion` 无副作用、无参数，
/// 返回 UnRAR vendor 版本号（> 0），是唯一可在无 fixture 环境安全调用的入口。
fn unrar_dll_version() -> i32 {
    unsafe { unrar_sys::RARGetDllVersion() }
}

/// sevenz-rust：`Password` 构造 + `SevenZReader::open` 错误路径（aes256 + compress
/// feature 下的读侧 API 面；打开不存在的路径返回 Err 即证明类型与符号可用）。
fn sevenz_api_surface(path: &std::path::Path) -> Result<(), sevenz_rust::Error> {
    let password = sevenz_rust::Password::from("smoke");
    let mut reader = sevenz_rust::SevenZReader::open(path, password)?;
    reader.for_each_entries(|_entry, _reader| Ok(true))?;
    Ok(())
}

/// aes + cbc：7z header 预检用的 AES-CBC 解密类型面（aes 的 zeroize feature）。
fn aes_cbc_type_surface(key: &[u8; 32]) {
    use aes::cipher::{KeyInit, KeyIvInit};
    type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
    let _cipher = aes::Aes256::new(key.into()); // KeyInit 面
    let _dec: Aes256CbcDec = Aes256CbcDec::new(key.into(), (&[0u8; 16]).into()); // KeyIvInit 面
}

/// zeroize：密码容器 `Zeroizing`（会话内存密码生命周期约束的载体类型）。
fn zeroize_api_surface(secret: &[u8]) -> zeroize::Zeroizing<Vec<u8>> {
    zeroize::Zeroizing::new(secret.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 锁文件钉版断言：直接解析本 crate 的 Cargo.lock，逐包断言精确版本。
    /// 任何裸 `cargo update` 顶破钉版（如 zeroize_derive 1.5.0 = edition2024）
    /// 都会让 1.75 编译失败之外再在此处显式报错，指明漂移的包名。
    #[test]
    fn locked_dependency_versions_match_msrv_pins() {
        let lock = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"))
            .expect("Cargo.lock must be committed alongside this crate");
        let mut versions: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let mut current_name: Option<String> = None;
        for line in lock.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("name = ") {
                current_name = Some(rest.trim_matches('"').to_string());
            } else if let Some(rest) = line.strip_prefix("version = ") {
                if let Some(name) = current_name.take() {
                    versions.insert(name, rest.trim_matches('"').to_string());
                }
            }
        }
        // 直接依赖：与 src-tauri/Cargo.toml 归档段逐字一致
        for (name, expected) in [
            ("zip", "2.4.2"),
            ("unrar_sys", "0.5.8"),
            ("sevenz-rust", "0.6.1"),
            ("lzma-rust", "0.1.7"),
            ("zeroize", "1.8.1"),
            ("aes", "0.8.4"),
            ("cbc", "0.1.2"),
        ] {
            assert_eq!(
                versions.get(name).map(String::as_str),
                Some(expected),
                "dependency {name} drifted from MSRV pin (bare `cargo update` run?)"
            );
        }
        // 传递钉版：这些包的最新版是 edition2024 或 rust>=1.80，1.75 无法解析/编译
        for (name, expected) in [
            ("zeroize_derive", "1.4.2"),
            ("indexmap", "2.11.4"),
            ("time", "0.3.41"),
            ("jobserver", "0.1.32"),
            ("crc", "3.0.1"),
            ("deflate64", "0.1.9"),
        ] {
            assert_eq!(
                versions.get(name).map(String::as_str),
                Some(expected),
                "transitive {name} drifted from MSRV pin (bare `cargo update` run?)"
            );
        }
    }

    #[test]
    fn zip_api_compiles_and_rejects_non_archive_input() {
        let err = zip_api_surface(b"not a zip").unwrap_err();
        assert!(matches!(err, zip::result::ZipError::InvalidArchive(_)));
    }

    #[test]
    fn unrar_native_core_links_and_reports_version() {
        assert!(unrar_dll_version() > 0);
    }

    #[test]
    fn sevenz_api_compiles_and_open_fails_for_missing_path() {
        let missing = std::env::temp_dir().join("archive-msrv-smoke-nonexistent.7z");
        assert!(sevenz_api_surface(&missing).is_err());
    }

    #[test]
    fn aes_cbc_and_zeroize_type_surfaces_compile() {
        aes_cbc_type_surface(&[7u8; 32]);
        let secret = zeroize_api_surface(b"smoke-secret");
        assert_eq!(secret.as_slice(), b"smoke-secret");
    }
}
