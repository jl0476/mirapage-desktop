//! 远程图片预读预载（spec rev5 §3.6 / 计划任务 17，rev8 会话协议）。
//! 命令定义放独立模块——Tauri 宏在定义处生成 `__cmd__X`，与 lib.rs 内注册的同名导入冲突。

use tauri::Manager;

// ─── module3.2.0（spec rev5 §3.6 / rev8）：远程图片预读预载 warm 会话协议 ───

/// 预热会话状态（Rust 侧真值源——前端 ref 递增不通知后端，取消必须走 IPC）：
/// session_id = ReaderView 挂载时 crypto.randomUUID()（每次挂载唯一）；
/// generation = 同一挂载内 openBook/切书时递增。
/// 任何 advance 调用无条件覆盖当前会话 → 所有旧 (session_id, generation) 任务作废。
static WARM_SESSION: std::sync::OnceLock<std::sync::Mutex<(String, u64)>> =
    std::sync::OnceLock::new();

fn warm_session_current() -> (String, u64) {
    WARM_SESSION
        .get_or_init(|| std::sync::Mutex::new((String::new(), 0)))
        .lock()
        .unwrap()
        .clone()
}

/// 判定某任务会话是否仍有效（任务启动前 + 读源完成填充缓存前 双检查）
fn warm_session_matches(session_id: &str, generation: u64) -> bool {
    let (cur_sid, cur_gen) = warm_session_current();
    cur_sid == session_id && cur_gen == generation
}

/// Reader 打开 / 切书 / 卸载时**无条件**调用——既是 begin 也是 cancel（覆盖即作废旧会话）
#[tauri::command]
pub fn advance_warm_session(session_id: String, generation: u64) -> Result<(), String> {
    *WARM_SESSION
        .get_or_init(|| std::sync::Mutex::new((String::new(), 0)))
        .lock()
        .unwrap() = (session_id, generation);
    Ok(())
}

/// 从 WebView URL 提取 media 协议 path（`http://media.localhost/<path>` / `media://localhost/<path>` → `<path>`）。
/// 严格前缀剥离——只接受本应用 media 协议两种形态，其余（含伪造 host）返回 None。
fn media_path_of(url: &str) -> Option<String> {
    const HTTP_FORM: &str = "http://media.localhost/";
    const SCHEME_FORM: &str = "media://localhost/";
    if let Some(rest) = url.strip_prefix(HTTP_FORM) {
        return Some(rest.to_string());
    }
    if let Some(rest) = url.strip_prefix(SCHEME_FORM) {
        return Some(rest.to_string());
    }
    None
}

/// 读单个远程媒体并填充 LRU。失败静默（预读是优化不是承诺，调用方忽略错误）。
/// 写缓存前做会话检查——切书后的陈旧预热不进缓存。
async fn read_and_cache_media(
    app: &tauri::AppHandle,
    media_path: &str,
    session_id: &str,
    generation: u64,
) {
    let target = match crate::media_protocol::parse_media_path(media_path) {
        Ok(t) => t,
        Err(_) => return,
    };
    if matches!(target, crate::media_protocol::MediaTarget::Local { .. }) {
        return; // Local 形态不产生 IO（文件系统页缓存已够）
    }
    let (descriptor, file_path) = match crate::rebuild_descriptor(app, &target) {
        Ok(v) => v,
        Err(_) => return,
    };
    let factory = app.state::<crate::source::MediaSourceFactory>();
    let src = factory.resolve(&descriptor);
    let Ok(bytes) = src.read_file(&descriptor, &file_path, None).await else {
        return;
    };
    if !warm_session_matches(session_id, generation) {
        return; // 读源完成、写 LRU 前双检查（rev8）
    }
    let name = file_path.rsplit('/').next().unwrap_or(&file_path).to_string();
    let mime = crate::algorithm::mime_from_name(&name)
        .unwrap_or("application/octet-stream")
        .to_string();
    crate::media_cache::global().lock().unwrap().put(
        media_path.to_string(),
        crate::media_cache::CachedMedia { bytes, mime },
    );
}

/// 图片预读。契约（rev8）：
/// - 每次调用最多取前 WARM_MAX（=4）个 URL，超出静默截断——单次调用的资源边界
/// - 去重（保持顺序）
/// - 只接受本应用 media 协议 URL：复用 parse_media_path/rebuild_descriptor 完整
///   解析/校验/DB 重建路径，任何一步失败跳过该条（静默）
/// - 并发上限 = WARM_MAX（组内全并发，组间天然受限）
/// - 会话取消：任务启动前 + 读源完成后双检查 warm_session_matches
#[tauri::command]
pub async fn warm_media_urls(
    app: tauri::AppHandle,
    session_id: String,
    generation: u64,
    urls: Vec<String>,
) -> Result<(), String> {
    const WARM_MAX: usize = 4;
    if !warm_session_matches(&session_id, generation) {
        return Ok(()); // 提交即过期（openBook 的 advance 未完成前不发，防御）
    }
    let mut seen = std::collections::HashSet::new();
    let targets: Vec<String> = urls
        .into_iter()
        .filter(|u| seen.insert(u.clone()))
        .filter_map(|u| media_path_of(&u))
        .take(WARM_MAX)
        .collect();
    let mut handles = Vec::with_capacity(targets.len());
    for p in targets {
        let app = app.clone();
        let sid = session_id.clone();
        handles.push(tokio::spawn(async move {
            if !warm_session_matches(&sid, generation) {
                return; // 启动前检查
            }
            read_and_cache_media(&app, &p, &sid, generation).await;
        }));
    }
    for h in handles {
        let _ = h.await;
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_path_of_extracts_after_localhost() {
        assert_eq!(media_path_of("http://media.localhost/webdav/7/a%2Fb.jpg").as_deref(), Some("webdav/7/a%2Fb.jpg"));
        assert_eq!(media_path_of("media://localhost/local/x").as_deref(), Some("local/x"));
        assert_eq!(media_path_of("https://evil.com/x"), None);
    }

    #[test]
    fn warm_session_advance_invalidates_old_and_matches_new() {
        advance_warm_session("s1".into(), 1).unwrap();
        assert!(warm_session_matches("s1", 1));
        assert!(!warm_session_matches("s1", 2), "同会话旧 generation 作废");
        assert!(!warm_session_matches("s2", 1), "不同 session 作废");
        advance_warm_session("s2".into(), 5).unwrap();
        assert!(warm_session_matches("s2", 5), "覆盖即新会话");
    }
}
