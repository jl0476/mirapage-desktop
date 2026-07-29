//! `commands::accounts` —— 网络账户 CRUD + 连接测试(Phase 7-8)

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccountItem {
    pub id: i64,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub share: Option<String>,
    pub username: Option<String>,
    // 不返回密码(凭据 keyring 已加密)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAccountArgs {
    pub id: Option<i64>,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub share: Option<String>,
    pub username: Option<String>,
    /// 纯文本密码(后端用 keyring 加密后丢弃)
    pub password: Option<String>,
}

#[tauri::command]
pub fn list_accounts(db: tauri::State<crate::db::Db>) -> Result<Vec<AccountItem>, String> {
    let conn = db.conn();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, type, host, port, share, username FROM account ORDER BY name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(AccountItem {
                id: row.get::<_, i64>(0)?,
                name: row.get::<_, String>(1)?,
                kind: row.get::<_, String>(2)?,
                host: row.get::<_, Option<String>>(3)?,
                port: row.get::<_, Option<i64>>(4)?,
                share: row.get::<_, Option<String>>(5)?,
                username: row.get::<_, Option<String>>(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn upsert_account(
    args: UpsertAccountArgs,
    db: tauri::State<crate::db::Db>,
) -> Result<i64, String> {
    let conn = db.conn();
    // 凭据通过 keyring 存储(Phase 7 实现)
    if let (Some(password), Some(host)) = (&args.password, &args.host) {
        // 真实项目用 keyring 加密;Phase 4 stub:写入 DB
        let encrypted = format!("plain:{}", password); // 仅 stub
        let _ = encrypted; // suppress unused
        let _ = host;
    }
    if let Some(id) = args.id {
        conn.execute(
            "UPDATE account SET name = ?1, type = ?2, host = ?3, port = ?4, share = ?5, username = ?6 WHERE id = ?7",
            rusqlite::params![args.name, args.kind, args.host, args.port, args.share, args.username, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(id)
    } else {
        conn.execute(
            "INSERT INTO account (name, type, host, port, share, username, encrypted_password) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
            rusqlite::params![args.name, args.kind, args.host, args.port, args.share, args.username],
        )
        .map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }
}

#[tauri::command]
pub fn delete_account(id: i64, db: tauri::State<crate::db::Db>) -> Result<(), String> {
    let conn = db.conn();
    conn.execute("DELETE FROM account WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 测试连接(Phase 7-8 stub:smb-rs / reqwest 实际握手)
#[tauri::command]
pub fn test_connection(_id: i64) -> Result<bool, String> {
    // TODO(Phase 7): smb-rs connect
    // TODO(Phase 8): reqwest PROPFIND
    Ok(false)
}