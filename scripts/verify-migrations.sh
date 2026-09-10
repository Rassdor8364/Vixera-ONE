#!/usr/bin/env bash
# Applies every migration + the dev seed to a throwaway PostgreSQL and runs
# scripts/sql/verify.sql. Works without Docker/Supabase: a shim provides the
# auth schema, roles and auth.uid(). With `supabase start` running, prefer
# `supabase db reset` (real Supabase image) and then run:
#   psql "$DATABASE_URL" -f scripts/sql/verify.sql
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [[ -n "${DATABASE_URL:-}" ]]; then
  PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q)
  echo "Using DATABASE_URL"
else
  [[ -x "$PGBIN/initdb" ]] || { echo "PostgreSQL binaries not found (set PGBIN or DATABASE_URL)"; exit 1; }
  TMP="$(mktemp -d)"; PORT="${VERIFY_PG_PORT:-54329}"
  trap '"$PGBIN/pg_ctl" -D "$TMP/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
  RUN=(); if [[ "$(id -u)" == "0" ]]; then chown -R postgres "$TMP"; RUN=(runuser -u postgres --); fi
  "${RUN[@]}" "$PGBIN/initdb" -D "$TMP/data" -A trust -U postgres >/dev/null
  "${RUN[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -o "-p $PORT -k $TMP -c listen_addresses=''" -l "$TMP/pg.log" start >/dev/null
  PSQL=("${RUN[@]}" psql -h "$TMP" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
  "${PSQL[@]}" -c "create database vixera_verify" >/dev/null
  PSQL=("${RUN[@]}" psql -h "$TMP" -p "$PORT" -U postgres -d vixera_verify -v ON_ERROR_STOP=1 -q)
  "${PSQL[@]}" -f "$ROOT/scripts/sql/supabase-shim.sql"
fi
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"; "${PSQL[@]}" -f "$f"
done
echo "applying seed.sql"; "${PSQL[@]}" -f "$ROOT/supabase/seed.sql"
"${PSQL[@]}" -f "$ROOT/scripts/sql/verify.sql"
