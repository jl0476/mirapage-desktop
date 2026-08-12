//! 路径工具
//!
//! 参考 MiraPage Android `PathUtils.kt:12`，用 Rust 重写。
//! 桌面端**不**用 SAF，路径就是普通字符串（绝对路径）。

/// 把路径切成 segments（按 `/` 或 `\` 分隔），去空段
pub fn segments(path: &str) -> Vec<String> {
    path.replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

/// 规范化路径：合并多余分隔符
pub fn normalize(path: &str) -> String {
    segments(path).join("/")
}

/// 拼接路径（`base` + `segment`）
pub fn join(base: &str, segment: &str) -> String {
    let norm_base = normalize(base);
    let norm_seg = normalize(segment);
    if norm_base.is_empty() {
        norm_seg
    } else {
        format!("{}/{}", norm_base, norm_seg)
    }
}

/// 取父目录（移除最后一段）
pub fn parent(path: &str) -> String {
    let segs = segments(path);
    if segs.len() <= 1 {
        String::new()
    } else {
        segs[..segs.len() - 1].join("/")
    }
}

/// 面包屑（每段累计路径）
pub fn crumbs(root_label: &str, path: &str) -> Vec<(String, String)> {
    let segs = segments(path);
    let mut result = vec![(root_label.to_string(), String::new())];
    let mut acc = String::new();
    for seg in segs {
        acc = if acc.is_empty() {
            seg.clone()
        } else {
            format!("{}/{}", acc, seg)
        };
        result.push((seg, acc.clone()));
    }
    result
}

/// source-relative path 校验错误。
///
/// 语义与前端 `src/lib/relativePath.ts::RelPathReason` 1:1。
/// 改一边务必同步另一边。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelPathError {
    /// 含 NUL 字节
    Nul,
    /// UNC 路径（\\\\server 或 //server 开头）
    Unc,
    /// Windows 盘符（^[A-Za-z]:）
    Drive,
    /// 以 / 或 \\ 开头的绝对路径
    Absolute,
    /// 任一段为 `..`（父目录引用）
    DotDot,
}

/// 校验并标准化 source-relative path。根目录 `""` 合法，返回 `Ok(String::new())`。
///
/// 接受：`""` / `a` / `a/b` / `a\\b`（统一为 `/`）。
/// 拒绝：盘符路径、以 `/` 或 `\\` 开头、UNC、任何 `..` 段、NUL 字节。
///
/// 绝对路径只允许出现在 `SourceDescriptor::rootPath`；currentPath / rel_path /
/// absolute_path / thumbnail rel_path 一律必须相对 root。
pub fn validate_source_relative(path: &str) -> Result<String, RelPathError> {
    // 1. NUL 字节（字节级最早检查）
    if path.contains('\0') {
        return Err(RelPathError::Nul);
    }

    // 2. UNC（双分隔符开头，优先于单分隔符 absolute）
    if path.starts_with(r"\\") || path.starts_with("//") {
        return Err(RelPathError::Unc);
    }

    // 3. Windows 盘符（^[A-Za-z]:）
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(RelPathError::Drive);
    }

    // 4. 单分隔符开头的绝对路径（/x 或 \x，已排除 \\ UNC）
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(RelPathError::Absolute);
    }

    // 5. 切段，查 .. 遍历（segments 会把 \\ → /、split、filter 空段）
    let segs = segments(path);
    if segs.iter().any(|s| s == "..") {
        return Err(RelPathError::DotDot);
    }

    // 6. 通过 → normalized 为 / join
    Ok(segs.join("/"))
}

/// 路径工具的命名空间包装（方便 `PathUtils::parent(...)` 调用）
pub struct PathUtils;

