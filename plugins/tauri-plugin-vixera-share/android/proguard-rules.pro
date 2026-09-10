# Keep the Tauri plugin entry points: the Rust side instantiates SharePlugin by
# name through JNI and dispatches @Command methods reflectively.
-keep class ai.vixera.one.share.SharePlugin { *; }
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
}
-keep class ai.vixera.one.share.ShareInbox { *; }
-keep class ai.vixera.one.share.ShareInbox$* { *; }
