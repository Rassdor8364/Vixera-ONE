# Android build (Vixera One companion)

Same Tauri project as Windows (`apps/desktop`), same React code, same Rust
shell; Kotlin only where Android forces it: the share-sheet intake and the
Keystore-backed secure store, both inside `plugins/tauri-plugin-vixera-share`.

## What the companion does in Phase 1

* **Share to Vixera** — the app appears in the Android share sheet for PDFs,
  images and text/URLs. Shared objects are copied into the app cache, queued,
  and handed to the normalized ingestion pipeline (`IngestItem` → `document` +
  `context_event`). Explicit capture (file picker, camera via the picker) uses
  the same path.
* **Receive context** — the companion signs in to the same Supabase spine and
  reads threads / people / documents / handoffs over HTTPS + Realtime.
* **Secure storage** — the Supabase session and device key live in
  `EncryptedSharedPreferences` under an Android Keystore master key.

What it does **not** do: no accessibility service, no screen reading, no
overlays over other apps, no background capture, no OCR. The user explicitly
hands Vixera an object; nothing else is observed.

## Prerequisites

| Tool | Version / value |
| --- | --- |
| Android Studio (or command-line tools) | Hedgehog or newer |
| Android SDK Platform | API 34 (`compileSdk = 34`; `minSdk = 26` from `tauri.conf.json` and the plugin) |
| Build tools | 34.0.0 |
| NDK | 26.1.10909125 (r26; anything >= r25 works) |
| JDK | 17 (bundled with Android Studio) |
| Rust targets | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| Node 22 + pnpm 10 | as for Windows |

Environment variables (add to your shell profile):

```bash
export ANDROID_HOME="$HOME/Android/Sdk"            # Windows: %LOCALAPPDATA%\Android\Sdk
export NDK_HOME="$ANDROID_HOME/ndk/26.1.10909125"
export JAVA_HOME="/path/to/jdk-17"                  # Android Studio: <studio>/jbr
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

## Commands

```bash
pnpm install
pnpm tauri android init                 # once: generates apps/desktop/src-tauri/gen/android (Gradle project)
# → edit the generated AndroidManifest.xml as described below
pnpm tauri android dev                  # debug build on the connected device / emulator (Vite on :1420 via TAURI_DEV_HOST)
pnpm tauri android build --apk          # release APK(s) in gen/android/app/build/outputs/apk/
pnpm tauri android build --aab          # Play bundle (not needed in Phase 1)
```

`pnpm tauri android dev --open` opens the project in Android Studio for logcat
and the profiler. For a physical device on Wi-Fi set `TAURI_DEV_HOST=<your LAN ip>`
so the WebView can reach Vite. Use `pnpm tauri android build --apk --target aarch64`
to build a single ABI quickly.

Cargo cross-compiles `apps/desktop/src-tauri` and the plugin for Android; the
plugin's `build.rs` copies Tauri's Android runtime into
`plugins/tauri-plugin-vixera-share/android/.tauri/` (git-ignored) and the Tauri
CLI wires the plugin's Gradle module into the generated app.

## Manifest changes after `tauri android init`

The generated project is not committed in full (see `.gitignore`); after
`pnpm tauri android init` edit
`apps/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml` and
change the `MainActivity` element to:

```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:launchMode="singleTask"
    android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode"
    android:theme="@style/Theme.vixera_one"
    android:windowSoftInputMode="adjustResize">

    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>

    <!-- Share to Vixera: single object -->
    <intent-filter android:label="Vixera One">
        <action android:name="android.intent.action.SEND" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="application/pdf" />
        <data android:mimeType="image/*" />
        <data android:mimeType="text/plain" />
    </intent-filter>

    <!-- Share to Vixera: several objects -->
    <intent-filter android:label="Vixera One">
        <action android:name="android.intent.action.SEND_MULTIPLE" />
        <category android:name="android.intent.category.DEFAULT" />
        <data android:mimeType="application/pdf" />
        <data android:mimeType="image/*" />
    </intent-filter>
