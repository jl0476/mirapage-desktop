//! `commands::archive_cache` —— archive cache 管理 IPC（M3 spec §8；模式同 thumbnails
//! clear/info，但清空多「闸门 + 排空」两段——物化在途时不能删文件）。
//!
//! - `get_archive_cache_info`：{count, bytes, partCount, partBytes}（dao::usage +
//!   materializer::parts_usage；终审二批 P1-2）。
//! - `clear_archive_cache`：四段式（简报 rev5）——
//!   ① `begin_clearing()`：持 inflight 锁置 clearing=true 后 cancel_all（与
//!      ensure_cached 的「查闸门 + 注册」临界区互斥，TOCTOU 封死）；
//!   ② `wait_inflight_drained(2s)` 排空在途（tokio sleep 轮询，不阻塞 runtime）；
//!      超时 → 复位闸门 + 返回忙碌错误，**不删任何东西**；
//!   ③ 实删：clear_all 返回的 cache_abs_path 逐个删 + part/ 整体重建
//!      （.part + sidecar + .meta.tmp 一并清除）+ 清表；
//!   ④ `end_clearing()` 复位闸门——新任务（新代际）自然恢复。
//!
//! 命令薄壳 + `_impl` 可测核心（State 拆掉，直测 `(&Db, &Materializer)`）。

use std::sync::Arc;
use std::time::Duration;

use tauri::State;

use crate::db::Db;
use crate::source::archive::materializer::Materializer;
use crate::source::archive::service::ArchiveService;

/// 清空缓存的类型化错误（任务 10）：DrainTimeout = 排空超时（闸门已同步复位、
/// 未删任何东西——前端提示稍后重试）；Io = 磁盘/DB 删除失败。
#[derive(Debug)]
pub(crate) enum ArchiveCacheError {
    DrainTimeout,
    Io(String),
}

impl std::fmt::Display for ArchiveCacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArchiveCacheError::DrainTimeout => {
                f.write_str("缓存正忙（有下载在途），请稍后重试")
            }
            ArchiveCacheError::Io(s) => f.write_str(s),
        }
    }
}

/// (ready 条数, ready 字节, .part 条数, .part 字节)——`get_archive_cache_info` 的
/// 可测核心（终审二批 P1-2：.part 计入用量统计，spec §12；ready 字段名不变前端兼容）。
pub(crate) fn get_archive_cache_info_impl(
    db: &Db, cache_root: &std::path::Path,
) -> rusqlite::Result<(i64, i64, usize, u64)> {
    let conn = db.conn();
    let (count, bytes) = crate::source::archive::dao::usage(&conn)?;
    let (part_count, part_bytes) = crate::source::archive::materializer::parts_usage(cache_root);
    Ok((count, bytes, part_count, part_bytes))
}

/// 清空缓存的可测核心（2s 排空超时；语义见 `_with_timeout`）。
pub(crate) async fn clear_archive_cache_impl(
    db: &Db, mat: &Materializer, service: &ArchiveService,
) -> Result<(), ArchiveCacheError> {
    clear_archive_cache_impl_with_timeout(db, mat, service, Duration::from_secs(2)).await
}

