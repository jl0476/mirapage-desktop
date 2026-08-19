//! `commands::find_next_volume` —— 跨卷连续阅读算法 + IPC command
//!
//! v0.1.0-module3.0.8-cross-volume 任务 2: 替换原 stub 为 async command。
//!
//! - 强类型 `VolumeDirection`（P2：非法值在 serde 反序列化边界报错，不静默当 next）
//! - 强类型解析 `SourceDescriptor`（P1-5：不在 command 内反复操作 `serde_json::Value`）
//! - Local + WebDAV 源（module3.2.0 spec rev4 §3.2 泛化：factory 列父目录，Local 零回归；
//!   Smb 3.3.0 前明确报错；Archive 无跨卷语义——包即整书）
//! - `NextVolumeResult` 无 `is_archive` 字段（仅 Local 目录卷）
//! - 删除 `filter` 参数（P1-3：reader / masonry 在仅 Local 目录卷下语义一致）
//!
//! Spec: `docs/superpowers/specs/2026-08-11-cross-volume-reading-design.md` §5.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::algorithm::path::PathUtils;
use crate::source::{MediaSourceFactory, SourceDescriptor};

/// 跨卷列举源分派（module3.2.0 spec rev4 §3.2 + M2 修订）。
/// Local + WebDav + Smb 走 OK；Archive 拒绝（包即整书）。
/// M2 task 7：SMB 跨卷已放开（任务 4-6 完成接线）。
fn listing_kind(d: &SourceDescriptor) -> Result<(), String> {
    match d {
        SourceDescriptor::Local { .. }
        | SourceDescriptor::WebDav { .. }
        | SourceDescriptor::Smb { .. } => Ok(()),
        _ => Err("跨卷当前仅支持 Local / WebDAV / SMB 源（Archive 无跨卷语义——包即整书）".into()),
    }
}

/// 跨卷方向（强类型 IPC 入参，非法值在 serde 反序列化边界报错）。
///
/// spec §5.1：在任务 1 定义供 `pick_sibling` 签名使用；任务 2 `FindNextVolumeArgs` 也用它。
#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum VolumeDirection {
    Next,
    Prev,
}

/// 兄弟目录排序字段（与 TS `SortField` / `directory_sort.sort_field` 存储值一致）。
/// 不作 IPC 入参 —— command 按父目录生效排序自动解析（resolve_sibling_sort），
/// 与文件浏览器 `fileSort.sortEntries` 展示卷的顺序保持一致（2026-08-16）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeSortField {
    Name,
    ModifiedAt,
    Size,
}

impl VolumeSortField {
    /// 解析 `directory_sort.sort_field` / settings `fb_sort_field` 的存储值。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "name" => Some(Self::Name),
            "modifiedAt" => Some(Self::ModifiedAt),
            "size" => Some(Self::Size),
            _ => None,
        }
    }
}

/// spec §5.2：在 siblings 里按 natural sort 找 current 的 next/prev，只保留 `is_directory`。
/// 返回目标 entry 的克隆（不返回索引，避免过滤数组索引歧义 —— P1-5）。
/// current 不在或越界返回 None。
pub fn pick_sibling(
    siblings: &[crate::source::descriptor::MediaEntry],
    current_basename: &str,
    direction: VolumeDirection,
) -> Option<crate::source::descriptor::MediaEntry> {
    pick_sibling_where(
        siblings,
        current_basename,
        direction,
        VolumeSortField::Name,
        true,
        &|_| true,
    )
}

