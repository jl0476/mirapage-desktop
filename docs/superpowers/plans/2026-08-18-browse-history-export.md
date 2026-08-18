# 阅览记录导出 JSON 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将全部阅览记录导出为 Android MiraPage 导出 schema v2 兼容的 30 字段平铺 JSON（History 页 + Settings maintenance 双入口）。

**架构：** Rust 一站式 command（`export_browse_history`：dialog 保存框 + 联表组装 + `std::fs::write`），组装逻辑抽 `build_export_doc(&Connection) -> Result<ExportDoc, String>` 纯函数单测；前端只做按钮 + 文件名生成（本地时间戳）+ IPC 封装。两入口共享 `useHistoryExport` composable。

**技术栈：** Rust（tauri 2 / rusqlite / serde_json / tauri-plugin-dialog Rust API）+ Vue 3（`<script setup>` / Pinia 不涉及 / vue-i18n）。

**Spec：** `docs/superpowers/specs/2026-08-18-browse-history-export-design.md`（字段映射总表 §3.4、warnings §3.5、Rust §4、前端 §5）

**修正 spec 一处：** `build_export_doc` 签名带 `Result`（spec §6 错误处理表要求 DB 读失败冒泡 Err，spec §4.3 签名漏了）；文件名函数放**新建** `src/lib/format.ts`（spec §5.2 写「`src/lib/format.ts` 已有 formatBytes」——实际 formatBytes 在 `locales/helpers.ts`，lib/format.ts 不存在，本计划新建它，时间戳与 locale 无关不应进 locales）。

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src-tauri/src/commands/history_export.rs` | 创建 | ExportedItem/ExportDoc/ExportOutcome 结构 + `build_export_doc` 纯函数 + `export_browse_history` command + 单测 |
| `src-tauri/src/commands/mod.rs` | 修改 | 加 `pub mod history_export;` |
| `src-tauri/src/lib.rs:56` | 修改 | `generate_handler![...]` 追加注册 |
| `src/lib/format.ts` + `format.test.ts` | 创建 | `formatExportTimestamp` / `browseHistoryExportFileName` 纯函数 |
| `src/lib/tauri.ts` | 修改 | `BrowseHistoryExportOutcome` 类型 + `exportBrowseHistory` 封装 |
| `src/composables/useHistoryExport.ts` + `.test.ts` | 创建 | 导出状态机（idle/exporting/done/failed + 3s 回落 + unmount 清理）共享两入口 |
| `src/views/History.vue` | 修改 | header 加导出按钮 |
| `src/views/History.test.ts` | 修改 | 追加按钮用例 |
| `src/views/Settings.vue` | 修改 | maintenance「历史记录」子块加导出行 |
| `src/views/Settings.test.ts` | 修改 | 追加导出行用例 |
| `src/locales/zh-CN.ts` / `en-US.ts` | 修改 | 6 组新 keys |
| `src/locales/locales.test.ts` | 修改 | 双语一致性断言补 keys（若有 keys 清单式测试则追加） |

---

### 任务 1：Rust 结构 + `build_export_doc` 骨架（local 变体最小闭环）

**文件：**
- 创建：`src-tauri/src/commands/history_export.rs`
- 修改：`src-tauri/src/commands/mod.rs`（加 `pub mod history_export;`）

- [ ] **步骤 1：编写失败的测试**

在 `src-tauri/src/commands/history_export.rs` 写下完整测试骨架 + 第一组用例（local 行 + 顶层结构）：

```rust
//! commands::history_export —— 阅览记录导出 JSON（module3.1.2）
//! 数据结构对齐 Android MiraPage 导出 schema v2（30 字段平铺命名空间），
//! 联表逻辑按桌面端 schema 重写。spec: docs/superpowers/specs/2026-08-18-browse-history-export-design.md

use std::collections::HashMap;

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

use crate::source::descriptor::{ArchiveFormat, SourceDescriptor};

/// 导出条目：30 字段，字段名/字段序对齐 Android v2 样本（混合命名，逐字段显式 rename）。
#[derive(Debug, Serialize)]
pub struct ExportedItem {
    pub id: i64,
    #[serde(rename = "relPath")]
    pub rel_path: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(rename = "sourceType")]
    pub source_type: String,
    #[serde(rename = "local_rootUri")]
    pub local_root_uri: Option<String>,
    #[serde(rename = "smb_host")]
    pub smb_host: Option<String>,
    #[serde(rename = "smb_initialPath")]
    pub smb_initial_path: Option<String>,
    #[serde(rename = "smb_path")]
    pub smb_path: Option<String>,
    #[serde(rename = "smb_accountId")]
    pub smb_account_id: Option<i64>,
    #[serde(rename = "smb_port")]
    pub smb_port: Option<i32>,
    #[serde(rename = "webdav_baseUrl")]
    pub webdav_base_url: Option<String>,
    #[serde(rename = "webdav_path")]
    pub webdav_path: Option<String>,
    #[serde(rename = "webdav_accountId")]
    pub webdav_account_id: Option<i64>,
    #[serde(rename = "archive_fileUri")]
    pub archive_file_uri: Option<String>,
    #[serde(rename = "archive_format")]
    pub archive_format: Option<String>,
    #[serde(rename = "archive_originType")]
    pub archive_origin_type: Option<String>,
    #[serde(rename = "archive_origin_rootUri")]
    pub archive_origin_root_uri: Option<String>,
    #[serde(rename = "archive_origin_host")]
    pub archive_origin_host: Option<String>,
    #[serde(rename = "archive_origin_initialPath")]
    pub archive_origin_initial_path: Option<String>,
    #[serde(rename = "archive_origin_path")]
    pub archive_origin_path: Option<String>,
    #[serde(rename = "archive_origin_accountId")]
    pub archive_origin_account_id: Option<i64>,
    #[serde(rename = "archive_origin_port")]
    pub archive_origin_port: Option<i32>,
    #[serde(rename = "archive_originEntryPath")]
    pub archive_origin_entry_path: Option<String>,
    #[serde(rename = "archive_archiveRelPath")]
    pub archive_archive_rel_path: Option<String>,
    #[serde(rename = "pageIndex")]
    pub page_index: Option<i64>,
    pub finished: Option<bool>,
    #[serde(rename = "readerMode")]
    pub reader_mode: Option<String>,
    #[serde(rename = "scaleMode")]
    pub scale_mode: Option<String>,
    #[serde(rename = "readDirection")]
    pub read_direction: Option<String>,
    pub liked: bool,
}