/// 清空缓存的可测核心（任务 10：超时可注入）。固定顺序：
/// `coordinator.begin_clear()`（ClearGuard Drop 同步复位 gate，覆盖超时/删除失败/
/// unwind）→ materializer 双闸门 + 排空（inflight + coordinator admission，超时 →
/// `DrainTimeout` 且**不删任何东西**）→ `service.clear_runtime_caches_while_gated`
/// （清 catalog LRU + 块 LRU）→ 删除磁盘与 DAO → drop clear_guard。
/// 从 Service/Materializer 断言取得的是同一个 coordinator Arc（装配错误即 panic）。
pub(crate) async fn clear_archive_cache_impl_with_timeout(
    db: &Db,
    mat: &Materializer,
    service: &ArchiveService,
    timeout: Duration,
) -> Result<(), ArchiveCacheError> {
    let coordinator = service.cache_coordinator();
    assert!(
        std::sync::Arc::ptr_eq(&coordinator, &mat.coordinator()),
        "Service 与 Materializer 必须共用同一 ArchiveCacheCoordinator（装配错误）"
    );
    // ① 双闸门：coordinator begin_clear（ClearGuard Drop 同步复位，覆盖 return/panic）
    //    + 持 inflight 锁置 clearing=true 后 cancel_all——与 ensure_cached 的
    //    「查闸门 + 注册」临界区互斥；已注册任务都在 map 里可见，drain 会等它们
    let clear_guard = coordinator.begin_clear();
    mat.begin_clearing().await;
    // ② 排空在途（检查点粒度快速退出 + coordinator admission 排空）；超时 →
    //    复位双闸门 + DrainTimeout，不删任何东西
    let drained = mat.wait_inflight_drained(timeout).await
        && coordinator.wait_drained(timeout).await;
    if !drained {
        mat.end_clearing().await;
        drop(clear_guard);
        return Err(ArchiveCacheError::DrainTimeout);
    }
    // ②.5 运行时缓存（catalog LRU + 远程 ZIP 块 LRU）：guard 存活且代次一致才清
    service.clear_runtime_caches_while_gated(clear_guard.generation());
    // ③ 实删：ready 文件（clear_all 返回的路径逐个删）+ part/ 整体重建 + 清表
    //    （conn guard 不跨 await——此处闭包内无 await）
    let result = (|| -> Result<(), ArchiveCacheError> {
        let conn = db.conn();
        let roots = crate::source::archive::dao::clear_all(&conn)
            .map_err(|e| ArchiveCacheError::Io(e.to_string()))?;
        for abs in &roots {
            let _ = std::fs::remove_file(abs);
        }
        let root = mat.cache_root();
        let _ = std::fs::remove_dir_all(root.join("part"));
        let _ = std::fs::create_dir_all(root.join("part"));
        Ok(())
    })();
    // ④ 复位闸门——begin_clearing 内 cancel_all 已推进代际，新任务取新代际自然恢复；
    //    coordinator ClearGuard 最后 Drop（end_clearing 重开 materializer 闸门时
    //    coordinator 闸门仍关闭，新 admission 依旧被拒，无穿透窗口）
    mat.end_clearing().await;
    drop(clear_guard);
    result
}

/// 缓存统计：{ count, bytes, partCount, partBytes }（parts = 有效 .part 半截下载）。
#[tauri::command]
pub async fn get_archive_cache_info(
    db: State<'_, Db>,
    mat: State<'_, Arc<Materializer>>,
) -> Result<serde_json::Value, String> {
    let (count, bytes, part_count, part_bytes) =
        get_archive_cache_info_impl(&db, &mat.cache_root()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "count": count, "bytes": bytes,
        "partCount": part_count, "partBytes": part_bytes,
    }))
}

