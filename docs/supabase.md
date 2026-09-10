# Supabase — local development and deployment

Everything needed to recreate the database is in `supabase/`:
`config.toml`, `migrations/`, `seed.sql`, `functions/`. Nothing is created by hand
in the dashboard.

## Local (full stack, needs Docker)

```bash
supabase start                 # Postgres, Auth, Storage, Realtime, Edge runtime
supabase db reset              # apply migrations + seed.sql (dev identity + fixtures)
supabase functions serve       # Edge Functions with supabase/functions/deno.json
supabase status                # prints API URL and anon key for .env
```

Put the printed URL/anon key into `.env` (see `.env.example`). The dev login is
`dev@vixera.local` / `vixera-dev-password`; the identity is the fixed UUID
`00000000-0000-4000-8000-000000000001` (`DEV_USER_ID`).

## Local (migrations only, no Docker)

```bash
pnpm db:verify
```

`scripts/verify-migrations.sh` starts a throwaway PostgreSQL 15/16, applies
`scripts/sql/supabase-shim.sql` (auth schema, roles, `auth.uid()`), every migration,
the seed, and `scripts/sql/verify.sql`. Set `DATABASE_URL` to run the same against
an existing database.

## Edge Functions

| Function | Auth | Purpose |
| --- | --- | --- |
| `action-dispatch` | user JWT (`verify_jwt = true`) | server-side actions (notification actions, One Command mutations, ingestion, handoff, sync-now, person merge); idempotent by key, audited in `action_requests` |
| `connector-link` | user JWT on `POST /`; HMAC-signed state on `GET /callback` (`verify_jwt = false`, verified in code) | start OAuth / Plaid link, finish it on the server, disconnect; tokens go to Vault; creates `connector_accounts` + sync states |
| `connector-sync` | `X-Vixera-Sync-Secret` (pg_cron, all users) or user JWT (`verify_jwt = false`, verified in code) | runs the `SyncEngine` for one account, one user, or all users |
| `ingest-process` | user JWT (`verify_jwt = true`) | runs the ingestion pipeline for one item or every `received` item |

Shared code is imported from `packages/*` through `supabase/functions/deno.json`.
Check locally with `pnpm functions:check` (Deno 2: `deno check` per function +
`deno test` for `_shared`). The HTTP contract shared with the Field, the CORS
origins and the error envelope are documented in `supabase/functions/README.md`.

### Secrets (server configuration, never in git)

```bash
supabase secrets set \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... MICROSOFT_TENANT=common \
  PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \
  VIXERA_SYNC_SECRET=<random 32+ chars> \
  VIXERA_LINK_STATE_SECRET=<random 32+ chars> \
  VIXERA_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
by the platform. `MICROSOFT_TENANT` defaults to `common`; `VIXERA_LINK_STATE_SECRET`
falls back to a key derived from the service role key; `VIXERA_FUNCTIONS_URL` falls
back to `SUPABASE_URL + /functions/v1`. Register
`<VIXERA_FUNCTIONS_URL>/connector-link/callback` as the redirect URI in the Google
and Microsoft app registrations. `VIXERA_ENABLE_MOCK_CONNECTOR=true` (local only)
registers the mock connector. Locally, put the same names in
`supabase/functions/.env` (git-ignored) and run
`supabase functions serve --env-file supabase/functions/.env`.

For scheduled sync also create the two Vault secrets described in
`supabase/migrations/20260910000500_scheduled_sync.sql` (`vixera_functions_url`,
`vixera_sync_secret`); without them the cron job logs a notice and does nothing.

## Deployment

```bash
supabase link --project-ref <ref>
supabase db push                   # migrations only; seed.sql is never pushed
supabase functions deploy action-dispatch connector-link connector-sync ingest-process
```

The dev identity does not exist in a deployed project; create the real user through
Supabase Auth and sign in from the app. `currentUser()` then resolves from the
session (see `current-user.md`).

First-deploy smoke test (nothing in this repository has yet run against a live
project): link one account and confirm the `connector_accounts` row appears in
the Field; `POST connector-sync` with the user JWT and read the report; `POST
action-dispatch` twice with the same idempotency key and confirm `replayed:
true`; `GET connector-link/callback?state=bad` and confirm the "Not connected"
page.

## Storage

Bucket `artifacts` is created by migration 4 (and declared in `config.toml` for
local). Objects are keyed `<user_id>/<purpose>/<uuid>-<name>`; policies allow only
the owner.