/// 顶层文档（字段序：schemaVersion, totalCount, warnings, items）。
#[derive(Debug, Serialize)]
pub struct ExportDoc {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i32,
    #[serde(rename = "totalCount")]
    pub total_count: usize,
    pub warnings: Vec<String>,
    pub items: Vec<ExportedItem>,
}

/// IPC 返回（camelCase，项目 IPC 惯例）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub exported: bool,
    pub path: Option<String>,
    pub total_count: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::history::record_history_inner;

    fn test_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    fn local_sd() -> SourceDescriptor {
        SourceDescriptor::Local { root_path: "D:/comics".into() }
    }

    fn seed(conn: &rusqlite::Connection, sd: &SourceDescriptor, rel: &str, name: &str, t: i64, book_id: Option<i64>) {
        let s = serde_json::to_string(sd).unwrap();
        record_history_inner(conn, &s, rel, name, t, book_id).unwrap();
    }

    fn insert_library(conn: &rusqlite::Connection, is_favorite: bool) -> i64 {
        conn.execute(
            "INSERT INTO library (title, source_descriptor, absolute_path, is_favorite) VALUES ('T', '{}', '/abs', ?1)",
            rusqlite::params![is_favorite as i64],
        ).unwrap();
        conn.query_row("SELECT last_insert_rowid()", [], |r| r.get(0)).unwrap()
    }

    fn insert_progress(conn: &rusqlite::Connection, book_id: i64, page: i64, mode: &str, finished: i64) {
        conn.execute(
            "INSERT INTO progress (book_id, page, reader_mode, updated_at, finished) VALUES (?1, ?2, ?3, 100, ?4)",
            rusqlite::params![book_id, page, mode, finished],
        ).unwrap();
    }

    #[test]
    fn local_row_maps_and_keeps_all_30_keys_with_null_namespace() {
        let conn = test_db();
        seed(&conn, &local_sd(), "/vol1", "Vol 1", 100, None);

        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc.items.len(), 1);
        let it = &doc.items[0];

        assert_eq!(it.id, 1, "id 为导出序号（1 起）");
        assert_eq!(it.rel_path, "/vol1");
        assert_eq!(it.display_name, "Vol 1");
        assert_eq!(it.source_type, "local");
        assert_eq!(it.local_root_uri.as_deref(), Some("D:/comics"));
        // 命名空间规则：不适字段 null 但 key 保留
        assert_eq!(it.smb_host, None);
        assert_eq!(it.webdav_base_url, None);
        assert_eq!(it.archive_file_uri, None);
        assert_eq!(it.scale_mode, None, "scaleMode 恒 null");
        assert_eq!(it.read_direction, None, "readDirection 恒 null");
        assert!(!it.liked, "无 library 行 liked=false（非 null）");

        // 序列化后 30 个 key 全部存在（null 也是 key）
        let v = serde_json::to_value(it).unwrap();
        let obj = v.as_object().unwrap();
        assert_eq!(obj.len(), 30, "字段数 30");
        for key in ["smb_host", "webdav_baseUrl", "archive_originType", "scaleMode", "readDirection", "pageIndex"] {
            assert!(obj.contains_key(key), "key 应保留: {key}");
            assert!(obj[key].is_null(), "{key} 应为 null");
        }
        assert_eq!(obj["liked"], serde_json::Value::Bool(false), "liked 恒布尔");
    }

    #[test]
    fn top_level_structure_and_desc_order() {
        let conn = test_db();
        seed(&conn, &local_sd(), "/old", "Old", 100, None);
        seed(&conn, &local_sd(), "/new", "New", 200, None);

        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc.schema_version, 2);
        assert_eq!(doc.total_count, doc.items.len());
        assert_eq!(doc.total_count, 2);
        assert!(doc.warnings.is_empty());
        assert_eq!(doc.items[0].rel_path, "/new", "按 last_visited_at DESC");
        assert_eq!(doc.items[1].rel_path, "/old");
        assert_eq!((doc.items[0].id, doc.items[1].id), (1, 2), "id 为 1..N 递增序号");

        // 顶层字段序 + pretty 格式（2 空格 + LF）
        let json = serde_json::to_string_pretty(&doc).unwrap();
        assert!(json.starts_with("{\n  \"schemaVersion\": 2"));
        assert!(json.contains("\n  \"totalCount\""));
        assert!(!json.contains("\r"), "LF 换行");
    }
}
```

- [ ] **步骤 2：运行测试验证失败**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib history_export
```
预期：编译失败 `cannot find function build_export_doc`。

- [ ] **步骤 3：编写最少实现**

同文件追加（struct 定义之后、tests 之前）：

