//! 自然排序：page2.jpg < page10.jpg
//!
//! 参考 MiraPage Android `NaturalSortComparator.kt:11`，用 Rust 重写。
//!
//! ## 语义
//! - 数字段按"长度优先，相等再逐位"（`100 > 99`）
//! - 前导零归一（`img001 == img1`）
//! - 大小写无关
//! - 空串相等
//!
//! ## 边界
//! - 纯数字长度比较
//! - 前导零归一
//! - 大小写无关
//! - 混合段（数字 + 非数字交替）
//! - `"page" < "page1"`（短前缀胜）

pub fn natural_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let a_segments = split_to_segments(a);
    let b_segments = split_to_segments(b);
    let len = a_segments.len().min(b_segments.len());

    for i in 0..len {
        let (a_seg, b_seg) = (&a_segments[i], &b_segments[i]);
        let a_is_num = a_seg.chars().next().map_or(false, |c| c.is_ascii_digit());
        let b_is_num = b_seg.chars().next().map_or(false, |c| c.is_ascii_digit());

        if a_is_num && b_is_num {
            // 去前导零但保留至少一位
            let a_norm = a_seg.trim_start_matches('0');
            let b_norm = b_seg.trim_start_matches('0');
            let a_norm = if a_norm.is_empty() { "0" } else { a_norm };
            let b_norm = if b_norm.is_empty() { "0" } else { b_norm };

            // 长度优先，再逐位
            match a_norm.len().cmp(&b_norm.len()) {
                Ordering::Equal => {
                    match a_norm.cmp(b_norm) {
                        Ordering::Equal => continue,
                        other => return other,
                    }
                }
                other => return other,
            }
        } else {
            // 非数字段：逐位小写比较
            let a_lower = a_seg.to_lowercase();
            let b_lower = b_seg.to_lowercase();
            match a_lower.cmp(&b_lower) {
                Ordering::Equal => continue,
                other => return other,
            }
        }
    }

    // 长度差
    a_segments.len().cmp(&b_segments.len())
}

/// 把字符串切成"数字段 + 非数字段"交替的列表
fn split_to_segments(s: &str) -> Vec<&str> {
    // 使用 byte-level 切片安全（仅 ASCII）
    let bytes = s.as_bytes();
    let mut segments = Vec::new();
    let mut start = 0;
    let mut i = 0;

    while i < bytes.len() {
        let is_digit = bytes[i].is_ascii_digit();
        let mut j = i;
        while j < bytes.len() && bytes[j].is_ascii_digit() == is_digit {
            j += 1;
        }
        segments.push(&s[start..j.min(s.len())]);
        // 防止 UTF-8 边界问题（ASCII 范围内安全，但需保证切片在 char 边界）
        // 这里我们只用 ASCII 切片；安全
        start = j;
        i = j;
    }

    // 边界：start 可能指向 char 中间，但因为我们只切 ASCII 段，OK
    if start == 0 && !s.is_empty() {
        // 兜底
        segments.clear();
        segments.push(s);
    }

    segments
}

/// 对 Vec 按 key 提取的字符串做自然排序（返回新 Vec）
pub fn natural_sort<T, F>(items: Vec<T>, key_fn: F) -> Vec<T>
where
    F: Fn(&T) -> &str,
{
    let mut indices: Vec<usize> = (0..items.len()).collect();
    indices.sort_by(|&i, &j| natural_compare(key_fn(&items[i]), key_fn(&items[j])));
    indices.into_iter().map(|i| items[i]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_natural_compare_basic() {
        // page2.jpg < page10.jpg
        assert!(natural_compare("page2.jpg", "page10.jpg") == std::cmp::Ordering::Less);
        assert!(natural_compare("page10.jpg", "page2.jpg") == std::cmp::Ordering::Greater);
    }

    #[test]
    fn test_natural_compare_leading_zero() {
        // img001 == img1（按 Android 语义归一）
        assert!(natural_compare("img001", "img1") == std::cmp::Ordering::Equal);
        assert!(natural_compare("img0010", "img10") == std::cmp::Ordering::Equal);
    }

    #[test]
    fn test_natural_compare_length_priority() {
        // 100 > 99（数字段长度优先）
        assert!(natural_compare("99", "100") == std::cmp::Ordering::Less);
        assert!(natural_compare("100", "99") == std::cmp::Ordering::Greater);
    }

    #[test]
    fn test_natural_compare_case_insensitive() {
        assert!(natural_compare("Page1.jpg", "page1.jpg") == std::cmp::Ordering::Equal);
    }

    #[test]
    fn test_natural_compare_empty() {
        assert!(natural_compare("", "") == std::cmp::Ordering::Equal);
    }

    #[test]
    fn test_natural_compare_prefix() {
        // "page" < "page1"
        assert!(natural_compare("page", "page1") == std::cmp::Ordering::Less);
    }

    #[test]
    fn test_natural_sort_real_case() {
        let names = vec!["page10.jpg", "page2.jpg", "page1.jpg", "page20.jpg", "page3.jpg"];
        let sorted = natural_sort(names, |n| n);
        assert_eq!(sorted, vec!["page1.jpg", "page2.jpg", "page3.jpg", "page10.jpg", "page20.jpg"]);
    }
}