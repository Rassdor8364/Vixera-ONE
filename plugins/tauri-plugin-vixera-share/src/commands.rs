use tauri::{command, AppHandle, Runtime};

use crate::{PendingShares, Result, VixeraShareExt};

#[command]
pub(crate) async fn get_pending_shares<R: Runtime>(app: AppHandle<R>) -> Result<PendingShares> {
    app.vixera_share().get_pending_shares()
}

#[command]
pub(crate) async fn clear_pending_shares<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.vixera_share().clear_pending_shares()
}

#[command]
pub(crate) async fn secure_get<R: Runtime>(app: AppHandle<R>, key: String) -> Result<Option<String>> {
    app.vixera_share().secure_get(&key)
}

#[command]
pub(crate) async fn secure_set<R: Runtime>(app: AppHandle<R>, key: String, value: String) -> Result<()> {
    app.vixera_share().secure_set(&key, &value)
}

#[command]
pub(crate) async fn secure_delete<R: Runtime>(app: AppHandle<R>, key: String) -> Result<()> {
    app.vixera_share().secure_delete(&key)
}
