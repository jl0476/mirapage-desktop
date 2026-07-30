//! `commands::shortcuts` —— 快捷方式 CRUD
//!
//! DESIGN §1.3 + §7.4: 多个根目录作为"快捷方式"持久化到 DB。
//! 注意吸取 #0 review 教训：Rust command 直接用扁平参数（camelCase 嵌套 struct 由 Tauri 拆分），
//! 不用 `args: X` 包裹，避免 IPC 反序列化失败。

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutItem {
    pub id: i64,
    pub root_path: String,
    pub label: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub fn list_shortcuts(db: tauri::State<crate::db::Db>) -> Result<Vec<ShortcutItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare("SELECT id, root_path, label, created_at FROM shortcut ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ShortcutItem {
                id: row.get::<_, i64>(0)?,
                root_path: row.get::<_, String>(1)?,
                label: row.get::<_, Option<String>>(2)?,
                created_at: row.get::<_, i64>(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn create_shortcut(
    root_path: String,
    label: Option<String>,
    db: tauri::State<crate::db::Db>,
) -> Result<i64, String> {
    let conn = db.conn();
    let now = chrono_now();
    // INSERT OR IGNORE: 重复 root_path 时不报错
    conn.execute(
        "INSERT OR IGNORE INTO shortcut (root_path, label, created_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![root_path, label, now],
    )
    .map_err(|e| e.to_string())?;
    // 读出 id（无论是新插入还是已存在）
    let id: i64 = conn
        .query_row(
            "SELECT id FROM shortcut WHERE root_path = ?1",
            [root_path],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(id)
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

    /// 在隔离 conn 上跑 migrations 001 + 002，得到一个干净的测试 DB
    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        db::migrations::run(&conn).unwrap();
        conn
    }

    fn list_with_conn(conn: &Connection) -> Vec<ShortcutItem> {
        let mut stmt = conn
            .prepare("SELECT id, root_path, label, created_at FROM shortcut ORDER BY created_at DESC")
            .unwrap();
        stmt.query_map([], |row| {
            Ok(ShortcutItem {
                id: row.get(0).unwrap(),
                root_path: row.get(1).unwrap(),
                label: row.get(2).unwrap(),
                created_at: row.get(3).unwrap(),
            })
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect()
    }

    /// 直接 SQL 版本：跳过 tauri::State 包装，与 create_shortcut 同等行为
    fn insert_with_conn(conn: &Connection, root_path: &str, label: Option<&str>) -> i64 {
        let now = chrono_now();
        conn.execute(
            "INSERT OR IGNORE INTO shortcut (root_path, label, created_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![root_path, label, now],
        )
        .unwrap();
        conn.query_row(
            "SELECT id FROM shortcut WHERE root_path = ?1",
            [root_path],
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
        // 验证响应序列化键名是 camelCase（前端 TS 期望 rootPath / createdAt）
        let item = ShortcutItem {
            id: 1,
            root_path: "/a".into(),
            label: None,
            created_at: 100,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"rootPath\""), "应是 rootPath: {json}");
        assert!(json.contains("\"createdAt\""), "应是 createdAt: {json}");
        assert!(!json.contains("\"root_path\""), "不应有 root_path: {json}");
    }

    #[test]
    fn insert_then_list_includes() {
        let conn = setup_db();
        let id = insert_with_conn(&conn, "C:/comics", Some("我的漫画"));
        assert!(id > 0);
        let items = list_with_conn(&conn);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].root_path, "C:/comics");
        assert_eq!(items[0].label, Some("我的漫画".to_string()));
    }

    #[test]
    fn insert_duplicate_returns_existing_id() {
        let conn = setup_db();
        let id1 = insert_with_conn(&conn, "C:/comics", Some("标签 A"));
        let id2 = insert_with_conn(&conn, "C:/comics", Some("标签 B"));
        assert_eq!(id1, id2, "重复 root_path 应返回已存在 id");
        let items = list_with_conn(&conn);
        assert_eq!(items.len(), 1, "不应创建第二条");
        // 标签保留首次
        assert_eq!(items[0].label, Some("标签 A".to_string()));
    }

    #[test]
    fn delete_removes() {
        let conn = setup_db();
        let id = insert_with_conn(&conn, "C:/comics", None);
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
        let id1 = insert_with_conn(&conn, "C:/first", None);
        // 时间戳递增，所以后插入的 created_at 更大
        let id2 = insert_with_conn(&conn, "C:/second", None);
        let items = list_with_conn(&conn);
        assert_eq!(items.len(), 2);
        // 最新的 (id2) 排第一
        assert_eq!(items[0].id, id2);
        assert_eq!(items[1].id, id1);
    }

    #[test]
    fn label_optional_allows_null() {
        let conn = setup_db();
        let id = insert_with_conn(&conn, "C:/a", None);
        let items = list_with_conn(&conn);
        assert_eq!(items[0].id, id);
        assert!(items[0].label.is_none());
    }
}