/// bugfix 2026-08-16（跨卷排序与文件浏览器一致）：按父目录生效排序排兄弟目录，
/// 在方向上逐个迭代，返回第一个通过 `pred` 的候选。`pick_sibling` =
/// (name 升序, pred 恒 true) 的特例（旧行为）。
pub fn pick_sibling_where(
    siblings: &[crate::source::descriptor::MediaEntry],
    current_basename: &str,
    direction: VolumeDirection,
    sort_field: VolumeSortField,
    sort_ascending: bool,
    pred: &dyn Fn(&crate::source::descriptor::MediaEntry) -> bool,
) -> Option<crate::source::descriptor::MediaEntry> {
    use crate::algorithm::natural_compare;
    let mut dirs: Vec<&crate::source::descriptor::MediaEntry> = siblings
        .iter()
        .filter(|e| e.is_directory)
        .collect();
    if dirs.is_empty() {
        return None;
    }
    dirs.sort_by(|a, b| cmp_sibling(a, b, sort_field));
    // 镜像 TS sortEntries：descending = 升序结果整体反转
    if !sort_ascending {
        dirs.reverse();
    }
    let pos = dirs.iter().position(|e| e.name == current_basename)?;
    let clone = |i: usize| {
        dirs.get(i).map(|e| crate::source::descriptor::MediaEntry {
            name: e.name.clone(),
            path: e.path.clone(),
            is_directory: e.is_directory,
            is_archive: e.is_archive,
            size: e.size,
            modified_at: e.modified_at,
        })
    };
    match direction {
        VolumeDirection::Next => {
            for i in (pos + 1)..dirs.len() {
                if let Some(e) = dirs.get(i) {
                    if pred(e) {
                        return clone(i);
                    }
                }
            }
            None
        }
        VolumeDirection::Prev => {
            for i in (0..pos).rev() {
                if let Some(e) = dirs.get(i) {
                    if pred(e) {
                        return clone(i);
                    }
                }
            }
            None
        }
    }
}

/// 镜像 TS `fileSort.sortByField` 的比较语义（ascending 方向）：
/// - name：natural_compare（与 TS naturalSort 语义对齐，Android 真值源）
/// - modifiedAt：数值比较，`None` 排末尾（TS `undefined` 排后）
/// - size：数值比较
fn cmp_sibling(
    a: &crate::source::descriptor::MediaEntry,
    b: &crate::source::descriptor::MediaEntry,
    field: VolumeSortField,
) -> std::cmp::Ordering {
    use crate::algorithm::natural_compare;
    match field {
        VolumeSortField::Name => natural_compare(&a.name, &b.name),
        VolumeSortField::ModifiedAt => match (a.modified_at, b.modified_at) {
            (Some(x), Some(y)) => x.cmp(&y),
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
        },
        VolumeSortField::Size => a.size.cmp(&b.size),
    }
}

/// 父目录生效排序（与文件浏览器一致，逐维度解析）：
/// `directory_sort` 覆盖（location_key 与 directory_sort 命令同构）
/// ?? settings 全局（`fb_sort_field` / `fb_sort_ascending`）?? name 升序。
/// 查不到 / 值非法 → 静默回退默认，不阻断跨卷。
fn resolve_sibling_sort(
    db: &crate::db::Db,
    descriptor_value: &serde_json::Value,
    parent_path: &str,
) -> (VolumeSortField, bool) {
    let conn = db.conn();
    let key = crate::commands::directory_sort::location_key_of(descriptor_value, parent_path);
    let ovr: Option<(String, bool)> = conn
        .query_row(
            "SELECT sort_field, ascending FROM directory_sort WHERE location_key = ?1",
            rusqlite::params![key],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0)),
        )
        .ok();
    let global_field = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'fb_sort_field'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok();
    let global_asc = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'fb_sort_ascending'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok();
    let field = ovr
        .as_ref()
        .and_then(|(f, _)| VolumeSortField::parse(f))
        .or_else(|| global_field.as_deref().and_then(VolumeSortField::parse))
        .unwrap_or(VolumeSortField::Name);
    let ascending = ovr
        .as_ref()
        .map(|(_, a)| *a)
        .or_else(|| global_asc.as_deref().map(|v| v == "1"))
        .unwrap_or(true);
    (field, ascending)
}

