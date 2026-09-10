#!/usr/bin/env bash
# Type-checks every Edge Function with Deno using the shared import map, and
# runs their Deno tests. Requires deno (https://deno.land). Supabase CLI runs
# the same code with `supabase functions serve`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DENO="${DENO:-$(command -v deno || echo "$HOME/.deno/bin/deno")}"
cd "$ROOT/supabase/functions"
for dir in */; do
  fn="${dir%/}"
  [[ "$fn" == _* ]] && continue
  [[ -f "$fn/index.ts" ]] || continue
  echo "deno check $fn"; "$DENO" check --config deno.json "$fn/index.ts"
done
if compgen -G "*/**/*.test.ts" >/dev/null || compgen -G "_shared/*.test.ts" >/dev/null; then
  "$DENO" test --config deno.json --allow-env --allow-net=127.0.0.1,localhost .
fi
