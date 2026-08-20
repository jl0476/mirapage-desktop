//! 三级预载（M3 spec §7）：元数据 stat 预热 / 内容低优 ensure_cached / 强制=同步路径。
//! 复用 3.0.7 调度语义：epoch 取消 + in-flight 去重（去重由 Materializer.inflight 承担）。

use super::materializer::Materializer;
use crate::source::descriptor::SourceDescriptor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct ArchivePrefetcher {
    mat: Arc<Materializer>,
    enabled: AtomicBool,
}

impl ArchivePrefetcher {
    pub fn new(mat: Arc<Materializer>) -> Self {
        Self { mat, enabled: AtomicBool::new(true) }
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
        self.mat.new_epoch(epoch);
        let mat = self.mat.clone();
        let origin = origin.clone();
        let rels = rels.to_vec();
        tokio::spawn(async move {
            for rel in &rels {
                // epoch 变更即停（ensure_cached_cancellable 检查点取消，任务 3 语义）
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
