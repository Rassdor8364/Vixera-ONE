//! Platform-neutral Rust for Vixera One.
//!
//! This crate has no Tauri dependency. It holds the small set of platform
//! capabilities the app shell (`apps/desktop/src-tauri`) exposes as commands:
//!
//! * [`credentials`] — the [`CredentialStore`] abstraction (device secrets such
//!   as the Supabase session and the device key) with an in-memory store for
//!   tests/dev and an OS keychain store behind the `keyring` feature.
//! * [`device`] — a stable, random [`DeviceIdentity`] persisted as `device.json`.
//! * [`hash`] — streaming SHA-256 for files and bytes (document identity).
//! * [`praxion`] — a loopback TCP probe used only as a fast "is Praxion likely
//!   running" hint; the real contract negotiation happens over HTTP in TypeScript.
//!
//! Nothing here knows about the domain model or about users: the Vixera user id
//! is attached by the TypeScript spine store (`currentUser()`), never derived from
//! the machine.

pub mod credentials;
pub mod device;
pub mod hash;
pub mod praxion;

pub use credentials::{CredentialError, CredentialStore, InMemoryCredentialStore, CREDENTIAL_SERVICE};
#[cfg(all(feature = "keyring", any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub use credentials::KeyringCredentialStore;
pub use device::{DeviceError, DeviceIdentity, Platform, DEVICE_FILE_NAME};
pub use hash::{sha256_bytes, sha256_file, FileHash, HashError};
pub use praxion::{is_port_open, PRAXION_DEFAULT_HOST, PRAXION_DEFAULT_PORT};
