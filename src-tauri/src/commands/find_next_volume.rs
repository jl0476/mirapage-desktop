//! `commands::find_next_volume` —— 跨卷连续阅读算法 + IPC command
//!
//! v0.1.0-module3.0.8-cross-volume 任务 2: 替换原 stub 为 async command。
//!
//! - 强类型 `VolumeDirection`（P2：非法值在 serde 反序列化边界报错，不静默当 next）
//! - 强类型解析 `SourceDescriptor`（P1-5：不在 command 内反复操作 `serde_json::Value`）
//! - 仅 Local 源（spec §1.2 收窄决策；非 Local 返回明确错误，不静默 fallback）
//! - `NextVolumeResult` 无 `is_archive` 字段（仅 Local 目录卷）
//! - 删除 `filter` 参数（P1-3：reader / masonry 在仅 Local 目录卷下语义一致）
//!
//! Spec: `docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md` §5.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::algorithm::path::PathUtils;
use crate::source::{MediaSourceFactory, SourceDescriptor};

/// 跨卷方向（强类型 IPC 入参，非法值在 serde 反序列化边界报错）。
///
/// spec §5.1：在任务 1 定义供 `pick_sibling` 签名使用；任务 2 `FindNextVolumeArgs` 也用它。
#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum VolumeDirection {
    Next,
    Prev,
}

/// spec §5.2：在 siblings 里按 natural sort 找 current 的 next/prev，只保留 `is_directory`。
/// 返回目标 entry 的克隆（不返回索引，避免过滤数组索引歧义 —— P1-5）。
/// current 不在或越界返回 None。
pub fn pick_sibling(
    siblings: &[crate::source::descriptor::MediaEntry],
    current_basename: &str,
    direction: VolumeDirection,
) -> Option<crate::source::descriptor::MediaEntry> {
    use crate::algorithm::natural_compare;
    let mut dirs: Vec<&crate::source::descriptor::MediaEntry> = siblings
        .iter()
        .filter(|e| e.is_directory)
        .collect();
    if dirs.is_empty() {
        return None;
    }
    dirs.sort_by(|a, b| natural_compare(&a.name, &b.name));
    let pos = dirs.iter().position(|e| e.name == current_basename)?;
    let target_pos = match direction {
        VolumeDirection::Next => pos + 1,
        VolumeDirection::Prev => pos.checked_sub(1)?,
    };
    dirs.get(target_pos)
        .map(|e| crate::source::descriptor::MediaEntry {
            name: e.name.clone(),
            path: e.path.clone(),
            is_directory: e.is_directory,
            is_archive: e.is_archive,
            size: e.size,
            modified_at: e.modified_at,
        })
}

/// IPC 入参（spec §5.1）
///
/// P1-3 修复：无 `filter` 字段（reader / masonry 在仅 Local 目录卷下语义一致）。
/// P2 修复：`direction` 强类型枚举，非法值在反序列化边界报错。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindNextVolumeArgs {
    /// 当前卷的 `SourceDescriptor`（本版实际只用 Local）
    pub descriptor: serde_json::Value,
    /// 当前卷相对 `rootPath` 的完整路径（如 `"comics/vol1"`）
    pub current_path: String,
    /// 跨卷方向
    pub direction: VolumeDirection,
}

/// IPC 出参（spec §5.1）
///
/// 注：本版不返回 `is_archive` —— 仅 Local 目录卷，避免调用方残留 if 分支。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextVolumeResult {
    /// 下一卷 `SourceDescriptor`（同源 Local，`rootPath` 不变）
    pub descriptor: serde_json::Value,
    /// 下一卷相对 `rootPath` 的完整路径
    pub rel_path: String,
    /// 目录名（显示用）
    pub title: String,
}

