//! 凭据存储抽象（spec §3.4）：keyring 为生产实现，内存实现供测试。
//! service 固定；account key = "{type}-{id}"。密码不落 DB。

pub const KEYRING_SERVICE: &str = "top.racyan.mirapage-desktop";

pub fn account_key(kind: &str, id: i64) -> String {
    format!("{}-{}", kind, id)
}

pub trait CredentialStore: Send + Sync {
    fn set_password(&self, key: &str, password: &str) -> Result<(), String>;
    fn get_password(&self, key: &str) -> Result<Option<String>, String>;
    fn delete_password(&self, key: &str) -> Result<(), String>;
}

/// 生产实现：OS 凭据管理器（Windows Credential Manager / macOS Keychain / Linux Secret Service）
pub struct KeyringStore;

impl CredentialStore for KeyringStore {
    fn set_password(&self, key: &str, password: &str) -> Result<(), String> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .and_then(|e| e.set_password(password))
            .map_err(|e| format!("keyring set: {e}"))
    }
    fn get_password(&self, key: &str) -> Result<Option<String>, String> {
        match keyring::Entry::new(KEYRING_SERVICE, key).and_then(|e| e.get_password()) {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keyring get: {e}")),
        }
    }
    fn delete_password(&self, key: &str) -> Result<(), String> {
        match keyring::Entry::new(KEYRING_SERVICE, key).and_then(|e| e.delete_credential()) {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // 幂等
            Err(e) => Err(format!("keyring delete: {e}")),
        }
    }
}

/// 测试实现（不触 OS）
pub struct MemoryStore(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl MemoryStore {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(std::collections::HashMap::new()))
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for MemoryStore {
    fn set_password(&self, key: &str, password: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(key.to_string(), password.to_string());
        Ok(())
    }
    fn get_password(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(key).cloned())
    }
    fn delete_password(&self, key: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip_and_delete() {
        let s = MemoryStore::new();
        s.set_password("webdav-3", "p@ss").unwrap();
        assert_eq!(s.get_password("webdav-3").unwrap().as_deref(), Some("p@ss"));
        s.delete_password("webdav-3").unwrap();
        assert_eq!(s.get_password("webdav-3").unwrap(), None);
    }

    #[test]
    fn account_key_format() {
        assert_eq!(account_key("webdav", 3), "webdav-3");
        assert_eq!(account_key("smb", 12), "smb-12");
    }
}