impl PathUtils {
    pub fn segments(path: &str) -> Vec<String> {
        segments(path)
    }
    pub fn normalize(path: &str) -> String {
        normalize(path)
    }
    pub fn join(base: &str, segment: &str) -> String {
        join(base, segment)
    }
    pub fn parent(path: &str) -> String {
        parent(path)
    }
    pub fn crumbs(root_label: &str, path: &str) -> Vec<(String, String)> {
        crumbs(root_label, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_segments() {
        assert_eq!(segments("a/b/c"), vec!["a", "b", "c"]);
        assert_eq!(segments("a\\b\\c"), vec!["a", "b", "c"]);
        assert_eq!(segments("/a/b/"), vec!["a", "b"]);
        assert_eq!(segments(""), Vec::<String>::new());
    }

    #[test]
    fn test_normalize() {
        assert_eq!(normalize("a//b\\\\c"), "a/b/c");
    }

    #[test]
    fn test_join() {
        assert_eq!(join("a/b", "c/d"), "a/b/c/d");
        assert_eq!(join("a/b", "/c/d"), "a/b/c/d");
        assert_eq!(join("", "a"), "a");
    }

    #[test]
    fn test_parent() {
        assert_eq!(parent("a/b/c"), "a/b");
        assert_eq!(parent("a"), "");
        assert_eq!(parent(""), "");
    }

    #[test]
    fn test_crumbs() {
        // crumbs = root label 1 项 + 每段累计 1 项 = 1 + 3 = 4 项
        let c = crumbs("Root", "docs/comics/x");
        assert_eq!(c.len(), 4);
        assert_eq!(c[0], ("Root".to_string(), "".to_string()));
        assert_eq!(c[1], ("docs".to_string(), "docs".to_string()));
        assert_eq!(c[2], ("comics".to_string(), "docs/comics".to_string()));
        assert_eq!(c[3], ("x".to_string(), "docs/comics/x".to_string()));
    }

    // ── validate_source_relative（与前端 relativePath.ts 1:1）──

    #[test]
    fn test_validate_root_empty() {
        assert_eq!(validate_source_relative(""), Ok(String::new()));
    }

    #[test]
    fn test_validate_single_segment() {
        assert_eq!(validate_source_relative("normal"), Ok("normal".to_string()));
    }

    #[test]
    fn test_validate_multi_segment_slash() {
        assert_eq!(validate_source_relative("raw/竖版"), Ok("raw/竖版".to_string()));
    }

    #[test]
    fn test_validate_backslash_normalized() {
        assert_eq!(validate_source_relative(r"raw\竖版"), Ok("raw/竖版".to_string()));
    }

    #[test]
    fn test_validate_mixed_separators() {
        assert_eq!(validate_source_relative(r"a//b\\c"), Ok("a/b/c".to_string()));
    }

    #[test]
    fn test_validate_trailing_slash_trimmed() {
        assert_eq!(validate_source_relative("a/b/"), Ok("a/b".to_string()));
    }

    #[test]
    fn test_validate_reject_drive() {
        assert_eq!(validate_source_relative("F:"), Err(RelPathError::Drive));
        assert_eq!(validate_source_relative("F:/WallPaper"), Err(RelPathError::Drive));
        assert_eq!(validate_source_relative(r"F:\WallPaper"), Err(RelPathError::Drive));
        assert_eq!(validate_source_relative("d:/x"), Err(RelPathError::Drive));
    }

    #[test]
    fn test_validate_reject_absolute() {
        assert_eq!(validate_source_relative("/etc/passwd"), Err(RelPathError::Absolute));
        assert_eq!(validate_source_relative(r"\WallPaper"), Err(RelPathError::Absolute));
    }

    #[test]
    fn test_validate_reject_unc() {
        assert_eq!(validate_source_relative(r"\\server\share"), Err(RelPathError::Unc));
        assert_eq!(validate_source_relative("//server/share"), Err(RelPathError::Unc));
    }

    #[test]
    fn test_validate_reject_dotdot() {
        assert_eq!(validate_source_relative(".."), Err(RelPathError::DotDot));
        assert_eq!(validate_source_relative("../x"), Err(RelPathError::DotDot));
        assert_eq!(validate_source_relative("a/../b"), Err(RelPathError::DotDot));
        assert_eq!(validate_source_relative("a/.."), Err(RelPathError::DotDot));
    }

    #[test]
    fn test_validate_accept_dotdot_substring_in_name() {
        // '..b' / 'a..' 是合法文件名段（.. 不是整段）
        assert_eq!(validate_source_relative("..b"), Ok("..b".to_string()));
        assert_eq!(validate_source_relative("a.."), Ok("a..".to_string()));
    }

    #[test]
    fn test_validate_reject_nul() {
        assert_eq!(validate_source_relative("a\0b"), Err(RelPathError::Nul));
    }
}