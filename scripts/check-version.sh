#!/usr/bin/env bash
# One version, three consumers.
#
#   apps/desktop/package.json   ← the source of truth
#   tauri.conf.json             must point at it ("version": "../package.json"),
#                               so the installers, the PE version resource and
#                               the Android versionName/versionCode derive from it
#   Cargo.toml [workspace.package] must equal it: Cargo cannot read a path, and
#                               the Rust crates carry their own version string
#
# Drift here is how an installer ships claiming one version while the binary
# inside says another. Runs in CI (hygiene) and at the start of every release.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pkg="$(node -p "require('$ROOT/apps/desktop/package.json').version")"
tauri="$(node -p "require('$ROOT/apps/desktop/src-tauri/tauri.conf.json').version")"
cargo="$(sed -nE '/^\[workspace\.package\]/,/^\[/{s/^version *= *"([^"]+)"/\1/p}' "$ROOT/Cargo.toml")"

status=0
[[ "$pkg" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::apps/desktop/package.json version '$pkg' is not MAJOR.MINOR.PATCH (Android versionCode derives from it)"; status=1; }
if [[ "$tauri" != "../package.json" ]]; then
  echo "::error::tauri.conf.json version must be the path \"../package.json\" (is \"$tauri\") so it cannot drift from the package version"; status=1
fi
if [[ "$cargo" != "$pkg" ]]; then
  echo "::error::Cargo.toml [workspace.package] version is '$cargo' but apps/desktop/package.json is '$pkg'"; status=1
fi

if [[ $status -eq 0 ]]; then
  IFS=. read -r maj min pat <<< "$pkg"
  echo "check-version: $pkg everywhere (Android versionCode will be $((maj * 1000000 + min * 1000 + pat)))"
fi
exit $status
