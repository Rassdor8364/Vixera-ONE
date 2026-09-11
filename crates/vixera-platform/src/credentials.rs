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

/// Windows Credential Manager caps `CredentialBlob` at 2560 bytes, and the blob is
/// the value encoded as UTF-16, so a credential is limited to 1280 UTF-16 code
/// units — about 1280 ASCII characters. A Supabase session (access JWT, refresh
/// token, and the whole user object including `user_metadata`) is comfortably
/// past that, so storing it unsplit fails with `TooLong`.
///
/// 1000 leaves headroom under the real 1280 without making entries numerous.
pub const DEFAULT_MAX_UTF16_UNITS: usize = 1000;

/// Marks a primary entry as a manifest rather than a value. U+0001 cannot begin
/// any value Vixera stores (they are JSON or base64), so an entry written by an
/// older build is still read back correctly as a plain value.
const CHUNK_SENTINEL: &str = "\u{1}vx-chunked:";

fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// Split on character boundaries so a surrogate pair is never cut in half.
fn split_utf16(value: &str, max_units: usize) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut units) = (0usize, 0usize);
    for (index, ch) in value.char_indices() {
        let width = ch.len_utf16();
        if units + width > max_units {
            parts.push(&value[start..index]);
            start = index;
            units = 0;
        }
        units += width;
    }
    parts.push(&value[start..]);
    parts
}

/// Splits oversized values across several entries of the wrapped store.
///
/// A value that fits is written verbatim, so this is transparent to anything
/// already stored. A value that does not fit becomes `key` holding a manifest
/// plus `key:c0 … key:cN-1` holding the pieces.
///
/// Everything stays in the platform-secure store; nothing spills to disk.
#[derive(Debug, Clone)]
pub struct ChunkedCredentialStore<S> {
    inner: S,
    max_utf16_units: usize,
}

impl<S: CredentialStore> ChunkedCredentialStore<S> {
    pub fn new(inner: S) -> Self {
        Self { inner, max_utf16_units: DEFAULT_MAX_UTF16_UNITS }
    }

    /// Mainly for tests, which need to drive the boundary without a 1000-character value.
    pub fn with_limit(inner: S, max_utf16_units: usize) -> Self {
        Self { inner, max_utf16_units: max_utf16_units.max(1) }
    }

    fn chunk_key(&self, key: &str, index: usize) -> Result<String, CredentialError> {
        let chunk = format!("{key}:c{index}");
        validate_key(&chunk)?;
        Ok(chunk)
    }

    /// Remove chunks from `from` upward until one is missing, so shrinking a value
    /// never leaves a longer previous one half-present.
    fn delete_chunks_from(&self, key: &str, from: usize) -> Result<(), CredentialError> {
        for index in from.. {
            let chunk = self.chunk_key(key, index)?;
            match self.inner.get(&chunk)? {
                Some(_) => self.inner.delete(&chunk)?,
                None => break,
            }
        }
        Ok(())
    }
}

impl<S: CredentialStore> CredentialStore for ChunkedCredentialStore<S> {
    fn get(&self, key: &str) -> Result<Option<String>, CredentialError> {
        validate_key(key)?;
        let Some(primary) = self.inner.get(key)? else { return Ok(None) };
        let Some(count) = primary.strip_prefix(CHUNK_SENTINEL) else { return Ok(Some(primary)) };
        let count: usize = count
            .parse()
            .map_err(|_| CredentialError::Backend { key: key.to_owned(), message: "unreadable chunk manifest".into() })?;

        let mut value = String::new();
        for index in 0..count {
            // A missing piece means the value was torn by an interrupted write. It
            // is unrecoverable, and for every caller it means the same thing a
            // missing credential means — sign in again — so report it as absent
            // rather than as an error they cannot act on differently.
            let Some(part) = self.inner.get(&self.chunk_key(key, index)?)? else { return Ok(None) };
            value.push_str(&part);
        }
        Ok(Some(value))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), CredentialError> {
        validate_key(key)?;
        if utf16_len(value) <= self.max_utf16_units {
            self.inner.set(key, value)?;
            return self.delete_chunks_from(key, 0);
        }

        let parts = split_utf16(value, self.max_utf16_units);
        // Chunks first, manifest last: until the manifest lands the old value is
        // what `get` returns, so a failure part-way through never publishes a
        // half-written session.
        for (index, part) in parts.iter().enumerate() {
            self.inner.set(&self.chunk_key(key, index)?, part)?;
        }
        self.inner.set(key, &format!("{CHUNK_SENTINEL}{}", parts.len()))?;
        self.delete_chunks_from(key, parts.len())
    }

    fn delete(&self, key: &str) -> Result<(), CredentialError> {
        validate_key(key)?;
        self.inner.delete(key)?;
        self.delete_chunks_from(key, 0)
    }
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

    /// Stands in for Windows Credential Manager: refuses anything whose UTF-16
    /// encoding exceeds the blob cap, exactly as `keyring` reports it.
    #[derive(Default)]
    struct WindowsLikeStore {
        inner: InMemoryCredentialStore,
        max_utf16_units: usize,
    }

    impl WindowsLikeStore {
        fn new(max_utf16_units: usize) -> Self {
            Self { inner: InMemoryCredentialStore::new(), max_utf16_units }
        }
    }

