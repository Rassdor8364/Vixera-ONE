//! Device-side credential storage.
//!
//! Vixera keeps two kinds of secrets on a device: the Supabase session and the
//! device key (see `docs/credentials.md`). Provider tokens never reach devices;
//! they live in the server Vault. Every store implements [`CredentialStore`]:
//! opaque string values addressed by namespaced keys such as
//! `supabase.session`, `device.key` or `connector.<accountId>` (the last is
//! reserved for a future device-hosted sync and unused in Phase 1).
//!
//! Rules: values are never logged, never written to plain files, and never
//! embedded in error messages. Error text may mention the key, never the value.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// Service name under which every Vixera One credential is stored in the OS keychain
/// (Windows Credential Manager target prefix, macOS Keychain service, Linux keyutils description).
pub const CREDENTIAL_SERVICE: &str = "ai.vixera.one";

/// Key for the serialized Supabase session (managed by supabase-js through the Tauri bridge).
pub const KEY_SUPABASE_SESSION: &str = "supabase.session";
/// Key for the per-device secret used to authenticate device-scoped operations.
pub const KEY_DEVICE_KEY: &str = "device.key";
/// Prefix for per-connector-account secrets (`connector.<accountId>`). Reserved; unused in Phase 1.
pub const KEY_CONNECTOR_PREFIX: &str = "connector.";

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    /// The key is empty, too long, or contains characters the backend cannot store.
    #[error("invalid credential key: {0}")]
    InvalidKey(String),
    /// The backend refused the value (e.g. too long for the platform store).
    #[error("credential value rejected for key {0}")]
    InvalidValue(String),
    /// No secure storage is available on this platform/build.
    #[error("secure credential storage is unavailable: {0}")]
    Unavailable(String),
    /// The platform store failed. The message never contains the value.
    #[error("credential store failure for key {key}: {message}")]
    Backend { key: String, message: String },
}

/// Opaque key/value secret storage bound to one device.
///
/// Implementations must be safe to call from any thread. `get` of a missing key
/// is `Ok(None)`; `delete` of a missing key is `Ok(())` (idempotent).
pub trait CredentialStore {
    fn get(&self, key: &str) -> Result<Option<String>, CredentialError>;
    fn set(&self, key: &str, value: &str) -> Result<(), CredentialError>;
    fn delete(&self, key: &str) -> Result<(), CredentialError>;
}

/// Keys are short, printable, and namespaced with dots; they are used verbatim as
/// keychain account names, so keep them boring.
pub fn validate_key(key: &str) -> Result<(), CredentialError> {
    if key.is_empty() {
        return Err(CredentialError::InvalidKey("key must not be empty".into()));
    }
    if key.len() > 128 {
        return Err(CredentialError::InvalidKey(format!("key is longer than 128 bytes ({} bytes)", key.len())));
    }
    if !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':')) {
        return Err(CredentialError::InvalidKey(format!("key {key:?} contains characters outside [A-Za-z0-9._:-]")));
    }
    Ok(())
}

/// Process-local store for tests and development. Nothing is persisted.
#[derive(Debug, Default)]
pub struct InMemoryCredentialStore {
    values: Mutex<HashMap<String, String>>,
}

