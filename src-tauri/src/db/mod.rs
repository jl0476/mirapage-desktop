//! 数据库初始化 + 连接管理
//!
//! Phase 1 实现：建表 + 初始 settings 默认值。
//! 后续 Phase 加入更多表 / DAO。

pub mod migrations;

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// 应用全局数据库连接
///
/// `Clone`（内部 `Arc<Mutex<Connection>>`）：lib.rs manage 后同时把克隆句柄
/// 注入 `MediaSourceFactory`（WebDAV 源读 account 行取凭据），`State<Db>` 命令零改动。
#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("db mutex poisoned")
    }

    /// 测试 helper：建一个跑完 migrations 的 in-memory DB。
    /// 生产路径用 `init()`（带文件路径 + tauri AppHandle）。
    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        migrations::run(&conn)?;
        Ok(Db {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
}

/// 初始化数据库
pub fn init(app: &AppHandle) -> anyhow::Result<Db> {
    // 数据库路径：~/.local/share/mirapage-desktop/mirapage.db（macOS/Linux）
    //            %APPDATA%/mirapage-desktop/mirapage.db（Windows）
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("failed to resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&data_dir)?;

    let db_path: PathBuf = data_dir.join("mirapage.db");
    tracing::info!("opening database at {}", db_path.display());

    let conn = Connection::open(&db_path)?;

    // 执行 migrations
    migrations::run(&conn)?;

    Ok(Db {
        conn: Arc::new(Mutex::new(conn)),
    })
}