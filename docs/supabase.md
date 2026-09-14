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

## Local (real PostgREST, no Docker)

```bash
pnpm test:live          # starts the stack, runs the store suite against it, fails loudly if it cannot
pnpm db:live            # just start it; prints VIXERA_LIVE_URL / VIXERA_LIVE_JWT_SECRET
pnpm db:live:down
```

`scripts/live-stack.sh` starts a throwaway PostgreSQL, applies the migrations and
seed, and serves them through a real PostgREST (plus a small proxy so
`supabase-js` can address `/rest/v1`). It is what proves the Supabase store
against the real API surface: PostgREST's `db-max-rows` cap, `numeric` as JSON
number, `on conflict` targets, RPC signatures, trigger-raised errors and RLS.
`VIXERA_REST_MAX_ROWS=5 pnpm db:live` is a useful stress: every read must still
return the whole set.

Only `postgrest` (a single static binary) is required beyond PostgreSQL; put it
on `PATH` or at `/tmp/vixera-live-stack/postgrest`.

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

### The project

| | |
| --- | --- |
| Project | `Vixera-ONE`, region `us-east-1`, Postgres 17 |
| Ref | `uhdlacchajiblhmgasjg` |
| API | `https://uhdlacchajiblhmgasjg.supabase.co` |

**Schema: deployed through migration 8.** Migrations 9
(`20260914000100_realtime_replica_identity`) and 10
(`20260914000200_ingest_attempts`) were added on 2026-09-14 and are **not yet
applied** to the live project — `supabase db push` is due; until it runs, the
Realtime DELETE exposure migration 9 closes (`docs/sync.md` → Realtime) is
live, and the ingest pipeline's `attempts` column is missing (an
`ingest.submit` against the live project would fail on insert). Verified on
the live database after migration 8: 18 tables, none without `user_id`, none without RLS, 19 policies, 20
enums, 15 `vx_*` functions, 33 triggers, the private `artifacts` bucket, seven
tables in the realtime publication, and the `vixera-connector-sync` cron job.
Two throwaway users proved isolation end to end: each saw only its own rows,
neither could plant a row for the other or reference the other's parents through
a foreign key, dangling graph edges and polymorphic subjects were refused, and a
client could not write `credential_ref`, a sync checkpoint or an
`action_requests` row, nor call the credential vault.

**Functions: not deployed yet.** They need a Supabase access token, which this
repository deliberately does not hold.

```bash
SUPABASE_ACCESS_TOKEN=sbp_...  scripts/deploy-functions.sh uhdlacchajiblhmgasjg
```

The script type-checks each function with Deno and deploys the raw sources with
the same JWT gates as `config.toml`; the CLI bundles them itself, following the
workspace imports through `supabase/functions/deno.json`. (An earlier version
of the script bundled into `dist/functions` first — dead work, since the CLI
resolves functions from the repository's own `supabase/` folder; the 2026-09-11
deployment below went out exactly this way.)

### Schema changes after this point

```bash
supabase link --project-ref uhdlacchajiblhmgasjg
supabase db push                   # migrations only; seed.sql is never pushed
```

The dev identity does not exist in a deployed project; create the real user through
Supabase Auth and sign in from the app. `currentUser()` then resolves from the
session (see `current-user.md`).

**Deployed to `uhdlacchajiblhmgasjg` on 2026-09-11.** All four functions are
ACTIVE at version 1, with the JWT gates as designed: `action-dispatch` and
`ingest-process` verify the platform JWT; `connector-link` and `connector-sync`
do not, because each authenticates its own caller in the function body (the
OAuth callback arrives from the system browser with no Vixera session, and cron
presents `X-Vixera-Sync-Secret`). Verified live: both gated functions answer an
anon key with Vixera's own `unauthorized` envelope rather than a platform error,
which is what proves the module booted; `connector-sync` rejects a missing
bearer and a wrong secret; `connector-link` answers a bare GET with `405` and a
preflight with `204`. The full scheduled chain — `pg_cron` →
`vx_trigger_scheduled_sync()` → `pg_net` → `connector-sync` → `200` — was run
end to end and logged in `net._http_response`.

First-deploy smoke test, once the functions are up: link one account and confirm
the `connector_accounts` row appears in the Field; `POST connector-sync` with the
user JWT and read the report; `POST action-dispatch` twice with the same
idempotency key and confirm `replayed: true`; `GET
connector-link/callback?state=bad` and confirm the "Not connected" page.

