#!/usr/bin/env bash
# Inspects the installers in dist/installers and refuses to bless a release
# that is not what it claims to be. Every check is something that has gone
# wrong, or nearly gone wrong, in this repo's history:
#
#   - the file name says one version, the binary inside says another
#   - a previous version's artifact was copied under the new name
#   - two artifacts match and the wrong one would be picked
#   - the build ran without the certificate and shipped unsigned
#   - the APK was signed with a different key (update-incompatible)
#   - the frontend was built from a dev .env, or with the fixture world on
#   - dist/ was rebuilt after the binary, so the manifest no longer describes it
#
# Usage:  pnpm release:verify            (all artifacts for the current version)
#         scripts/release-verify.sh [dir] [--version X.Y.Z]
#
# Needs: node; 7z (Windows payload); aapt2 + apksigner from ANDROID_HOME (Android);
# osslsigncode (Windows signer subject — signature *presence* is checked without it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${1:-$ROOT/dist/installers}"; [[ "${1:-}" == --* ]] && DIR="$ROOT/dist/installers"
EXPECT="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
for ((i = 1; i <= $#; i++)); do [[ "${!i}" == "--version" ]] && { j=$((i + 1)); EXPECT="${!j}"; }; done
# shellcheck source=release-identity.env
source "$ROOT/scripts/release-identity.env"
REQUIRE_SIGNING="${VIXERA_REQUIRE_SIGNING:-1}"

status=0; checks=0
ok()   { checks=$((checks + 1)); printf '  \e[32m✓\e[0m %s\n' "$*"; }
bad()  { checks=$((checks + 1)); printf '  \e[31m✗\e[0m %s\n' "$*"; status=1; }
note() { printf '  · %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
sdk_tool() { find "${ANDROID_HOME:-/opt/android-sdk}/build-tools" -name "$1" -type f 2>/dev/null | sort -V | tail -1; }

IFS=. read -r maj min pat <<< "$EXPECT"
EXPECT_CODE=$((maj * 1000000 + min * 1000 + pat))
echo "release-verify: expecting version $EXPECT (Android versionCode $EXPECT_CODE) in $DIR"
[[ -d "$DIR" ]] || { echo "::error::$DIR does not exist — nothing to verify"; exit 1; }

# ---------------------------------------------------------------- stale ------
echo "artifacts"
shopt -s nullglob
stale=()
for f in "$DIR"/VixeraOne-*; do
  b="$(basename "$f")"
  [[ "$b" =~ ^VixeraOne-([0-9]+\.[0-9]+\.[0-9]+)- ]] || continue
  [[ "${BASH_REMATCH[1]}" == "$EXPECT" ]] || stale+=("$b")
done
if ((${#stale[@]})); then bad "artifacts from another version are present and could be shipped by mistake: ${stale[*]}"; else ok "no artifacts from other versions"; fi

# --------------------------------------------------------------- manifest ---
# Written by build-installers.sh right after the frontend build, before the
# binary is produced. It is what lets us say what was baked in.
manifest_check() {
  local platform="$1" bin_asset_names="$2"
  local m="$DIR/VixeraOne-$EXPECT-$platform.manifest.json"   # separate line: `local a=x b=$a` expands $a before assigning
  if [[ ! -f "$m" ]]; then bad "$platform: no build manifest ($(basename "$m")) — cannot prove what was baked in"; return; fi
  local mv; mv="$(node -p "require('$m').version")"
  [[ "$mv" == "$EXPECT" ]] && ok "$platform manifest: version $mv" || bad "$platform manifest: version $mv ≠ $EXPECT"
  local url fixtures clean commit dirty
  url="$(node -p "require('$m').env.VITE_SUPABASE_URL || ''")"
  fixtures="$(node -p "String(require('$m').env.VITE_VIXERA_DEV_FIXTURES || '')")"
  clean="$(node -p "String(require('$m').entryChunkClean)")"
  commit="$(node -p "require('$m').git.commit")"; dirty="$(node -p "String(require('$m').git.dirty)")"
  [[ "$url" =~ ^https://[a-z]{20}\.supabase\.co$ ]] && ok "$platform manifest: Supabase URL baked ($url)" || bad "$platform manifest: VITE_SUPABASE_URL is '$url' (expected a project URL — was .env.production present?)"
  [[ "$fixtures" == "true" ]] && bad "$platform manifest: VITE_VIXERA_DEV_FIXTURES=true was baked in" || ok "$platform manifest: dev fixtures off"
  [[ "$clean" == "true" ]] && ok "$platform manifest: fixture world absent from entry chunk" || bad "$platform manifest: entry chunk contains the fixture world"
  [[ "$dirty" == "true" ]] && note "$platform manifest: built from a DIRTY tree at $commit" || ok "$platform manifest: built from clean tree at $commit"
  # The binary embeds the content-hashed asset names of the exact vite output it
  # was built from. Every one must be in the manifest, or dist/ was rebuilt.
  local missing=0 n
  while read -r n; do
    [[ -z "$n" ]] && continue
    node -e "process.exit(Object.prototype.hasOwnProperty.call(require('$m').assets, '${n#/assets/}') ? 0 : 1)" || { missing=1; note "$platform: binary embeds $n which the manifest does not list"; }
  done <<< "$bin_asset_names"
  [[ $missing -eq 0 ]] && ok "$platform: embedded asset names match the manifest" || bad "$platform: binary and manifest describe different frontend builds"
}

# ---------------------------------------------------------------- windows ---
exes=("$DIR"/VixeraOne-"$EXPECT"-windows-x64-setup.exe)
echo "windows"
if ((${#exes[@]} == 0)); then
  note "no Windows installer for $EXPECT (skipped)"
elif ((${#exes[@]} > 1)); then
  bad "ambiguous: ${#exes[@]} Windows installers match"
else
  exe="${exes[0]}"
  info="$(node "$ROOT/scripts/pe-info.mjs" "$exe")"
  fv="$(node -pe "JSON.parse(process.argv[1]).fileVersion" "$info")"; pv="$(node -pe "JSON.parse(process.argv[1]).productVersion" "$info")"
  signed="$(node -pe "JSON.parse(process.argv[1]).signed" "$info")"
  [[ "$fv" == "$EXPECT" && "$pv" == "$EXPECT" ]] && ok "installer version resource $fv" || bad "installer version resource says FileVersion=$fv ProductVersion=$pv, expected $EXPECT"
  if [[ "$signed" == true ]]; then ok "installer carries an Authenticode signature"
  elif [[ "$REQUIRE_SIGNING" == "0" ]]; then note "installer is UNSIGNED (VIXERA_REQUIRE_SIGNING=0)"
  else bad "installer is UNSIGNED"; fi
  if have osslsigncode && [[ "$signed" == true ]]; then
    # Capture once: `osslsigncode | grep -m1` would SIGPIPE osslsigncode under
    # pipefail (exit 141). It also exits non-zero for our self-signed chain,
    # which is expected — the subject and timestamp are what we check.
    sig="$(osslsigncode verify "$exe" 2>/dev/null || true)"
    subj="$(grep -m1 'Subject:' <<< "$sig" | sed 's/^[[:space:]]*Subject: *//')"
    [[ "$subj" == "$WINDOWS_SIGNER_SUBJECT" ]] && ok "signer $subj" || bad "signer is '$subj', expected '$WINDOWS_SIGNER_SUBJECT'"
    grep -q 'Timestamp time:' <<< "$sig" && ok "signature is timestamped" || bad "signature has no timestamp (expires with the certificate)"
  fi
  if have 7z; then
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    7z x -o"$tmp" "$exe" >/dev/null 2>&1 || true
    inner="$(find "$tmp" -iname 'vixera-one.exe' | head -1)"
    if [[ -z "$inner" ]]; then bad "installer payload has no vixera-one.exe"; else
      iinfo="$(node "$ROOT/scripts/pe-info.mjs" "$inner")"
      ifv="$(node -pe "JSON.parse(process.argv[1]).fileVersion" "$iinfo")"; isigned="$(node -pe "JSON.parse(process.argv[1]).signed" "$iinfo")"; ico="$(node -pe "JSON.parse(process.argv[1]).companyName" "$iinfo")"
      [[ "$ifv" == "$EXPECT" ]] && ok "app binary inside is $ifv" || bad "app binary inside says $ifv (a stale payload?)"
      [[ "$isigned" == true ]] && ok "app binary inside is signed" || { [[ "$REQUIRE_SIGNING" == "0" ]] && note "app binary inside is unsigned" || bad "app binary inside is UNSIGNED"; }
      [[ "$ico" == "Vixera AI" ]] && ok "app binary CompanyName '$ico'" || bad "app binary CompanyName is '$ico'"
      names="$(strings -n 10 "$inner" | grep -oE '/assets/[A-Za-z0-9_-]+\.(js|css|woff2)' | sort -u)"
      manifest_check windows-x64 "$names"
    fi
  else note "7z missing: payload not inspected"; fi
fi

# ---------------------------------------------------------------- android ---
apks=("$DIR"/VixeraOne-"$EXPECT"-android-arm64.apk)
echo "android"
if ((${#apks[@]} == 0)); then
  note "no Android APK for $EXPECT (skipped)"
elif ((${#apks[@]} > 1)); then
  bad "ambiguous: ${#apks[@]} APKs match"
else
  apk="${apks[0]}"
  aapt="$(sdk_tool aapt2)"; apksigner="$(sdk_tool apksigner)"
  if [[ -x "$aapt" ]]; then
    # Capture whole outputs, then pick lines: a `| head -1` or `| grep -q` on a
    # live pipe SIGPIPEs the producer (exit 141 under pipefail).
    badging="$("$aapt" dump badging "$apk" 2>/dev/null || true)"; badging="$(grep -m1 '^package:' <<< "$badging")"
    # Anchor each key: the line also carries platformBuildVersionName='16' etc.,
    # and a greedy `.*name='` would pick that up instead of `package: name=`.
    pkg="$(sed -nE "s/^package: name='([^']+)'.*/\1/p" <<< "$badging")"
    vc="$(sed -nE "s/.* versionCode='([^']+)'.*/\1/p" <<< "$badging")"
    vn="$(sed -nE "s/.* versionName='([^']+)'.*/\1/p" <<< "$badging")"
    [[ "$pkg" == "$ANDROID_APPLICATION_ID" ]] && ok "applicationId $pkg" || bad "applicationId is '$pkg', expected $ANDROID_APPLICATION_ID"
    [[ "$vn" == "$EXPECT" ]] && ok "versionName $vn" || bad "versionName is '$vn', expected $EXPECT"
    [[ "$vc" == "$EXPECT_CODE" ]] && ok "versionCode $vc" || bad "versionCode is '$vc', expected $EXPECT_CODE (an update installs only if this is greater than the installed one)"
  else note "aapt2 missing: manifest not inspected"; fi
  if [[ -x "$apksigner" ]]; then
    if certs="$("$apksigner" verify --print-certs "$apk" 2>/dev/null)"; then
      sha="$(grep -m1 'certificate SHA-256 digest' <<< "$certs" | sed -nE 's/.*SHA-256 digest: *([0-9a-f]+).*/\1/p')"
      dn="$(grep -m1 'certificate DN' <<< "$certs" | sed -nE 's/.*certificate DN: *(.*)$/\1/p')"
      [[ "$sha" == "$ANDROID_SIGNER_SHA256" ]] && ok "signer $dn ($sha)" || bad "signer $dn has SHA-256 $sha, expected $ANDROID_SIGNER_SHA256 — installed apps would refuse this update"
    else bad "APK signature does not verify (unsigned, or signed then modified)"; fi
  else note "apksigner missing: signature not inspected"; fi
  listing="$(unzip -l "$apk" 2>/dev/null || true)"
  grep -q 'lib/arm64-v8a/libvixera_one_lib.so' <<< "$listing" && ok "native library present for arm64-v8a" || bad "no arm64-v8a native library"
  names="$(unzip -p "$apk" lib/arm64-v8a/libvixera_one_lib.so | strings -n 10 | grep -oE '/assets/[A-Za-z0-9_-]+\.(js|css|woff2)' | sort -u)"
  manifest_check android-arm64 "$names"
fi

# ---------------------------------------------------------------- sums ------
echo "checksums"
if [[ -f "$DIR/SHA256SUMS.txt" ]]; then
  if (cd "$DIR" && sha256sum --quiet -c SHA256SUMS.txt 2>/dev/null); then ok "SHA256SUMS.txt matches every listed artifact"; else bad "SHA256SUMS.txt does not match"; fi
  for f in "${exes[@]}" "${apks[@]}"; do grep -q " $(basename "$f")\$" "$DIR/SHA256SUMS.txt" || bad "$(basename "$f") is not listed in SHA256SUMS.txt"; done
else bad "no SHA256SUMS.txt"; fi

echo
if [[ $status -eq 0 ]]; then echo "release-verify: $checks checks passed — $EXPECT is what it says it is"; else echo "release-verify: FAILED — do not ship"; fi
exit $status
