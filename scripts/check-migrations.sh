#!/usr/bin/env bash
# Static sanity for supabase/migrations. `pnpm db:verify` proves the migrations
# apply and the invariants hold; this catches the class of mistake that applies
# cleanly and still weakens the security posture, before a database is touched.
#
#   - filenames follow <14-digit version>_<snake_case>.sql, versions unique
#   - no migration disables row level security
#   - nothing is granted to anon (every reader is authenticated; anon only signs in)
#   - every SECURITY DEFINER function pins search_path (the Supabase linter rule
#     that bit us in migration 8, now enforced)
#   - no SECURITY DEFINER function is left executable by PUBLIC/anon/authenticated
#     unless it is on the documented allow-list below
#   - no migration references seed.sql or dev fixture ids
#   - no table ends up with `replica identity full` (Realtime does not apply RLS
#     to DELETE events, and full identity broadcasts the whole deleted row)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/supabase/migrations"
status=0
fail() { echo "::error::$*"; status=1; }

# Definer functions clients are meant to call through PostgREST RPC. Anything
# else that is SECURITY DEFINER must be revoked from client roles.
CLIENT_CALLABLE_DEFINERS=(
  vx_connector_account_disconnect   # user-scoped by auth.uid() inside; migration 3 grants it on purpose
)

shopt -s nullglob
files=("$DIR"/*.sql)
[[ ${#files[@]} -gt 0 ]] || fail "no migrations found in $DIR"

# `grep` exits 1 on no match, which under pipefail would kill the script, and a
# `| while` loop runs in a subshell where `fail` cannot set `status`. So: collect
# matches into an array first, then report in the main shell.
lines_matching() { grep -niE "$1" "$2" || true; }

declare -A seen
for f in "${files[@]}"; do
  name="$(basename "$f")"
  [[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+\.sql$ ]] || fail "$name: filename must be <14-digit version>_<snake_case>.sql"
  v="${name%%_*}"
  [[ -n "${seen[$v]:-}" ]] && fail "$name: version $v is also used by ${seen[$v]}"
  seen[$v]="$name"

  mapfile -t hits < <(lines_matching 'disable row level security' "$f")
  for l in "${hits[@]}"; do fail "$name: $l"; done
  mapfile -t hits < <(lines_matching '^\s*grant\b.*\bto\b.*\banon\b' "$f")
  for l in "${hits[@]}"; do fail "$name: grants to anon: $l"; done
  mapfile -t hits < <(lines_matching 'seed\.sql|00000000-0000-4000-8000-000000000001' "$f")
  for l in "${hits[@]}"; do fail "$name: references dev seed: $l"; done
done

# Replica identity: the last `alter table … replica identity` per table across
# the migrations (version order) wins, so an early `full` reverted later passes.
declare -A replident
for f in "${files[@]}"; do
  mapfile -t hits < <(grep -oiE 'alter table (public\.)?[a-z_]+ replica identity (full|default|nothing)' "$f" || true)
  for h in "${hits[@]}"; do
    t="$(awk '{print $3}' <<< "$h")"; t="${t#public.}"
    replident[$t]="$(awk '{print tolower($NF)}' <<< "$h")"
  done
done
for t in "${!replident[@]}"; do
  [[ "${replident[$t]}" == full ]] && fail "$t ends with replica identity full: Realtime would broadcast its deleted rows to every subscriber, unfiltered by RLS"
done

# SECURITY DEFINER functions. Walk each function header (from `create function`
# to the `as $$` that opens the body) and classify it. Portable awk only.
all_sql="$(cat "${files[@]}")"
definers="$(printf '%s\n' "$all_sql" | awk '
  BEGIN { IGNORECASE = 1; fn = "" }
  tolower($0) ~ /create (or replace )?function/ {
    line = tolower($0); sub(/.*function[ \t]+public\./, "", line); sub(/[^a-z0-9_].*/, "", line)
    fn = line; hdr = ""
  }
  fn != "" { hdr = hdr "\n" tolower($0) }
  fn != "" && tolower($0) ~ /as[ \t]*\$/ {
    if (hdr ~ /security definer/) print ((hdr ~ /set[ \t]+search_path/) ? "DEF " : "NOPATH ") fn
    fn = ""; hdr = ""
  }' | sort -u)"

count=0
while read -r kind fn; do
  [[ -z "${fn:-}" ]] && continue
  count=$((count + 1))
  if [[ "$kind" == NOPATH ]]; then
    fail "security definer function $fn does not pin search_path"
    continue
  fi
  allowed=0; for a in "${CLIENT_CALLABLE_DEFINERS[@]}"; do [[ "$a" == "$fn" ]] && allowed=1; done
  if [[ $allowed -eq 0 ]] && ! printf '%s\n' "$all_sql" | grep -qiE "revoke[^;]*on function public\.$fn\b[^;]*\b(public|anon|authenticated)\b"; then
    fail "security definer function $fn is not revoked from client roles (or allow-list it in check-migrations.sh with a reason)"
  fi
done <<< "$definers"

[[ $status -eq 0 ]] && echo "check-migrations: ${#files[@]} migrations, $count security-definer functions checked, clean"
exit $status