## Auth

The door (`docs/field.md`) is email + password against Supabase Auth and nothing
else; no OAuth provider is configured on the project and the social row is not
rendered. What the code assumes about the project's Auth settings:

| Setting | Value the app is written for | Why |
| --- | --- | --- |
| Providers | Email only | the door offers nothing else |
| Sign-ups | allowed | "Create account" calls `signUp`; `vx_handle_new_auth_user` copies the name into `public.users` |
| Confirm email | on (live project: `mailer_autoconfirm` off) | `signUp` returns no session and the door says "open the link, then sign in"; with it off the person is signed in at once, which the door also handles |
| Reset Password template | **must include `{{ .Token }}`** | recovery is by code: `resetPasswordForEmail` with no redirect, then `verifyOtp({ type: "recovery" })`. Supabase's default template carries `{{ .ConfirmationURL }}` and no code, which a desktop app has nowhere to receive — with the default template the recover screen can only ever say "that code is not right". Add a line such as `Your code: {{ .Token }}` (keep the link if a web client ever exists). **Not verified on the live project from this repository**; do it in the dashboard (Auth → Email Templates) before anyone needs it |
| Email sender | Supabase built-in, a few messages per hour | fine for one person; the door names this quota when it is hit; real SMTP before a launch |
| Refresh token rotation | default (on) | supabase-js refreshes in the background; sign-out is `scope: "local"` so one device's revocation leaves the others signed in |

`auth.users` is not read by the app; `public.users` (kept in step by trigger) is
the row RLS policies and graph edges hang off.

## Storage

Bucket `artifacts` is created by migration 4 (and declared in `config.toml` for
local). Objects are keyed `<user_id>/<purpose>/<uuid>-<name>`; policies allow only
the owner.

## pg_net is readable by anon and authenticated, and cannot be fixed from `postgres`

`vx_trigger_scheduled_sync()` calls `net.http_post`, which puts the row — URL,
body and **headers, including `X-Vixera-Sync-Secret`** — into
`net.http_request_queue` until pg_net's worker picks it up. pg_net grants that
table, `net._http_response` and every `net.*` function to **PUBLIC**, so `anon`
and `authenticated` can read them.

It cannot be revoked from this project. Those objects are owned by
`supabase_admin`; the role the CLI, MCP and the SQL editor all connect as
(`postgres`) is neither a superuser nor a member of it, so a `REVOKE` is a silent
no-op — Postgres warns rather than errors, which means a migration that tries it
**reports success and changes nothing**. Verify with `relacl` / `proacl`, never
with `has_table_privilege`:

```sql
select relname, relacl from pg_class where relnamespace = 'net'::regnamespace;
-- `=arwdDxtm/supabase_admin` — empty grantee — is the grant to PUBLIC
```

Why it is being accepted rather than worked around:

- **Not reachable with the shipped key.** PostgREST exposes only `public`. The
  anon key compiled into the installers reaches PostgREST and GoTrue, not raw
  Postgres, so there is no way to run `select * from net.http_request_queue`
  with it. Reading it needs a direct database connection, which needs the
  database password.
- **Nothing is stored durably.** The worker deletes the queue row as it sends,
  so the secret exists there for milliseconds per tick, ten minutes apart.
  `net._http_response` keeps *response* headers only — the request headers, and
  therefore the secret, are never written to it.
- **Small blast radius if it did leak.** `X-Vixera-Sync-Secret` authorises one
  thing: asking `connector-sync` to run a scheduled pass. That returns counts,
  not user data, and every account it touches is still scoped by `user_id`.
  Rotate with `supabase secrets set VIXERA_SYNC_SECRET=...` plus
  `vault.create_secret(..., 'vixera_sync_secret')`.

The residual risk is therefore defence-in-depth only: a future SQL-injectable
`SECURITY INVOKER` function in `public` would hand an attacker an SSRF primitive
along with everything else it already hands them. Every `public` function here is
parameterised plpgsql with `search_path` pinned; keep it that way.

The `extension_in_public` advisor warning about `pg_net` has the same root and
the same answer: the extension's registration marker is in `public`, but all
twelve of its functions live in `net`, so nothing of pg_net is callable through
PostgREST.
