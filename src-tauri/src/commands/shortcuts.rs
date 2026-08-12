//! `commands::shortcuts` —— 快捷方式 CRUD (跨源 + 子目录, v0.1.0-module3.0.5)
//!
//! DESIGN §1.3 + §7.4: 多个目录作为"快捷方式"持久化到 DB。
//! v0.1.0-module3.0.5: 对齐 Android ShortcutEntity ——
//!   - 存 source_descriptor_json (跨源 Local/Smb/WebDav/Archive) + rel_path (子目录)
//!   - icon_hint 派生 (local/smb/webdav/archive)
//!   - UNIQUE(source_descriptor_json, rel_path) 去重
//! 注意吸取 #0 review 教训：Rust command 直接用扁平参数（camelCase 嵌套 struct 由 Tauri 拆分），
//! 不用 `args: X` 包裹，避免 IPC 反序列化失败。

use serde::{Deserialize, Serialize};

use crate::source::descriptor::SourceDescriptor;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutItem {
    pub id: i64,
    pub source_descriptor_json: String,
    pub rel_path: String,
    pub alias: Option<String>,
    pub icon_hint: String,
    pub created_at: i64,
}

/// 按 descriptor 类型派生 icon_hint (与 TS 端 `iconHintFor` 语义一致)
fn icon_hint_for(json: &str) -> String {
    match serde_json::from_str::<SourceDescriptor>(json) {
        Ok(d) => d.type_str().to_string(),
        Err(_) => "local".to_string(),
    }
}