/// 业务实现（spec §5.2）。
///
/// 拆出独立函数供测试：测试用 `find_next_volume_impl(args, &factory)` 调，
/// 避免构造 `tauri::State`。
pub async fn find_next_volume_impl(
    args: FindNextVolumeArgs,
    factory: &MediaSourceFactory,
) -> Result<Option<NextVolumeResult>, String> {
    // 1. 强类型解析 descriptor（不在 command 内反复操作 serde_json::Value —— P1-5 修复）
    let descriptor: SourceDescriptor = serde_json::from_value(args.descriptor.clone())
        .map_err(|e| format!("invalid descriptor: {e}"))?;

    // 2. 本版只支持 Local（收窄决策）。非 Local 返回明确错误，不静默 fallback。
    //    `matches!` 只验证 variant —— root_path 不单独绑定，避免 unused variable warning。
    if !matches!(descriptor, SourceDescriptor::Local { .. }) {
        return Err("find_next_volume: 非 Local 源暂不支持跨卷（见 spec §1.2）".into());
    }

    // 3. parent_path = current_path 的父目录；current_basename = 末段
    let parent_path = PathUtils::parent(&args.current_path);
    let current_basename = PathUtils::segments(&args.current_path)
        .last()
        .cloned()
        .unwrap_or_default();

    // 4. list parent + pick_sibling（只保留 is_directory）
    let source = factory.resolve(&descriptor);
    let siblings = source
        .list_directory(&descriptor, &parent_path)
        .await
        .map_err(|e| e.to_string())?;
    let target = match pick_sibling(&siblings, &current_basename, args.direction) {
        Some(t) => t,
        None => return Ok(None),
    };

    // 5. 构造 NextVolumeResult（同源 Local descriptor，rel_path = parent + name）
    let rel_path = if parent_path.is_empty() {
        target.name.clone()
    } else {
        PathUtils::join(&parent_path, &target.name)
    };
    let descriptor_json = serde_json::to_value(&descriptor).map_err(|e| e.to_string())?;
    Ok(Some(NextVolumeResult {
        descriptor: descriptor_json,
        rel_path,
        title: target.name,
    }))
}

/// Tauri command（spec §5.2）。
///
/// `tauri::State<MediaSourceFactory>` 由 `lib.rs` 的 `app.manage(factory)` 注入。
#[tauri::command]
pub async fn find_next_volume(
    args: FindNextVolumeArgs,
    factory: State<'_, MediaSourceFactory>,
) -> Result<Option<NextVolumeResult>, String> {
    find_next_volume_impl(args, factory.inner()).await
}

#[cfg(test)]
mod tests {
    //! spec §17.1 + brief 步骤 1+3：
    //! - `pick_sibling` 纯函数测试（任务 1 已有，保留）。
    //! - `find_next_volume` command 集成测试（任务 2 新增）：Local 跨卷 / 越界 / current 不存在 /
    //!   非 Local 错误 / Windows-POSIX 分隔符 / 强类型方向反序列化。
    //!
    //! 返回 entry 非索引（断言 name），direction 是 enum 非 &str。
    use super::*;
    use crate::source::descriptor::MediaEntry;
    use std::fs;
    use std::path::Path;

    // ---- pick_sibling 纯函数测试（任务 1 保留） ----

    /// 测试 helper：构造 MediaEntry。
    fn entry(name: &str, is_directory: bool, is_archive: bool) -> MediaEntry {
        MediaEntry {
            name: name.to_string(),
            path: name.to_string(),
            is_directory,
            is_archive,
            size: 0,
            modified_at: None,
        }
    }

