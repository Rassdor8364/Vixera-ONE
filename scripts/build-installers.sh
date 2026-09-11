#!/usr/bin/env bash
# Builds the installers users actually double-click / sideload:
#
#   windows   one .exe (NSIS) that installs Vixera One per-user, no admin
#   android   one signed .apk for arm64 phones
#
# Both bake in the frontend configuration from apps/desktop/.env.production
# (git-ignored; copy .env.production.example). The Supabase anon key belongs
# there: it is a public client key and RLS is what protects the data.
#
# Usage:
#   scripts/build-installers.sh [windows|android|all]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/apps/desktop"
WHAT="${1:-all}"
OUT="$ROOT/dist/installers"

version() { node -p "require('$APP/src-tauri/tauri.conf.json').version" 2>/dev/null || echo 0.0.0; }

[[ -f "$APP/.env.production" ]] || {
  echo "missing $APP/.env.production — copy .env.production.example and fill it in"; exit 1; }
mkdir -p "$OUT"

build_windows() {
  echo "==> Windows installer (NSIS)"
  # Cross-compiled from Linux with cargo-xwin, which fetches the MSVC CRT and
  # Windows SDK headers itself. On Windows, drop the --runner/--target flags.
  local extra=()
  if [[ "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* ]]; then
    command -v makensis >/dev/null || { echo "makensis missing (apt-get install nsis)"; exit 1; }
    command -v clang-cl >/dev/null || { echo "clang-cl missing (apt-get install clang lld llvm; ln -s \$(command -v clang) /usr/local/bin/clang-cl)"; exit 1; }
    cargo xwin --version >/dev/null 2>&1 || { echo "cargo-xwin missing (cargo install --locked cargo-xwin)"; exit 1; }
    extra=(--runner cargo-xwin --target x86_64-pc-windows-msvc)
  fi
  # Authenticode-sign as Vixera AI. Tauri resolves signCommand relative to its
  # own working directory, so the overlay is generated here with an absolute
  # path. windows-sign.sh is a no-op when no certificate is present.
  local overlay
  overlay="$(mktemp --suffix=.json)"
  printf '{"bundle":{"windows":{"signCommand":"bash %s/scripts/windows-sign.sh %%1"}}}' "$ROOT" > "$overlay"
  ( cd "$APP" && pnpm tauri build "${extra[@]}" --bundles nsis --config "$overlay" )
  rm -f "$overlay"
  local built
  built="$(find "$ROOT/target" -path '*/nsis/*-setup.exe' -newermt '-2 hours' -print -quit)"
  [[ -n "$built" ]] || { echo "no NSIS installer produced"; exit 1; }
  cp -v "$built" "$OUT/VixeraOne-$(version)-windows-x64-setup.exe"
  # Report who signed it. `verify` exits non-zero for a self-signed chain, which
  # is expected here and must not fail the build (the script runs under pipefail).
  if command -v osslsigncode >/dev/null; then
    for f in "$OUT"/*setup.exe; do
      osslsigncode verify "$f" 2>/dev/null | grep -E 'Subject:|Timestamp time:' | head -2 || true
    done
  fi
}

build_android() {
  echo "==> Android APK (arm64, signed release)"
  : "${ANDROID_HOME:?set ANDROID_HOME}"
  : "${NDK_HOME:?set NDK_HOME}"
  [[ -f "$APP/src-tauri/gen/android/key.properties" ]] || {
    echo "missing gen/android/key.properties — a release APK must be signed."
    echo "Create the keystore once (KEEP IT AND ITS PASSWORD FOREVER; losing it"
    echo "means no future update can install over this app):"
    echo
    echo '  cd apps/desktop/src-tauri/gen/android'
    echo '  keytool -genkeypair -v -keystore vixera-one-release.keystore \'
    echo '    -alias vixera-one -keyalg RSA -keysize 4096 -validity 10950'
    echo '  printf "storeFile=vixera-one-release.keystore\nstorePassword=...\nkeyAlias=vixera-one\nkeyPassword=...\n" > key.properties'
    exit 1; }
  ( cd "$APP" && pnpm tauri android build --apk --target aarch64 )
  local apk
  apk="$(find "$APP/src-tauri/gen/android/app/build/outputs/apk" -name '*-release*.apk' ! -name '*unsigned*' -print -quit)"
  [[ -n "$apk" ]] || { echo "no signed release APK produced"; exit 1; }
  cp -v "$apk" "$OUT/VixeraOne-$(version)-android-arm64.apk"
  # One apksigner, not every build-tools version the glob happens to match.
  local apksigner
  apksigner="$(find "$ANDROID_HOME/build-tools" -name apksigner -type f | sort -V | tail -1)"
  [[ -x "$apksigner" ]] && { "$apksigner" verify --print-certs "$OUT/VixeraOne-$(version)-android-arm64.apk" | grep -E "DN:|SHA-256 digest" || true; }
}

case "$WHAT" in
  windows) build_windows ;;
  android) build_android ;;
  all)     build_windows; build_android ;;
  *) echo "usage: $0 [windows|android|all]"; exit 1 ;;
esac

echo
echo "==> installers in $OUT"
ls -la "$OUT"
