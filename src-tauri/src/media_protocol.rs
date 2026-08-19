//! media:// 协议纯函数层（spec rev3 §3.1）
//! 编码铁律：每个逻辑字段整体 percent-encode 为恰好一个 segment（字段内 `/` → `%2F`），
//! URL 段数固定，解析可逆。解码恰好一次，安全性靠结构化路径校验，不靠字符黑名单。

#[derive(Debug, PartialEq, Eq)]
pub enum MediaTarget {
    Local { abs_path: String },
    Smb { account_id: i64, initial_path: String, rel_path: String },
    WebDav { account_id: i64, rel_path: String },
    Archive {
        origin: String,
        account_id: Option<i64>,
        /// origin="local" → 压缩包绝对路径；origin="smb" → initialPath
        origin_ref: String,
        archive_rel_path: Option<String>,
        entry_path: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum ProtocolError {
    BadShape(&'static str),      // 段数/类型不符 → 404
    InvalidEncoding,             // 非法 % 序列 → 403
    InvalidPath(&'static str),   // 结构化校验失败 → 403
}

/// percent-encode：unreserved [A-Za-z0-9\-_.~] 原样，其余 %XX 大写 hex
pub fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// decode 恰好一次；裸 % / 非 hex / 截断 → Err
pub fn decode_segment(s: &str) -> Result<String, ProtocolError> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if bytes.len() < i + 3 {
                return Err(ProtocolError::InvalidEncoding);
            }
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            match (hi, lo) {
                (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
                _ => return Err(ProtocolError::InvalidEncoding),
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| ProtocolError::InvalidEncoding)
}

/// 相对路径结构化校验（源内 relPath / initialPath / archiveRelPath / entryPath 共用）
pub fn validate_rel_path(p: &str) -> Result<(), ProtocolError> {
    if p.is_empty() || p.starts_with('/') || p.contains('\\') {
        return Err(ProtocolError::InvalidPath("空/绝对/反斜杠"));
    }
    for seg in p.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return Err(ProtocolError::InvalidPath("空段或点段"));
        }
    }
    Ok(())
}

/// 本地绝对路径校验（Windows 盘符或 UNC 开头；拒绝相对形态与 `..` 段）。
/// 按路径段拒绝——只拒绝恰好等于 ".." 的 segment，`foo..bar.jpg` 等含连续点的合法文件名放行。
pub fn validate_abs_path(p: &str) -> Result<(), ProtocolError> {
    let ok = p.len() >= 3 && p.as_bytes()[1] == b':' && p.as_bytes()[2] == b'/'
        || p.starts_with(r"\\");
    if !ok {
        return Err(ProtocolError::InvalidPath("非绝对路径"));
    }
    if p.split(['/', '\\']).any(|seg| seg == "..") {
        return Err(ProtocolError::InvalidPath("含 .. 段"));
    }
    Ok(())
}

/// 解析 media 协议 path（`/type/...` 形态；Windows 下宿主是 media.localhost，path 即此处入参）
pub fn parse_media_path(path: &str) -> Result<MediaTarget, ProtocolError> {
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let n = segs.len();
    let acct = |s: &str| -> Result<i64, ProtocolError> {
        s.parse::<i64>().map_err(|_| ProtocolError::BadShape("accountId 非数字"))
    };
    match segs.first().copied() {
        Some("local") if n == 2 => {
            let p = decode_segment(segs[1])?;
            validate_abs_path(&p)?;
            Ok(MediaTarget::Local { abs_path: p })
        }
        Some("webdav") if n == 3 => {
            let id = acct(segs[1])?;
            let p = decode_segment(segs[2])?;
            validate_rel_path(&p)?;
            Ok(MediaTarget::WebDav { account_id: id, rel_path: p })
        }
        Some("smb") if n == 4 => {
            let id = acct(segs[1])?;
            let init = decode_segment(segs[2])?;
            let rel = decode_segment(segs[3])?;
            validate_rel_path(&init)?;
            validate_rel_path(&rel)?;
            Ok(MediaTarget::Smb { account_id: id, initial_path: init, rel_path: rel })
        }
        Some("archive") if n == 5 && segs[1] == "webdav" => {
            let id = acct(segs[2])?;
            let ar = decode_segment(segs[3])?;
            let entry = decode_segment(segs[4])?;
            validate_rel_path(&ar)?;
            validate_rel_path(&entry)?;
            Ok(MediaTarget::Archive {
                origin: "webdav".into(),
                account_id: Some(id),
                origin_ref: String::new(),
                archive_rel_path: Some(ar),
                entry_path: entry,
            })
        }
        Some("archive") if n == 6 && segs[1] == "smb" => {
            let id = acct(segs[2])?;
            let init = decode_segment(segs[3])?;
            let ar = decode_segment(segs[4])?;
            let entry = decode_segment(segs[5])?;
            validate_rel_path(&init)?;
            validate_rel_path(&ar)?;
            validate_rel_path(&entry)?;
            Ok(MediaTarget::Archive {
                origin: "smb".into(),
                account_id: Some(id),
                origin_ref: init,
                archive_rel_path: Some(ar),
                entry_path: entry,
            })
        }
        Some("archive") if n == 4 && segs[1] == "local" => {
            let abs = decode_segment(segs[2])?;
            let entry = decode_segment(segs[3])?;
            validate_abs_path(&abs)?;
            validate_rel_path(&entry)?;
            Ok(MediaTarget::Archive {
                origin: "local".into(),
                account_id: None,
                origin_ref: abs,
                archive_rel_path: None,
                entry_path: entry,
            })
        }
        _ => Err(ProtocolError::BadShape("段数/类型不符")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_single_segment() {
        assert_eq!(encode_segment("a/b"), "a%2Fb");          // 字段内 / 必须编码（单段铁律）
        assert_eq!(encode_segment("100%.jpg"), "100%25.jpg");
        assert_eq!(encode_segment("中文"), "%E4%B8%AD%E6%96%87");
        assert_eq!(encode_segment("plain-A_1.txt"), "plain-A_1.txt"); // unreserved 原样
        assert_eq!(encode_segment(r"C:\x"), "C%3A%5Cx");
    }

    #[test]
    fn decode_rejects_invalid_pct_and_bare_percent() {
        assert_eq!(decode_segment("a%2Fb").unwrap(), "a/b");
        assert_eq!(decode_segment("100%25.jpg").unwrap(), "100%.jpg"); // 含 % 合法文件名（rev3）
        assert!(decode_segment("100%.jpg").is_err());   // 裸 % 非法编码
        assert!(decode_segment("%zz").is_err());        // 非 hex
        assert!(decode_segment("%2").is_err());         // 截断
    }

    #[test]
    fn parse_local() {
        let t = parse_media_path(&format!("/local/{}", encode_segment("D:/comics/x.jpg"))).unwrap();
        assert!(matches!(t, MediaTarget::Local { ref abs_path } if abs_path == "D:/comics/x.jpg"));
    }

    #[test]
    fn parse_webdav_fixed_segments() {
        let p = format!("/webdav/7/{}", encode_segment("sub/页.jpg"));
        let t = parse_media_path(&p).unwrap();
        assert!(matches!(t, MediaTarget::WebDav { account_id: 7, ref rel_path } if rel_path == "sub/页.jpg"));
    }

    #[test]
    fn parse_smb_initial_path_single_segment() {
        let p = format!("/smb/3/{}/{}", encode_segment("share/comics"), encode_segment("v1/001.jpg"));
        match parse_media_path(&p).unwrap() {
            MediaTarget::Smb { account_id, ref initial_path, ref rel_path } => {
                assert_eq!((account_id, initial_path.as_str(), rel_path.as_str()),
                           (3, "share/comics", "v1/001.jpg"));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parse_archive_local_and_remote() {
        let p = format!("/archive/local/{}/{}", encode_segment("D:/a.cbz"), encode_segment("inner/p1.jpg"));
        assert!(matches!(parse_media_path(&p).unwrap(), MediaTarget::Archive { ref origin, .. }
            if matches!(origin.as_str(), "local")));
        let p2 = format!("/archive/webdav/7/{}/{}", encode_segment("books/a.zip"), encode_segment("p1.jpg"));
        assert!(matches!(parse_media_path(&p2).unwrap(), MediaTarget::Archive { ref origin, .. }
            if matches!(origin.as_str(), "webdav")));
    }

    #[test]
    fn parse_rejects_bad_shapes() {
        assert!(parse_media_path("/smb/3").is_err());                       // 段数不足
        assert!(parse_media_path("/smb/3/a/b/c").is_err());                 // 段数过多
        assert!(parse_media_path("/ftp/1/x").is_err());                     // 未知类型
        let dotdot = encode_segment("../etc/passwd");
        assert!(parse_media_path(&format!("/local/{dotdot}")).is_err());    // 结构化校验：..
        let abs = encode_segment("/etc/passwd");
        assert!(parse_media_path(&format!("/webdav/1/{abs}")).is_err());    // 绝对路径
        let empty = encode_segment("");
        assert!(parse_media_path(&format!("/webdav/1/{empty}")).is_err());  // 空字段
        assert!(parse_media_path(&format!("/smb/x/{}/y", encode_segment("s"))).is_err()); // accountId 非数字
    }

    #[test]
    fn validate_rel_path_rules() {
        assert!(validate_rel_path("a/b/c.jpg").is_ok());
        assert!(validate_rel_path("").is_err());
        assert!(validate_rel_path("../x").is_err());
        assert!(validate_rel_path("a/../../x").is_err());
        assert!(validate_rel_path("/abs").is_err());
        assert!(validate_rel_path("a//b").is_err());       // 空段
        assert!(validate_rel_path("a/./b").is_err());
        assert!(validate_rel_path("a\\b").is_err());       // 反斜杠拒绝（统一 / 语义）
        assert!(validate_rel_path("100%.jpg").is_ok());    // % 合法（rev3）
        // local 绝对路径走独立分支
        assert!(validate_abs_path("D:/x/y.jpg").is_ok());
        assert!(validate_abs_path("relative/path").is_err());
        assert!(validate_abs_path("D:/comics/foo..bar.jpg").is_ok()); // rev5：连续点文件名合法，只拒 `..` 段
        assert!(validate_abs_path("D:/comics/../secret").is_err());
    }
}
