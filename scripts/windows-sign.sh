#!/usr/bin/env bash
# Authenticode-signs one file, in place, as Vixera AI. Tauri calls this for the
# app binary and again for the NSIS installer via bundle.windows.signCommand.
#
# The certificate in .signing/ is SELF-SIGNED: it puts "Vixera AI" in the file's
# signature and publisher fields, but Windows only trusts it on machines where
# the certificate has been added to Trusted Root / Trusted Publishers. For a
# signature the public trusts out of the box, buy an OV or EV code-signing
# certificate and point SIGN_PFX at it — nothing else here changes.
set -euo pipefail

FILE="${1:?usage: windows-sign.sh <file>}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROPS="${SIGN_PROPS:-$DIR/.signing/codesign.properties}"

[[ -f "$PROPS" ]] || { echo "windows-sign: no $PROPS, skipping signing"; exit 0; }
command -v osslsigncode >/dev/null || { echo "windows-sign: osslsigncode missing"; exit 1; }

PFX="${SIGN_PFX:-$DIR/.signing/$(grep '^pfx=' "$PROPS" | cut -d= -f2-)}"
PW="${SIGN_PASSWORD:-$(grep '^password=' "$PROPS" | cut -d= -f2-)}"
# NOTE: mktemp -u, not mktemp: osslsigncode refuses to write to a file that
# already exists, so the output path must not be created up front.
TMP="$(mktemp -u)"

# A timestamp keeps the signature valid after the certificate expires. If no
# timestamp authority is reachable, sign without one rather than fail the build.
for TS in http://timestamp.digicert.com http://timestamp.sectigo.com ""; do
  if [[ -n "$TS" ]]; then
    osslsigncode sign -pkcs12 "$PFX" -pass "$PW" -n "Vixera One" -i "https://vixera.ai" \
      -h sha256 -t "$TS" -in "$FILE" -out "$TMP" >/dev/null 2>&1 && { mv "$TMP" "$FILE"; echo "windows-sign: signed $(basename "$FILE") (timestamped)"; exit 0; }
  else
    osslsigncode sign -pkcs12 "$PFX" -pass "$PW" -n "Vixera One" -i "https://vixera.ai" \
      -h sha256 -in "$FILE" -out "$TMP" >/dev/null 2>&1 && { mv "$TMP" "$FILE"; echo "windows-sign: signed $(basename "$FILE") (no timestamp)"; exit 0; }
  fi
done
rm -f "$TMP"; echo "windows-sign: FAILED to sign $FILE"; exit 1
