//! media:// 进程内 LRU（spec rev5 §3.6）——预读预载的载体。
//! Local 源不进缓存；命中只回 200 全量（Range 走源）；账户变更整表清空。

use std::collections::HashMap;
use std::sync::Mutex;

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
}