/// 清空缓存（闸门 + 排空 + 实删 + 复位；在途未排空返回忙碌错误且不动文件）。
/// 任务 10：从 managed state 取 factory 装配的同一 `Arc<ArchiveService>`（清
/// catalog/块 LRU 与 Service 共用同一 coordinator），不得另建实例。
#[tauri::command]
pub async fn clear_archive_cache(
    db: State<'_, Db>,
    mat: State<'_, Arc<Materializer>>,
    service: State<'_, Arc<ArchiveService>>,
) -> Result<(), String> {
    clear_archive_cache_impl(&db, &mat, &service)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::archive::dao::{self, NewCacheRow};
    use crate::source::archive::materializer::tests::{temp_materializer, webdav, MockOrigin};
    use std::sync::Arc as StdArc;

    /// 与 mat 共用同一 coordinator 的 Service 实例（clear impl 的任务 10 签名需要；
    /// 断言同一 Arc 即在此验证）
    fn service_sharing(mat: &Materializer) -> StdArc<ArchiveService> {
        StdArc::new(ArchiveService::new(
            StdArc::new(mat.clone()) as StdArc<dyn crate::source::archive_impl::Materialize>,
            mat.coordinator(),
        ))
    }

    /// 手工铺一行 ready 缓存（文件 + 表行）——不走网络，确定性
    fn seed_ready(db: &Db, root: &std::path::Path, key: &str, bytes: &[u8]) -> std::path::PathBuf {
        let abs = root.join(format!("{key}.zip"));
        std::fs::write(&abs, bytes).unwrap();
        let conn = db.conn();
        dao::upsert(&conn, &NewCacheRow {
            cache_key: key.into(),
            origin_kind: "webdav".into(),
            archive_rel_path: "books/a.cbz".into(),
            origin_size: bytes.len() as i64,
            origin_mtime: Some(1000),
            cache_abs_path: abs.display().to_string(),
            byte_size: bytes.len() as i64,
        }).unwrap();
        abs
    }

    #[test]
    fn info_reports_usage() {
        let mock = StdArc::new(MockOrigin::new(0));
        let (m, dir, db) = temp_materializer(mock);
        let _ = m;
        seed_ready(&db, dir.path(), "k1", b"aaa");
        seed_ready(&db, dir.path(), "k2", b"bb");
        let (count, bytes, part_count, part_bytes) =
            get_archive_cache_info_impl(&db, dir.path()).unwrap();
        assert_eq!((count, bytes), (2, 5), "两条 ready 行，字节求和");
        assert_eq!((part_count, part_bytes), (0, 0), "无 .part");
    }

    /// 终审二批 P1-2：info 载荷加 partCount/partBytes——有效 .part 计入用量统计
    /// （spec §12「.part 目录计入用量统计」）；ready 的 count/bytes 字段名不变。
    #[test]
    fn info_reports_part_usage() {
        let mock = StdArc::new(MockOrigin::new(0));
        let (m, dir, db) = temp_materializer(mock);
        let _ = m;
        seed_ready(&db, dir.path(), "k1", b"aaa");
        let part = dir.path().join("part");
        std::fs::write(part.join("k2.part"), b"xy").unwrap();
        std::fs::write(part.join("k2.part.meta"), b"{}").unwrap();
        std::fs::write(part.join("k3.part.meta.tmp"), b"{}").unwrap();
        let (count, bytes, part_count, part_bytes) =
            get_archive_cache_info_impl(&db, dir.path()).unwrap();
        assert_eq!((count, bytes), (1, 3), "ready 字段语义不变");
        assert_eq!((part_count, part_bytes), (1, 2),
                   "只计 .part 数据文件（sidecar/.tmp 不计）");
    }

    #[tokio::test]
    async fn clear_removes_files_and_rows() {
        let mock = StdArc::new(MockOrigin::new(0));
        let (m, dir, db) = temp_materializer(mock);
        let root = dir.path();
        let f1 = seed_ready(&db, root, "k1", b"aaa");
        let f2 = seed_ready(&db, root, "k2", b"bb");
        // part/ 残留：半截 .part + sidecar + 原子写残留 .meta.tmp
        let part = root.join("part");
        std::fs::write(part.join("k3.part"), b"xx").unwrap();
        std::fs::write(part.join("k3.part.meta"), b"{}").unwrap();
        std::fs::write(part.join("k4.part.meta.tmp"), b"{}").unwrap();

        let service = service_sharing(&m);
        clear_archive_cache_impl(&db, &m, &service).await.unwrap();

        let (count, bytes, part_count, part_bytes) =
            get_archive_cache_info_impl(&db, root).unwrap();
        assert_eq!((count, bytes, part_count, part_bytes), (0, 0, 0, 0), "表已清空");
        assert!(!f1.exists() && !f2.exists(), "ready 文件实删（clear_all 路径）");
        // part/ 整体重建后为空目录（.part / .meta / .meta.tmp 一并清除）
        let entries: Vec<_> = std::fs::read_dir(&part).unwrap().collect();
        assert!(entries.is_empty(), "part/ 重建为空，实际残留 {} 项", entries.len());
    }

    /// rev4 闸门（任务 8 起 Cancelled 变体）：begin_clearing 后新 ensure_cached 被拒；
    /// end_clearing 后恢复（begin 内 cancel_all 已推进代际——旧 in-flight 即便漏网
    /// 也不会 upsert 复活缓存）。
    #[tokio::test]
    async fn clearing_gate_rejects_new_tasks_and_recovers() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, _dir, db) = temp_materializer(mock);
        m.begin_clearing().await;
        let err = m.ensure_cached(&webdav(""), "a.cbz", crate::source::descriptor::ArchiveFormat::Cbz)
            .await.unwrap_err();
        assert!(matches!(err, crate::source::archive::materializer::MaterializeError::Cancelled),
                "闸门开启时新任务被拒（Cancelled），实际 {err}");
        // 排空立即成功（无在途）→ 清空正常完成 → 复位
        assert!(m.wait_inflight_drained(Duration::from_secs(2)).await);
        let service = service_sharing(&m);
        clear_archive_cache_impl(&db, &m, &service).await.unwrap();
        // end_clearing 已由 impl ④ 完成：新任务正常物化
        let p = m.ensure_cached(&webdav(""), "a.cbz", crate::source::descriptor::ArchiveFormat::Cbz)
            .await.unwrap();
        assert!(p.exists(), "闸门复位后新任务正常工作");
    }
}
