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

# apps/desktop/package.json is the one version; tauri.conf.json points at it
# and Cargo.toml must match (scripts/check-version.sh).
version() { node -p "require('$APP/package.json').version"; }

[[ -f "$APP/.env.production" ]] || {
  echo "missing $APP/.env.production — copy .env.production.example and fill it in"; exit 1; }
bash "$ROOT/scripts/check-version.sh"
# Signing is mandatory unless explicitly waived; windows-sign.sh and the final
# release-verify both honour this.
export VIXERA_REQUIRE_SIGNING="${VIXERA_REQUIRE_SIGNING:-1}"
mkdir -p "$OUT"
# Anything from another version in the output directory is a shipping accident
# waiting to happen; a stale artifact from THIS version is replaced below.
shopt -s nullglob
for f in "$OUT"/VixeraOne-*; do
  b="$(basename "$f")"
  if [[ "$b" =~ ^VixeraOne-([0-9]+\.[0-9]+\.[0-9]+)[-.] && "${BASH_REMATCH[1]}" != "$(version)" ]]; then
    echo "removing $b (version ${BASH_REMATCH[1]} ≠ $(version))"; rm -f "$f"
  fi
done
shopt -u nullglob

# Records what the frontend build that went INTO the binary contained: the
# baked env, the content-hashed asset names, and whether the fixture world
# leaked into the entry chunk. release-verify ties the binary back to this by
# the asset names it embeds. Must run right after `tauri build`, before anything
# rebuilds apps/desktop/dist.
write_manifest() {
  local platform="$1"
  local m="$OUT/VixeraOne-$(version)-$platform.manifest.json"   # own line: `local a=x b=$a` expands $a first
  local entry; entry="$(ls "$APP"/dist/assets/index-*.js | head -1)"
  local clean=true; grep -q "Northwind" "$entry" && clean=false
  # Runs from $APP so `import "vite"` resolves the app's own Vite: the env is
  # resolved by Vite's loadEnv, exactly as `vite build` resolved it — .env,
  # .env.local, .env.production, .env.production.local and VITE_* from the
  # shell, in that precedence. Re-parsing .env.production alone recorded a
  # clean env while a fixture flag from .env.local or the shell was baked in.
  (cd "$APP" && node --input-type=module - "$m" "$(version)" "$platform" "$clean" "$APP/dist/assets" "$ROOT" <<'JS'
import fs from "node:fs"; import path from "node:path"; import cp from "node:child_process"; import crypto from "node:crypto";
import { loadEnv } from "vite";
const [, , out, version, platform, clean, assetsDir, root] = process.argv; // argv[1] is "-" for stdin
const app = process.cwd();
const env = loadEnv("production", app, ["VITE_"]);
const envFiles = [".env", ".env.local", ".env.production", ".env.production.local"].filter((f) => fs.existsSync(path.join(app, f)));
const envFromShell = Object.keys(process.env).filter((k) => k.startsWith("VITE_")).sort();
// Only public build-time config belongs in a manifest; the anon key is public
// too but there is no reason to copy it around, so it is reduced to its length.
if (env.VITE_SUPABASE_ANON_KEY) env.VITE_SUPABASE_ANON_KEY = `<${env.VITE_SUPABASE_ANON_KEY.length} chars>`;
const assets = Object.fromEntries(fs.readdirSync(assetsDir).sort().map((n) =>
  [n, crypto.createHash("sha256").update(fs.readFileSync(path.join(assetsDir, n))).digest("hex")]));
const git = (a) => cp.execSync(`git ${a}`, { cwd: root, encoding: "utf8" }).trim();
fs.writeFileSync(out, JSON.stringify({
  version, platform, builtAt: new Date().toISOString(),
  git: { commit: git("rev-parse HEAD"), dirty: git("status --porcelain").length > 0 },
  env, envFiles, envFromShell, entryChunkClean: clean === "true", assets,
}, null, 2) + "\n");
console.log(`manifest: ${path.basename(out)} (${Object.keys(assets).length} assets, env from ${envFiles.join(", ") || "nothing"}${envFromShell.length ? ` + shell ${envFromShell.join(", ")}` : ""}, entry chunk ${clean === "true" ? "clean" : "CONTAINS FIXTURES"})`);
JS
  )
}

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
  # Pin to the version just built and take the newest match. Matching only
  # `*-setup.exe` picks up a previous version still sitting in target/ and
  # silently ships it under the new name — `-print -quit` takes whichever the
  # filesystem returns first, which is not the newest.
  local built
  local matches
  mapfile -t matches < <(find "$ROOT/target" -path '*/nsis/*-setup.exe' -name "*_$(version)_*" -newer "$APP/package.json")
  case ${#matches[@]} in
    0) echo "no NSIS installer for version $(version) newer than package.json in target/"; exit 1 ;;
    1) ;;
    *) echo "ambiguous: ${#matches[@]} NSIS installers match version $(version):"; printf '  %s\n' "${matches[@]}"; exit 1 ;;
  esac
  local built="${matches[0]}" out="$OUT/VixeraOne-$(version)-windows-x64-setup.exe"
  cp -v "$built" "$out"
  write_manifest windows-x64
  # Report who signed it. `verify` exits non-zero for a self-signed chain, which
  # is expected here and must not fail the build (the script runs under pipefail).
  if command -v osslsigncode >/dev/null; then
    osslsigncode verify "$out" 2>/dev/null | grep -E 'Subject:|Timestamp time:' | head -2 || true
  fi
}

build_android() {
  echo "==> Android APK (arm64, signed release)"
  # Same default as release-verify; a shell without the profile export (a CI
  # step, a background job) otherwise stops here with the SDK sitting in place.
  [[ -n "${ANDROID_HOME:-}" ]] || { [[ -d /opt/android-sdk ]] && export ANDROID_HOME=/opt/android-sdk; }
  : "${ANDROID_HOME:?set ANDROID_HOME}"
  [[ -n "${NDK_HOME:-}" ]] || { NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"; [[ -n "$NDK_HOME" ]] && export NDK_HOME; }
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
  local matches
  mapfile -t matches < <(find "$APP/src-tauri/gen/android/app/build/outputs/apk" -name '*-release*.apk' ! -name '*unsigned*' -newer "$APP/package.json")
  case ${#matches[@]} in
    0) echo "no signed release APK newer than package.json produced"; exit 1 ;;
    1) ;;
    *) echo "ambiguous: ${#matches[@]} release APKs produced:"; printf '  %s\n' "${matches[@]}"; exit 1 ;;
  esac
  local apk="${matches[0]}"
  cp -v "$apk" "$OUT/VixeraOne-$(version)-android-arm64.apk"
  write_manifest android-arm64
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

( cd "$OUT" && sha256sum VixeraOne-"$(version)"-*.exe VixeraOne-"$(version)"-*.apk 2>/dev/null > SHA256SUMS.txt || true )
echo
echo "==> installers in $OUT"
ls -la "$OUT"
echo
# The build is not done until the artifacts have been inspected.
bash "$ROOT/scripts/release-verify.sh" "$OUT"
