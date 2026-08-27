//! media:// 进程内 LRU（spec rev5 §3.6）——预读预载的载体。
//! Local 源不进缓存；命中只回 200 全量（Range 走源）；账户变更整表清空。
//! 2026-08 spec §8：media path singleflight（watch 单飞）+ generation 守卫
//! 收敛 media:// miss 与 warm 两条路径的同图重复下载。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::watch;

pub struct CachedMedia {
    pub bytes: Vec<u8>,
    pub mime: String,
}

struct Entry {
    media: std::sync::Arc<CachedMedia>,
    prev: Option<String>,
    next: Option<String>,
}

pub struct MediaLru {
    cap: usize, // 字节上限
    bytes: usize,
    map: HashMap<String, Entry>,
    head: Option<String>, // 最新
    tail: Option<String>, // 最旧
    /// 代际（spec §8.1）：clear_all 递增；在途下载按下载前捕获的代写入，
    /// 旧代结果丢弃——封死"账户变更 clear 后，旧请求完成又把旧内容写回"的窗口。
    generation: u64,
}

impl MediaLru {
    pub fn new(cap_bytes: usize) -> Self {
        Self { cap: cap_bytes, bytes: 0, map: HashMap::new(), head: None, tail: None, generation: 0 }
    }

    pub fn get(&mut self, key: &str) -> Option<std::sync::Arc<CachedMedia>> {
        let e = self.map.get(key)?;
        let media = e.media.clone();
        self.touch(key);
        Some(media)
    }

    /// rev7 方向统一：**head=最新、tail=最旧**——新条目插入 head，淘汰淘汰 tail，
    /// touch 把条目移回 head。纯 put 序列淘汰最早写入项（方向回归用例守护）。
    pub fn put(&mut self, key: String, media: CachedMedia) {
        let sz = media.bytes.len();
        if sz > self.cap {
            return; // 单项超限不缓存
        }
        if self.map.contains_key(&key) {
            self.detach(&key); // 旧值先摘链（bytes 已扣）
        }
        while self.bytes + sz > self.cap {
            let victim = match self.tail.clone() { Some(v) => v, None => break };
            self.detach(&victim); // 淘汰最旧
        }
        let old_head = self.head.clone();
        self.bytes += sz;
        self.map.insert(key.clone(), Entry {
            media: std::sync::Arc::new(media),
            prev: None,
            next: old_head.clone(),
        });
        if let Some(h) = &old_head {
            if let Some(e) = self.map.get_mut(h) { e.prev = Some(key.clone()); }
        } else {
            // 空表：新条目同时是 tail
            self.tail = Some(key.clone());
        }
        self.head = Some(key);
    }

    pub fn clear(&mut self) {
        self.bytes = 0; self.map.clear(); self.head = None; self.tail = None;
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// 同一临界区内比较并插入（spec §8.1）：与 clear 的递增互斥，
    /// 封死"检查后、写入前被 clear"窗口。返回是否真正写入。
    pub fn put_if_generation(&mut self, key: String, media: CachedMedia, expected: u64) -> bool {
        if self.generation != expected {
            return false;
        }
        self.put(key, media);
        true
    }

    /// 清空并递增代（clear_all 的实现细节；表级 clear 语义同旧 clear + 失效在途写入）。
    pub fn clear_and_bump(&mut self) {
        self.clear();
        self.generation += 1;
    }

    pub fn current_bytes(&self) -> usize { self.bytes }

    /// 把 key 移回 head（最新端）。detach 会删 map 条目，故先取 media 再重插（字节记账先扣后加，净零）
    fn touch(&mut self, key: &str) {
        if self.head.as_deref() == Some(key) { return; }
        let media = match self.map.get(key) { Some(e) => e.media.clone(), None => return };
        self.detach(key);
        let old_head = self.head.clone();
        let sz = media.bytes.len();
        self.bytes += sz;
        self.map.insert(key.to_string(), Entry { media, prev: None, next: old_head.clone() });
        if let Some(h) = &old_head {
            if let Some(e) = self.map.get_mut(h) { e.prev = Some(key.to_string()); }
        } else {
            self.tail = Some(key.to_string()); // detach 后表空，key 兼任 tail
        }
        self.head = Some(key.to_string());
    }

    /// 通用摘链：移除 map 条目、修前后链接、扣字节
    fn detach(&mut self, key: &str) {
        let (prev, next, sz) = {
            let e = match self.map.get(key) { Some(e) => e, None => return };
            (e.prev.clone(), e.next.clone(), e.media.bytes.len())
        };
        self.map.remove(key);
        self.bytes -= sz;
        if let Some(p) = &prev { if let Some(e) = self.map.get_mut(p) { e.next = next.clone(); } }
        if let Some(n) = &next { if let Some(e) = self.map.get_mut(n) { e.prev = prev.clone(); } }
        if self.head.as_deref() == Some(key) { self.head = next.clone(); }
        if self.tail.as_deref() == Some(key) { self.tail = prev.clone(); }
    }
}

/// 全局单例（handler / warm / 账户清空共用；std::sync::OnceLock，rev8 定死无 once_cell 依赖）
pub static GLOBAL: std::sync::OnceLock<Mutex<MediaLru>> = std::sync::OnceLock::new();

pub fn global() -> &'static Mutex<MediaLru> {
    GLOBAL.get_or_init(|| Mutex::new(MediaLru::new(256 * 1024 * 1024)))
}