```rust
/// 联表 + 展平映射。损坏行（descriptor 解析失败 / 不支持的 origin）跳过并记 warnings。
pub(crate) fn build_export_doc(conn: &rusqlite::Connection) -> Result<ExportDoc, String> {
    // account host 预载（防 N+1）：顶层 smb 与 archive origin=Smb 共用
    let mut account_hosts: HashMap<i64, Option<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, host FROM account").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            account_hosts.insert(row.0, row.1);
        }
    }

    let mut items: Vec<ExportedItem> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut stmt = conn
        .prepare(
            "SELECT bh.source_descriptor, bh.rel_path, bh.display_name, bh.book_id,
                    l.is_favorite, p.page, p.reader_mode, p.finished
             FROM browse_history bh
             LEFT JOIN library l ON bh.book_id = l.id
             LEFT JOIN progress p ON p.book_id = l.id
             ORDER BY bh.last_visited_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<i64>>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    for row in rows {
        let (sd_str, rel_path, display_name, _book_id, is_favorite, page, reader_mode, finished) =
            row.map_err(|e| e.to_string())?;
        let sd: SourceDescriptor = match serde_json::from_str(&sd_str) {
            Ok(d) => d,
            Err(e) => {
                warnings.push(format!("relPath={rel_path}: source descriptor 解析失败: {e}"));
                continue;
            }
        };
        let id = items.len() as i64 + 1;
        match map_row(id, &sd, &rel_path, &display_name, is_favorite, page, reader_mode, finished, &account_hosts) {
            Ok(item) => items.push(item),
            Err(w) => warnings.push(w),
        }
    }

    let total_count = items.len();
    Ok(ExportDoc { schema_version: 2, total_count, warnings, items })
}

/// reader_mode → Android 样本大写口径（spec §3.4；未知值原样大写）。
fn map_reader_mode(mode: &str) -> String {
    match mode {
        "single" => "SINGLE".into(),
        "double" => "DOUBLE".into(),
        "webtoon" => "VERTICAL_WEBTOON".into(),
        other => other.to_uppercase(),
    }
}

/// ArchiveFormat → Android 格式串（sevenz→"7z"，其余小写原样）。
fn archive_format_str(f: &ArchiveFormat) -> &'static str {
    match f {
        ArchiveFormat::Cbz => "cbz",
        ArchiveFormat::Cbr => "cbr",
        ArchiveFormat::Zip => "zip",
        ArchiveFormat::Rar => "rar",
        ArchiveFormat::SevenZ => "7z",
    }
}

fn variant_name(sd: &SourceDescriptor) -> &'static str {
    match sd {
        SourceDescriptor::Local { .. } => "local",
        SourceDescriptor::Smb { .. } => "smb",
        SourceDescriptor::WebDav { .. } => "webdav",
        SourceDescriptor::Archive { .. } => "archive",
    }
}

/// 单行映射：descriptor 展平到 30 字段。Err = warning 消息（该行跳过）。
#[allow(clippy::too_many_arguments)]
fn map_row(
    id: i64,
    sd: &SourceDescriptor,
    rel_path: &str,
    display_name: &str,
    is_favorite: Option<i64>,
    page: Option<i64>,
    reader_mode: Option<String>,
    finished: Option<i64>,
    account_hosts: &HashMap<i64, Option<String>>,
) -> Result<ExportedItem, String> {
    let mut it = ExportedItem {
        id,
        rel_path: rel_path.to_string(),
        display_name: display_name.to_string(),
        source_type: String::new(),
        local_root_uri: None,
        smb_host: None,
        smb_initial_path: None,
        smb_path: None,
        smb_account_id: None,
        smb_port: None,
        webdav_base_url: None,
        webdav_path: None,
        webdav_account_id: None,
        archive_file_uri: None,
        archive_format: None,
        archive_origin_type: None,
        archive_origin_root_uri: None,
        archive_origin_host: None,
        archive_origin_initial_path: None,
        archive_origin_path: None,
        archive_origin_account_id: None,
        archive_origin_port: None,
        archive_origin_entry_path: None,
        archive_archive_rel_path: None,
        page_index: page,
        finished: finished.map(|f| f != 0),
        reader_mode: reader_mode.as_deref().map(map_reader_mode),
        scale_mode: None,
        read_direction: None,
        liked: is_favorite.unwrap_or(0) != 0,
    };
    match sd {
        SourceDescriptor::Local { root_path } => {
            it.source_type = "local".into();
            it.local_root_uri = Some(root_path.clone());
        }
        SourceDescriptor::Smb { account_id, initial_path, path, port } => {
            it.source_type = "smb".into();
            it.smb_host = account_hosts.get(account_id).cloned().flatten();
            it.smb_initial_path = Some(initial_path.clone());
            it.smb_path = Some(path.clone());
            it.smb_account_id = Some(*account_id);
            it.smb_port = Some(*port);
        }
        SourceDescriptor::WebDav { account_id, base_url, path } => {
            it.source_type = "webdav".into();
            it.webdav_base_url = Some(base_url.clone());
            it.webdav_path = Some(path.clone());
            it.webdav_account_id = Some(*account_id);
        }
        SourceDescriptor::Archive {
            archive_path,
            format,
            origin,
            origin_entry_path,
            archive_rel_path,
            ..
        } => {
            it.source_type = "archive".into();
            it.archive_file_uri = Some(archive_path.clone());
            it.archive_format = Some(archive_format_str(format).to_string());
            it.archive_origin_entry_path = origin_entry_path.clone();
            it.archive_archive_rel_path = archive_rel_path.clone();
            match origin.as_deref() {
                None => {}
                Some(SourceDescriptor::Local { root_path }) => {
                    it.archive_origin_type = Some("local".into());
                    it.archive_origin_root_uri = Some(root_path.clone());
                }
                Some(SourceDescriptor::Smb { account_id, initial_path, path, port }) => {
                    it.archive_origin_type = Some("smb".into());
                    it.archive_origin_host = account_hosts.get(account_id).cloned().flatten();
                    it.archive_origin_initial_path = Some(initial_path.clone());
                    it.archive_origin_path = Some(path.clone());
                    it.archive_origin_account_id = Some(*account_id);
                    it.archive_origin_port = Some(*port);
                }
                Some(other) => {
                    return Err(format!(
                        "relPath={rel_path}: 不支持的 origin 形态: {}",
                        variant_name(other)
                    ));
                }
            }
        }
    }
    Ok(it)
}
```

注意：此时 `DialogExt` import 与 command 尚未使用会有 unused warning——command 在任务 5 补上；若 cargo 对 unused import 报 warning 而非 error 不影响测试。**为避免任务 1 就编译不过，`use tauri_plugin_dialog::DialogExt;` 留到任务 5 再加。**

