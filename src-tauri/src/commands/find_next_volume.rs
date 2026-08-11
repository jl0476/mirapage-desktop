//! `commands::find_next_volume` —— 跨卷连续阅读算法
//!
//! 当前为 stub——完整实现见 usecase/find_next_volume.rs(Phase 5)。

use serde::Deserialize;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")] // v0.1.0-module3.0.2 (H4): 与 create_book / record_history 对齐
pub struct FindNextVolumeArgs {
    pub descriptor: serde_json::Value,
    pub current_path: String,
    pub direction: String, // "next" | "prev"
}

#[tauri::command]
pub fn find_next_volume(args: FindNextVolumeArgs) -> Result<Option<String>, String> {
    // TODO(Phase 5): 接 usecase::find_next_volume
    // 当前为占位:返回 None(无下一卷 / 上一卷)
    let _ = args;
    Ok(None)
}

#[cfg(test)]
mod tests {
    //! spec §17.1 + brief 步骤 1：`pick_sibling` 纯函数测试。
    //! 返回 entry 非索引（断言 name），direction 是 enum 非 &str。
    use super::*;
    use crate::source::descriptor::MediaEntry;

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
            entry("readme.txt", false, false),   // 文件
            entry("vol2", true, false),
            entry("vol1.zip", false, true),      // 压缩包
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
}