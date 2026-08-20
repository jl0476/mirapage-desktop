//! 三级预载（M3 spec §7）：元数据 stat 预热 / 内容低优 ensure_cached / 强制=同步路径。
//! 复用 3.0.7 调度语义：epoch 取消 + in-flight 去重（去重由 Materializer.inflight 承担）。

use super::materializer::Materializer;
use crate::source::descriptor::SourceDescriptor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct ArchivePrefetcher {
    mat: Arc<Materializer>,
    /// Arc：notify_window 的 spawn 闭包持有克隆，循环内逐 rel 读**实时**开关——
    /// 批次进行中 set_enabled(false) 也要丢弃待开始任务（spec §7）
    enabled: Arc<AtomicBool>,
}

impl ArchivePrefetcher {
    pub fn new(mat: Arc<Materializer>) -> Self {
        Self { mat, enabled: Arc::new(AtomicBool::new(true)) }
    }

    pub fn set_enabled(&self, v: bool) {
        self.enabled.store(v, Ordering::SeqCst);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// 元数据预载：远程目录列举完成后调，仅 stat（结果弃用或留内存——首期直接 stat
    /// 预热 SMB/WebDAV 连接缓存，不落任何状态；YAGNI）。开关关闭时同样不发网络请求。
    pub async fn warm_metadata(&self, origin: &SourceDescriptor, rels: &[String]) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        for rel in rels {
            let _ = self.mat.stat_origin(origin, rel).await;
        }
    }

