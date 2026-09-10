//! One error type for every command, serialized to the webview as a plain string.
//! Messages may name a key or a path; they never contain a credential value.

use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Credential(#[from] vixera_platform::CredentialError),
    #[error(transparent)]
    Device(#[from] vixera_platform::DeviceError),
    #[error(transparent)]
    Hash(#[from] vixera_platform::HashError),
    #[error("path must be absolute: {0}")]
    RelativePath(String),
    #[error("background task failed: {0}")]
    Join(String),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
