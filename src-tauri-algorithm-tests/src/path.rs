//! 路径工具（与 src-tauri/src/algorithm/path.rs 镜像）

pub fn segments(path: &str) -> Vec<String> {
    path.replace('\\', "/")
        .split('/')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

pub fn normalize(path: &str) -> String {
    segments(path).join("/")
}

pub fn join(base: &str, segment: &str) -> String {
    let norm_base = normalize(base);
    let norm_seg = normalize(segment);
    if norm_base.is_empty() {
        norm_seg
    } else {
        format!("{}/{}", norm_base, norm_seg)
    }
}

pub fn parent(path: &str) -> String {
    let segs = segments(path);
    if segs.len() <= 1 {
        String::new()
    } else {
        segs[..segs.len() - 1].join("/")
    }
}

pub fn crumbs(root_label: &str, path: &str) -> Vec<(String, String)> {
    let segs = segments(path);
    let mut result = vec![(root_label.to_string(), String::new())];
    let mut acc = String::new();
    for seg in segs {
        acc = if acc.is_empty() {
            seg.clone()
        } else {
            format!("{}/{}", acc, seg)
        };
        result.push((seg, acc.clone()));
    }
    result
}

pub struct PathUtils;

impl PathUtils {
    pub fn segments(path: &str) -> Vec<String> { segments(path) }
    pub fn normalize(path: &str) -> String { normalize(path) }
    pub fn join(base: &str, segment: &str) -> String { join(base, segment) }
    pub fn parent(path: &str) -> String { parent(path) }
    pub fn crumbs(root_label: &str, path: &str) -> Vec<(String, String)> { crumbs(root_label, path) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_segments() {
        assert_eq!(segments("a/b/c"), vec!["a", "b", "c"]);
        assert_eq!(segments("a\\b\\c"), vec!["a", "b", "c"]);
        assert_eq!(segments("/a/b/"), vec!["a", "b"]);
        assert_eq!(segments(""), Vec::<String>::new());
    }

    #[test]
    fn test_normalize() {
        assert_eq!(normalize("a//b\\\\c"), "a/b/c");
    }

    #[test]
    fn test_join() {
        assert_eq!(join("a/b", "c/d"), "a/b/c/d");
        assert_eq!(join("a/b", "/c/d"), "a/b/c/d");
        assert_eq!(join("", "a"), "a");
    }

    #[test]
    fn test_parent() {
        assert_eq!(parent("a/b/c"), "a/b");
        assert_eq!(parent("a"), "");
        assert_eq!(parent(""), "");
    }

    #[test]
    fn test_crumbs() {
        let c = crumbs("Root", "docs/comics");
        assert_eq!(c.len(), 3);
        assert_eq!(c[0], ("Root".to_string(), "".to_string()));
        assert_eq!(c[1], ("docs".to_string(), "docs".to_string()));
        assert_eq!(c[2], ("comics".to_string(), "docs/comics".to_string()));
    }
}