#[tauri::command]
pub fn list_shortcuts(db: tauri::State<crate::db::Db>) -> Result<Vec<ShortcutItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT id, source_descriptor_json, rel_path, alias, icon_hint, created_at FROM shortcut ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ShortcutItem {
                id: row.get::<_, i64>(0)?,
                source_descriptor_json: row.get::<_, String>(1)?,
                rel_path: row.get::<_, String>(2)?,
                alias: row.get::<_, Option<String>>(3)?,
                icon_hint: row.get::<_, String>(4)?,
                created_at: row.get::<_, i64>(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn create_shortcut(
    source_descriptor_json: String,
    rel_path: String,
    alias: Option<String>,
    db: tauri::State<crate::db::Db>,
) -> Result<i64, String> {
    let conn = db.conn();
    let now = chrono_now();
    // 路径身份修复 (2026-08-12, spec §6.3): descriptor 反序列化校验 + 重新序列化规范化;
    // rel_path 校验 source-relative。防止坏 shortcut 把绝对路径灌进库持续重放污染。
    let (descriptor_json_norm, rel_path_norm) =
        normalize_shortcut_input(&source_descriptor_json, &rel_path)?;
    let icon_hint = icon_hint_for(&descriptor_json_norm);
    // INSERT OR IGNORE: 重复 (descriptor, rel_path) 时不报错 (保留旧 alias)
    conn.execute(
        "INSERT OR IGNORE INTO shortcut (source_descriptor_json, rel_path, alias, icon_hint, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![descriptor_json_norm, rel_path_norm, alias, icon_hint, now],
    )
    .map_err(|e| e.to_string())?;
    // 读出 id（无论是新插入还是已存在）
    let id: i64 = conn
        .query_row(
            "SELECT id FROM shortcut WHERE source_descriptor_json = ?1 AND rel_path = ?2",
            rusqlite::params![descriptor_json_norm, rel_path_norm],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// 路径身份修复: 校验 + 规范化 shortcut 入参（descriptor 反序列化 + rel_path source-relative）。
/// 抽成纯函数便于单测。返回 (规范化 descriptor_json, 规范化 rel_path)。
fn normalize_shortcut_input(
    source_descriptor_json: &str,
    rel_path: &str,
) -> Result<(String, String), String> {
    let descriptor: crate::source::descriptor::SourceDescriptor =
        serde_json::from_str(source_descriptor_json)
            .map_err(|e| format!("source descriptor 非法: {}", e))?;
    let descriptor_json_norm = serde_json::to_string(&descriptor).map_err(|e| e.to_string())?;
    let rel_path_norm = crate::algorithm::validate_source_relative(rel_path)
        .map_err(|_| format!("rel_path 越出数据源根: {}", rel_path))?;
    Ok((descriptor_json_norm, rel_path_norm))
}

#[tauri::command]
pub fn delete_shortcut(id: i64, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    let changed = conn
        .execute("DELETE FROM shortcut WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("shortcut id={} 不存在", id));
    }
    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use rusqlite::Connection;

    /// 在隔离 conn 上跑 migrations 001~007，得到一个干净的测试 DB
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::run(&conn).unwrap();
        conn
    }

    fn list_with_conn(conn: &Connection) -> Vec<ShortcutItem> {
        let mut stmt = conn
            .prepare("SELECT id, source_descriptor_json, rel_path, alias, icon_hint, created_at FROM shortcut ORDER BY created_at DESC")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(ShortcutItem {
                id: row.get(0).unwrap(),
                source_descriptor_json: row.get(1).unwrap(),
                rel_path: row.get(2).unwrap(),
                alias: row.get(3).unwrap(),
                icon_hint: row.get(4).unwrap(),
                created_at: row.get(5).unwrap(),
            })
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    }

    /// 直接 SQL 版本：跳过 tauri::State 包装，与 create_shortcut 同等行为
    fn insert_with_conn(
        conn: &Connection,
        json: &str,
        rel_path: &str,
        alias: Option<&str>,
    ) -> i64 {
        let now = chrono_now();
        let icon_hint = icon_hint_for(json);
        conn.execute(
            "INSERT OR IGNORE INTO shortcut (source_descriptor_json, rel_path, alias, icon_hint, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![json, rel_path, alias, icon_hint, now],
        )
        .unwrap();
        conn.query_row(
            "SELECT id FROM shortcut WHERE source_descriptor_json = ?1 AND rel_path = ?2",
            rusqlite::params![json, rel_path],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn delete_with_conn(conn: &Connection, id: i64) -> bool {
        let changed = conn
            .execute("DELETE FROM shortcut WHERE id = ?1", rusqlite::params![id])
            .unwrap();
        changed > 0
    }

    #[test]
    fn shortcut_item_serializes_as_camel_case() {
        // 验证响应序列化键名是 camelCase（前端 TS 期望 sourceDescriptorJson / relPath / iconHint / createdAt）
        let item = ShortcutItem {
            id: 1,
            source_descriptor_json: r#"{"type":"local","rootPath":"/a"}"#.into(),
            rel_path: "".into(),
            alias: None,
            icon_hint: "local".into(),
            created_at: 100,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"sourceDescriptorJson\""), "应是 sourceDescriptorJson: {json}");
        assert!(json.contains("\"relPath\""), "应是 relPath: {json}");
        assert!(json.contains("\"iconHint\""), "应是 iconHint: {json}");
        assert!(json.contains("\"createdAt\""), "应是 createdAt: {json}");
        assert!(!json.contains("\"root_path\""), "不应有 root_path: {json}");
        assert!(!json.contains("\"source_descriptor_json\""), "不应有 source_descriptor_json: {json}");
    }

    #[test]
    fn insert_then_list_includes() {
        let conn = setup_db();
        let json = r#"{"type":"local","rootPath":"C:/comics"}"#;
        let id = insert_with_conn(&conn, json, "", Some("我的漫画"));
        assert!(id > 0);
        let items = list_with_conn(&conn);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source_descriptor_json, json);
        assert_eq!(items[0].rel_path, "");
        assert_eq!(items[0].icon_hint, "local");
        assert_eq!(items[0].alias, Some("我的漫画".to_string()));
    }

    #[test]
    fn insert_with_subdirectory_relpath() {
        // 子目录快捷方式：同一 descriptor + 不同 rel_path 共存
        let conn = setup_db();
        let json = r#"{"type":"local","rootPath":"D:/manga"}"#;
        let id_root = insert_with_conn(&conn, json, "", Some("根"));
        let id_sub = insert_with_conn(&conn, json, "jujutsu/vol05", Some("咒术 Vol.05"));
        assert_ne!(id_root, id_sub);
        let items = list_with_conn(&conn);
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn insert_duplicate_returns_existing_id() {
        let conn = setup_db();
        let json = r#"{"type":"local","rootPath":"C:/comics"}"#;
        let id1 = insert_with_conn(&conn, json, "", Some("标签 A"));
        let id2 = insert_with_conn(&conn, json, "", Some("标签 B"));
        assert_eq!(id1, id2, "重复 (descriptor, rel_path) 应返回已存在 id");
        let items = list_with_conn(&conn);
        assert_eq!(items.len(), 1, "不应创建第二条");
        // alias 保留首次
        assert_eq!(items[0].alias, Some("标签 A".to_string()));
    }

    #[test]
    fn delete_removes() {
        let conn = setup_db();
        let json = r#"{"type":"local","rootPath":"C:/comics"}"#;
        let id = insert_with_conn(&conn, json, "", None);
        assert!(delete_with_conn(&conn, id));
        assert!(list_with_conn(&conn).is_empty());
    }

    #[test]
    fn delete_nonexistent_returns_false() {
        let conn = setup_db();
        assert!(!delete_with_conn(&conn, 99999));
    }

    #[test]
    fn list_orders_by_created_at_desc() {
        let conn = setup_db();
        let json_a = r#"{"type":"local","rootPath":"C:/first"}"#;
        let json_b = r#"{"type":"local","rootPath":"C:/second"}"#;
        let id1 = insert_with_conn(&conn, json_a, "", None);
        // 手动设确定的 created_at（毫秒精度在同毫秒内多次插入会并列，排序不稳定）
        conn.execute(
            "UPDATE shortcut SET created_at = 100 WHERE id = ?1",
            rusqlite::params![id1],
        )
        .unwrap();
        let id2 = insert_with_conn(&conn, json_b, "", None);
        conn.execute(
            "UPDATE shortcut SET created_at = 200 WHERE id = ?1",
            rusqlite::params![id2],
        )
        .unwrap();
        let items = list_with_conn(&conn);
        assert_eq!(items.len(), 2);
        // 最新的 (created_at=200, id2) 排第一
        assert_eq!(items[0].id, id2);
        assert_eq!(items[1].id, id1);
    }

    #[test]
    fn alias_optional_allows_null() {
        let conn = setup_db();
        let json = r#"{"type":"local","rootPath":"C:/a"}"#;
        let id = insert_with_conn(&conn, json, "", None);
        let items = list_with_conn(&conn);
        assert_eq!(items[0].id, id);
        assert!(items[0].alias.is_none());
    }

    #[test]
    fn icon_hint_derives_from_descriptor_type() {
        // local descriptor → "local"
        assert_eq!(icon_hint_for(r#"{"type":"local","rootPath":"C:/x"}"#), "local");
        // archive descriptor → "archive"
        assert_eq!(
            icon_hint_for(r#"{"type":"archive","archivePath":"C:/x.cbz","format":"cbz"}"#),
            "archive",
        );
        // 非法 JSON fallback → "local"
        assert_eq!(icon_hint_for("not json"), "local");
    }

    // ─── 路径身份修复 (2026-08-12, spec §6.3): create_shortcut 入参校验 ───

    #[test]
    fn normalize_shortcut_input_accepts_root_empty() {
        let json = r#"{"type":"local","rootPath":"C:/comics"}"#;
        let (nj, rp) = normalize_shortcut_input(json, "").unwrap();
        assert_eq!(rp, "");
        assert!(nj.contains("comics"));
    }

    #[test]
    fn normalize_shortcut_input_accepts_relative_subdir() {
        let json = r#"{"type":"local","rootPath":"C:/comics"}"#;
        let (_, rp) = normalize_shortcut_input(json, "sub/vol01").unwrap();
        assert_eq!(rp, "sub/vol01");
    }

    #[test]
    fn normalize_shortcut_input_rejects_absolute_relpath() {
        let json = r#"{"type":"local","rootPath":"C:/normal"}"#;
        // 绝对 relPath (模拟 id=8 类坏 shortcut) 必须拒绝, 不能进库
        assert!(normalize_shortcut_input(json, "F:/WallPaper").is_err());
        assert!(normalize_shortcut_input(json, "/etc").is_err());
        assert!(normalize_shortcut_input(json, "../escape").is_err());
    }

    #[test]
    fn normalize_shortcut_input_rejects_bad_descriptor() {
        // 非法 JSON descriptor 拒绝
        assert!(normalize_shortcut_input("not json", "").is_err());
        // 未知 variant 拒绝
        assert!(normalize_shortcut_input(r#"{"type":"unknown"}"#, "").is_err());
    }
}
