//! 会话级 Archive 密码库：按 identity 精确匹配的内存存储。
//!
//! identity =（location, size, modified_at）——size/mtime 任一变化即视为不同归档，
//! 拒绝把旧密码套用到被替换过的文件上。值用 `Zeroizing` 包裹，drop 即擦除。

use std::collections::HashMap;
use std::sync::RwLock;
use zeroize::Zeroizing;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ArchiveIdentity {
    pub location: String,
    pub size: u64,
    pub modified_at: Option<i64>,
}

impl ArchiveIdentity {
    pub fn new(location: impl Into<String>, size: u64, modified_at: Option<i64>) -> Self {
        Self { location: location.into(), size, modified_at }
    }
}

#[derive(Default)]
pub struct ArchivePasswordStore {
    values: RwLock<HashMap<ArchiveIdentity, Zeroizing<Vec<u8>>>>,
}

impl ArchivePasswordStore {
    pub fn insert(&self, id: ArchiveIdentity, password: Zeroizing<Vec<u8>>) {
        self.values.write().unwrap().insert(id, password);
    }

    pub fn get(&self, id: &ArchiveIdentity) -> Option<Zeroizing<Vec<u8>>> {
        self.values
            .read()
            .unwrap()
            .get(id)
            .map(|value| Zeroizing::new(value.to_vec()))
    }

    pub fn forget(&self, id: &ArchiveIdentity) {
        self.values.write().unwrap().remove(id);
    }

    pub fn clear(&self) {
        self.values.write().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_store_only_returns_exact_identity_and_can_forget() {
        let store = ArchivePasswordStore::default();
        let a = ArchiveIdentity::new("local:C:/a.cbz", 10, Some(1));
        let changed = ArchiveIdentity::new("local:C:/a.cbz", 11, Some(2));
        store.insert(a.clone(), Zeroizing::new(b"secret".to_vec()));
        let password = store.get(&a).unwrap();
        assert_eq!(password.as_slice(), b"secret");
        assert_eq!(store.get(&changed), None);
        store.forget(&a);
        assert_eq!(store.get(&a), None);
    }
}
