#!/usr/bin/env bash
# Refuses tracked files that look like they carry a secret. Runs in CI and is
# cheap enough to run before every commit. Patterns are deliberately shaped
# like the real things this repo handles — a Supabase personal access token,
# a JWT (anon / service-role keys are JWTs), a PEM private key, a Plaid or
# OAuth client secret assignment — not a generic entropy scan.
#
# The Supabase ANON key is public and may be committed (it ships inside the
# installers), but it lives in git-ignored .env files by convention, so a JWT
# anywhere tracked is still treated as a mistake.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

patterns=(
  'sbp_[A-Za-z0-9]{20,}'                                             # Supabase personal access token
  'eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' # JWT
  '-----BEGIN (RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----'
  # a literal secret assigned: quoted, or a bare .env-style value to end of line
  '(client_secret|CLIENT_SECRET|PLAID_SECRET|storePassword|keyPassword)\s*[:=]\s*["'\''][A-Za-z0-9/+_=-]{16,}["'\'']'
  '^\s*(GOOGLE_CLIENT_SECRET|MICROSOFT_CLIENT_SECRET|PLAID_SECRET|VIXERA_SYNC_SECRET|SUPABASE_SERVICE_ROLE_KEY|storePassword|keyPassword)=[A-Za-z0-9/+_=-]{16,}\s*$'
  'AKIA[0-9A-Z]{16}'                                                 # AWS access key id
  'xox[baprs]-[A-Za-z0-9-]{10,}'                                     # Slack token
)

# Files that legitimately contain example placeholders are excluded by content
# below (placeholders never match the real-value shapes), not by path.
exclude=(':!pnpm-lock.yaml' ':!*.lock' ':!*.woff2' ':!*.png' ':!*.ico' ':!*.icns')

status=0
for p in "${patterns[@]}"; do
  # -e: the PEM pattern starts with "-" and would otherwise be read as options
  if hits="$(git grep -nIE -e "$p" -- . "${exclude[@]}" 2>/dev/null)"; then
    echo "::error::secret-shaped content matched /$p/:"
    echo "$hits" | sed 's/^/  /'
    status=1
  fi
done

# The signing directory and keystores must never be tracked, whatever they contain.
# `:(glob)**/` so a nested env file (apps/desktop/.env.production) is seen: a
# bare '.env.*' pathspec only matches at the repository root.
if tracked="$(git ls-files -- .signing '*.keystore' '*.jks' '*.pfx' '*.p12' 'apps/desktop/src-tauri/gen/android/key.properties' ':(glob)**/.env' ':(glob)**/.env.*' ':(glob,exclude)**/*.example' 2>/dev/null)" && [[ -n "$tracked" ]]; then
  echo "::error::signing material or environment files are tracked:"
  echo "$tracked" | sed 's/^/  /'
  status=1
fi

[[ $status -eq 0 ]] && echo "check-secrets: clean"
exit $status
