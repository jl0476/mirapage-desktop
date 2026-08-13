//! 数据库保留与自动清理（v0.1.0-database-retention-and-cleanup）
//!
//! maintenance 模块职责（spec §5）：
//! - 浏览历史保留评分 / 候选选择 / 有界删除（`history`）
//! - 防抖 / 节流调度核心（`scheduler`）——把高频 dirty 合并为单次执行
//! - 跨域维护摘要 + 用户手动预览/执行入口（`MaintenanceService`）
//!
//! 缩略图维护**不**在本模块重建——继续走既有 `ThumbnailService::evict_to_limit`
//! （`thumbnail::service`），容量元数据在 `thumbnail::index` DAO 内维护（spec §5/§6）。

pub mod history;
pub mod scheduler;

pub use history::{HistoryCleanupPreview, HistoryCleanupResult, HistoryRetentionConfig};
pub use scheduler::{MaintenanceHandle, MaintenanceTiming};

use std::sync::Arc;

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::Db;
use crate::thumbnail::service::ThumbnailService;

const SECS_PER_DAY: i64 = 86_400;

/// 维护执行结果（单次 run 统计，写回 `maintenance_last_result_json`）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceRunResult {
    pub history_deleted: i64,
    pub thumbnail_freed_bytes: u64,
    pub thumbnail_dirty_cleaned: usize,
    pub protected_exceeds_limit: bool,
    /// 触发来源：`auto`（防抖到期）/ `manual`（立即维护按钮）
    pub source: &'static str,
}

/// 维护摘要（Settings 页展示当前用量 + 上限 + 最近结果）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceSummary {
    pub history_total: i64,
    pub history_max_entries: i64,
    pub history_retention_days: i64,
    pub history_protect_days: i64,
    pub auto_enabled: bool,
    pub last_run_at: i64,
    pub last_result_json: String,
    pub thumbnail_total_bytes: u64,
    pub thumbnail_count: u64,
    pub thumbnail_limit_bytes: u64,
}

/// 维护预览（只读，spec §8）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenancePreview {
    pub history: HistoryCleanupPreview,
    pub thumbnail_total_bytes: u64,
    pub thumbnail_limit_bytes: u64,
}

// ─── 设置读写 helpers（settings.value 是 TEXT）──────────────────────────

fn setting_str(conn: &Connection, key: &str, default: &str) -> String {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| default.to_string())
}

fn setting_i64(conn: &Connection, key: &str, default: i64) -> i64 {
    setting_str(conn, key, &default.to_string())
        .parse()
        .unwrap_or(default)
}