    /// 内容预载：masonry 预读窗口。epoch 同步给 Materializer（取消在途 chunk）；
    /// 逐 rel 低优物化（cancellable——新 epoch 即停，.part 保留供续传）。
    pub async fn notify_window(&self, epoch: u64, origin: &SourceDescriptor, rels: &[String]) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        let batch_epoch = epoch; // 本批次身份：new_epoch 之前捕获（值相同，语义在此）
        self.mat.new_epoch(epoch);
        let mat = self.mat.clone();
        let enabled = self.enabled.clone();
        let origin = origin.clone();
        let rels = rels.to_vec();
        tokio::spawn(async move {
            for rel in &rels {
                // 批次级取消（任务 8 审查修复 / spec §7「待开始任务丢弃」）：epoch 在
                // download 内的 epoch_at_start 只能取消**正在下载**的 rel——同批后续
                // rel 启动时会捕获新 epoch 完整下载（快速滚动数百 MB CBX 白下）。
                // 故每个 rel 启动前比对批次 epoch 与实时开关，变了/关了即不再启动。
                if mat.current_epoch() != batch_epoch
                    || !enabled.load(Ordering::SeqCst)
                {
                    break;
                }
                let _ = mat.ensure_cached_cancellable(&origin, rel).await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::archive::materializer::cache_key;
    use crate::source::archive::materializer::tests::{
        temp_materializer, wait_reads, webdav, MockOrigin,
    };
    use std::sync::atomic::Ordering;
    use std::sync::Arc as StdArc;

    /// 轮询直到 cond 为 true（2s 超时 panic——与 wait_reads 同款节拍）
    async fn wait_until(what: &str, cond: impl Fn() -> bool) {
        for _ in 0..400 {
            if cond() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("2s 内未满足条件: {what}");
    }

    #[tokio::test]
    async fn window_targets_trigger_low_priority_ensure() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, dir, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let p = ArchivePrefetcher::new(StdArc::new(m));
        // notify_window(epoch=1, targets=[rel1, rel2]) → spawn 低优物化 → 两 rel ready
        p.notify_window(1, &origin, &["rel1.cbz".into(), "rel2.cbz".into()])
            .await;
        let f1 = dir.path().join(format!("{}.zip", cache_key(&origin, "rel1.cbz")));
        let f2 = dir.path().join(format!("{}.zip", cache_key(&origin, "rel2.cbz")));
        wait_until("两个 rel 物化 ready", || f1.exists() && f2.exists()).await;
        assert_eq!(
            mock.read_calls.load(Ordering::SeqCst),
            2,
            "两个 rel 各一次全量读（10 字节 < CHUNK，各 1 chunk）"
        );
    }

    #[tokio::test]
    async fn epoch_bump_cancels_pending_prefetch() {
        // 慢源：两 chunk（CHUNK+5 字节），read 延迟 150ms——第二 chunk 前检查点可命中
        let mock = StdArc::new(MockOrigin::new(crate::source::archive::materializer::CHUNK + 5));
        *mock.read_delay_ms.lock().unwrap() = 150;
        let (m, dir, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let m = StdArc::new(m);
        let p = ArchivePrefetcher::new(m.clone());
        p.notify_window(1, &origin, &["slow.cbz".into()]).await;
        // 确认第一 chunk 已在途（epoch_at_start=1 已捕获、inflight 已注册）
        wait_reads(&mock, 1).await;
        // 立刻推进 epoch（新窗口）→ 在途预载在第二 chunk 前的检查点被取消
        p.notify_window(2, &origin, &[]).await;
        for _ in 0..400 {
            if m.inflight_empty().await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(m.inflight_empty().await, "预载任务已退出（被 epoch 取消）");
        assert_eq!(
            mock.read_calls.load(Ordering::SeqCst),
            1,
            "下载被取消（read_calls 未达全量 2 chunk）"
        );
        let part = dir
            .path()
            .join("part")
            .join(format!("{}.part", cache_key(&origin, "slow.cbz")));
        assert!(part.exists(), ".part 保留（预载取消不删断点，供后续续传）");
    }

    /// 批次级取消（任务 8 审查修复 / spec §7「待开始任务丢弃」）：同批 [rel1, rel2]，
    /// rel1 首 chunk 在途时推进窗口 epoch → rel1 在检查点被取消后，rel2 **不得启动**。
    /// 旧实现 epoch_at_start 在 download 内捕获：rel2 启动时拿到新 epoch 完整下载
    /// （快速滚动场景数百 MB CBX 白下）。断言 read_calls 停在 rel1 的 1 次首 chunk
    /// 且 rel2 无任何缓存产出——mock 计数先于延迟自增，300ms 余量内若 rel2 被启动必被观测。
    #[tokio::test]
    async fn batch_epoch_bump_drops_not_yet_started_rels() {
        let mock = StdArc::new(MockOrigin::new(crate::source::archive::materializer::CHUNK + 5));
        *mock.read_delay_ms.lock().unwrap() = 150;
        let (m, dir, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let m = StdArc::new(m);
        let p = ArchivePrefetcher::new(m.clone());
        p.notify_window(1, &origin, &["rel1.cbz".into(), "rel2.cbz".into()])
            .await;
        // rel1 首 chunk 已在途（epoch_at_start=1 已捕获、inflight 已注册）
        wait_reads(&mock, 1).await;
        // 窗口 B（epoch=2）：rel1 在第二 chunk 前被取消；rel2 属「待开始」应被丢弃
        p.notify_window(2, &origin, &[]).await;
        for _ in 0..400 {
            if m.inflight_empty().await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(m.inflight_empty().await, "rel1 已退出（epoch 取消）");
        // 旧实现：循环随即启动 rel2（read_calls → 2，计数先于 150ms 延迟自增）
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert_eq!(
            mock.read_calls.load(Ordering::SeqCst),
            1,
            "rel2 从未启动（待开始任务丢弃——spec §7）"
        );
        assert!(
            !dir.path().join(format!("{}.zip", cache_key(&origin, "rel2.cbz"))).exists(),
            "rel2 无缓存产出"
        );
    }

    #[tokio::test]
    async fn metadata_stat_only_no_download() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, dir, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let p = ArchivePrefetcher::new(StdArc::new(m));
        p.warm_metadata(&origin, &["a.cbz".into(), "b.cbz".into()]).await;
        assert_eq!(mock.stat_calls.load(Ordering::SeqCst), 2, "两个 rel 各 stat 一次");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 0, "元数据级不下载内容");
        // 无任何缓存文件产出（final 不存在）
        assert!(
            !dir.path().join(format!("{}.zip", cache_key(&origin, "a.cbz"))).exists()
                && !dir.path().join(format!("{}.zip", cache_key(&origin, "b.cbz"))).exists(),
            "stat 预热不落缓存文件"
        );
    }

    #[tokio::test]
    async fn disabled_flag_blocks_all_but_forced() {
        let mock = StdArc::new(MockOrigin::new(10));
        let (m, dir, _db) = temp_materializer(mock.clone());
        let origin = webdav("");
        let m = StdArc::new(m);
        let p = ArchivePrefetcher::new(m.clone());
        p.set_enabled(false);
        p.notify_window(1, &origin, &["a.cbz".into()]).await;
        p.warm_metadata(&origin, &["a.cbz".into()]).await;
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 0, "关闭后内容预载不触发下载");
        assert_eq!(mock.stat_calls.load(Ordering::SeqCst), 0, "关闭后 stat 预热也不发");
        // 强制路径（用户打开/阅读）不受开关影响——Materializer.ensure_cached 直调
        let forced = m.ensure_cached(&origin, "a.cbz").await.unwrap();
        assert!(forced.exists(), "强制物化照常工作");
        assert_eq!(mock.read_calls.load(Ordering::SeqCst), 1);
        assert!(dir.path().join(format!("{}.zip", cache_key(&origin, "a.cbz"))).exists());
    }
}
