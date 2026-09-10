//! Mobile implementation: forwards to the Kotlin `SharePlugin`
//! (`ai.vixera.one.share.SharePlugin`). iOS is not a Phase 1 target; the plugin
//! registers nothing there and every call fails with a plugin-invoke error.

use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::{PendingShares, Result, SecureKeyArgs, SecureSetArgs, SecureValue};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "ai.vixera.one.share";

pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, api: PluginApi<R, C>) -> Result<VixeraShare<R>> {
    #[cfg(target_os = "android")]
    {
        let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SharePlugin")?;
        Ok(VixeraShare(handle))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = api;
        Err(crate::Error::UnsupportedPlatform("iOS"))
    }
}

pub struct VixeraShare<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> VixeraShare<R> {
    pub fn get_pending_shares(&self) -> Result<PendingShares> {
        self.0.run_mobile_plugin("getPendingShares", ()).map_err(Into::into)
    }

    pub fn clear_pending_shares(&self) -> Result<()> {
        self.0.run_mobile_plugin::<()>("clearPendingShares", ()).map(|_| ()).map_err(Into::into)
    }

    pub fn secure_get(&self, key: &str) -> Result<Option<String>> {
        self.0
            .run_mobile_plugin::<SecureValue>("secureGet", SecureKeyArgs { key: key.to_owned() })
            .map(|v| v.value)
            .map_err(Into::into)
    }

    pub fn secure_set(&self, key: &str, value: &str) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("secureSet", SecureSetArgs { key: key.to_owned(), value: value.to_owned() })
            .map(|_| ())
            .map_err(Into::into)
    }

    pub fn secure_delete(&self, key: &str) -> Result<()> {
        self.0
            .run_mobile_plugin::<()>("secureDelete", SecureKeyArgs { key: key.to_owned() })
            .map(|_| ())
            .map_err(Into::into)
    }
}
