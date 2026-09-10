#!/usr/bin/env bash
# Starts a throwaway PostgreSQL + PostgREST with the Vixera schema applied, so
# SupabaseSpineStore can be exercised against a real PostgREST (the seam that
# unit tests with a fake query builder cannot cover). Not part of `supabase
# start` — that needs Docker; this needs only the two binaries.
#
#   scripts/live-stack.sh up    # prints the env for the integration test
#   scripts/live-stack.sh down
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${VIXERA_LIVE_STATE:-/tmp/vixera-live-stack}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
POSTGREST="${POSTGREST:-$(command -v postgrest || echo "$STATE/postgrest")}"
PGPORT="${VIXERA_PG_PORT:-54331}"
RESTPORT="${VIXERA_REST_PORT:-54332}"
JWT_SECRET="${VIXERA_JWT_SECRET:-vixera-local-jwt-secret-at-least-32-chars}"

case "${1:-up}" in
  up)
    mkdir -p "$STATE"
    [[ -x "$POSTGREST" ]] || { echo "postgrest binary not found (set POSTGREST=)"; exit 1; }
    RUN=(); if [[ "$(id -u)" == "0" ]]; then chown -R postgres "$STATE"; RUN=(runuser -u postgres --); fi
    if [[ ! -d "$STATE/data" ]]; then
      "${RUN[@]}" "$PGBIN/initdb" -D "$STATE/data" -A trust -U postgres >/dev/null
    fi
    "${RUN[@]}" "$PGBIN/pg_ctl" -D "$STATE/data" -o "-p $PGPORT -k $STATE -c listen_addresses=127.0.0.1" -l "$STATE/pg.log" start >/dev/null 2>&1 || true
    PSQL=("${RUN[@]}" psql -h 127.0.0.1 -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q)
    "${PSQL[@]}" -d postgres -c "drop database if exists vixera_live" >/dev/null
    "${PSQL[@]}" -d postgres -c "create database vixera_live" >/dev/null
    DB=("${PSQL[@]}" -d vixera_live)
    "${DB[@]}" -f "$ROOT/scripts/sql/supabase-shim.sql"
    for f in "$ROOT"/supabase/migrations/*.sql; do "${DB[@]}" -f "$f"; done
    "${DB[@]}" -f "$ROOT/supabase/seed.sql"
    # PostgREST needs a role to switch from; anon/authenticated/service_role exist in the shim.
    "${DB[@]}" -c "create role vixera_authenticator noinherit login password 'authenticator'" >/dev/null 2>&1 || true
    "${DB[@]}" -c "grant anon, authenticated, service_role to vixera_authenticator"
    "${DB[@]}" -c "grant usage on schema public, extensions, vault to anon, authenticated, service_role"
    "${DB[@]}" -c "grant all on all tables in schema public to anon, authenticated, service_role"
    "${DB[@]}" -c "grant all on all sequences in schema public to anon, authenticated, service_role"
    "${DB[@]}" -c "grant execute on all functions in schema public to anon, authenticated, service_role"
    # Re-apply the deliberate revokes (the blanket grants above would undo them).
    "${DB[@]}" -f "$ROOT/scripts/sql/live-grants.sql"
    PGRST_DB_URI="postgres://vixera_authenticator:authenticator@127.0.0.1:$PGPORT/vixera_live" \
    PGRST_DB_SCHEMAS="public" PGRST_DB_ANON_ROLE="anon" PGRST_JWT_SECRET="$JWT_SECRET" \
    PGRST_SERVER_PORT="$RESTPORT" PGRST_DB_POOL=4 PGRST_LOG_LEVEL=error \
      nohup "$POSTGREST" > "$STATE/postgrest.log" 2>&1 &
    echo $! > "$STATE/postgrest.pid"
    for _ in $(seq 1 40); do
      if curl -sS -o /dev/null "http://127.0.0.1:$RESTPORT/" 2>/dev/null; then break; fi
      sleep 0.25
    done
    # supabase-js addresses <url>/rest/v1; the proxy strips that prefix.
    PROXYPORT="${VIXERA_PROXY_PORT:-54333}"
    nohup node "$ROOT/scripts/live-proxy.mjs" "$PROXYPORT" "http://127.0.0.1:$RESTPORT" > "$STATE/proxy.log" 2>&1 &
    echo $! > "$STATE/proxy.pid"
    for _ in $(seq 1 40); do
      if curl -sS -o /dev/null "http://127.0.0.1:$PROXYPORT/health" 2>/dev/null; then break; fi
      sleep 0.25
    done
    echo "VIXERA_LIVE_URL=http://127.0.0.1:$PROXYPORT"
    echo "VIXERA_LIVE_JWT_SECRET=$JWT_SECRET"
    echo "VIXERA_LIVE_PG=postgres://postgres@127.0.0.1:$PGPORT/vixera_live"
    ;;
  down)
    [[ -f "$STATE/proxy.pid" ]] && kill "$(cat "$STATE/proxy.pid")" 2>/dev/null || true
    [[ -f "$STATE/postgrest.pid" ]] && kill "$(cat "$STATE/postgrest.pid")" 2>/dev/null || true
    rm -f "$STATE/postgrest.pid" "$STATE/proxy.pid"
    RUN=(); if [[ "$(id -u)" == "0" ]]; then RUN=(runuser -u postgres --); fi
    "${RUN[@]}" "$PGBIN/pg_ctl" -D "$STATE/data" stop -m immediate >/dev/null 2>&1 || true
    ;;
  *) echo "usage: live-stack.sh [up|down]"; exit 2;;
esac
