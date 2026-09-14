#!/usr/bin/env bash
# Deploys the four Vixera One Edge Functions to a Supabase project.
#
# The functions import workspace packages (@vixera/domain, @vixera/sync, the
# connectors) that live OUTSIDE supabase/functions; the CLI follows those
# imports through supabase/functions/deno.json and bundles them itself.
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

# The CLI resolves each function from this repository's supabase/functions and
# bundles it itself (eszip over supabase/functions/deno.json, whose import map
# reaches the workspace packages by relative path). An earlier version of this
# script bundled into dist/functions first, but `supabase functions deploy`
# never read that directory: it walks up from the working directory to the
# nearest supabase/ folder and deploys those sources. Type-check first so a
# broken import fails here rather than at boot.
echo "==> deno check"
for fn in "${FUNCTIONS[@]}"; do
  "$DENO" check --config "$ROOT/supabase/functions/deno.json" "$ROOT/supabase/functions/$fn/index.ts"
done

echo "==> deploying to $REF"
for fn in "${FUNCTIONS[@]}"; do
  args=(functions deploy "$fn" --project-ref "$REF" --use-api)
  for n in "${NO_JWT[@]}"; do [[ "$n" == "$fn" ]] && args+=(--no-verify-jwt); done
  ( cd "$ROOT" && supabase "${args[@]}" )
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