pub fn clear_all() {
    global().lock().unwrap().clear_and_bump();
}

// ─── singleflight（spec §8）───

/// singleflight 终态（spec §8：watch 值语义，防 Notify 丢唤醒）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum FetchOutcome {
    Pending,
    Done,
    Failed,
}

fn inflight_registry() -> &'static Mutex<HashMap<String, Arc<watch::Sender<FetchOutcome>>>> {
    static REG: OnceLock<Mutex<HashMap<String, Arc<watch::Sender<FetchOutcome>>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 生产入口：经 MediaSource::read_file 下载并写入 LRU（generation 守卫 + 同路径单飞）。
/// true = 该路径现可在 LRU 命中；false = 失败/旧代丢弃（media:// 回 502，warm 静默）。
pub async fn fetch_remote_to_cache(
    media_path: &str,
    src: Arc<dyn crate::source::trait_def::MediaSource>,
    descriptor: &crate::source::descriptor::SourceDescriptor,
    file_path: &str,
) -> bool {
    fetch_remote_to_cache_with(
        media_path,
        move |fp| {
            let src = src.clone();
            let d = descriptor.clone();
            async move { src.read_file(&d, &fp, None).await.map_err(|e| e.to_string()) }
        },
        file_path,
    )
    .await
}

/// 可测参数化版本（测试注入计数闭包）。注册表锁内定角色：
/// 有在途 → waiter（锁内 subscribe，watch 值语义保证 owner 先 send 也读得到终态）；
/// 无 → owner（下载 → generation 守卫入 LRU → send 终态 → 摘条目）。
pub async fn fetch_remote_to_cache_with<F, Fut>(media_path: &str, fetch: F, file_path: &str) -> bool
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = std::result::Result<Vec<u8>, String>>,
{
    enum Role {
        Waiter(watch::Receiver<FetchOutcome>),
        Owner(Arc<watch::Sender<FetchOutcome>>),
    }
    let role = {
        let mut m = inflight_registry().lock().unwrap();
        match m.get(media_path) {
            Some(tx) => Role::Waiter(tx.subscribe()),
            None => {
                let (tx, _rx) = watch::channel(FetchOutcome::Pending);
                let tx = Arc::new(tx);
                m.insert(media_path.to_string(), tx.clone());
                Role::Owner(tx)
            }
        }
    };
    match role {
        Role::Waiter(mut rx) => {
            // 等终态（owner send 先于摘条目；防御 sender 提前 drop）
            loop {
                if *rx.borrow() != FetchOutcome::Pending {
                    break;
                }
                if rx.changed().await.is_err() {
                    break;
                }
            }
            if *rx.borrow() == FetchOutcome::Done {
                return global().lock().unwrap().get(media_path).is_some();
            }
            false
        }
        Role::Owner(tx) => {
            // 代捕获在下载启动前（spec §8.1）
            let expected = global().lock().unwrap().generation();
            let res = fetch(file_path.to_string()).await;
            let ok = match res {
                Ok(bytes) => {
                    let name = file_path.rsplit('/').next().unwrap_or(file_path);
                    let mime = crate::algorithm::mime_from_name(name)
                        .unwrap_or("application/octet-stream")
                        .to_string();
                    global().lock().unwrap().put_if_generation(
                        media_path.to_string(),
                        CachedMedia { bytes, mime },
                        expected,
                    )
                }
                Err(_) => false,
            };
            let _ = tx.send(if ok { FetchOutcome::Done } else { FetchOutcome::Failed });
            inflight_registry().lock().unwrap().remove(media_path);
            ok
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_oldest_and_counts_bytes() {
        let mut c = MediaLru::new(10);
        c.put("a".into(), CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() }); // head=a
        c.put("b".into(), CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() }); // head=b, tail=a
        c.get("a");                                                        // touch → head=a, tail=b
        c.put("c".into(), CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() }); // 12 > 10 → 淘汰 tail=b
        assert!(c.get("a").is_some());
        assert!(c.get("b").is_none(), "touch 后 b 是最旧，被淘汰");
        assert!(c.get("c").is_some());
        assert_eq!(c.current_bytes(), 8);
    }

    /// rev7 方向回归：连续 put 无 get 时，必须淘汰**最早写入**的 a
    #[test]
    fn consecutive_puts_evict_oldest_without_get() {
        let mut c = MediaLru::new(8);
        c.put("a".into(), CachedMedia { bytes: vec![0; 4], mime: "m".into() });
        c.put("b".into(), CachedMedia { bytes: vec![0; 4], mime: "m".into() });
        c.put("c".into(), CachedMedia { bytes: vec![0; 4], mime: "m".into() }); // 12 > 8
        assert!(c.get("a").is_none(), "无 touch 时最早写入的 a 被淘汰");
        assert!(c.get("b").is_some());
        assert!(c.get("c").is_some());
    }

    /// rev7 方向回归：touch 保护条目——get("a") 后 a 不可被淘汰
    #[test]
    fn touch_protects_entry_from_eviction() {
        let mut c = MediaLru::new(8);
        c.put("a".into(), CachedMedia { bytes: vec![0; 4], mime: "m".into() });
        c.put("b".into(), CachedMedia { bytes: vec![0; 4], mime: "m".into() });
        assert!(c.get("a").is_some()); // a → head（最新）
        c.put("c".into(), CachedMedia { bytes: vec![0; 4], mime: "m".into() });
        assert!(c.get("a").is_some(), "被 touch 的 a 不被淘汰");
        assert!(c.get("b").is_none(), "淘汰未被 touch 的 b");
    }

    #[test]
    fn clear_all_resets() {
        let mut c = MediaLru::new(10);
        c.put("a".into(), CachedMedia { bytes: vec![0; 4], mime: "m".into() });
        c.clear();
        assert_eq!(c.current_bytes(), 0);
        assert!(c.get("a").is_none());
    }

    #[test]
    fn oversize_entry_not_cached() {
        let mut c = MediaLru::new(4);
        c.put("big".into(), CachedMedia { bytes: vec![0; 8], mime: "m".into() });
        assert!(c.get("big").is_none());
    }

    #[test]
    fn put_if_generation_matches_only() {
        let mut c = MediaLru::new(1 << 20);
        let g0 = c.generation();
        assert!(c.put_if_generation(
            "a".into(),
            CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() },
            g0,
        ));
        assert!(c.get("a").is_some());

        c.clear_and_bump(); // 模拟 clear_all 的清空+递增
        let g1 = c.generation();
        assert_ne!(g0, g1);
        assert!(!c.put_if_generation(
            "b".into(),
            CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() },
            g0, // 旧代：必须拒绝
        ));
        assert!(c.get("b").is_none(), "旧代写入不得落表");
        assert!(c.put_if_generation(
            "b".into(),
            CachedMedia { bytes: vec![0; 4], mime: "image/jpeg".into() },
            g1,
        ));
    }

    // ─── singleflight（spec §8/§11.3）：三测试共享全局 LRU + 注册表 + clear_all，
    // cargo 并行执行下 clear_all 会丢弃他测在途 owner 的结果——测试锁串行化本组 ───

    fn singleflight_test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        // poison 恢复：一个测试 panic 不连锁死锁余下测试
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[tokio::test]
    async fn singleflight_dedups_concurrent_same_path() {
        let _g = singleflight_test_lock();
        crate::media_cache::clear_all();
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let c2 = calls.clone();
        let fetch = move |_fp: String| {
            let c = c2.clone();
            async move {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
                Ok(vec![1u8, 2, 3])
            }
        };
        let a = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/x", fetch, "p/x.jpg"));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await; // 让 owner 就位
        let c2b = calls.clone();
        let fetch2 = move |_fp: String| {
            let c = c2b.clone();
            async move {
                c.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(vec![9u8])
            }
        };
        let b = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/x", fetch2, "p/x.jpg"));
        let (ra, rb) = (a.await.unwrap(), b.await.unwrap());
        assert!(ra, "owner 成功");
        assert!(rb, "waiter 经 LRU 命中成功");
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "同 path 并发只下载一份");
        assert!(crate::media_cache::global().lock().unwrap().get("/m/x").is_some());
    }

    #[tokio::test]
    async fn owner_failure_wakes_waiter_err() {
        let _g = singleflight_test_lock();
        crate::media_cache::clear_all();
        let fetch = move |_fp: String| async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            Err::<Vec<u8>, String>("boom".into())
        };
        let a = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/y", fetch, "p/y.jpg"));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let fetch2 = move |_fp: String| async { Ok::<Vec<u8>, String>(vec![9]) };
        let b = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/y", fetch2, "p/y.jpg"));
        assert!(!a.await.unwrap(), "owner 失败");
        assert!(!b.await.unwrap(), "waiter 查 LRU miss → false");
    }

    #[tokio::test]
    async fn generation_change_discards_owner_result() {
        let _g = singleflight_test_lock();
        crate::media_cache::clear_all();
        let fetch = move |_fp: String| async {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            Ok(vec![1u8, 2, 3])
        };
        let a = tokio::spawn(crate::media_cache::fetch_remote_to_cache_with("/m/z", fetch, "p/z.jpg"));
        tokio::time::sleep(std::time::Duration::from_millis(10)).await; // owner 在途
        crate::media_cache::clear_all(); // 账户变更模拟：代已变
        assert!(!a.await.unwrap(), "旧代结果必须丢弃");
        assert!(crate::media_cache::global().lock().unwrap().get("/m/z").is_none());
    }
}
