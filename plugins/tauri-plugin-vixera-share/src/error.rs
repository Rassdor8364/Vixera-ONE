use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The command has no implementation on this platform (desktop `secure_*`).
    #[error("{0} is unsupported on desktop")]
    UnsupportedOnDesktop(&'static str),
    /// The plugin has no native implementation for this mobile platform (iOS is not a Phase 1 target).
    #[error("vixera-share is not implemented on {0}")]
    UnsupportedPlatform(&'static str),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

/// Commands surface the error as a plain string; the message never contains a secret value.
impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
