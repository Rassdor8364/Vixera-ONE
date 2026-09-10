#!/usr/bin/env bash
# Deploys the four Vixera One Edge Functions to a Supabase project.
#
# The functions import workspace packages (@vixera/domain, @vixera/sync, the
# connectors) that live OUTSIDE supabase/functions, so they are bundled first:
# one self-contained file per function, with @supabase/supabase-js left as an
# npm specifier for the Edge Runtime to resolve. That keeps each bundle around
# 50-130 KB instead of ~1 MB.
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_...  scripts/deploy-functions.sh <project-ref>
#
# Get the token at https://supabase.com/dashboard/account/tokens
# (or run `supabase login` once and omit it).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="${1:-${SUPABASE_PROJECT_REF:-}}"
DENO="${DENO:-$(command -v deno || echo "$HOME/.deno/bin/deno")}"
OUT="$ROOT/dist/functions"
FUNCTIONS=(action-dispatch connector-link connector-sync ingest-process)

# connector-sync authenticates cron callers with X-Vixera-Sync-Secret and users
# with a bearer token, both in the function body; connector-link's OAuth
# callback is reached by the system browser with no Vixera session. Both verify
# their own callers, so the platform JWT gate is off for them (mirrors
# supabase/config.toml).
NO_JWT=(connector-sync connector-link)

[[ -n "$REF" ]] || { echo "usage: $0 <project-ref>   (or set SUPABASE_PROJECT_REF)"; exit 1; }
command -v supabase >/dev/null || { echo "supabase CLI not found"; exit 1; }
[[ -x "$DENO" ]] || { echo "deno not found (set DENO=/path/to/deno)"; exit 1; }

echo "==> bundling"
rm -rf "$OUT"
for fn in "${FUNCTIONS[@]}"; do
  mkdir -p "$OUT/$fn"
  "$DENO" bundle \
    --config "$ROOT/supabase/functions/deno.json" \
    --platform deno --minify \
    --external "@supabase/supabase-js" \
    -o "$OUT/$fn/index.js" \
    "$ROOT/supabase/functions/$fn/index.ts" >/dev/null
  cat > "$OUT/$fn/deno.json" <<'JSON'
{ "imports": { "@supabase/supabase-js": "npm:@supabase/supabase-js@2.116.0" } }
JSON
  printf '    %-16s %s KB\n' "$fn" "$(( $(wc -c < "$OUT/$fn/index.js") / 1024 ))"
done

echo "==> deploying to $REF"
for fn in "${FUNCTIONS[@]}"; do
  args=(functions deploy "$fn" --project-ref "$REF" --use-api)
  for n in "${NO_JWT[@]}"; do [[ "$n" == "$fn" ]] && args+=(--no-verify-jwt); done
  ( cd "$OUT" && supabase "${args[@]}" )
done

cat <<EOF

==> deployed: ${FUNCTIONS[*]}

Still required before a connector can sync (secrets never live in this repo):

  supabase secrets set --project-ref $REF \\
    GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \\
    MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... \\
    PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \\
    VIXERA_SYNC_SECRET="\$(openssl rand -hex 32)"

Then let pg_cron reach the function with that same secret (run once, in the
SQL editor, using the value you just set):

  select vault.create_secret('https://$REF.supabase.co/functions/v1', 'vixera_functions_url');
  select vault.create_secret('<the same VIXERA_SYNC_SECRET>', 'vixera_sync_secret');

Until both Vault secrets exist the scheduled job runs and no-ops by design.
EOF
