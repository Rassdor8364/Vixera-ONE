//! Device identity: a random, stable id for this installation.
//!
//! `device.json` lives in a caller-provided directory (the Tauri app data dir).
//! The id is a fresh UUID v4 created on first run and never derived from the
//! hostname, the OS account, MAC addresses or the user: the same human on two
//! machines has two device ids, and a machine rename changes nothing.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const DEVICE_FILE_NAME: &str = "device.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Android,
    Macos,
    Ios,
    Ipados,
    Linux,
    Unknown,
}

impl Platform {
    /// The platform this binary was compiled for.
    ///
    /// iPadOS cannot be distinguished from iOS at compile time; the app shell
    /// may refine it at runtime.
    pub const fn current() -> Platform {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "android") {
            Platform::Android
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else if cfg!(target_os = "ios") {
            Platform::Ios
        } else if cfg!(target_os = "linux") {
            Platform::Linux
        } else {
            Platform::Unknown
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Platform::Windows => "windows",
            Platform::Android => "android",
            Platform::Macos => "macos",
            Platform::Ios => "ios",
            Platform::Ipados => "ipados",
            Platform::Linux => "linux",
            Platform::Unknown => "unknown",
        }
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub device_id: Uuid,
    pub platform: Platform,
    /// Human-readable label chosen by the caller (e.g. "Windows desktop"). Not an identity.
    pub name: String,
    /// RFC 3339 UTC timestamp of first creation.
    pub created_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("device identity io error at {path}: {source}")]
    Io { path: PathBuf, #[source] source: std::io::Error },
    #[error("device identity file at {path} is not valid: {source}")]
    Corrupt { path: PathBuf, #[source] source: serde_json::Error },
}

impl DeviceIdentity {
    /// Load `dir/device.json` or create it with a fresh UUID v4. Idempotent: a
    /// second call returns the same identity. `platform` and `name` are recorded
    /// on creation only; an existing file wins.
    pub fn load_or_create(dir: &Path, platform: Platform, name: &str) -> Result<DeviceIdentity, DeviceError> {
        let path = dir.join(DEVICE_FILE_NAME);
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| DeviceError::Corrupt { path, source }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let identity = DeviceIdentity {
                    device_id: Uuid::new_v4(),
                    platform,
                    name: name.to_owned(),
                    created_at: now_rfc3339(),
                };
                identity.save(&path)?;
                Ok(identity)
            }
            Err(source) => Err(DeviceError::Io { path, source }),
        }
    }

    fn save(&self, path: &Path) -> Result<(), DeviceError> {
        let io = |source| DeviceError::Io { path: path.to_path_buf(), source };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(io)?;
        }
        let json = serde_json::to_vec_pretty(self).expect("DeviceIdentity serializes");
        // Write-then-rename so a crash never leaves a half-written identity.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(io)?;
        std::fs::rename(&tmp, path).map_err(io)
    }
}

/// UTC "YYYY-MM-DDTHH:MM:SSZ" without pulling in a date crate.
fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    rfc3339_from_unix(secs)
}

fn rfc3339_from_unix(secs: u64) -> String {
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_once_and_reloads_identically() {
        let dir = tempfile::tempdir().unwrap();
        let first = DeviceIdentity::load_or_create(dir.path(), Platform::Linux, "Test box").unwrap();
        let second = DeviceIdentity::load_or_create(dir.path(), Platform::Windows, "Renamed").unwrap();
        assert_eq!(first, second, "second call must not regenerate or overwrite");
        assert_eq!(second.name, "Test box");
        assert_eq!(second.platform, Platform::Linux);
        assert!(dir.path().join(DEVICE_FILE_NAME).exists());
        assert!(!dir.path().join("device.json.tmp").exists());
    }

    #[test]
    fn id_is_a_random_v4_uuid_not_derived_from_the_machine() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let ia = DeviceIdentity::load_or_create(a.path(), Platform::current(), "same name").unwrap();
        let ib = DeviceIdentity::load_or_create(b.path(), Platform::current(), "same name").unwrap();
        assert_ne!(ia.device_id, ib.device_id, "same host + same name must still yield different ids");
        assert_eq!(ia.device_id.get_version(), Some(uuid::Version::Random));
    }

    #[test]
    fn creates_missing_directories_and_serializes_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested").join("deeper");
        let id = DeviceIdentity::load_or_create(&nested, Platform::Android, "Phone").unwrap();
        let raw = std::fs::read_to_string(nested.join(DEVICE_FILE_NAME)).unwrap();
        assert!(raw.contains("\"deviceId\""));
        assert!(raw.contains("\"platform\": \"android\""));
        assert!(raw.contains(&id.device_id.to_string()));
        assert!(id.created_at.ends_with('Z') && id.created_at.len() == 20, "{}", id.created_at);
    }

    #[test]
    fn corrupt_file_is_reported_not_silently_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(DEVICE_FILE_NAME), b"{ not json").unwrap();
        let err = DeviceIdentity::load_or_create(dir.path(), Platform::Linux, "x").unwrap_err();
        assert!(matches!(err, DeviceError::Corrupt { .. }));
    }

    #[test]
    fn platform_current_matches_cfg() {
        let p = Platform::current();
        if cfg!(target_os = "linux") {
            assert_eq!(p, Platform::Linux);
        } else if cfg!(target_os = "windows") {
            assert_eq!(p, Platform::Windows);
        } else if cfg!(target_os = "macos") {
            assert_eq!(p, Platform::Macos);
        }
        assert_eq!(serde_json::to_string(&p).unwrap(), format!("\"{}\"", p.as_str()));
    }

    #[test]
    fn rfc3339_known_vectors() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(rfc3339_from_unix(951_782_400), "2000-02-29T00:00:00Z");
        assert!(now_rfc3339().starts_with("20"));
    }
}
