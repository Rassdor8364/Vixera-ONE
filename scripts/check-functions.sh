#!/usr/bin/env bash
# Type-checks every Edge Function with Deno using the shared import map
# (supabase/functions/deno.json), then runs the Deno tests of the shared
# layer (supabase/functions/_shared/*_test.ts). Requires deno 2
# (https://deno.land). Supabase CLI runs the same code with
# `supabase functions serve`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DENO="${DENO:-$(command -v deno || echo "$HOME/.deno/bin/deno")}"
cd "$ROOT/supabase/functions"

checked=0
for dir in */; do
  fn="${dir%/}"
  [[ "$fn" == _* ]] && continue
  [[ -f "$fn/index.ts" ]] || continue
  echo "deno check $fn"
  "$DENO" check --config deno.json "$fn/index.ts"
  checked=$((checked + 1))
done
echo "checked $checked function(s)"

shopt -s nullglob
tests=(*/*_test.ts)
if (( ${#tests[@]} > 0 )); then
  echo "deno test (${#tests[@]} file(s))"
  # Tests run offline against InMemorySpineStore; --allow-env lets env.ts read Deno.env
  # and --allow-net is restricted to loopback so nothing can leave the machine.
  "$DENO" test --config deno.json --allow-env --allow-net=127.0.0.1,localhost "${tests[@]}"
else
  echo "no Deno tests found"
fi
