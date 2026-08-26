//! UNC 路径拼接 + 根路径契约（母 spec §4.2 双侧校验的 source 侧）。

/// descriptor 的 '/' 分隔 rel → UNC '\' 分隔（相对 share 的路径段拼接）。
///
/// 契约（§4.2）：initialPath 首段 === share。transport rel 语义是「相对 share 根」，
/// 而 share 连接（tree）本身已定位在 share 内——**首段必须剥离**，否则拼出
/// `\\host\share\share\...` 重复段（实机 2026-08-26「提升当前目录为根」暴露：
/// initial `Other1/wall` 被整体拼到 share 后 → Object Path Not Found）。
/// 空 initial = share 根（459bf78 实机修正），无段可剥。
pub fn unc_rel(initial_path: &str, path: &str) -> String {
    let b = path.replace(['/', '\\'], "\\");
    let b = b.trim_matches('\\');
    let below_share = if initial_path.is_empty() {
        String::new()
    } else {
        initial_path
            .replace(['/', '\\'], "\\")
            .trim_matches('\\')
            .splitn(2, '\\')
            .nth(1)
            .unwrap_or("")
            .to_string()
    };
    match (below_share.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (false, true) => below_share.to_string(),
        (false, false) => format!("{below_share}\\{b}"),
    }
}

/// 根路径契约：initialPath 首段必须等于 account.share（share NULL 视为配置错误）。
pub fn share_root_matches(initial_path: &str, account_share: Option<&str>) -> Result<(), &'static str> {
    let Some(share) = account_share else {
        return Err("账户缺少 share 配置（固定共享根必填）");
    };
    // 空 initial = share 根（实机修正 2026-08-26：原契约下 share 根不可达——
    // initial 非空时 unc_rel 会把它拼进相对路径，列「initial 自身」需 share 根下
    // 存在同名子目录，M2 待实机标注期间从未暴露。同日二次修正：unc_rel 现在
    // 剥离首段，非空 initial 的「share/子路径」形态不再依赖镜像同名子目录）
    if initial_path.is_empty() {
        return Ok(());
    }
    let first = initial_path.split('/').next().unwrap_or("");
    if first.is_empty() || first != share {
        return Err("initialPath 首段必须等于 account.share（跨 share 访问被拒绝）");
    }
    Ok(())
}

/// full_rel（含 initial_path 前缀的 '/' 分隔路径）→ 相对 initial_path 的子路径。
/// 前缀不符返回 None（调用方按 PathEscape 拒绝）。
pub fn strip_initial_prefix(initial_path: &str, full_rel: &str) -> Option<String> {
    let init = initial_path.trim_matches('/');
    let full = full_rel.trim_matches('/');
    if init.is_empty() {
        return Some(full.to_string());
    }
    full.strip_prefix(&format!("{init}/"))
        .map(|s| s.to_string())
        .or(if full == init { Some(String::new()) } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_join_converts_slashes() {
        // descriptor path 是 '/' 分隔的 source-relative；UNC 用 '\'。
        // 首段 = share，拼接时剥离（tree 已在 share 内）
        assert_eq!(unc_rel("comics/v1", "001.jpg"), r"v1\001.jpg");
        assert_eq!(unc_rel("", "001.jpg"), "001.jpg");       // 空 initial = share 根
        assert_eq!(unc_rel("comics", ""), "");               // initial == share → share 根
        assert_eq!(unc_rel("comics", "f.bin"), "f.bin");
        assert_eq!(unc_rel("media/comics", "v1"), r"comics\v1");
    }

    #[test]
    fn share_contract_first_segment_must_match() {
        // 根路径契约（母 spec §4.2）：initialPath 首段 === account.share
        assert!(share_root_matches("media", Some("media")).is_ok());
        assert!(share_root_matches("media/comics", Some("media")).is_ok());
        assert!(share_root_matches("other", Some("media")).is_err());   // 跨 share 越权
        assert!(share_root_matches("media", None).is_err());            // share NULL = 配置错误
        // 实机修正（2026-08-26）：空 initial = share 根，合法——原「首段不存在即拒」
        // 使 share 根不可达（initial 非空会被 unc_rel 拼成 share 内同名子目录）
        assert!(share_root_matches("", Some("media")).is_ok());
    }

    #[test]
    fn rel_below_initial_path() {
        // MediaSource.path 参数语义：相对 initial_path 的子路径（不含 initial_path 前缀）
        assert_eq!(strip_initial_prefix("media/comics", "media/comics/v1"), Some("v1".to_string()));
        assert_eq!(strip_initial_prefix("media", "media"), Some(String::new()));
        assert_eq!(strip_initial_prefix("media", "other/x"), None); // 前缀不符
    }
}