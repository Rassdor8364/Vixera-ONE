# Installers

Two files, one per platform, both built by `scripts/build-installers.sh`.

```bash
scripts/build-installers.sh            # both
scripts/build-installers.sh windows    # just the .exe
scripts/build-installers.sh android    # just the .apk
```

Output lands in `dist/installers/` (git-ignored — installers are build output,
not source).

## What each one is

| | Windows | Android |
| --- | --- | --- |
| File | `VixeraOne-<version>-windows-x64-setup.exe` | `VixeraOne-<version>-android-arm64.apk` |
| Size | ~2.5 MB | ~11.4 MB |
| Format | NSIS installer | signed APK, v2 signature scheme |
| Installs | per-user, no administrator prompt | sideload |
| Needs | Windows 10/11 x64 | Android 8.0 (API 26) or newer, arm64 |

### Windows

The installer carries `vixera-one.exe` (~6.9 MB, the app with its frontend
compiled in), an uninstaller, and Tauri's NSIS helper. WebView2 is downloaded by
the installer only if Windows does not already have it, which is rare on Windows
11. Everything installs under the user's own profile, so no elevation prompt.

It is cross-compiled from Linux with `cargo-xwin` (which fetches the MSVC CRT and
Windows SDK headers itself) and packaged with `makensis`. On a Windows machine the
same script works without the cross-compilation flags.

**Signed as Vixera AI, self-signed.** `scripts/windows-sign.sh` Authenticode-signs
the app binary, every NSIS plugin and the installer itself, with a DigiCert
timestamp so the signature outlives the certificate. File properties and the
signature dialog read `CN=Vixera AI, O=Vixera AI`.

What that does and does not buy:

* It does **not** silence SmartScreen. Windows trusts a certificate chain, not a
  name, and this certificate is its own issuer. First run still shows "Windows
  protected your PC" → *More info* → *Run anyway*.
* On machines you control, importing `.signing/vixera-ai-codesign.crt` into
  Trusted Root and Trusted Publishers makes the signature trusted — the usual
  route for internal distribution, by Group Policy in a domain.
* For a signature the public trusts out of the box, buy an OV or EV
  code-signing certificate and point `SIGN_PFX` at it. Nothing else changes; an
  EV certificate also builds SmartScreen reputation immediately.

Inspect a built installer:

```bash
osslsigncode verify dist/installers/VixeraOne-*-windows-x64-setup.exe
```

### Android

Built for `arm64-v8a` only, which covers every phone from roughly 2016 onward.
The APK contains the Rust core (8.2 MB), the Kotlin share plugin
(`SharePlugin`, `ShareInbox`), Keystore-backed `EncryptedSharedPreferences`, and
the `ACTION_SEND` / `ACTION_SEND_MULTIPLE` filters that put Vixera in the share
sheet for PDFs, images and text.

Release builds run R8. That is the reason the plugin ships its own
`consumerProguardFiles`: `androidx.security-crypto` pulls in Google Tink, which
references classes that are not on the runtime classpath, and Tink resolves its
key managers reflectively. Debug builds do not minify, so only a release build
surfaces this.

Sideloading: copy the APK to the phone and open it, or `adb install -r
VixeraOne-<version>-android-arm64.apk`. Android will ask permission to install
from this source the first time.

## Signing key

The release keystore lives at
`apps/desktop/src-tauri/gen/android/vixera-one-release.keystore`, with its
password in `key.properties` beside it. **Both are git-ignored, and both need an
offline backup.** Android identifies an app by its signing key: lose it and no
future build can ever install as an update over an installed copy — the only way
back is a new package name and a fresh install.

| | |
| --- | --- |
| Subject | `CN=Vixera AI, O=Vixera AI, OU=Vixera One` |
| Alias | `vixera-ai` |
| Key | RSA 4096, valid 30 years |
| SHA-256 | `c3d0a85006a7b8c6f50980880d3ada4a3d3e1063298d0451a7ca90539af1c634` |

The Windows certificate is separate, in `.signing/` — also git-ignored, also
worth backing up, though losing it only means re-issuing one rather than
orphaning an installed app.

Confirm what a built APK was signed with:

```bash
$ANDROID_HOME/build-tools/*/apksigner verify --print-certs <apk>
```

## Configuration baked in at build time

Both installers embed `apps/desktop/.env.production` (git-ignored; copy
`.env.production.example`):

| Variable | Why it is safe to embed |
| --- | --- |
| `VITE_SUPABASE_URL` | public project URL |
| `VITE_SUPABASE_ANON_KEY` | public client key; it grants nothing on its own, RLS is what protects data, and every table has it |
| `VITE_PRAXION_BASE_URL` | loopback address of the local Praxion, `http://127.0.0.1:47815` |

The service role key must never appear here. It bypasses RLS and belongs only in
Edge Function secrets.

Verify a build picked up the right project before shipping it:

```bash
grep -l "<your project ref>.supabase.co" apps/desktop/dist/assets/index-*.js
```

The development fixture world is code-split into its own chunk that production
never loads, so no invented people or invoices ship in either installer.

## What has and has not been tested

Built and inspected here: the Windows installer is a valid PE32 NSIS archive
containing the app and uninstaller, Authenticode-signed as Vixera AI with a
verified DigiCert timestamp; the APK is signed by the key above, and carries the
native library, the share plugin classes and the share intent filters.

Not tested here, because this build machine is Linux and headless: running the
Windows installer on Windows, and installing the APK on a phone. First run on
each platform is still worth doing by hand — sign in, confirm the Field loads
from the live project, and share a PDF into the Android app.
