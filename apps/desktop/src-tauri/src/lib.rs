//! Vixera One application shell (Tauri 2, identifier `ai.vixera.one`).
//!
//! Rust here handles platform capabilities only; it knows nothing about the
//! domain model. The React Field talks to it through the commands in
//! [`commands`] and the standard plugins registered below:
//!
//! | Capability | Provider |
//! | --- | --- |
//! | Loopback HTTP to Praxion, HTTPS to Supabase | `tauri-plugin-http` (bypasses WebView CORS) |
//! | Open a document with the OS viewer (Praxion-absent fallback) | `tauri-plugin-opener` |
//! | File picker | `tauri-plugin-dialog` |
//! | Read picked/dropped/shared file bytes for upload | `tauri-plugin-fs` |
//! | Local notifications | `tauri-plugin-notification` |
//! | OS version/arch | `tauri-plugin-os` |
//! | Android share sheet + Keystore secure storage | `tauri-plugin-vixera-share` (mobile only) |
//! | Device secrets (`supabase.session`, `device.key`) | [`AppState::credentials`] |
//! | Device identity (`device.json` in the app data dir) | [`AppState::device`] |
//!
//! Credential store selection: desktop builds use `KeyringCredentialStore`
//! (service `ai.vixera.one`); Android uses the Kotlin plugin's
//! `EncryptedSharedPreferences` through [`android::PluginCredentialStore`]. There
//! is no file-based fallback: if secure storage is unavailable the commands fail
//! and the Field shows the sign-in state.
//!
//! Window drag-and-drop stays on Tauri's built-in `tauri://drag-drop` event
//! (`dragDropEnabled: true` in `tauri.conf.json`); there is no overlay, tray or
//! shell extension in Phase 1.

mod commands;
mod error;

use tauri::Manager;
use vixera_platform::{CredentialStore, DeviceIdentity, Platform};

pub use error::{Error, Result};

/// State managed by Tauri and injected into commands.
pub struct AppState {
    pub credentials: Box<dyn CredentialStore + Send + Sync>,
    pub device: DeviceIdentity,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init());

    // Share-sheet intake and Keystore-backed secure storage exist only on mobile.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_vixera_share::init());

    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let device = DeviceIdentity::load_or_create(&data_dir, Platform::current(), &default_device_name())?;
            let credentials = build_credential_store(app.handle());
            app.manage(AppState { credentials, device });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::credential_get,
            commands::credential_set,
            commands::credential_delete,
            commands::device_identity,
            commands::hash_file,
            commands::platform_info,
            commands::probe_praxion,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vixera One");
}

/// A label only; never an identity (see `vixera_platform::device`).
fn default_device_name() -> String {
    format!("Vixera One on {}", Platform::current())
}

#[cfg(desktop)]
fn build_credential_store<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Box<dyn CredentialStore + Send + Sync> {
    // Dev builds use a separate service name so `pnpm dev:desktop` never reads or
    // overwrites the installed app's session.
    let service = if cfg!(debug_assertions) { "ai.vixera.one.dev" } else { vixera_platform::CREDENTIAL_SERVICE };
    Box::new(vixera_platform::KeyringCredentialStore::with_service(service))
}

#[cfg(mobile)]
fn build_credential_store<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Box<dyn CredentialStore + Send + Sync> {
    Box::new(android::PluginCredentialStore::new(app.clone()))
}

#[cfg(mobile)]
pub mod android {
    //! `CredentialStore` backed by the share plugin's `secure_*` commands
    //! (`EncryptedSharedPreferences` + Android Keystore master key).

    use tauri::{AppHandle, Runtime};
    use tauri_plugin_vixera_share::VixeraShareExt;
    use vixera_platform::{CredentialError, CredentialStore};

    pub struct PluginCredentialStore<R: Runtime> {
        app: AppHandle<R>,
    }

    impl<R: Runtime> PluginCredentialStore<R> {
        pub fn new(app: AppHandle<R>) -> Self {
            Self { app }
        }
    }

    fn backend(key: &str, error: tauri_plugin_vixera_share::Error) -> CredentialError {
        CredentialError::Backend { key: key.to_owned(), message: error.to_string() }
    }

    impl<R: Runtime> CredentialStore for PluginCredentialStore<R> {
        fn get(&self, key: &str) -> Result<Option<String>, CredentialError> {
            vixera_platform::credentials::validate_key(key)?;
            self.app.vixera_share().secure_get(key).map_err(|e| backend(key, e))
        }

        fn set(&self, key: &str, value: &str) -> Result<(), CredentialError> {
            vixera_platform::credentials::validate_key(key)?;
            self.app.vixera_share().secure_set(key, value).map_err(|e| backend(key, e))
        }

        fn delete(&self, key: &str) -> Result<(), CredentialError> {
            vixera_platform::credentials::validate_key(key)?;
            self.app.vixera_share().secure_delete(key).map_err(|e| backend(key, e))
        }
    }
}
