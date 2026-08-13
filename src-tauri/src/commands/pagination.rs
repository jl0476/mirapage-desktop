//! 列表分页共享 helper（spec §7）。
//!
//! 约定：`limit=None && cursor=None` → 返回全部（兼容现有无参前端调用）。
//! 否则分页：`limit` 缺省 100，钳到 [1, 500]；`cursor` 为不透明 JSON 字符串，
//! 编码上一页最后一条的排序键。游标无法反序列化 → `Err`（参数错误）。

use serde::de::DeserializeOwned;
use serde::Serialize;

/// 钳制 limit。None → 100；Some(n) → clamp(n, 1, 500)。
pub fn page_limit(limit: Option<i64>) -> i64 {
    limit.unwrap_or(100).clamp(1, 500)
}

/// 解码不透明 cursor JSON 为具体键结构。失败返回参数错误。
pub fn decode_cursor<T: DeserializeOwned>(cursor: &str) -> Result<T, String> {
    serde_json::from_str(cursor).map_err(|_| "游标无效".to_string())
}

/// 分页信封（spec §7）。无参兼容调用：items=全部，nextCursor=None。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paginated<T: Serialize> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

impl<T: Serialize> Paginated<T> {
    pub fn all(items: Vec<T>) -> Self {
        Self { items, next_cursor: None }
    }
    /// 若结果数 == limit，把最后一条的 key 编码为 nextCursor；否则 None。
    pub fn from_page(items: Vec<T>, limit: i64, last_key: impl FnOnce(&T) -> Option<String>) -> Self {
        let next_cursor = if (items.len() as i64) == limit {
            items.last().and_then(last_key)
        } else {
            None
        };
        Self { items, next_cursor }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_limit_none_defaults_100() {
        assert_eq!(page_limit(None), 100);
    }

    #[test]
    fn page_limit_clamps_below_1_and_above_500() {
        assert_eq!(page_limit(Some(0)), 1);
        assert_eq!(page_limit(Some(-5)), 1);
        assert_eq!(page_limit(Some(1)), 1);
        assert_eq!(page_limit(Some(250)), 250);
        assert_eq!(page_limit(Some(500)), 500);
        assert_eq!(page_limit(Some(501)), 500);
        assert_eq!(page_limit(Some(99999)), 500);
    }

    #[test]
    fn decode_cursor_invalid_json_errors() {
        let res: Result<(i64,), String> = decode_cursor("not json");
        assert!(res.is_err());
        let res: Result<(i64,), String> = decode_cursor("[1, 2]"); // 类型不符
        assert!(res.is_err());
    }

    #[test]
    fn decode_cursor_valid() {
        let (a, b): (i64, String) = decode_cursor(r#"[5,"x"]"#).unwrap();
        assert_eq!(a, 5);
        assert_eq!(b, "x");
    }
}
