// Commands exposed to the webview as `plugin:vixera-share|<command>`.
// `register_listener` / `remove_listener` are the base-class listener commands the
// Kotlin `Plugin` implements; listing them here generates their permissions so
// `addPluginListener("vixera-share", "share", ...)` is allowed by the capability.
const COMMANDS: &[&str] = &[
    "get_pending_shares",
    "clear_pending_shares",
    "secure_get",
    "secure_set",
    "secure_delete",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
