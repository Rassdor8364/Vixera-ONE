# Keep the Tauri plugin entry points: the Rust side instantiates SharePlugin by
# name through JNI and dispatches @Command methods reflectively.
-keep class ai.vixera.one.share.SharePlugin { *; }
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
}
-keep class ai.vixera.one.share.ShareInbox { *; }
-keep class ai.vixera.one.share.ShareInbox$* { *; }

# androidx.security-crypto (EncryptedSharedPreferences) pulls in Google Tink,
# which references compile-time-only annotations that are not on the runtime
# classpath. Without these, R8 fails the release build with "Missing class
# javax.annotation.Nullable ... and 86 other contexts".
-dontwarn javax.annotation.**
-dontwarn javax.annotation.concurrent.**
-dontwarn com.google.errorprone.annotations.**

# Tink resolves its key managers reflectively, so its classes must survive
# minification or secure_get / secure_set fail at runtime rather than at build.
-keep class com.google.crypto.tink.** { *; }
-keep class androidx.security.crypto.** { *; }

# Keeping all of Tink (above) also keeps its optional KeysDownloader, which
# fetches keysets over HTTP using the Google API client and Joda-Time. Vixera
# never calls it — EncryptedSharedPreferences generates its key in the Android
# Keystore — so those libraries are absent and R8 only needs to stop warning.
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**
