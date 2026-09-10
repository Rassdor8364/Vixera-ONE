#!/usr/bin/env bash
# Starts the live PostgreSQL + PostgREST stack and runs the store suite against
# it. Fails loudly when the stack does not come up: a silently skipped live
# suite is worse than no live suite, because it reports success.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(bash "$ROOT/scripts/live-stack.sh" up)" || { echo "live stack failed to start:"; echo "$OUT"; exit 1; }
eval "$(printf '%s\n' "$OUT" | sed 's/^/export /')"
if [[ -z "${VIXERA_LIVE_URL:-}" || -z "${VIXERA_LIVE_JWT_SECRET:-}" ]]; then
  echo "live stack did not report VIXERA_LIVE_URL / VIXERA_LIVE_JWT_SECRET:"; echo "$OUT"; exit 1
fi
if ! curl -fsS -o /dev/null "$VIXERA_LIVE_URL/health"; then
  echo "live stack is not answering at $VIXERA_LIVE_URL"; exit 1
fi
export VIXERA_LIVE_URL VIXERA_LIVE_JWT_SECRET
VIXERA_LIVE_REQUIRED=1 pnpm --filter @vixera/sync test
