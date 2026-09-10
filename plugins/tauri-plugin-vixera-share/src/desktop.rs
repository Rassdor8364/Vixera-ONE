//! Desktop implementation: inert. Windows has no share sheet in Phase 1 (file
//! drop goes through Tauri's built-in drag-drop event) and desktop secrets live
//! in the OS keychain via `vixera-platform`, not here.

use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::{Error, PendingShares, Result};

pub fn init<R: Runtime, C: DeserializeOwned>(app: &AppHandle<R>, _api: PluginApi<R, C>) -> Result<VixeraShare<R>> {
    Ok(VixeraShare(app.clone()))
}

pub struct VixeraShare<R: Runtime>(AppHandle<R>);

impl<R: Runtime> VixeraShare<R> {
    pub fn get_pending_shares(&self) -> Result<PendingShares> {
        Ok(PendingShares::default())
    }

    pub fn clear_pending_shares(&self) -> Result<()> {
        Ok(())
    }

    pub fn secure_get(&self, _key: &str) -> Result<Option<String>> {
        Err(Error::UnsupportedOnDesktop("secure_get"))
    }

    pub fn secure_set(&self, _key: &str, _value: &str) -> Result<()> {
        Err(Error::UnsupportedOnDesktop("secure_set"))
    }

    pub fn secure_delete(&self, _key: &str) -> Result<()> {
        Err(Error::UnsupportedOnDesktop("secure_delete"))
    }
}