- [ ] **步骤 4：运行测试验证通过**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib history_export
```
预期：2 passed。

- [ ] **步骤 5：Commit**

```bash
git add src-tauri/src/commands/history_export.rs src-tauri/src/commands/mod.rs
git commit -m "feat(history-export): build_export_doc 纯函数（local 变体 + 30 字段命名空间）
"
```

---

### 任务 2：联表语义（liked / progress / readerMode 映射）

**文件：**
- 修改：`src-tauri/src/commands/history_export.rs`（tests 模块追加用例）

- [ ] **步骤 1：编写失败的测试**（追加到 tests 模块）

```rust
    #[test]
    fn liked_joins_library_is_favorite() {
        let conn = test_db();
        let b1 = insert_library(&conn, true);
        let b2 = insert_library(&conn, false);
        seed(&conn, &local_sd(), "/a", "A", 100, Some(b1));
        seed(&conn, &local_sd(), "/b", "B", 200, Some(b2));
        seed(&conn, &local_sd(), "/c", "C", 300, None); // book_id NULL

        let doc = build_export_doc(&conn).unwrap();
        let by: HashMap<_, _> = doc.items.iter().map(|i| (i.rel_path.clone(), i.liked)).collect();
        assert_eq!(by["/a"], true);
        assert_eq!(by["/b"], false);
        assert_eq!(by["/c"], false, "无 library 行 liked=false（非 null）");
    }

    #[test]
    fn progress_hit_and_miss() {
        let conn = test_db();
        let b1 = insert_library(&conn, false);
        seed(&conn, &local_sd(), "/hit", "H", 100, Some(b1));
        seed(&conn, &local_sd(), "/miss", "M", 200, None);
        insert_progress(&conn, b1, 12, "webtoon", 1);

        let doc = build_export_doc(&conn).unwrap();
        let hit = doc.items.iter().find(|i| i.rel_path == "/hit").unwrap();
        let miss = doc.items.iter().find(|i| i.rel_path == "/miss").unwrap();

        assert_eq!(hit.page_index, Some(12));
        assert_eq!(hit.finished, Some(true), "finished 1 → true");
        assert_eq!(hit.reader_mode.as_deref(), Some("VERTICAL_WEBTOON"));
        assert_eq!(miss.page_index, None);
        assert_eq!(miss.finished, None);
        assert_eq!(miss.reader_mode, None);
    }

    #[test]
    fn finished_zero_maps_false_and_reader_mode_variants() {
        let conn = test_db();
        let b = insert_library(&conn, false);
        seed(&conn, &local_sd(), "/s", "S", 100, Some(b));
        insert_progress(&conn, b, 3, "single", 0);

        // 未知值原样大写
        conn.execute(
            "UPDATE progress SET reader_mode = 'weird' WHERE book_id = ?1",
            rusqlite::params![b],
        ).unwrap();

        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc.items[0].finished, Some(false), "finished 0 → false");
        assert_eq!(doc.items[0].reader_mode.as_deref(), Some("WEIRD"), "未知值原样大写");

        // 三值映射逐一验证
        for (input, expected) in [("single", "SINGLE"), ("double", "DOUBLE"), ("webtoon", "VERTICAL_WEBTOON")] {
            conn.execute("UPDATE progress SET reader_mode = ?1 WHERE book_id = ?2", rusqlite::params![input, b]).unwrap();
            let doc = build_export_doc(&conn).unwrap();
            assert_eq!(doc.items[0].reader_mode.as_deref(), Some(expected), "{input} → {expected}");
        }
    }
```

- [ ] **步骤 2：运行测试验证通过**

任务 1 的实现已覆盖这些路径（联表 SQL + map 已写全）。运行：

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib history_export
```
预期：5 passed。**若有失败按 TDD 修实现**（正常应全绿——任务 1 是整函数一次交付，任务 2-4 是按 spec §7.1 用例矩阵补断言防回归）。

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/commands/history_export.rs
git commit -m "test(history-export): liked/progress/readerMode 联表语义用例
"
```

---

### 任务 3：smb / webdav 变体 + account 联查

**文件：**
- 修改：`src-tauri/src/commands/history_export.rs`（tests 追加）

- [ ] **步骤 1：编写失败的测试**

```rust
    fn insert_account(conn: &rusqlite::Connection, host: Option<&str>) -> i64 {
        conn.execute(
            "INSERT INTO account (name, type, host, port, share, username) VALUES ('a', 'smb', ?1, 445, 'share', 'u')",
            rusqlite::params![host],
        ).unwrap();
        conn.query_row("SELECT last_insert_rowid()", [], |r| r.get(0)).unwrap()
    }

    fn smb_sd(account_id: i64) -> SourceDescriptor {
        SourceDescriptor::Smb { account_id, initial_path: "usbshare3".into(), path: String::new(), port: 445 }
    }

    #[test]
    fn smb_row_maps_five_fields_and_joins_account_host() {
        let conn = test_db();
        let acc = insert_account(&conn, Some("192.168.50.100"));
        seed(&conn, &smb_sd(acc), "/00down/x", "X", 100, None);

        let doc = build_export_doc(&conn).unwrap();
        let it = &doc.items[0];
        assert_eq!(it.source_type, "smb");
        assert_eq!(it.smb_host.as_deref(), Some("192.168.50.100"), "host 从 account 表联查");
        assert_eq!(it.smb_initial_path.as_deref(), Some("usbshare3"));
        assert_eq!(it.smb_path.as_deref(), Some(""));
        assert_eq!(it.smb_account_id, Some(acc));
        assert_eq!(it.smb_port, Some(445));
        assert_eq!(it.local_root_uri, None);
    }

    #[test]
    fn smb_host_null_when_account_deleted() {
        let conn = test_db();
        seed(&conn, &smb_sd(999), "/x", "X", 100, None); // account 999 不存在

        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc.items[0].smb_host, None, "账号已删 → smb_host null");
        assert_eq!(doc.items[0].smb_account_id, Some(999), "accountId 仍导出");
    }

    #[test]
    fn webdav_row_maps_three_fields() {
        let conn = test_db();
        let sd = SourceDescriptor::WebDav { account_id: 7, base_url: "https://dav.example.com".into(), path: "/books".into() };
        seed(&conn, &sd, "/book1", "B1", 100, None);

        let doc = build_export_doc(&conn).unwrap();
        let it = &doc.items[0];
        assert_eq!(it.source_type, "webdav");
        assert_eq!(it.webdav_base_url.as_deref(), Some("https://dav.example.com"));
        assert_eq!(it.webdav_path.as_deref(), Some("/books"));
        assert_eq!(it.webdav_account_id, Some(7));
        assert_eq!(it.smb_host, None);
    }