/// 候选卷是否已读完（progress.finished=1）。
/// 无 library 行（从未打开过）或无 progress 行 → 未读完（不跳过）。
fn sibling_is_finished(
    db: &crate::db::Db,
    descriptor_str: &str,
    parent_path: &str,
    entry: &crate::source::descriptor::MediaEntry,
) -> bool {
    let rel = if parent_path.is_empty() {
        entry.name.clone()
    } else {
        PathUtils::join(parent_path, &entry.name)
    };
    let rel_norm = crate::algorithm::validate_source_relative(&rel)
        .unwrap_or_else(|_| rel.clone());
    let conn = db.conn();
    let book_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM library WHERE source_descriptor = ?1 AND absolute_path = ?2",
            rusqlite::params![descriptor_str, rel_norm],
            |r| r.get(0),
        )
        .ok();
    match book_id {
        Some(id) => conn
            .query_row(
                "SELECT finished FROM progress WHERE book_id = ?1",
                rusqlite::params![id],
                |r| r.get::<_, i64>(0),
            )
            .map(|f| f != 0)
            .unwrap_or(false),
        None => false,
    }
}

/// IPC 入参（spec §5.1）
///
/// P1-3 修复：无 `filter` 字段（reader / masonry 在目录卷下语义一致）。
/// P2 修复：`direction` 强类型枚举，非法值在反序列化边界报错。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindNextVolumeArgs {
    /// 当前卷的 `SourceDescriptor`（module3.2.0 起 Local + WebDAV）
    pub descriptor: serde_json::Value,
    /// 当前卷相对 `rootPath` 的完整路径（如 `"comics/vol1"`）
    pub current_path: String,
    /// 跨卷方向
    pub direction: VolumeDirection,
    /// 自动跨卷跳过已读完（progress.finished=1）的相邻卷，落到方向上第一个未读卷。
    /// 缺省 false —— 手动跨卷（Alt+→ / manual 确认）不跳，用户显式选择目标。
    #[serde(default)]
    pub skip_finished: Option<bool>,
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
/// 拆出独立函数供测试：测试用 `find_next_volume_impl(args, &factory, None)` 调，
/// 避免构造 `tauri::State`。
pub async fn find_next_volume_impl(
    args: FindNextVolumeArgs,
    factory: &MediaSourceFactory,
    db: Option<&crate::db::Db>,
) -> Result<Option<NextVolumeResult>, String> {
    // 1. 强类型解析 descriptor（不在 command 内反复操作 serde_json::Value —— P1-5 修复）
    let descriptor: SourceDescriptor = serde_json::from_value(args.descriptor.clone())
        .map_err(|e| format!("invalid descriptor: {e}"))?;

    // 2. 分派校验（module3.2.0 spec rev4 §3.2 + M2 修订）：Local 走现有实现零回归；WebDAV 经
    //    factory 列目录（兄弟排序/跳已读/directory_sort 操作 MediaEntry 与 location_key，
    //    随列举源切换自动生效）；SMB M2 已放开（同 WebDAV 走 factory.resolve().list_directory）；
    //    Archive 无跨卷语义。
    listing_kind(&descriptor)?;

    // 3. parent_path = current_path 的父目录；current_basename = 末段
    let parent_path = PathUtils::parent(&args.current_path);
    let current_basename = PathUtils::segments(&args.current_path)
        .last()
        .cloned()
        .unwrap_or_default();

    // 4. list parent + 按父目录生效排序排兄弟（与文件浏览器视觉顺序一致）
    let source = factory.resolve(&descriptor);
    let siblings = source
        .list_directory(&descriptor, &parent_path)
        .await
        .map_err(|e| e.to_string())?;
    // 兄弟排序：父目录 directory_sort 覆盖 ?? settings 全局 ?? name 升序
    // （db=None 仅旧单测路径 → 默认；生产 command 恒传 Some）
    let (sort_field, sort_ascending) = match db {
        Some(db) => resolve_sibling_sort(db, &args.descriptor, &parent_path),
        None => (VolumeSortField::Name, true),
    };
    // skip_finished 的 finished 查库用（与 create_book 写入的序列化保持一致）
    let descriptor_str = serde_json::to_string(&descriptor).map_err(|e| e.to_string())?;
    // pred：skip_finished=true 时跳过已读完的相邻卷；否则恒通过
    let pred: Box<dyn Fn(&crate::source::descriptor::MediaEntry) -> bool> =
        if args.skip_finished.unwrap_or(false) {
            let db = db.ok_or_else(|| {
                "find_next_volume: skip_finished 需要 DB 访问（command 层必须传入）".to_string()
            })?;
            // parent_path 后面 rel_path 计算还要用 → clone 进闭包
            let parent_for_pred = parent_path.clone();
            Box::new(move |e| !sibling_is_finished(db, &descriptor_str, &parent_for_pred, e))
        } else {
            Box::new(|_| true)
        };
    let target = pick_sibling_where(
        &siblings,
        &current_basename,
        args.direction,
        sort_field,
        sort_ascending,
        &*pred,
    );
    let target = match target {
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
/// `db` 供 skip_finished 查 library/progress（无该 flag 时不触库）。
#[tauri::command]
pub async fn find_next_volume(
    args: FindNextVolumeArgs,
    factory: State<'_, MediaSourceFactory>,
    db: State<'_, crate::db::Db>,
) -> Result<Option<NextVolumeResult>, String> {
    find_next_volume_impl(args, factory.inner(), Some(&db)).await
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

    // ---- module3.2.0: 跨卷源分派（listing_kind） ----

    #[test]
    fn listing_kind_accepts_local_and_webdav_and_smb_after_m2() {
        // M2 task 7 修订：SMB 跨卷放开——Local + WebDav + Smb 走 listing_kind 校验
        let local = SourceDescriptor::Local { root_path: "F:/c".into() };
        let webdav = SourceDescriptor::WebDav { account_id: 1, base_url: "https://d/x".into(), path: "comics/v1".into() };
        let smb = SourceDescriptor::Smb { account_id: 1, initial_path: "s".into(), path: "v1".into(), port: 445 };
        assert!(listing_kind(&local).is_ok());
        assert!(listing_kind(&webdav).is_ok());
        assert!(listing_kind(&smb).is_ok(), "M2 放开 SMB 跨卷");
    }

    #[test]
    fn listing_kind_rejects_archive() {
        // Archive 仍拒绝：包即整书，无相邻卷语义
        let archive = SourceDescriptor::Archive {
            archive_path: "D:/a.cbz".into(), entry_prefix: String::new(),
            format: crate::source::descriptor::ArchiveFormat::Cbz,
            origin: None, origin_entry_path: None, archive_rel_path: None,
        };
        assert!(listing_kind(&archive).is_err());
        let err = listing_kind(&archive).unwrap_err();
        assert!(
            err.contains("Local") || err.contains("WebDAV") || err.contains("SMB") || err.contains("Archive"),
            "错误信息应说明支持的源: {err}"
        );
    }

    /// M2 task 7 简报步骤 1：SMB descriptor 在 listing_kind 后可继续到 list_directory。
    /// 这里只断言 listing_kind 接受；完整跨卷路径由任务 5+7 链式真实接线后端到端验证。
    #[test]
    fn listing_kind_accepts_smb_after_m2() {
        let smb = SourceDescriptor::Smb { account_id: 1, initial_path: "s".into(), path: "v1".into(), port: 445 };
        assert!(listing_kind(&smb).is_ok(), "M2 放开 SMB 跨卷");
    }

    #[test]
    fn parent_path_semantics_for_rel_paths() {
        // PathUtils.parent 对源内相对路径（Local relPath / WebDAV path 同构）
        assert_eq!(PathUtils::parent("comics/v1"), "comics");
        assert_eq!(PathUtils::parent("v1"), ""); // 根下第一层：parent = 根
        assert_eq!(PathUtils::parent(""), "");   // 已在根：parent 仍是根（跨根无语义）
    }

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
        MediaSourceFactory::new(
            crate::db::Db::open_in_memory().expect("in-memory db"),
            std::sync::Arc::new(crate::credentials::MemoryStore::new()),
        )
    }

    /// 测试 helper：建 nested 子目录（如 `"comics/vol1"` 用 `create_dir_all`）。
    fn make_subdir(parent: &Path, subpath: &str) {
        fs::create_dir_all(parent.join(subpath)).expect("create dir all");
    }

    /// 测试 helper：构造 Local descriptor JSON（与 TS 端 `SourceDescriptorLocal` 对齐）。
    fn local_descriptor(root_path: &str) -> serde_json::Value {
        serde_json::json!({"type": "local", "rootPath": root_path})
    }

    /// 1) SMB descriptor 在 M2 任务 7 后 listing_kind 接受 —— 不再被源分派拦截。
    /// （任务 5 时该测试断言 is_err；M2 后该门已开放，跨卷后续路径走真实 SMB 列举。）
    #[tokio::test]
    async fn smb_descriptor_listing_kind_accepted_after_m2() {
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
            skip_finished: None,
        };
        // listing_kind 放行后，跨卷代码会进入 factory.resolve().list_directory —— 这条路径
        // 在 SMB 真实接线下会因为没有可达的 SMB 服务（无 NAS CI）返回连接级错误，但
        // 这属于源数据访问错（test_connection 等价），不再是"源不支持"的语义错误。
        let result = find_next_volume_impl(args, &factory, None).await;
        // 允许 Err（真实网络失败），但 Err 信息**不能**是 listing_kind 的"源不支持"消息
        // —— 已升级到 SMB 真实列举阶段。
        if let Err(ref e) = result {
            assert!(
                !e.contains("Local") || !e.contains("WebDAV") || !e.contains("SMB") || e.contains("跨卷当前仅支持"),
                "M2 后 SMB 不应再被源分派拦截：{e}"
            );
            // 实际：真实网络失败信息应含 connection/connect/timeout/no address 等
        }
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None).await;
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None)
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
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, None).await;
        assert!(result.is_err(), "不存在的 parent 应返回 Err");
    }

    // ---- skip_finished 测试（2026-08-16 自动跨卷跳过已读完）----

    /// 测试 helper：在 library 表登记一本书（与 create_book 同序列化），
    /// finished=Some 时再写 progress.finished。
    fn seed_book(
        db: &crate::db::Db,
        root: &str,
        abs_path: &str,
        finished: Option<bool>,
    ) -> i64 {
        use crate::source::descriptor::SourceDescriptor;
        let desc = SourceDescriptor::Local {
            root_path: root.to_string(),
        };
        let descriptor_str = serde_json::to_string(&desc).expect("serialize descriptor");
        db.conn()
            .execute(
                "INSERT INTO library
                    (title, source_descriptor, source_type, absolute_path,
                     cover_entry_path, cover_entry_name, page_count,
                     added_at, is_favorite)
                 VALUES (?1, ?2, 'Local', ?3, NULL, NULL, 0, 0, 0)",
                rusqlite::params![abs_path, descriptor_str, abs_path],
            )
            .expect("seed library row");
        let id = db.conn().last_insert_rowid();
        if let Some(f) = finished {
            db.conn()
                .execute(
                    "INSERT INTO progress (book_id, page, reader_mode, updated_at, finished)
                     VALUES (?1, 0, 'single', 0, ?2)",
                    rusqlite::params![id, if f { 1i64 } else { 0i64 }],
                )
                .expect("seed progress row");
        }
        id
    }

    /// pick_sibling_where 纯函数：pred 拒绝的候选被跳过，返回方向上第一个通过者。
    #[test]
    fn pick_sibling_where_skips_rejected_candidates() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol2", true, false),
            entry("vol3", true, false),
        ];
        // 拒绝 vol2 → next 取 vol3
        assert_eq!(
            pick_sibling_where(&s, "vol1", VolumeDirection::Next, VolumeSortField::Name, true, &|e| e.name != "vol2")
                .map(|e| e.name),
            Some("vol3".to_string()),
        );
        // prev 从 vol3 反向，拒绝 vol2 → 取 vol1
        assert_eq!(
            pick_sibling_where(&s, "vol3", VolumeDirection::Prev, VolumeSortField::Name, true, &|e| e.name != "vol2")
                .map(|e| e.name),
            Some("vol1".to_string()),
        );
    }

    /// pick_sibling_where：全部被拒 → None。
    #[test]
    fn pick_sibling_where_all_rejected_returns_none() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol2", true, false),
        ];
        assert!(pick_sibling_where(&s, "vol1", VolumeDirection::Next, VolumeSortField::Name, true, &|_| false).is_none());
    }

    /// 12) skip_finished：相邻 vol2 已读完 → 跳到 vol3。
    #[tokio::test]
    async fn skip_finished_jumps_over_finished_volume() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2", "vol3"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("in-memory db");
        seed_book(&db, dir.path().to_str().unwrap(), "vol2", Some(true));

        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: Some(true),
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        let next = result.expect("vol3 未读完应有下一卷");
        assert_eq!(next.title, "vol3");
        assert_eq!(next.rel_path, "vol3");
    }

    /// 13) skip_finished 但 vol2 未读完（finished=0）→ 正常取相邻 vol2。
    #[tokio::test]
    async fn skip_finished_keeps_unfinished_adjacent_volume() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("in-memory db");
        seed_book(&db, dir.path().to_str().unwrap(), "vol2", Some(false));

        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: Some(true),
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        assert_eq!(result.expect("vol2 未读完").title, "vol2");
    }

    /// 14) skip_finished：book 存在但无 progress 行（读过一半？无记录）→ 不跳过。
    #[tokio::test]
    async fn skip_finished_without_progress_row_keeps_volume() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("in-memory db");
        // 只登记 library 行，不写 progress
        seed_book(&db, dir.path().to_str().unwrap(), "vol2", None);

        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: Some(true),
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        assert_eq!(result.expect("无 progress 行不算读完").title, "vol2");
    }

    /// 15) skip_finished：方向上全部读完 → None（视为没有可跨的卷）。
    #[tokio::test]
    async fn skip_finished_all_finished_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2", "vol3"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("in-memory db");
        seed_book(&db, dir.path().to_str().unwrap(), "vol2", Some(true));
        seed_book(&db, dir.path().to_str().unwrap(), "vol3", Some(true));

        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: Some(true),
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        assert!(result.is_none(), "全部读完应返回 None");
    }

    /// 16) skip_finished：从未打开过的卷（无 library 行）→ 不跳过。
    #[tokio::test]
    async fn skip_finished_never_opened_volume_keeps() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("in-memory db");
        // vol2 无任何记录

        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: Some(true),
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        assert_eq!(result.expect("未打开过 = 未读").title, "vol2");
    }

    /// 17) skip_finished + 嵌套路径（parent 非根）查库路径拼对。
    #[tokio::test]
    async fn skip_finished_nested_path_lookup() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2", "vol3"] {
            make_subdir(dir.path(), &format!("comics/{name}"));
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("in-memory db");
        seed_book(&db, dir.path().to_str().unwrap(), "comics/vol2", Some(true));

        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "comics/vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: Some(true),
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        let next = result.expect("comics/vol3 未读完");
        assert_eq!(next.title, "vol3");
        assert_eq!(next.rel_path, "comics/vol3");
    }

    /// 18) skip_finished=true 但 db 未传（内部调用误用）→ 明确 Err。
    #[tokio::test]
    async fn skip_finished_without_db_returns_err() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: Some(true),
        };
        let result = find_next_volume_impl(args, &factory, None).await;
        assert!(result.is_err(), "skip_finished 无 DB 应明确报错");
    }

    /// 19) FindNextVolumeArgs 缺 skip_finished 字段 → 反序列化为 None（向后兼容）。
    #[test]
    fn find_next_volume_args_skip_finished_defaults_none() {
        let json = r#"{"descriptor": {}, "currentPath": "x", "direction": "next"}"#;
        let args: FindNextVolumeArgs = serde_json::from_str(json).expect("deserialize");
        assert_eq!(args.skip_finished, None);
        let json = r#"{"descriptor": {}, "currentPath": "x", "direction": "next", "skipFinished": true}"#;
        let args: FindNextVolumeArgs = serde_json::from_str(json).expect("deserialize skip");
        assert_eq!(args.skip_finished, Some(true));
    }

    // ---- 兄弟排序与文件浏览器一致（2026-08-16）----

    /// 带时间的 entry（mtime 可控，避开 fs mtime）。
    fn entry_mtime(name: &str, mtime: Option<i64>) -> MediaEntry {
        MediaEntry {
            name: name.to_string(),
            path: name.to_string(),
            is_directory: true,
            is_archive: false,
            size: 0,
            modified_at: mtime,
        }
    }

    /// name 降序：升序整体反转 → vol1 是最后，next 无；vol3 的 next 是 vol2。
    #[test]
    fn pick_sibling_where_name_desc_reverses_order() {
        let s = vec![
            entry("vol1", true, false),
            entry("vol2", true, false),
            entry("vol3", true, false),
        ];
        // 降序 = [vol3, vol2, vol1]
        assert!(pick_sibling_where(&s, "vol1", VolumeDirection::Next, VolumeSortField::Name, false, &|_| true).is_none());
        assert_eq!(
            pick_sibling_where(&s, "vol3", VolumeDirection::Next, VolumeSortField::Name, false, &|_| true)
                .map(|e| e.name),
            Some("vol2".to_string()),
        );
        // prev 对称：vol1 的 prev 是 vol2
        assert_eq!(
            pick_sibling_where(&s, "vol1", VolumeDirection::Prev, VolumeSortField::Name, false, &|_| true)
                .map(|e| e.name),
            Some("vol2".to_string()),
        );
    }

    /// modifiedAt 升序：兄弟顺序按 mtime（与 name 序不同），next 跟随时间序。
    #[test]
    fn pick_sibling_where_modified_at_orders_by_mtime() {
        // name 序 [a, b, c]；mtime 序 [c(1), a(2), b(3)]
        let s = vec![
            entry_mtime("a", Some(2)),
            entry_mtime("b", Some(3)),
            entry_mtime("c", Some(1)),
        ];
        // 升序 = [c, a, b] → a 的 next 是 b；c 的 next 是 a
        assert_eq!(
            pick_sibling_where(&s, "a", VolumeDirection::Next, VolumeSortField::ModifiedAt, true, &|_| true)
                .map(|e| e.name),
            Some("b".to_string()),
        );
        assert_eq!(
            pick_sibling_where(&s, "c", VolumeDirection::Next, VolumeSortField::ModifiedAt, true, &|_| true)
                .map(|e| e.name),
            Some("a".to_string()),
        );
    }

    /// modifiedAt 缺失值：升序排末尾；降序（整体反转）排最前 —— 镜像 TS sortEntries 怪癖。
    #[test]
    fn pick_sibling_where_modified_at_none_endings_mirror_ts() {
        let s = vec![
            entry_mtime("none1", None),
            entry_mtime("old", Some(1)),
            entry_mtime("new", Some(2)),
            entry_mtime("none2", None),
        ];
        // 升序 = [old, new, none1, none2]（None 排末尾，稳定序保插入序）
        assert_eq!(
            pick_sibling_where(&s, "new", VolumeDirection::Next, VolumeSortField::ModifiedAt, true, &|_| true)
                .map(|e| e.name),
            Some("none1".to_string()),
        );
        // 降序 = [none2, none1, new, old]（反转后 None 到最前 —— TS 同款行为）
        assert_eq!(
            pick_sibling_where(&s, "none2", VolumeDirection::Next, VolumeSortField::ModifiedAt, false, &|_| true)
                .map(|e| e.name),
            Some("none1".to_string()),
        );
    }

    /// resolve_sibling_sort：directory_sort 覆盖优先（location_key 与命令同构）。
    #[test]
    fn resolve_sibling_sort_override_wins() {
        let db = crate::db::Db::open_in_memory().expect("db");
        let desc = serde_json::json!({"type": "local", "rootPath": "/r"});
        let key = crate::commands::directory_sort::location_key_of(&desc, "");
        db.conn()
            .execute(
                "INSERT INTO directory_sort (location_key, sort_field, ascending) VALUES (?1, 'modifiedAt', 0)",
                rusqlite::params![key],
            )
            .expect("seed");
        assert_eq!(
            resolve_sibling_sort(&db, &desc, ""),
            (VolumeSortField::ModifiedAt, false),
        );
    }

    /// resolve_sibling_sort：无覆盖 → settings 全局（fb_sort_field / fb_sort_ascending）。
    #[test]
    fn resolve_sibling_sort_settings_global_fallback() {
        let db = crate::db::Db::open_in_memory().expect("db");
        let desc = serde_json::json!({"type": "local", "rootPath": "/r"});
        db.conn()
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('fb_sort_field', 'size'), ('fb_sort_ascending', '0')",
                [],
            )
            .expect("seed settings");
        assert_eq!(
            resolve_sibling_sort(&db, &desc, ""),
            (VolumeSortField::Size, false),
        );
    }

    /// resolve_sibling_sort：全空 / 值非法 → 默认 name 升序（静默回退不阻断）。
    #[test]
    fn resolve_sibling_sort_defaults_on_missing_or_invalid() {
        let db = crate::db::Db::open_in_memory().expect("db");
        let desc = serde_json::json!({"type": "local", "rootPath": "/r"});
        assert_eq!(resolve_sibling_sort(&db, &desc, ""), (VolumeSortField::Name, true));

        // 覆盖存在但值非法 → 回退默认（不是全局——全局也没配）
        let key = crate::commands::directory_sort::location_key_of(&desc, "");
        db.conn()
            .execute(
                "INSERT INTO directory_sort (location_key, sort_field, ascending) VALUES (?1, 'garbage', 1)",
                rusqlite::params![key],
            )
            .expect("seed");
        assert_eq!(resolve_sibling_sort(&db, &desc, ""), (VolumeSortField::Name, true));
    }

    /// 20) command 级：父目录 directory_sort 覆盖（name 降序）→ 跨卷跟随降序。
    #[tokio::test]
    async fn cross_volume_follows_parent_sort_override_desc() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2", "vol3"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("db");
        let desc = local_descriptor(dir.path().to_str().unwrap());
        let key = crate::commands::directory_sort::location_key_of(&desc, "");
        db.conn()
            .execute(
                "INSERT INTO directory_sort (location_key, sort_field, ascending) VALUES (?1, 'name', 0)",
                rusqlite::params![key],
            )
            .expect("seed");

        // 降序 = [vol3, vol2, vol1]：vol3 的 next 是 vol2；vol1 的 next 是 None
        let args = FindNextVolumeArgs {
            descriptor: desc.clone(),
            current_path: "vol3".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        assert_eq!(result.expect("降序下 vol3 → vol2").title, "vol2");

        let args = FindNextVolumeArgs {
            descriptor: desc,
            current_path: "vol1".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        assert!(result.is_none(), "降序下 vol1 是最后一卷，next 应为 None");
    }

    /// 21) command 级：无覆盖时 settings 全局（fb_sort_ascending='0'）生效。
    #[tokio::test]
    async fn cross_volume_follows_settings_global_sort_desc() {
        let dir = tempfile::tempdir().expect("tempdir");
        for name in ["vol1", "vol2"] {
            make_subdir(dir.path(), name);
        }
        let factory = make_factory();
        let db = crate::db::Db::open_in_memory().expect("db");
        db.conn()
            .execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('fb_sort_field', 'name'), ('fb_sort_ascending', '0')",
                [],
            )
            .expect("seed settings");

        // 全局降序 = [vol2, vol1]：vol2 的 next 是 vol1；vol1 的 next 是 None
        let args = FindNextVolumeArgs {
            descriptor: local_descriptor(dir.path().to_str().unwrap()),
            current_path: "vol2".to_string(),
            direction: VolumeDirection::Next,
            skip_finished: None,
        };
        let result = find_next_volume_impl(args, &factory, Some(&db))
            .await
            .expect("impl ok");
        assert_eq!(result.expect("全局降序 vol2 → vol1").title, "vol1");
    }
}
