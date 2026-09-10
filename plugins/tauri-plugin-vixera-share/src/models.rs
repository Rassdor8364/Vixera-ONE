//! Wire shapes between Kotlin, Rust and TypeScript. Field names are camelCase on
//! every side. These are platform objects, not domain objects: the TypeScript
//! ingestion pipeline converts a `ShareItem` into an `IngestItem`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareKind {
    File,
    Image,
    Url,
    Text,
}

/// One object the user explicitly shared into Vixera.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareItem {
    /// Stable id assigned by the plugin (UUID); also the cache file stem for file/image items.
    pub id: String,
    pub kind: ShareKind,
    /// Absolute path of the cached copy (file/image); `None` for url/text.
    #[serde(default)]
    pub path: Option<String>,
    /// URL or text payload (url/text); `None` for file/image.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    /// Display name resolved from the content provider, when known.
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    /// `EXTRA_SUBJECT` of the sharing intent, when present.
    #[serde(default)]
    pub title: Option<String>,
    /// RFC 3339 timestamp of when the share was received.
    pub received_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingShares {
    #[serde(default)]
    pub items: Vec<ShareItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureKeyArgs {
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureSetArgs {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecureValue {
    #[serde(default)]
    pub value: Option<String>,
}
