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
| `action-dispatch` | user JWT | server-side actions (notification actions, One Command mutations); idempotent by key, audited in `action_requests` |
| `connector-link` | user JWT | finish OAuth / Plaid link on the server; stores tokens in Vault; creates `connector_accounts` + sync states |
| `connector-sync` | `X-Vixera-Sync-Secret` (cron) or user JWT | runs the `SyncEngine` for one account, one user, or all users |
| `ingest-process` | user JWT | turns `ingest_items` into documents, relationships and context events |

Shared code is imported from `packages/*` through `supabase/functions/deno.json`.
Check locally with `pnpm functions:check` (Deno).

### Secrets (server configuration, never in git)

```bash
supabase secrets set \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... \
  PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \
  VIXERA_SYNC_SECRET=<random 32+ chars>
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
by the platform. For scheduled sync also create the two Vault secrets described in
`supabase/migrations/20260910000500_scheduled_sync.sql`.

## Deployment

```bash
supabase link --project-ref <ref>
supabase db push                   # migrations only; seed.sql is never pushed
supabase functions deploy action-dispatch connector-link connector-sync ingest-process
```

The dev identity does not exist in a deployed project; create the real user through
Supabase Auth and sign in from the app. `currentUser()` then resolves from the
session (see `current-user.md`).

## Storage

Bucket `artifacts` is created by migration 4 (and declared in `config.toml` for
local). Objects are keyed `<user_id>/<purpose>/<uuid>-<name>`; policies allow only
the owner.
