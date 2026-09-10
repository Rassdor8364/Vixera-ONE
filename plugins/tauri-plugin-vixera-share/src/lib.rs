//! tauri-plugin-vixera-share — the Android share/capture bridge for Vixera One.
//!
//! Identifier `ai.vixera.one.share`, plugin name `vixera-share`.
//!
//! What it does (Phase 1):
//! * Receives `ACTION_SEND` / `ACTION_SEND_MULTIPLE` intents (PDF, images, plain
//!   text/URLs) in Kotlin, copies content URIs into the app cache
//!   (`cacheDir/vixera-shares/<uuid>.<ext>`), queues normalized [`ShareItem`]s,
//!   emits the `share` event, and answers `get_pending_shares` /
//!   `clear_pending_shares`. The TypeScript side turns items into `IngestItem`s;
//!   nothing here knows about the domain model or the user.
//! * Exposes `secure_get` / `secure_set` / `secure_delete`, backed by
//!   `EncryptedSharedPreferences` with an Android Keystore master key. The app
//!   shell uses this as its `CredentialStore` on Android.
//!
//! On desktop the plugin compiles but is inert: no pending shares, and the
//! `secure_*` commands fail with "unsupported on desktop" (desktop uses the OS
//! keychain through `vixera-platform`).
//!
//! Not in scope, by design: no accessibility service, no overlays, no
//! background screen reading. The user explicitly hands Vixera an object.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
#[cfg(desktop)]
mod desktop;
mod error;
#[cfg(mobile)]
mod mobile;
mod models;

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
pub use desktop::VixeraShare;
#[cfg(mobile)]
pub use mobile::VixeraShare;

/// Plugin name as seen from JavaScript: `plugin:vixera-share|<command>`.
pub const PLUGIN_NAME: &str = "vixera-share";

/// Extension trait giving any [`tauri::Manager`] access to the share plugin.
pub trait VixeraShareExt<R: Runtime> {
    fn vixera_share(&self) -> &VixeraShare<R>;
}

impl<R: Runtime, T: Manager<R>> VixeraShareExt<R> for T {
    fn vixera_share(&self) -> &VixeraShare<R> {
        self.state::<VixeraShare<R>>().inner()
    }
}

/// Initializes the plugin. Register it with `tauri::Builder::plugin(...)`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(PLUGIN_NAME)
        .invoke_handler(tauri::generate_handler![
            commands::get_pending_shares,
            commands::clear_pending_shares,
            commands::secure_get,
            commands::secure_set,
            commands::secure_delete,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let share = mobile::init(app, api)?;
            #[cfg(desktop)]
            let share = desktop::init(app, api)?;
            app.manage(share);
            Ok(())
        })
        .build()
}