    impl CredentialStore for WindowsLikeStore {
        fn get(&self, key: &str) -> Result<Option<String>, CredentialError> {
            self.inner.get(key)
        }
        fn set(&self, key: &str, value: &str) -> Result<(), CredentialError> {
            if utf16_len(value) > self.max_utf16_units {
                return Err(CredentialError::InvalidValue(format!(
                    "{key}: password encoded as UTF-16 exceeds {}",
                    self.max_utf16_units * 2
                )));
            }
            self.inner.set(key, value)
        }
        fn delete(&self, key: &str) -> Result<(), CredentialError> {
            self.inner.delete(key)
        }
    }

    /// Shaped like the real thing: a long access JWT, a refresh token, and a user
    /// object carrying the metadata the register screen sets.
    fn fake_session(bytes: usize) -> String {
        format!(
            r#"{{"access_token":"{}","refresh_token":"{}","user":{{"id":"00000000-0000-4000-8000-000000000000","user_metadata":{{"display_name":"Daniel Vaszary"}}}}}}"#,
            "e".repeat(bytes),
            "r".repeat(64)
        )
    }

    #[test]
    fn a_real_sized_session_is_rejected_by_windows_but_survives_chunking() {
        let session = fake_session(2600);
        // 1280 UTF-16 units is the real Windows cap (2560 bytes / 2).
        assert!(matches!(
            WindowsLikeStore::new(1280).set(KEY_SUPABASE_SESSION, &session),
            Err(CredentialError::InvalidValue(_))
        ));

        let store = ChunkedCredentialStore::new(WindowsLikeStore::new(1280));
        store.set(KEY_SUPABASE_SESSION, &session).unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap().as_deref(), Some(session.as_str()));
    }

    #[test]
    fn values_that_fit_are_stored_whole_and_read_back_by_an_unwrapped_store() {
        let store = ChunkedCredentialStore::with_limit(InMemoryCredentialStore::new(), 100);
        store.set(KEY_DEVICE_KEY, "short-value").unwrap();
        assert_eq!(store.get(KEY_DEVICE_KEY).unwrap().as_deref(), Some("short-value"));
        // no manifest, no chunks: one entry, the value itself
        assert_eq!(store.inner.len(), 1);
        assert_eq!(store.inner.get(KEY_DEVICE_KEY).unwrap().as_deref(), Some("short-value"));
    }

    #[test]
    fn a_value_written_by_an_older_build_still_reads() {
        let inner = InMemoryCredentialStore::new();
        inner.set(KEY_SUPABASE_SESSION, "written-before-chunking-existed").unwrap();
        let store = ChunkedCredentialStore::with_limit(inner, 8);
        assert_eq!(
            store.get(KEY_SUPABASE_SESSION).unwrap().as_deref(),
            Some("written-before-chunking-existed")
        );
    }

    #[test]
    fn shrinking_then_growing_leaves_no_stale_chunks() {
        let store = ChunkedCredentialStore::with_limit(InMemoryCredentialStore::new(), 10);
        store.set(KEY_SUPABASE_SESSION, &"a".repeat(95)).unwrap();
        store.set(KEY_SUPABASE_SESSION, &"b".repeat(25)).unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap().as_deref(), Some("b".repeat(25).as_str()));
        // manifest + ceil(25/10) chunks, and nothing left from the 95-char value
        assert_eq!(store.inner.len(), 4);

        store.set(KEY_SUPABASE_SESSION, "tiny").unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap().as_deref(), Some("tiny"));
        assert_eq!(store.inner.len(), 1);
    }

    #[test]
    fn delete_removes_every_chunk() {
        let store = ChunkedCredentialStore::with_limit(InMemoryCredentialStore::new(), 10);
        store.set(KEY_SUPABASE_SESSION, &"a".repeat(95)).unwrap();
        store.delete(KEY_SUPABASE_SESSION).unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap(), None);
        assert!(store.inner.is_empty());
    }

    #[test]
    fn a_torn_write_reads_as_absent_rather_than_as_a_corrupt_session() {
        let store = ChunkedCredentialStore::with_limit(InMemoryCredentialStore::new(), 10);
        store.set(KEY_SUPABASE_SESSION, &"a".repeat(45)).unwrap();
        store.inner.delete(&format!("{KEY_SUPABASE_SESSION}:c2")).unwrap();
        assert_eq!(store.get(KEY_SUPABASE_SESSION).unwrap(), None);
    }

    #[test]
    fn splitting_never_cuts_a_surrogate_pair_in_half() {
        // Each emoji is two UTF-16 units, so an odd limit forces the boundary to
        // land where a naive split would tear one.
        let value = "\u{1F5DD}".repeat(40);
        let store = ChunkedCredentialStore::with_limit(InMemoryCredentialStore::new(), 7);
        store.set(KEY_DEVICE_KEY, &value).unwrap();
        assert_eq!(store.get(KEY_DEVICE_KEY).unwrap().as_deref(), Some(value.as_str()));
        for part in split_utf16(&value, 7) {
            assert!(utf16_len(part) <= 7);
        }
    }

    #[test]
    fn errors_never_carry_values() {
        let err = CredentialError::Backend { key: "supabase.session".into(), message: "locked".into() };
        let text = err.to_string();
        assert!(text.contains("supabase.session"));
        assert!(!text.contains("fake-session-token"));
    }
}