```

- [ ] **步骤 2：运行测试验证通过**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib history_export
```
预期：8 passed。

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/commands/history_export.rs
git commit -m "test(history-export): smb/webdav 变体 + account host 联查用例
"
```

---

### 任务 4：archive 变体（origin 三形态 + 格式映射）+ warnings

**文件：**
- 修改：`src-tauri/src/commands/history_export.rs`（tests 追加）

- [ ] **步骤 1：编写失败的测试**

```rust
    #[test]
    fn archive_origin_none_maps_archive_fields_only() {
        let conn = test_db();
        let sd = SourceDescriptor::Archive {
            archive_path: "D:/books/a.cbz".into(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Cbz,
            origin: None,
            origin_entry_path: None,
            archive_rel_path: None,
        };
        seed(&conn, &sd, "/a.cbz", "A", 100, None);

        let doc = build_export_doc(&conn).unwrap();
        let it = &doc.items[0];
        assert_eq!(it.source_type, "archive");
        assert_eq!(it.archive_file_uri.as_deref(), Some("D:/books/a.cbz"));
        assert_eq!(it.archive_format.as_deref(), Some("cbz"));
        assert_eq!(it.archive_origin_type, None, "origin=None → originType null");
        assert_eq!(it.archive_origin_root_uri, None);
        assert_eq!(it.archive_origin_host, None);
        assert_eq!(it.archive_origin_entry_path, None);
        assert_eq!(it.archive_archive_rel_path, None);
    }

    #[test]
    fn archive_origin_local_flattens_and_sevenz_maps_7z() {
        let conn = test_db();
        let sd = SourceDescriptor::Archive {
            archive_path: "D:/cache/tmp.7z".into(),
            entry_prefix: String::new(),
            format: ArchiveFormat::SevenZ,
            origin: Some(Box::new(SourceDescriptor::Local { root_path: "E:/src".into() })),
            origin_entry_path: Some("comics/vol1.7z".into()),
            archive_rel_path: Some("cache/tmp.7z".into()),
        };
        seed(&conn, &sd, "/vol1", "V1", 100, None);

        let doc = build_export_doc(&conn).unwrap();
        let it = &doc.items[0];
        assert_eq!(it.archive_format.as_deref(), Some("7z"), "sevenz → 7z");
        assert_eq!(it.archive_origin_type.as_deref(), Some("local"));
        assert_eq!(it.archive_origin_root_uri.as_deref(), Some("E:/src"));
        assert_eq!(it.archive_origin_host, None);
        assert_eq!(it.archive_origin_initial_path, None);
        assert_eq!(it.archive_origin_entry_path.as_deref(), Some("comics/vol1.7z"));
        assert_eq!(it.archive_archive_rel_path.as_deref(), Some("cache/tmp.7z"));
    }

    #[test]
    fn archive_origin_smb_flattens_with_account_host() {
        let conn = test_db();
        let acc = insert_account(&conn, Some("10.0.0.2"));
        let sd = SourceDescriptor::Archive {
            archive_path: "D:/cache/b.cbz".into(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Zip,
            origin: Some(Box::new(SourceDescriptor::Smb { account_id: acc, initial_path: "share".into(), path: "sub".into(), port: 445 })),
            origin_entry_path: None,
            archive_rel_path: None,
        };
        seed(&conn, &sd, "/b", "B", 100, None);

        let doc = build_export_doc(&conn).unwrap();
        let it = &doc.items[0];
        assert_eq!(it.archive_origin_type.as_deref(), Some("smb"));
        assert_eq!(it.archive_origin_host.as_deref(), Some("10.0.0.2"), "origin smb host 联 account");
        assert_eq!(it.archive_origin_initial_path.as_deref(), Some("share"));
        assert_eq!(it.archive_origin_path.as_deref(), Some("sub"));
        assert_eq!(it.archive_origin_account_id, Some(acc));
        assert_eq!(it.archive_origin_port, Some(445));
        assert_eq!(it.smb_host, None, "顶层 smb 命名空间不沾 origin 的值");
    }

    #[test]
    fn warnings_skip_broken_descriptor_and_unsupported_origin() {
        let conn = test_db();
        // 直接 SQL 插一条非法 descriptor（record_history_inner 会校验拒绝，绕过）
        conn.execute(
            "INSERT INTO browse_history (source_descriptor, rel_path, display_name, last_visited_at) VALUES ('not-json', '/bad', 'Bad', 100)",
            [],
        ).unwrap();
        seed(&conn, &local_sd(), "/good", "Good", 200, None);
        // origin=WebDav：Android v2 schema 无对应字段位 → 跳过
        let sd = SourceDescriptor::Archive {
            archive_path: "D:/c.zip".into(),
            entry_prefix: String::new(),
            format: ArchiveFormat::Zip,
            origin: Some(Box::new(SourceDescriptor::WebDav { account_id: 1, base_url: "https://d".into(), path: "/".into() })),
            origin_entry_path: None,
            archive_rel_path: None,
        };
        seed(&conn, &sd, "/wd", "WD", 300, None);

        let doc = build_export_doc(&conn).unwrap();
        assert_eq!(doc.items.len(), 1, "两条坏行跳过，仅 /good 导出");
        assert_eq!(doc.total_count, 1, "totalCount 不含跳过行");
        assert_eq!(doc.items[0].rel_path, "/good");
        assert_eq!(doc.items[0].id, 1, "跳过行不占序号");
        assert_eq!(doc.warnings.len(), 2);
        assert!(doc.warnings[0].contains("/bad"), "warnings 含路径明细: {:?}", doc.warnings[0]);
        assert!(doc.warnings[1].contains("/wd") && doc.warnings[1].contains("webdav"), "含 origin 形态: {:?}", doc.warnings[1]);
    }
```

- [ ] **步骤 2：运行测试验证通过**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib history_export
```
预期：12 passed（累计）。

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/commands/history_export.rs
git commit -m "test(history-export): archive origin 三态/格式映射/warnings 用例
"
```

---

### 任务 5：`export_browse_history` command + 注册

**文件：**
- 修改：`src-tauri/src/commands/history_export.rs`（加 command）
- 修改：`src-tauri/src/lib.rs:56`（`generate_handler![...]` 列表追加）

- [ ] **步骤 1：编写实现**

`src-tauri/src/commands/history_export.rs` 顶部补 `use tauri_plugin_dialog::DialogExt;`（若任务 1 已加则跳过），struct 定义后追加：

```rust
/// 导出全部阅览记录。前端传默认文件名（本地时间戳由前端生成）。
/// 用户取消对话框 → Ok(exported=false)，不算错误。
#[tauri::command]
pub fn export_browse_history(
    app: tauri::AppHandle,
    db: tauri::State<crate::db::Db>,
    default_file_name: String,
) -> Result<ExportOutcome, String> {
    let Some(file_path) = app
        .dialog()
        .file()
        .set_file_name(&default_file_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file()
    else {
        return Ok(ExportOutcome { exported: false, path: None, total_count: 0 });
    };
    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let doc = build_export_doc(&db.conn())?;
    let json = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(ExportOutcome {
        exported: true,
        path: Some(path.to_string_lossy().into_owned()),
        total_count: doc.total_count,
    })
}
```

`src-tauri/src/lib.rs` 的 `generate_handler![...]` 列表末尾追加一行：

```rust
            commands::history_export::export_browse_history,
```

- [ ] **步骤 2：编译 + 全量 Rust 测试**

```bash
cd src-tauri && cargo test -p mirapage-desktop-lib
```
预期：编译通过，history_export 12 用例 + 既有全量 passed（本机此前全绿基线）。

- [ ] **步骤 3：Commit**

```bash
git add src-tauri/src/commands/history_export.rs src-tauri/src/lib.rs
git commit -m "feat(history-export): export_browse_history 命令（dialog 保存框 + 写文件）
"
```

---

### 任务 6：前端基建——`lib/format.ts` + `lib/tauri.ts` 封装 + i18n keys

**文件：**
- 创建：`src/lib/format.ts`、`src/lib/format.test.ts`
- 修改：`src/lib/tauri.ts`（追加封装）
- 修改：`src/locales/zh-CN.ts`、`src/locales/en-US.ts`（6 keys）

- [ ] **步骤 1：编写失败的测试**

创建 `src/lib/format.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { browseHistoryExportFileName, formatExportTimestamp } from './format';

describe('formatExportTimestamp', () => {
  it('各段补零（月/日/时/分/秒 < 10）', () => {
    expect(formatExportTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102_030405');
  });

  it('两位段不补零、跨年正常', () => {
    expect(formatExportTimestamp(new Date(2026, 11, 31, 23, 59, 59))).toBe('20261231_235959');
  });

  it('导出文件名拼接（browse_history_ 前缀 + .json 后缀）', () => {
    expect(browseHistoryExportFileName(new Date(2026, 7, 18, 16, 19, 25))).toBe(
      'browse_history_20260818_161925.json'
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run src/lib/format.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现**

创建 `src/lib/format.ts`：

```ts
/**
 * 纯格式化函数（无 locale 依赖；locale 相关的日期时间在 locales/helpers.ts）。
 */

/** 本地时间戳 yyyyMMdd_HHmmss（导出文件名用，对齐 Android 命名）。 */
export function formatExportTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function browseHistoryExportFileName(now: Date = new Date()): string {
  return `browse_history_${formatExportTimestamp(now)}.json`;
}
```

`src/lib/tauri.ts` 追加（与其他封装同风格）：

```ts
export interface BrowseHistoryExportOutcome {
  exported: boolean;
  path: string | null;
  totalCount: number;
}

export async function exportBrowseHistory(defaultFileName: string): Promise<BrowseHistoryExportOutcome> {
  return invoke('export_browse_history', { defaultFileName });
}
```

i18n（zh-CN.ts 的 `history` 命名空间追加 + `settings.maintenance` 追加；en-US.ts 对应）：

```ts
// zh-CN.ts history 命名空间内：
export: '导出',
exporting: '导出中…',
exported: '已导出 {count} 条',
exportFailed: '导出失败',
// zh-CN.ts settings.maintenance 内：
exportHistory: '导出阅览记录',
exportHistoryDesc: '将全部阅览记录（含进度与喜欢状态）导出为 JSON 文件',
```

```ts
// en-US.ts history 命名空间内：
export: 'Export',
exporting: 'Exporting…',
exported: 'Exported {count} items',
exportFailed: 'Export failed',
// en-US.ts settings.maintenance 内：
exportHistory: 'Export browse history',
exportHistoryDesc: 'Export all browse history (with progress & liked) to a JSON file',
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run src/lib/format.test.ts && npx vitest run src/locales/locales.test.ts
```
预期：format 3 passed；locales 双语一致性 passed（若 locales.test.ts 有 key 集合断言需同步补——先跑，红了按其模式补）。

- [ ] **步骤 5：Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts src/lib/tauri.ts src/locales/zh-CN.ts src/locales/en-US.ts
git commit -m "feat(history-export): 前端基建（文件名生成/IPC 封装/i18n 6 keys）
"
```

---

### 任务 7：`useHistoryExport` composable（状态机，两入口共享）

**文件：**
- 创建：`src/composables/useHistoryExport.ts`、`src/composables/useHistoryExport.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `src/composables/useHistoryExport.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { exportBrowseHistory } from '@/lib/tauri';
import { useHistoryExport } from './useHistoryExport';

vi.mock('@/lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri')>('@/lib/tauri');
  return { ...actual, exportBrowseHistory: vi.fn() };
});

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: { 'zh-CN': { history: {
    export: '导出', exporting: '导出中…', exported: '已导出 {count} 条', exportFailed: '导出失败',
  } } },
});

function setup() {
  return useHistoryExport(i18n.global.t);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe('useHistoryExport', () => {
  it('idle 初始态按钮文本为「导出」', () => {
    const { buttonText, state } = setup();
    expect(state.value).toBe('idle');
    expect(buttonText.value).toBe('导出');
  });

  it('成功：exported=true → done 文案含条数，3s 后回落 idle', async () => {
    vi.mocked(exportBrowseHistory).mockResolvedValue({ exported: true, path: 'X:/a.json', totalCount: 42 });
    const { buttonText, state, trigger } = setup();

    const p = trigger();
    expect(state.value).toBe('exporting');
    await p;
    expect(state.value).toBe('done');
    expect(buttonText.value).toBe('已导出 42 条');
    expect(exportBrowseHistory).toHaveBeenCalledWith(expect.stringMatching(/^browse_history_\d{8}_\d{6}\.json$/));

    vi.advanceTimersByTime(3000);
    expect(state.value).toBe('idle');
  });

  it('取消：exported=false 静默回 idle（无 3s 等待）', async () => {
    vi.mocked(exportBrowseHistory).mockResolvedValue({ exported: false, path: null, totalCount: 0 });
    const { state, trigger } = setup();
    await trigger();
    expect(state.value).toBe('idle');
  });

  it('失败：异常 → failed 文案，3s 后回落', async () => {
    vi.mocked(exportBrowseHistory).mockRejectedValue(new Error('disk'));
    const { buttonText, state, trigger } = setup();
    await trigger();
    expect(state.value).toBe('failed');
    expect(buttonText.value).toBe('导出失败');
    vi.advanceTimersByTime(3000);
    expect(state.value).toBe('idle');
  });

  it('exporting 中重复 trigger 被忽略', async () => {
    let resolveFn: (v: { exported: boolean; path: string | null; totalCount: number }) => void = () => {};
    vi.mocked(exportBrowseHistory).mockImplementation(
      () => new Promise((res) => { resolveFn = res; })
    );
    const { trigger } = setup();
    const p1 = trigger();
    const p2 = trigger(); // exporting 中
    resolveFn({ exported: false, path: null, totalCount: 0 });
    await Promise.all([p1, p2]);
    expect(exportBrowseHistory).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run src/composables/useHistoryExport.test.ts
```
预期：FAIL（模块不存在）。

- [ ] **步骤 3：实现**

创建 `src/composables/useHistoryExport.ts`：

```ts
/**
 * 阅览记录导出状态机（module3.1.2，History 页与 Settings maintenance 共享）。
 *
 * idle → (trigger) → exporting → exported=true → done --3s--> idle
 *                               → exported=false（取消）→ idle（静默）
 *                               → 异常 → failed --3s--> idle
 * exporting 中重复 trigger 忽略；组件卸载清理定时器。
 */
import { computed, onUnmounted, ref } from 'vue';
import type { ComposerTranslation } from 'vue-i18n';
import { exportBrowseHistory } from '@/lib/tauri';
import { browseHistoryExportFileName } from '@/lib/format';

export type HistoryExportState = 'idle' | 'exporting' | 'done' | 'failed';

export function useHistoryExport(t: ComposerTranslation) {
  const state = ref<HistoryExportState>('idle');
  const exportedCount = ref(0);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const buttonText = computed(() => {
    switch (state.value) {
      case 'exporting':
        return t('history.exporting');
      case 'done':
        return t('history.exported', { count: exportedCount.value });
      case 'failed':
        return t('history.exportFailed');
      default:
        return t('history.export');
    }
  });

  function scheduleReset() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      state.value = 'idle';
    }, 3000);
  }

  async function trigger(): Promise<void> {
    if (state.value === 'exporting') return;
    state.value = 'exporting';
    try {
      const r = await exportBrowseHistory(browseHistoryExportFileName());
      if (r.exported) {
        exportedCount.value = r.totalCount;
        state.value = 'done';
        scheduleReset();
      } else {
        state.value = 'idle'; // 用户取消对话框：静默
      }
    } catch {
      state.value = 'failed';
      scheduleReset();
    }
  }

  onUnmounted(() => {
    if (timer) clearTimeout(timer);
  });

  return { state, buttonText, trigger };
}
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run src/composables/useHistoryExport.test.ts
```
预期：5 passed。

- [ ] **步骤 5：Commit**

```bash
git add src/composables/useHistoryExport.ts src/composables/useHistoryExport.test.ts
git commit -m "feat(history-export): useHistoryExport 状态机 composable
"
```

---

### 任务 8：History.vue 导出按钮

**文件：**
- 修改：`src/views/History.vue`（script import + header 模板）
- 修改：`src/views/History.test.ts`（追加用例）

- [ ] **步骤 1：编写失败的测试**

在 `src/views/History.test.ts` 按现有 mock 模式追加（沿用该文件已有的 mount helper / tauri mock；若其 mock 未含 `exportBrowseHistory` 则在 `vi.mock('@/lib/tauri')` 工厂补 `exportBrowseHistory: vi.fn()`）：

```ts
  it('渲染导出按钮，点击调 exportBrowseHistory 且成功后显示条数', async () => {
    const { exportBrowseHistory } = await import('@/lib/tauri');
    vi.mocked(exportBrowseHistory).mockResolvedValue({ exported: true, path: 'X:/o.json', totalCount: 3 });
    const wrapper = mountHistory(); // 该文件已有的挂载 helper（名字按实际）
    await flushPromises();

    const btn = wrapper.find('[data-test="btn-export"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('导出');

    await btn.trigger('click');
    await flushPromises();
    expect(exportBrowseHistory).toHaveBeenCalledWith(expect.stringMatching(/^browse_history_\d{8}_\d{6}\.json$/));
    expect(wrapper.find('[data-test="btn-export"]').text()).toContain('3');
  });

  it('导出中按钮 disabled', async () => {
    // pending promise 挂起期间 disabled=true
    let resolveFn: (v: never) => void = () => {};
    vi.mocked(exportBrowseHistory).mockImplementation(
      () => new Promise((res) => { resolveFn = res; })
    );
    const wrapper = mountHistory();
    await flushPromises();
    await wrapper.find('[data-test="btn-export"]').trigger('click');
    await nextTick();
    expect(wrapper.find('[data-test="btn-export"]').attributes('disabled')).toBeDefined();
    resolveFn({ exported: false, path: null, totalCount: 0 } as never);
    await flushPromises();
  });
```

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run src/views/History.test.ts
```
预期：新用例 FAIL（按钮不存在）。

- [ ] **步骤 3：实现**

`src/views/History.vue` script 追加：

```ts
import { useHistoryExport } from '@/composables/useHistoryExport';
// setup 内：
const { buttonText: exportButtonText, state: exportState, trigger: triggerExport } = useHistoryExport(t);
```

header 右侧 `<div class="flex items-center gap-3">` 内、`<ListSearchInput ...>` **之前**插入：

```html
        <button
          data-test="btn-export"
          class="text-xs px-2.5 py-1.5 rounded xp-bd bg-transparent text-text-secondary
                 hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50 whitespace-nowrap"
          :disabled="exportState === 'exporting'"
          @click="triggerExport"
        >
          {{ exportButtonText }}
        </button>
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run src/views/History.test.ts
```
预期：全部 passed（含既有用例无回归）。

- [ ] **步骤 5：Commit**

```bash
git add src/views/History.vue src/views/History.test.ts
git commit -m "feat(history-export): 阅览记录页工具栏导出按钮
"
```

---

### 任务 9：Settings.vue maintenance 导出行

**文件：**
- 修改：`src/views/Settings.vue`（maintenance section「历史记录」子块）
- 修改：`src/views/Settings.test.ts`（追加用例）

- [ ] **步骤 1：编写失败的测试**

```ts
  it('maintenance 渲染导出阅览记录行，点击触发导出', async () => {
    const { exportBrowseHistory } = await import('@/lib/tauri');
    vi.mocked(exportBrowseHistory).mockResolvedValue({ exported: false, path: null, totalCount: 0 });
    const wrapper = mountSettings(); // 该文件已有的挂载 helper（名字按实际）
    await flushPromises();

    const btn = wrapper.find('[data-test="maintenance-export-history"]');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    await flushPromises();
    expect(exportBrowseHistory).toHaveBeenCalledTimes(1);
  });
```

（Settings.test.ts 的 tauri mock 工厂同样补 `exportBrowseHistory: vi.fn()`。）

- [ ] **步骤 2：运行测试验证失败**

```bash
npx vitest run src/views/Settings.test.ts
```
预期：新用例 FAIL（行不存在）。

- [ ] **步骤 3：实现**

`src/views/Settings.vue` script 追加：

```ts
import { useHistoryExport } from '@/composables/useHistoryExport';
// setup 内：
const { buttonText: exportButtonText, state: exportState, trigger: triggerExportHistory } = useHistoryExport(t);
```

maintenance section「历史记录」子块（`historyTitle` 段内、两个 NumberRow 之后、该子块 `</div>` 之前）追加：

```html
                <div class="flex items-center justify-between gap-4 xp-bdt pt-3">
                  <div class="flex flex-col gap-0.5">
                    <p class="text-xs font-semibold text-text-secondary">{{ t('settings.maintenance.exportHistory') }}</p>
                    <p class="text-xs text-text-muted">{{ t('settings.maintenance.exportHistoryDesc') }}</p>
                  </div>
                  <button
                    data-test="maintenance-export-history"
                    class="text-xs px-2.5 py-1.5 rounded xp-bd bg-transparent text-text-secondary
                           hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                    :disabled="exportState === 'exporting'"
                    @click="triggerExportHistory"
                  >
                    {{ exportButtonText }}
                  </button>
                </div>
```

- [ ] **步骤 4：运行测试验证通过**

```bash
npx vitest run src/views/Settings.test.ts
```
预期：全部 passed。

- [ ] **步骤 5：Commit**

```bash
git add src/views/Settings.vue src/views/Settings.test.ts
git commit -m "feat(history-export): Settings maintenance 导出入口
"
```

---

### 任务 10：全量验证 + 实机冒烟 + 文档同步 + tag

- [ ] **步骤 1：全量自动化验证**

```bash
npm run type-check && npm test -- --run
cd src-tauri && cargo test -p mirapage-desktop-lib
```
预期：type-check 0 error；前端全绿（1023 + 新增 ≈ 1033）；Rust 全绿（新增 12 用例）。

- [ ] **步骤 2：实机冒烟（tauri:dev，按 docs/tauri-devtools-debugging.md 流程）**

```bash
# 清残留 → 带 CDP 启动
taskkill //F //IM mirapage-desktop.exe 2>/dev/null; true
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri:dev
```

逐项验证（spec §7.3）：

1. 阅览记录页点「导出」→ 保存对话框弹出，默认文件名 `browse_history_yyyyMMdd_HHmmss.json` → 保存 → 文件生成
2. `jq '{schemaVersion, totalCount, warnings, fields: (.items[0] | keys | length)}' <导出文件>` → `{"schemaVersion":2,"fields":30,...}`
3. `jq '.items[0] | keys_unsorted'` 与参考样本字段序一致
4. 取消对话框 → 无报错、按钮回「导出」
5. Settings → maintenance → 导出阅览记录，同流程可走通
6. **blocking dialog 不死锁**（点击后 UI 仍响应、对话框正常弹出/关闭）
7. warnings 场景（如有历史脏数据则自然触发；无则跳过）

- [ ] **步骤 3：文档同步**

- `AGENTS.md` 当前状态表追加 module3.1.2 行（**先 `git fetch github main` 确认 3.1.2 未被 racyan 占用**）
- README.md 状态行补一句（如需要）

- [ ] **步骤 4：Commit + tag + push**

```bash
git add AGENTS.md
git commit -m "docs: AGENTS 状态表补 module3.1.2 阅览记录导出"
git tag v0.1.0-module3.1.2-browse-history-export
git push github main
git push github v0.1.0-module3.1.2-browse-history-export
```

---

## 自检记录

1. **规格覆盖度**：spec §3 契约（任务 1 顶层结构测试 + 任务 4 warnings + 30 key 断言）；§3.4 映射总表逐行（任务 1 local、任务 2 liked/progress/readerMode、任务 3 smb/webdav、任务 4 archive/origin/format）；§3.5 warnings（任务 4）；§4.2-4.4 Rust（任务 1+5）；§5.1-5.5 前端（任务 6-9，i18n 6 keys 在任务 6）；§6 错误处理（任务 7 状态机 + 任务 5 command）；§7 测试（Rust 12 用例对齐 spec §7.1 的 13 组中 #1-#12，#13 格式并入任务 1 的 top_level 用例；前端 3+5+2+1=11 ≥ 8）；§7.3 冒烟（任务 10）；§8 风险 blocking dialog（任务 10 步骤 2-6 专项）。**无遗漏。**
2. **占位符扫描**：所有代码步骤含完整代码；「mountHistory()/mountSettings() 名字按实际」是既有 helper 引用不是占位——执行者沿用被测文件现有 helper。
3. **类型一致性**：`ExportOutcome` 字段 exported/path/totalCount 与 TS `BrowseHistoryExportOutcome` 一致；`useHistoryExport` 返回 `{ state, buttonText, trigger }` 在任务 8/9 引用一致；`build_export_doc` 返回 `Result<ExportDoc, String>` 与 command 的 `?` 用法一致。