</activity>
```

Keep whatever `android:theme` / `android:name` the generator produced; the
important additions are `android:launchMode="singleTask"` (so a share while the
app is running arrives in `SharePlugin.onNewIntent` instead of spawning a second
activity) and the two share intent-filters. No permissions are needed: the
sending app grants a temporary read permission on the content URI, and the
plugin copies the bytes immediately.

Re-apply this edit whenever you delete and regenerate `gen/android`.

## How a share flows

1. Android starts (or resumes) `MainActivity` with `ACTION_SEND` /
   `ACTION_SEND_MULTIPLE`.
2. `ai.vixera.one.share.SharePlugin` (Kotlin) reads `EXTRA_STREAM` content URIs,
   resolves display name / MIME / size through the `ContentResolver`, copies each
   into `<cacheDir>/vixera-shares/<uuid>.<ext>`; `EXTRA_TEXT` becomes a `url`
   item when it parses as http(s), else `text`; `EXTRA_SUBJECT` becomes `title`.
3. Items are queued in `ShareInbox` and the plugin emits the `share` event.
4. The Field calls `getPendingShares()` on start-up and subscribes with
   `onShare()` (`apps/desktop/src/platform/share.ts`;
   `field/companion/useShareIntake.ts`), reads file bytes with
   `readFileBytes(item.path)` (fs plugin; the cache dir is inside the
   `$APPCACHE/**` scope of `capabilities/mobile.json`), hashes with `hashFile`,
   uploads to Storage and dispatches `ingest.submit` per item
   (`drainShares` in `field/companion/share-intake.ts`). It then re-reads the
   queue for shares that arrived meanwhile and calls `clearPendingShares()`
   (which deletes the cached copies) only once every item was dispatched; a
   batch with failures leaves the queue untouched so it is retried on the next
   launch.

The cache lives under the app's private cache directory
(`/data/data/ai.vixera.one/cache/vixera-shares/`); Android may purge it under
storage pressure, which is why items are ingested promptly and cleared
afterwards. Nothing is written to shared storage.

## Secure storage

`secure_get / secure_set / secure_delete` (plugin commands) →
`EncryptedSharedPreferences("ai.vixera.one.secure")`, master key
`MasterKey.KeyScheme.AES256_GCM` in the Android Keystore
(`androidx.security:security-crypto:1.1.0-alpha06`). The Rust shell wraps
them as its `CredentialStore` on Android
(`apps/desktop/src-tauri/src/lib.rs`, `android::PluginCredentialStore`), so
the Field uses the same `credential_*` commands on every platform.
Uninstalling the app destroys the key and the preferences.

## Verified build

`pnpm tauri android build --apk --target aarch64 --debug` has been run against
this tree. The resulting
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`
contains `ai.vixera.one.share.SharePlugin` and `ShareInbox`, the
`EncryptedSharedPreferences` secure store, `lib/arm64-v8a/libvixera_one_lib.so`,
and the `ACTION_SEND` / `ACTION_SEND_MULTIPLE` filters with
`launchMode="singleTask"`. Installing it on a device and sharing a PDF into it
is the next check; that has not been done.

If Gradle fails with `Received status code 429 from server: Too Many Requests`
from `repo.maven.apache.org`, the network (not the project) is rate-limited.
Point Maven Central at a mirror from `~/.gradle/init.gradle`, which leaves the
repository untouched:

```groovy
def MIRROR = "https://maven-central.storage-download.googleapis.com/maven2"
static void remap(org.gradle.api.artifacts.dsl.RepositoryHandler repos, String mirror) {
    repos.withType(org.gradle.api.artifacts.repositories.MavenArtifactRepository).configureEach { repo ->
        def url = repo.url.toString()
        if (url.contains("repo.maven.apache.org") || url.contains("repo1.maven.org")) repo.url = mirror
    }
}
settingsEvaluated { s -> remap(s.pluginManagement.repositories, MIRROR); remap(s.dependencyResolutionManagement.repositories, MIRROR) }
allprojects { p -> remap(p.buildscript.repositories, MIRROR); remap(p.repositories, MIRROR) }
```

## Release APK

`scripts/build-installers.sh android` produces a signed arm64 APK
(~11 MB). Details, including the keystore that must be backed up offline, are in
[`installers.md`](./installers.md).

Release builds minify with R8, which debug builds skip. That is why
`plugins/tauri-plugin-vixera-share/android/proguard-rules.pro` carries
`consumerProguardFiles` rules for Google Tink: `androidx.security-crypto` pulls
it in, it references classes absent from the runtime classpath, and it resolves
key managers reflectively. Without those rules the release build fails at
`minifyUniversalReleaseWithR8`; with the keeps missing it would instead fail at
runtime inside `secure_get` / `secure_set`.

## Signing

Debug builds use the default debug keystore. For release APKs create a keystore
once and keep it out of git (`*.keystore`, `*.jks` and
`gen/android/key.properties` are ignored):

```bash
keytool -genkey -v -keystore ~/vixera-one-release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias vixera-one
```

`apps/desktop/src-tauri/gen/android/key.properties`:

```
storeFile=/absolute/path/to/vixera-one-release.jks
storePassword=<from your password manager>
keyAlias=vixera-one
keyPassword=<from your password manager>
```

and in `gen/android/app/build.gradle.kts` load it into a `signingConfigs.release`
block as documented by Tauri ("Android code signing"). Never commit the keystore
or `key.properties`; losing the keystore means a new package identity for users.

## Troubleshooting

* **`NDK_HOME` not set / `libclang` errors** — point `NDK_HOME` to the exact NDK
  folder; restart the shell.
* **"vixera-share:default" permission not found** — the plugin's
  `permissions/` directory is generated by its `build.rs`; run
  `cargo check -p tauri-plugin-vixera-share` once or clean `target/`.
* **App opens but shares do nothing** — the intent-filters / `singleTask` edit
  above is missing from the generated manifest.
* **Vite unreachable on device** — set `TAURI_DEV_HOST` and allow port 1420
  through the desktop firewall; the emulator can use `10.0.2.2` (already in the
  mobile capability's HTTP scope).
