//! `commands::archive_prefetch` —— 三级预载调度 IPC（M3 spec §7，任务 8）。
//!
//! - `notify_archive_window`：前端 masonry 像素窗口变化 / details 选中时推送预载目标。
//!   mode "metadata" → 仅 stat 预热（spawn 不阻塞 IPC）；"content" → 低优
//!   ensure_cached_cancellable（epoch 取消）；其他值忽略（前后端版本错位防御）。
//! - `set_archive_prefetch_enabled`：写 settings 表 + 推送运行时开关
//!   （模式同 `update_thumbnail_runtime_config` 的「写设置 + 推送」）。

use std::sync::Arc;

use tauri::State;

use crate::db::Db;
use crate::log;
use crate::source::archive::prefetch::ArchivePrefetcher;
use crate::source::descriptor::SourceDescriptor;

#[tauri::command]
pub async fn notify_archive_window(
    prefetcher: State<'_, Arc<ArchivePrefetcher>>,
    epoch: u64,
    descriptor: SourceDescriptor,
    rels: Vec<String>,
    mode: String,
) -> Result<(), String> {
    log::write_log(
        "DEBUG",
        "archive",
        &format!(
            "notify_archive_window epoch={} type={} mode={} rels={}",
            epoch,
            descriptor.type_str(),
            mode,
            rels.len(),
        ),
    );
    match mode.as_str() {
        // 元数据级：stat 预热连接缓存，spawn 不阻塞 IPC 返回
        "metadata" => {
            let p = prefetcher.inner().clone();
            tokio::spawn(async move {
                p.warm_metadata(&descriptor, &rels).await;
            });
            Ok(())
        }
        // 内容级：低优物化（notify_window 内部 spawn 逐 rel ensure）
        "content" => {
            prefetcher.notify_window(epoch, &descriptor, &rels).await;
            Ok(())
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub async fn set_archive_prefetch_enabled(
    db: State<'_, Db>,
    prefetcher: State<'_, Arc<ArchivePrefetcher>>,
    value: bool,
) -> Result<(), String> {
    {
        let conn = db.conn();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('remote_archive_prefetch_enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![value.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    prefetcher.set_enabled(value);
    log::write_log(
        "INFO",
        "archive",
        &format!("set_archive_prefetch_enabled value={}", value),
    );
    Ok(())
}
