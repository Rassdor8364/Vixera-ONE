//! Tauri commands exposed to the Field. Thin wrappers over `vixera-platform`;
//! the TypeScript bindings live in `apps/desktop/src/platform/`.

use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use vixera_platform::{DeviceIdentity, FileHash, Platform, PRAXION_DEFAULT_HOST, PRAXION_DEFAULT_PORT};

use crate::{AppState, Error, Result};

/// Loopback probes are hints; keep them short so the UI never stalls on them.
const PROBE_TIMEOUT: Duration = Duration::from_millis(150);

#[tauri::command]
pub fn credential_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    Ok(state.credentials.get(&key)?)
}

#[tauri::command]
pub fn credential_set(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    Ok(state.credentials.set(&key, &value)?)
}

#[tauri::command]
pub fn credential_delete(state: State<'_, AppState>, key: String) -> Result<()> {
    Ok(state.credentials.delete(&key)?)
}

#[tauri::command]
pub fn device_identity(state: State<'_, AppState>) -> DeviceIdentity {
    state.device.clone()
}

/// Streams the file through SHA-256 off the main thread. `path` must be absolute
/// (picked, dropped or shared files always are).
#[tauri::command]
pub async fn hash_file(path: String) -> Result<FileHash> {
    let path = PathBuf::from(&path);
    if !path.is_absolute() {
        return Err(Error::RelativePath(path.display().to_string()));
    }
    tauri::async_runtime::spawn_blocking(move || vixera_platform::sha256_file(&path))
        .await
        .map_err(|e| Error::Join(e.to_string()))?
        .map_err(Into::into)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub platform: Platform,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub arch: String,
    /// Something is listening on the Praxion loopback port. A hint only; the
    /// TypeScript client negotiates the versioned contract over HTTP.
    pub praxion_port_open: bool,
}

#[tauri::command]
pub async fn platform_info() -> Result<PlatformInfo> {
    let praxion_port_open = probe(PRAXION_DEFAULT_PORT).await?;
    Ok(PlatformInfo {
        platform: Platform::current(),
        os_version: Some(tauri_plugin_os::version().to_string()),
        arch: std::env::consts::ARCH.to_owned(),
        praxion_port_open,
    })
}

/// True when a TCP connection to `127.0.0.1:<port>` (default 47815) succeeds.
#[tauri::command]
pub async fn probe_praxion(port: Option<u16>) -> Result<bool> {
    probe(port.unwrap_or(PRAXION_DEFAULT_PORT)).await
}

async fn probe(port: u16) -> Result<bool> {
    tauri::async_runtime::spawn_blocking(move || vixera_platform::is_port_open(PRAXION_DEFAULT_HOST, port, PROBE_TIMEOUT))
        .await
        .map_err(|e| Error::Join(e.to_string()))
}