fn setting_bool(conn: &Connection, key: &str, default: bool) -> bool {
    match setting_str(conn, key, if default { "1" } else { "0" }).as_str() {
        "0" => false,
        _ => true,
    }
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/// 从 settings 拼装历史保留配置。
pub fn read_history_config(conn: &Connection) -> HistoryRetentionConfig {
    HistoryRetentionConfig {
        max_entries: setting_i64(conn, "history_retention_max_entries", 2000),
        retention_days: setting_i64(conn, "history_retention_days", 365),
        protect_days: setting_i64(conn, "history_recent_protect_days", 7).clamp(0, 30),
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ─── 核心执行（无 AppHandle 依赖之外的副作用，便于在 spawn_blocking 内跑）────

/// 执行一次维护。
///
/// - `auto=true`：防抖到期触发。尊重 `maintenance_auto_cleanup_enabled`（关闭时只统计不删）。
/// - `auto=false`：手动「立即维护」按钮（前端已传 `confirmed=true`）。总是执行删除。
///
/// 三阶段各自独立的 Db 借用，避免与 `ThumbnailService` 内部 lock 死锁。
pub fn run_maintenance_once(app: &AppHandle, auto: bool) -> MaintenanceRunResult {
    let source: &'static str = if auto { "auto" } else { "manual" };
    let now = now_secs();

    // 阶段 1：读配置（短 guard）+ 历史清理（run_history_cleanup 自管 guard，3 阶段释锁）
    let (hist_result, do_delete) = {
        let db = app.state::<Db>();
        let (cfg, auto_enabled) = {
            let conn = db.conn();
            (
                read_history_config(&conn),
                setting_bool(&conn, "maintenance_auto_cleanup_enabled", true),
            )
        };
        let do_delete = !auto || auto_enabled;
        let hist = if do_delete {
            history::run_history_cleanup(db.inner(), now, &cfg).unwrap_or_default()
        } else {
            HistoryCleanupResult::default()
        };
        (hist, do_delete)
    };

    // 阶段 2：缩略图淘汰 + 脏索引抽样（ThumbnailService 内部自取 Db 借用）
    let (thumb_freed, dirty_cleaned) = if do_delete {
        let ts = app.state::<ThumbnailService>();
        (ts.evict_now(), ts.sample_dirty(128))
    } else {
        (0, 0)
    };

    let result = MaintenanceRunResult {
        history_deleted: hist_result.total_deleted(),
        thumbnail_freed_bytes: thumb_freed,
        thumbnail_dirty_cleaned: dirty_cleaned,
        protected_exceeds_limit: hist_result.protected_exceeds_limit,
        source,
    };

    // 阶段 3：写最近结果（独立 Db 借用）
    {
        let db = app.state::<Db>();
        let conn = db.conn();
        let _ = write_setting(&conn, "maintenance_last_run_at", &now.to_string());
        let json = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
        let _ = write_setting(&conn, "maintenance_last_result_json", &json);
    }

    result
}

/// 历史条数是否已超上限 110%（spec §5.4 旁路节流）。max_entries=0 视为不限。
pub fn is_history_over_110(app: &AppHandle) -> bool {
    let db = app.state::<Db>();
    let conn = db.conn();
    let cfg = read_history_config(&conn);
    if cfg.max_entries == 0 {
        return false;
    }
    let threshold = (cfg.max_entries as f64) * 1.1;
    let total = history::count_history(&conn).unwrap_or(0);
    (total as f64) > threshold
}

/// 只读预览（不写库不删文件，spec §8）。
pub fn preview(app: &AppHandle) -> (MaintenancePreview, MaintenanceSummary) {
    let now = now_secs();
    let db = app.state::<Db>();
    let conn = db.conn();
    let cfg = read_history_config(&conn);
    let hist_preview = history::preview_history_cleanup(&conn, now, &cfg).unwrap_or_default();
    let summary_history = MaintenanceSummary {
        history_total: hist_preview.total,
        history_max_entries: cfg.max_entries,
        history_retention_days: cfg.retention_days,
        history_protect_days: cfg.protect_days,
        auto_enabled: setting_bool(&conn, "maintenance_auto_cleanup_enabled", true),
        last_run_at: setting_i64(&conn, "maintenance_last_run_at", 0),
        last_result_json: setting_str(&conn, "maintenance_last_result_json", "{}"),
        thumbnail_total_bytes: 0,
        thumbnail_count: 0,
        thumbnail_limit_bytes: 0,
    };
    // 缩略图统计（ThumbnailService 自取 Db 借用）——drop guard 先
    drop(conn);
    drop(db);
    let (thumb_total, thumb_count, thumb_limit) = {
        let ts = app.state::<ThumbnailService>();
        let (total, count) = ts.cache_info();
        (total, count, ts.cache_limit_bytes())
    };
    let preview = MaintenancePreview {
        history: hist_preview,
        thumbnail_total_bytes: thumb_total,
        thumbnail_limit_bytes: thumb_limit,
    };
    let summary = MaintenanceSummary {
        thumbnail_total_bytes: thumb_total,
        thumbnail_count: thumb_count,
        thumbnail_limit_bytes: thumb_limit,
        ..summary_history
    };
    (preview, summary)
}

// ─── 调度器执行体（生产实现）──────────────────────────────────────────

struct AppExecutor {
    app: AppHandle,
}

impl scheduler::MaintenanceExecutor for AppExecutor {
    fn execute(&self) -> scheduler::BoxFut {
        let app = self.app.clone();
        Box::pin(async move {
            let app2 = app.clone();
            let _ = tokio::task::spawn_blocking(move || run_maintenance_once(&app2, true)).await;
        })
    }
    fn is_over_limit_110(&self) -> bool {
        is_history_over_110(&self.app)
    }
}

/// 维护服务（Tauri managed state）。持有防抖 handle，前端/record_history 经此发 dirty。
pub struct MaintenanceService {
    handle: MaintenanceHandle,
}

impl MaintenanceService {
    /// 在 Tauri setup 内构造：用 `tauri::async_runtime::spawn` 驱动 actor。
    pub fn new(app: AppHandle) -> Self {
        Self::with_spawn(app, Arc::new(|f| {
            let _ = tauri::async_runtime::spawn(f);
        }))
    }

    /// 注入定时器 spawner（生产用，测试可注入 tokio::spawn）。
    fn with_spawn(
        app: AppHandle,
        spawn_timer: scheduler::TimerSpawner,
    ) -> Self {
        let executor = Arc::new(AppExecutor { app: app.clone() });
        // 110% 判定器：notify_dirty 时查（超阈则绕防抖立即触发，仍守 60s 节流）
        let is_over: scheduler::OverLimitChecker = {
            let app_for_check = app.clone();
            Arc::new(move || is_history_over_110(&app_for_check))
        };
        let (handle, actor) =
            scheduler::build(MaintenanceTiming::DEFAULT, executor, spawn_timer, is_over);
        tauri::async_runtime::spawn(actor.run());
        Self { handle }
    }

    /// 标记 history dirty（record_history 成功后调用）。
    pub fn notify_dirty(&self) {
        self.handle.notify_dirty();
    }

    /// 立即执行（手动按钮）。等待完成。
    pub async fn run_now(&self) {
        self.handle.run_now().await;
    }
}