impl InMemoryCredentialStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of stored keys (for tests).
    pub fn len(&self) -> usize {
        self.values.lock().unwrap_or_else(PoisonError::into_inner).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl CredentialStore for InMemoryCredentialStore {
    fn get(&self, key: &str) -> Result<Option<String>, CredentialError> {
        validate_key(key)?;
        Ok(self.values.lock().unwrap_or_else(PoisonError::into_inner).get(key).cloned())
    }

    fn set(&self, key: &str, value: &str) -> Result<(), CredentialError> {
        validate_key(key)?;
        self.values
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), CredentialError> {
        validate_key(key)?;
        self.values.lock().unwrap_or_else(PoisonError::into_inner).remove(key);
        Ok(())
    }
}

/// OS keychain store: Windows Credential Manager, macOS Keychain, Linux kernel keyutils.
///
/// Entries are `(service = "ai.vixera.one", user = <key>)`. The Linux keyutils
/// backend is in-memory per login session (it does not survive a reboot); callers
/// must treat a missing entry as "sign in again", which is the right behaviour for
/// a session anyway.
#[cfg(all(feature = "keyring", any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod keyring_store {
    use super::{validate_key, CredentialError, CredentialStore, CREDENTIAL_SERVICE};

    #[derive(Debug, Clone)]
    pub struct KeyringCredentialStore {
        service: String,
    }

    impl Default for KeyringCredentialStore {
        fn default() -> Self {
            Self::new()
        }
    }

    impl KeyringCredentialStore {
        /// Store under the production service name [`CREDENTIAL_SERVICE`].
        pub fn new() -> Self {
            Self { service: CREDENTIAL_SERVICE.to_owned() }
        }

        /// Store under another service name (e.g. `ai.vixera.one.dev`) so dev and
        /// installed builds never share a session.
        pub fn with_service(service: impl Into<String>) -> Self {
            Self { service: service.into() }
        }

        pub fn service(&self) -> &str {
            &self.service
        }

        fn entry(&self, key: &str) -> Result<keyring::Entry, CredentialError> {
            validate_key(key)?;
            keyring::Entry::new(&self.service, key).map_err(|e| backend(key, e))
        }
    }

    fn backend(key: &str, error: keyring::Error) -> CredentialError {
        match error {
            keyring::Error::NoStorageAccess(e) => CredentialError::Unavailable(e.to_string()),
            keyring::Error::TooLong(what, max) => CredentialError::InvalidValue(format!("{key}: {what} exceeds {max}")),
            keyring::Error::Invalid(what, why) => CredentialError::InvalidKey(format!("{what}: {why}")),
            // Every other variant is a platform failure; `Display` of these variants
            // never includes the secret.
            other => CredentialError::Backend { key: key.to_owned(), message: other.to_string() },
        }
    }

    impl CredentialStore for KeyringCredentialStore {
        fn get(&self, key: &str) -> Result<Option<String>, CredentialError> {
            match self.entry(key)?.get_password() {
                Ok(value) => Ok(Some(value)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(backend(key, e)),
            }
        }

        fn set(&self, key: &str, value: &str) -> Result<(), CredentialError> {
            self.entry(key)?.set_password(value).map_err(|e| backend(key, e))
        }

        fn delete(&self, key: &str) -> Result<(), CredentialError> {
            match self.entry(key)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(backend(key, e)),
            }
        }
    }
}

#[cfg(all(feature = "keyring", any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub use keyring_store::KeyringCredentialStore;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_memory_roundtrip_and_idempotent_delete() {
        let store = InMemoryCredentialStore::new();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap(), None);
        store.set(KEY_SUPABASE_SESSION, "fake-session-token").unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap().as_deref(), Some("fake-session-token"));
        store.set(KEY_SUPABASE_SESSION, "fake-session-token-2").unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap().as_deref(), Some("fake-session-token-2"));
        store.delete(KEY_SUPABASE_SESSION).unwrap();
        store.delete(KEY_SUPABASE_SESSION).unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap(), None);
        assert!(store.is_empty());
    }

    #[test]
    fn keys_are_namespaced_and_independent() {
        let store = InMemoryCredentialStore::new();
        store.set(KEY_DEVICE_KEY, "fake-device-key").unwrap();
        let account_key = format!("{KEY_CONNECTOR_PREFIX}acct-1");
        store.set(&account_key, "fake-token").unwrap();
        assert_eq!(store.len(), 2);
        store.delete(&account_key).unwrap();
        assert_eq!(store.get(KEY_DEVICE_KEY).unwrap().as_deref(), Some("fake-device-key"));
    }

    #[test]
    fn rejects_bad_keys_without_touching_storage() {
        let store = InMemoryCredentialStore::new();
        assert!(matches!(store.set("", "x"), Err(CredentialError::InvalidKey(_))));
        assert!(matches!(store.set("has space", "x"), Err(CredentialError::InvalidKey(_))));
        assert!(matches!(store.get(&"k".repeat(129)), Err(CredentialError::InvalidKey(_))));
        assert!(store.is_empty());
    }

    #[test]
    fn errors_never_carry_values() {
        let err = CredentialError::Backend { key: "supabase.session".into(), message: "locked".into() };
        let text = err.to_string();
        assert!(text.contains("supabase.session"));
        assert!(!text.contains("fake-session-token"));
    }
}