    #[test]
    fn next_takes_adjacent_directory() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol2", true, false),
            entry("vol3", true, false),
        ];
        assert_eq!(
            pick_sibling(&s, "vol1", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            Some("vol2".to_string()),
        );
        assert_eq!(
            pick_sibling(&s, "vol2", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            Some("vol3".to_string()),
        );
    }

    #[test]
    fn prev_takes_adjacent_directory() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol2", true, false),
            entry("vol3", true, false),
        ];
        assert_eq!(
            pick_sibling(&s, "vol3", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            Some("vol2".to_string()),
        );
        assert_eq!(
            pick_sibling(&s, "vol2", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            Some("vol1".to_string()),
        );
    }

    #[test]
    fn next_at_last_returns_none() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol2", true, false),
        ];
        assert_eq!(
            pick_sibling(&s, "vol2", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            None,
        );
    }

    #[test]
    fn prev_at_first_returns_none() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol2", true, false),
        ];
        assert_eq!(
            pick_sibling(&s, "vol1", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            None,
        );
    }

    #[test]
    fn current_not_in_siblings_returns_none() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol3", true, false),
        ];
        assert_eq!(
            pick_sibling(&s, "vol2", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            None,
        );
        assert_eq!(
            pick_sibling(&s, "vol2", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            None,
        );
    }

    #[test]
    fn empty_siblings_returns_none() {
        let s: Vec<MediaEntry> = vec![];
        assert_eq!(
            pick_sibling(&s, "vol1", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            None,
        );
        assert_eq!(
            pick_sibling(&s, "vol1", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            None,
        );
    }

    #[test]
    fn only_directories_are_filtered_out_files_and_archives() {
        // 混入文件/压缩包：pick_sibling 视它们不存在（spec §5.2：只保留 is_directory）
        let s = vec![
            entry("vol1", true, false),
            entry("readme.txt", false, false), // 文件
            entry("vol2", true, false),
            entry("vol1.zip", false, true), // 压缩包
            entry("vol3", true, false),
        ];
        // 过滤后排序 = [vol1, vol2, vol3]
        assert_eq!(
            pick_sibling(&s, "vol1", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            Some("vol2".to_string()),
        );
        assert_eq!(
            pick_sibling(&s, "vol2", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            Some("vol1".to_string()),
        );
        // vol2 的下一卷应是 vol3（不是 vol1.zip）
        assert_eq!(
            pick_sibling(&s, "vol2", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            Some("vol3".to_string()),
        );
    }

    #[test]
    fn empty_dirs_after_filter_returns_none() {
        // siblings 全是文件/压缩包 → filter 后空 → None
        let s = vec![
            entry("a.txt", false, false),
            entry("b.zip", false, true),
        ];
        assert_eq!(
            pick_sibling(&s, "a.txt", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            None,
        );
    }

    #[test]
    fn natural_sort_orders_page2_before_page10() {
        // 输入乱序：page10 排在 page2 前面，期望按 natural_compare 排序后 page2 < page10
        let s = vec![
            entry("page10", true, false),
            entry("page2", true, false),
            entry("page1", true, false),
            entry("page20", true, false),
        ];
        // 排序后 = [page1, page2, page10, page20]
        // page1 next → page2（不是 page10，验证 natural sort）
        assert_eq!(
            pick_sibling(&s, "page1", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            Some("page2".to_string()),
        );
        // page2 next → page10
        assert_eq!(
            pick_sibling(&s, "page2", VolumeDirection::Next).map(|e| e.name.as_str().to_owned()),
            Some("page10".to_string()),
        );
        // page10 prev → page2
        assert_eq!(
            pick_sibling(&s, "page10", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            Some("page2".to_string()),
        );
        // page20 prev → page10
        assert_eq!(
            pick_sibling(&s, "page20", VolumeDirection::Prev).map(|e| e.name.as_str().to_owned()),
            Some("page10".to_string()),
        );
    }

    // ---- IPC 数据结构契约测试（任务 2 新增） ----

    /// NextVolumeResult 序列化为 camelCase（TS 端 `NextVolumeResult` 期望 descriptor/relPath/title）。
    #[test]
    fn next_volume_result_serializes_as_camel_case() {
        let result = NextVolumeResult {
            descriptor: serde_json::json!({"type": "local", "rootPath": "/a"}),
            rel_path: "foo/bar".to_string(),
            title: "bar".to_string(),
        };
        let json = serde_json::to_string(&result).expect("serialize");
        assert!(json.contains("\"relPath\""), "应是 relPath: {json}");
        assert!(json.contains("\"title\""), "应是 title: {json}");
        assert!(json.contains("\"descriptor\""), "应是 descriptor: {json}");
        assert!(!json.contains("\"rel_path\""), "不应有 rel_path: {json}");
    }

    /// FindNextVolumeArgs 接受 `next` / `prev` 方向字符串（P2 强类型 enum）。
    #[test]
    fn find_next_volume_args_accepts_lowercase_direction() {
        let json = r#"{"descriptor": {}, "currentPath": "x", "direction": "next"}"#;
        let args: FindNextVolumeArgs = serde_json::from_str(json).expect("deserialize next");
        assert!(matches!(args.direction, VolumeDirection::Next));

        let json = r#"{"descriptor": {}, "currentPath": "x", "direction": "prev"}"#;
        let args: FindNextVolumeArgs = serde_json::from_str(json).expect("deserialize prev");
        assert!(matches!(args.direction, VolumeDirection::Prev));
    }

    /// FindNextVolumeArgs 拒绝非法 direction 值（serde 反序列化边界报错 —— P2）。
    #[test]
    fn find_next_volume_args_rejects_invalid_direction() {
        let json = r#"{"descriptor": {}, "currentPath": "x", "direction": "garbage"}"#;
        let result: serde_json::Result<FindNextVolumeArgs> = serde_json::from_str(json);
        assert!(
            result.is_err(),
            "非法 direction 值应在反序列化边界报错"
        );
    }

    // ---- command 集成测试（任务 2 新增） ----

    /// 测试 helper：构造 MediaSourceFactory（真实实例，Local 指向 tempdir）。
    fn make_factory() -> MediaSourceFactory {
        MediaSourceFactory::new()
    }

    /// 测试 helper：建 nested 子目录（如 `"comics/vol1"` 用 `create_dir_all`）。
    fn make_subdir(parent: &Path, subpath: &str) {
        fs::create_dir_all(parent.join(subpath)).expect("create dir all");
    }

    /// 测试 helper：构造 Local descriptor JSON（与 TS 端 `SourceDescriptorLocal` 对齐）。
    fn local_descriptor(root_path: &str) -> serde_json::Value {
        serde_json::json!({"type": "local", "rootPath": root_path})
    }

    /// 1) 非 Local descriptor 返回明确 Err —— 不静默 fallback（spec §1.2）。
    #[tokio::test]
    async fn non_local_descriptor_returns_err() {
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: serde_json::json!({
                "type": "smb",
                "accountId": 1,
                "initialPath": "share",
                "path": ""
            }),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory).await;
        assert!(result.is_err(), "非 Local 应返回 Err");
        let err = result.unwrap_err();
        assert!(
            err.contains("非 Local") || err.contains("Local"),
            "错误信息应明确提到 Local: {err}"
        );
    }

    /// 2) 无效 descriptor（垃圾 JSON Value）反序列化失败。
    #[tokio::test]
    async fn invalid_descriptor_returns_err() {
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            // type 字段缺失 → SourceDescriptor 反序列化失败
            descriptor: serde_json::json!({"rootPath": "/a"}),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory).await;
        assert!(
            result.is_err(),
            "垃圾 descriptor 应反序列化失败"
        );
        let err = result.unwrap_err();
        assert!(
            err.contains("invalid descriptor") || err.contains("descriptor"),
            "错误信息应提到 descriptor: {err}"
        );
    }

    /// 3) Local happy path: next 在根目录层跨卷 → 返回 rel_path = 目标 name。
    #[tokio::test]
    async fn local_next_at_root_finds_sibling() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2", "vol3"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        let next = result.expect("应有下一卷");
        assert_eq!(next.title, "vol2");
        assert_eq!(next.rel_path, "vol2");
        // 验证 descriptor 同源 Local
        assert_eq!(next.descriptor["type"], "local");
        assert_eq!(next.descriptor["rootPath"], dir.path().to_str().unwrap());
    }

    /// 4) Local happy path: prev 在根目录层跨卷。
    #[tokio::test]
    async fn local_prev_at_root_finds_sibling() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2", "vol3"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol3".to_string(),
            direction: VolumeDirection::Prev,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        let next = result.expect("应有上一卷");
        assert_eq!(next.title, "vol2");
        assert_eq!(next.rel_path, "vol2");
    }

    /// 5) Local 末卷 next → None。
    #[tokio::test]
    async fn local_next_at_last_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol2".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        assert!(result.is_none(), "末卷 next 应返回 None");
    }

    /// 6) Local 首卷 prev → None。
    #[tokio::test]
    async fn local_prev_at_first_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Prev,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        assert!(result.is_none(), "首卷 prev 应返回 None");
    }

    /// 7) Local current 不在 siblings（被移走） → None。
    #[tokio::test]
    async fn local_current_not_in_siblings_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 故意不建 vol2
        for name in ["vol1", "vol3"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol2".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        assert!(
            result.is_none(),
            "current 不在 siblings 应返回 None（无下一卷）"
        );
    }

    /// 8) Local 嵌套路径 + POSIX 分隔符（`/`）跨卷。
    #[tokio::test]
    async fn local_posix_separator_subdir_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2", "vol3"] {
            make_subdir(dir.path(), &format!("comics/{name}"));
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "comics/vol1".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        let next = result.expect("应有下一卷");
        assert_eq!(next.title, "vol2");
        // rel_path = parent + name = "comics/vol2"（PathUtils::join 用 `/`）
        assert_eq!(next.rel_path, "comics/vol2");
    }

    /// 9) Local 嵌套路径 + Windows 分隔符（`\`）跨卷（PathUtils 规范化）。
    #[tokio::test]
    async fn local_windows_separator_subdir_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), &format!("comics/{name}"));
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            // 用 Windows 风格 `\\`（实际是单反斜杠在 Rust 字符串里写为 `\\`）
            current_path: "comics\\vol1".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        let next = result.expect("应有下一卷");
        assert_eq!(next.title, "vol2");
        // rel_path 统一用 `/`（PathUtils::join 规范化）
        assert_eq!(next.rel_path, "comics/vol2");
    }

    /// 10) Local 自然排序：parent 含 page2 / page10 / page1 时按自然序取下一卷。
    #[tokio::test]
    async fn local_natural_sort_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 输入乱序：page10 排在 page2 前面
        for name in ["page10", "page2", "page1"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "page1".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory)
            .await
            .expect("impl ok");
        let next = result.expect("应有下一卷");
        // 自然排序后 page1 next = page2（不是 page10）
        assert_eq!(next.title, "page2");
        assert_eq!(next.rel_path, "page2");
    }

    /// 11) Local 父目录不存在 → list_directory 报 NotFound，propagate Err。
    #[tokio::test]
    async fn local_parent_not_found_returns_err() {
        let dir = tempfile::tempdir().expect("tempdir");
        // 不建任何子目录
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "missing/parent/vol1".to_string(),
            direction: VolumeDirection::Next,
        };
        let result = find_next_volume_impl(args, &factory).await;
        assert!(result.is_err(), "不存在的 parent 应返回 Err");
    }
}
