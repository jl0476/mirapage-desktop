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
    creds: tauri::State<std::sync::Arc<dyn crate::credentials::CredentialStore>>,
) -> Result<i64, String> {
    upsert_account_impl(&db, creds.inner().as_ref(), args)
}

/// keyring 补偿顺序（spec §3.4）：
/// - 新建：INSERT → 写 keyring；keyring 失败 → 删行报错（不留无凭据账户）
/// - 编辑：type 不可变；先快照旧字段，UPDATE 后写 keyring 失败 → 回滚 UPDATE
/// - password 空 = 保留旧凭据（编辑不回显密码）
pub fn upsert_account_impl(
    db: &crate::db::Db,
    creds: &dyn crate::credentials::CredentialStore,
    args: UpsertAccountArgs,
) -> Result<i64, String> {
    let conn = db.conn();
    match args.id {
        Some(id) => {
            // type 不可变（spec §3.4）：编辑改类型直接拒绝
            let existing: String = conn
                .query_row("SELECT type FROM account WHERE id = ?1", rusqlite::params![id], |r| r.get(0))
                .map_err(|e| format!("account 不存在: {e}"))?;
            if existing != args.kind {
                return Err("账户类型不可修改；如需更换请删除后重新添加".into());
            }
            // 快照旧字段——keyring 写失败时回滚 DB，保持「账户配置 ↔ 凭据」一致
            let (old_name, old_host, old_port, old_share, old_user): (String, Option<String>, Option<i64>, Option<String>, Option<String>) =
                conn.query_row("SELECT name, host, port, share, username FROM account WHERE id = ?1", rusqlite::params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
                .map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE account SET name = ?1, host = ?2, port = ?3, share = ?4, username = ?5 WHERE id = ?6",
                rusqlite::params![args.name, args.host, args.port, args.share, args.username, id],
            )
            .map_err(|e| e.to_string())?;
            if let Some(p) = args.password.filter(|p| !p.is_empty()) {
                if let Err(e) = creds.set_password(&crate::credentials::account_key(&args.kind, id), &p) {
                    let _ = conn.execute(
                        "UPDATE account SET name = ?1, host = ?2, port = ?3, share = ?4, username = ?5 WHERE id = ?6",
                        rusqlite::params![old_name, old_host, old_port, old_share, old_user, id],
                    );
                    return Err(format!("凭据保存失败，本次修改已回滚: {e}"));
                }
            }
            crate::media_cache::clear_all(); // 账户配置变更：同 URL 可能指向不同内容（spec §3.6）
            Ok(id)
        }
        None => {
            conn.execute(
                "INSERT INTO account (name, type, host, port, share, username, encrypted_password) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)",
                rusqlite::params![args.name, args.kind, args.host, args.port, args.share, args.username],
            )
            .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            if let Some(p) = args.password.filter(|p| !p.is_empty()) {
                if let Err(e) = creds.set_password(&crate::credentials::account_key(&args.kind, id), &p) {
                    // 补偿：回滚刚插的行，不留无凭据账户
                    let _ = conn.execute("DELETE FROM account WHERE id = ?1", rusqlite::params![id]);
                    return Err(format!("凭据保存失败，账户未创建: {e}"));
                }
            }
            crate::media_cache::clear_all();
            Ok(id)
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAccountResult {
    pub warning: Option<String>,
}

#[tauri::command]
pub fn delete_account(
    id: i64,
    db: tauri::State<crate::db::Db>,
    creds: tauri::State<std::sync::Arc<dyn crate::credentials::CredentialStore>>,
) -> Result<DeleteAccountResult, String> {
    delete_account_impl(&db, creds.inner().as_ref(), id)
}

/// 删除：先删 keyring（失败重试 1 次），失败不阻断 DB 删除但报告残留警告（spec §3.4）
pub fn delete_account_impl(
    db: &crate::db::Db,
    creds: &dyn crate::credentials::CredentialStore,
    id: i64,
) -> Result<DeleteAccountResult, String> {
    let conn = db.conn();
    let kind: String = conn
        .query_row("SELECT type FROM account WHERE id = ?1", rusqlite::params![id], |r| r.get(0))
        .map_err(|e| format!("account 不存在: {e}"))?;
    let key = crate::credentials::account_key(&kind, id);
    let mut warning = None;
    if let Err(first) = creds.delete_password(&key) {
        if let Err(second) = creds.delete_password(&key) {
            tracing::warn!("keyring 删除失败（重试后仍失败）: {first}; {second}");
            warning = Some(format!("凭据可能残留在系统凭据管理器（{key}），请手动清理"));
        }
    }
    conn.execute("DELETE FROM account WHERE id = ?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    crate::media_cache::clear_all();
    Ok(DeleteAccountResult { warning })
}

/// 测试连接：webdav 真握手（factory 分发）；smb M1 明确报错（module 3.3.0 交付）
#[tauri::command]
pub async fn test_connection(
    id: i64,
    db: tauri::State<'_, crate::db::Db>,
    factory: tauri::State<'_, crate::source::MediaSourceFactory>,
) -> Result<bool, String> {
    test_connection_impl(&db, &factory, id).await
}

pub async fn test_connection_impl(
    db: &crate::db::Db,
    factory: &crate::source::MediaSourceFactory,
    id: i64,
) -> Result<bool, String> {
    let (kind, host, port, share) = {
        let conn = db.conn();
        let (kind, host, port, share): (String, Option<String>, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT type, host, port, share FROM account WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| format!("账户不存在: {e}"))?;
        (kind, host, port, share)
    };
    match kind.as_str() {
        "webdav" => {
            let base_url = host.clone().ok_or("webdav 账户缺少 host（应为完整 base URL）")?;
            let d = crate::source::descriptor::SourceDescriptor::WebDav {
                account_id: id, base_url, path: String::new(),
            };
            factory.resolve(&d).test(&d).await
                .map(|_| true).map_err(|e| e.to_string())
        }
        "smb" => {
            // M2 task 7：真实握手（task 6 已接线 SmbClientTransport）。test 用 share 根做
            // initial_path，path 留空（factory.resolve → SmbMediaSource::test → 列根）。
            // port 来自账户行（默认 445）；port 越界在 SmbConnectionManager::resolve_params
            // 校验返回 TransportError::InvalidPath（→ MediaSourceError::InvalidPath）。
            let _host = host.clone().ok_or("smb 账户缺少 host")?;
            let share = share.clone().ok_or("smb 账户缺少 share（固定共享根必填）")?;
            let initial = share;
            let port_val = port.unwrap_or(445);
            let d = crate::source::descriptor::SourceDescriptor::Smb {
                account_id: id, initial_path: initial, path: String::new(), port: port_val as i32,
            };
            factory.resolve(&d).test(&d).await
                .map(|_| true).map_err(|e| e.to_string())
        }
        _ => Err(format!("未知账户类型 {kind}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{account_key, CredentialStore, MemoryStore};
    use std::sync::Arc;

    fn setup() -> (crate::db::Db, Arc<MemoryStore>) {
        let db = crate::db::Db::open_in_memory().unwrap();
        let store = Arc::new(MemoryStore::new());
        (db, store)
    }

    #[test]
    fn upsert_new_writes_keyring_and_rolls_back_on_failure() {
        // 用一个总是失败的 store 验证回滚
        struct FailStore;
        impl CredentialStore for FailStore {
            fn set_password(&self, _: &str, _: &str) -> Result<(), String> { Err("boom".into()) }
            fn get_password(&self, _: &str) -> Result<Option<String>, String> { Ok(None) }
            fn delete_password(&self, _: &str) -> Result<(), String> { Ok(()) }
        }
        let (db, _) = setup();
        let fail: Arc<dyn CredentialStore> = Arc::new(FailStore);
        let r = upsert_account_impl(&db, fail.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: Some("https://d".into()),
            port: None, share: None, username: Some("u".into()), password: Some("p".into()),
        });
        assert!(r.is_err());
        // 回滚：行不存在
        let conn = db.conn();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM account", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn upsert_edit_type_change_rejected() {
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: None }).unwrap();
        let err = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: Some(id), name: "n".into(), kind: "smb".into(), host: None, port: None,
            share: None, username: None, password: None });
        assert!(err.is_err()); // type 不可变
    }

    #[test]
    fn upsert_edit_empty_password_keeps_old() {
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: Some("old".into()) }).unwrap();
        upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: Some(id), name: "n2".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: None }).unwrap();
        assert_eq!(store.get_password(&account_key("webdav", id)).unwrap().as_deref(), Some("old"));
    }

    #[test]
    fn delete_removes_keyring_first_and_reports_warning() {
        struct FailDelete(MemoryStore);
        impl CredentialStore for FailDelete {
            fn set_password(&self, k: &str, p: &str) -> Result<(), String> { self.0.set_password(k, p) }
            fn get_password(&self, k: &str) -> Result<Option<String>, String> { self.0.get_password(k) }
            fn delete_password(&self, _: &str) -> Result<(), String> { Err("locked".into()) }
        }
        let (db, _) = setup();
        let s: Arc<dyn CredentialStore> = Arc::new(FailDelete(MemoryStore::new()));
        let id = upsert_account_impl(&db, s.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "webdav".into(), host: None, port: None,
            share: None, username: None, password: Some("p".into()) }).unwrap();
        let out = delete_account_impl(&db, s.as_ref(), id).unwrap();
        assert!(out.warning.is_some()); // 凭据残留警告
    }

    #[test]
    fn upsert_edit_keyring_failure_rolls_back_db() {
        // 编辑时 keyring 写失败 → DB 字段回滚到旧值（配置与凭据一致性）
        struct FailSet;
        impl CredentialStore for FailSet {
            fn set_password(&self, _: &str, _: &str) -> Result<(), String> { Err("boom".into()) }
            fn get_password(&self, _: &str) -> Result<Option<String>, String> { Ok(None) }
            fn delete_password(&self, _: &str) -> Result<(), String> { Ok(()) }
        }
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "old-name".into(), kind: "webdav".into(),
            host: Some("https://old".into()), port: None, share: None,
            username: Some("old-user".into()), password: Some("p".into()) }).unwrap();
        let fail: Arc<dyn CredentialStore> = Arc::new(FailSet);
        let r = upsert_account_impl(&db, fail.as_ref(), UpsertAccountArgs {
            id: Some(id), name: "new-name".into(), kind: "webdav".into(),
            host: Some("https://new".into()), port: None, share: None,
            username: Some("new-user".into()), password: Some("p2".into()) });
        assert!(r.is_err());
        let conn = db.conn();
        let (name, host, user): (String, Option<String>, Option<String>) = conn.query_row(
            "SELECT name, host, username FROM account WHERE id = ?1", rusqlite::params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((name.as_str(), host.as_deref(), user.as_deref()),
                   ("old-name", Some("https://old"), Some("old-user"))); // 旧值完整回滚
    }

    /// M2 task 7 简报步骤 1：share 缺失时 resolve_params 前置校验（零网络）拒绝；
    /// 错误信息不能再是「尚未实装」占位（任务 6 真实接线后即废弃）。
    #[tokio::test]
    async fn test_connection_smb_rejects_missing_share_without_network() {
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "smb".into(), host: Some("192.168.1.1".into()),
            port: Some(445), share: None, username: None, password: None }).unwrap();
        let factory = crate::source::MediaSourceFactory::new(
            db.clone(),
            std::sync::Arc::new(crate::credentials::MemoryStore::new()),
        );
        let r = test_connection_impl(&db, &factory, id).await;
        assert!(r.is_err(), "share 缺失应拒绝");
        let msg = r.unwrap_err();
        assert!(
            msg.contains("share") || msg.contains("共享"),
            "错误语义需体现 share 缺失: {msg}"
        );
        assert!(!msg.contains("尚未实装"), "M2 后不再有未实装占位错误: {msg}");
    }

    /// M2 task 7 简报步骤 1：port 越界（99999）在 resolve_params 校验直接拒绝，
    /// 零网络。验证 test_connection 链路对端口越界有明确语义。
    #[tokio::test]
    async fn test_connection_smb_rejects_out_of_range_port() {
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "smb".into(), host: Some("192.168.1.1".into()),
            port: Some(99999), share: Some("media".into()), username: None, password: None }).unwrap();
        let factory = crate::source::MediaSourceFactory::new(
            db.clone(),
            std::sync::Arc::new(crate::credentials::MemoryStore::new()),
        );
        let r = test_connection_impl(&db, &factory, id).await;
        assert!(r.is_err(), "端口越界应被拒绝而非静默忽略");
        let msg = r.unwrap_err();
        assert!(msg.contains("端口"), "端口越界语义需明确: {msg}");
    }

    /// M2 task 7 简报步骤 1：test_connection 走 factory.resolve(Smb).test() 真实路径
    /// （而非直接 NOT_IMPLEMENTED 占位）。share 缺失情况下，断言链路已穿过占位错误
    /// 走到 source 层 —— 错误消息不再是固定的「SMB 尚未实装」字符串。
    #[tokio::test]
    async fn test_connection_smb_uses_factory_handshake() {
        let (db, store) = setup();
        let id = upsert_account_impl(&db, store.as_ref(), UpsertAccountArgs {
            id: None, name: "n".into(), kind: "smb".into(), host: Some("192.168.1.1".into()),
            port: Some(445), share: Some("media".into()), username: None, password: None }).unwrap();
        let factory = crate::source::MediaSourceFactory::new(
            db.clone(),
            std::sync::Arc::new(crate::credentials::MemoryStore::new()),
        );
        let r = test_connection_impl(&db, &factory, id).await;
        // 无 NAS CI，本测试不依赖真实网络：链接到 factory.resolve → SmbMediaSource::test
        // → ConnectionManager::list → get_or_connect → resolve_params（share_root_matches
        // 通过）→ factory() → transport.connect —— 真实 transport 在 CI 环境连不上
        // 192.168.1.1:445，返回 connection-level 错误（如 Disconnected）。**关键是错误
        // 不再是占位「SMB 尚未实装`》。
        let msg = r.unwrap_err();
        assert!(!msg.contains("尚未实装"), "M2 后不应再走占位错误: {msg}");
    }
}
