//! 双页规划算法（SpreadPlanner）
//!
//! 参考 MiraPage Android `SpreadPlanner.kt:17`，用 Rust 重写。
//!
//! ## 语义
//! - `pageCount == 0` → `[]`
//! - `pageCount == 1` → `[0..0]`（单页无论 coverStandalone）
//! - `pageCount > 1 && coverStandalone` → `[0..0]` + `[1..2]` + `[3..4]` + ... + 余单页 `[i..i]`
//! - `coverStandalone == false` → 两两配对
//!
//! ## RTL
//! RTL 不在此函数处理，由调用方通过 Pager 的 `reverseLayout` + `LayoutDirection` 控制。

pub struct SpreadPlanner;

impl SpreadPlanner {
    /// 把扁平页表切成 spread 列表
    pub fn plan(page_count: u32, cover_standalone: bool) -> Vec<std::ops::Range<u32>> {
        if page_count == 0 {
            return vec![];
        }
        if page_count == 1 {
            return vec![0..1];
        }

        let mut spreads = Vec::new();

        // 封面独占
        if cover_standalone {
            spreads.push(0..1);
        }

        // 从 i 开始两两配对
        let start = if cover_standalone { 1 } else { 0 };
        let mut i = start;
        while i + 1 < page_count {
            spreads.push(i..i + 2);
            i += 2;
        }

        // 余单页
        if i < page_count {
            spreads.push(i..i + 1);
        }

        spreads
    }

    /// 反查：页索引 → spread 索引
    pub fn spread_index_for_page(page_index: u32, spreads: &[std::ops::Range<u32>]) -> u32 {
        for (idx, spread) in spreads.iter().enumerate() {
            if spread.contains(&page_index) {
                return idx as u32;
            }
        }
        0
    }

    /// 取某 spread 的首页
    pub fn first_page_of_spread(spread: &std::ops::Range<u32>) -> u32 {
        spread.start
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty() {
        assert!(SpreadPlanner::plan(0, true).is_empty());
    }

    #[test]
    fn test_single_page() {
        assert_eq!(SpreadPlanner::plan(1, true), vec![0..1]);
        assert_eq!(SpreadPlanner::plan(1, false), vec![0..1]);
    }

    #[test]
    fn test_two_pages_cover_standalone() {
        // pageCount=2, coverStandalone=true → [0..1], [1..2]
        let s = SpreadPlanner::plan(2, true);
        assert_eq!(s, vec![0..1, 1..2]);
    }

    #[test]
    fn test_two_pages_no_cover_standalone() {
        // pageCount=2, coverStandalone=false → [0..2]
        let s = SpreadPlanner::plan(2, false);
        assert_eq!(s, vec![0..2]);
    }

    #[test]
    fn test_ten_pages_cover_standalone() {
        // pageCount=10, coverStandalone=true → [0..1], [1..3], [3..5], [5..7], [7..9], [9..10]
        let s = SpreadPlanner::plan(10, true);
        assert_eq!(s, vec![0..1, 1..3, 3..5, 5..7, 7..9, 9..10]);
    }

    #[test]
    fn test_eleven_pages_cover_standalone() {
        // pageCount=11 → [0..1], [1..3], [3..5], [5..7], [7..9], [9..11]
        let s = SpreadPlanner::plan(11, true);
        assert_eq!(s, vec![0..1, 1..3, 3..5, 5..7, 7..9, 9..11]);
    }

    #[test]
    fn test_eight_pages_cover_standalone() {
        // pageCount=8 → [0..1], [1..3], [3..5], [5..7], [7..8]
        let s = SpreadPlanner::plan(8, true);
        assert_eq!(s, vec![0..1, 1..3, 3..5, 5..7, 7..8]);
    }

    #[test]
    fn test_spread_index_for_page() {
        let spreads = vec![0..1, 1..3, 3..5];
        assert_eq!(SpreadPlanner::spread_index_for_page(0, &spreads), 0);
        assert_eq!(SpreadPlanner::spread_index_for_page(1, &spreads), 1);
        assert_eq!(SpreadPlanner::spread_index_for_page(2, &spreads), 1);
        assert_eq!(SpreadPlanner::spread_index_for_page(3, &spreads), 2);
    }
}