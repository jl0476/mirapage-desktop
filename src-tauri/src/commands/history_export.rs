//! commands::history_export —— 阅览记录导出 JSON（module3.1.2）
//! 数据结构对齐 Android MiraPage 导出 schema v2（30 字段平铺命名空间），
//! 联表逻辑按桌面端 schema 重写。spec: docs/superpowers/specs/2026-08-18-browse-history-export-design.md

use std::collections::HashMap;

use serde::Serialize;

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
        // UNIQUE(source_descriptor, absolute_path)：同一用例多次插入需唯一键
        static COUNTER: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        conn.execute(
            "INSERT INTO library (title, source_descriptor, absolute_path, is_favorite) VALUES ('T', ?2, ?3, ?1)",
            rusqlite::params![is_favorite as i64, format!("{{\"n\":{n}}}"), format!("/abs{n}")],
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
        assert!(!json.contains('\r'), "LF 换行");
    }

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
        // warnings 顺序跟随主查询 DESC 行序，断言顺序无关
        assert!(
            doc.warnings.iter().any(|w| w.contains("/bad") && w.contains("解析失败")),
            "含 descriptor 解析失败明细: {:?}",
            doc.warnings
        );
        assert!(
            doc.warnings.iter().any(|w| w.contains("/wd") && w.contains("webdav")),
            "含 origin 形态明细: {:?}",
            doc.warnings
        );
    }
}
