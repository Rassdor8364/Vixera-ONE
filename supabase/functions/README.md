# Edge Functions (Vixera One)

Deno 2, web-standard APIs. Workspace packages are imported through `deno.json`
(`@vixera/domain`, `@vixera/sync`, `@vixera/connector-*`). Check locally with
`pnpm functions:check` (`deno check` per function + `deno test` for `_shared`).
There is no Docker requirement for that; `supabase functions serve` runs the
same code with the local stack.

## HTTP contract (shared with the Field)

All calls: `POST https://<project>/functions/v1/<name>` with
`Authorization: Bearer <access token>`, `apikey: <anon key>`,
`Content-Type: application/json`. Errors are `{ error: { code, message } }`
with 400 / 401 / 403 / 404 / 409 / 413 / 500. CORS allows
`http://localhost:1420`, `http://127.0.0.1:1420`, `tauri://localhost`,
`http://tauri.localhost`, `https://tauri.localhost`.

| Function | Body | Response |
| --- | --- | --- |
| `action-dispatch` | `ActionEnvelope` (`@vixera/domain`) | `ActionOutcome`; replay of a key ⇒ `replayed: true`, never re-executed; still running ⇒ 409 `in_progress` |
| `connector-link` | `{ provider: "google" \| "microsoft", step: "start" }` | `{ authorizationUrl, expiresAt }` — browser lands on `GET …/connector-link/callback?code&state` which renders "Connected — return to Vixera One" |
| | `{ provider: "plaid", step: "start" }` | `{ linkToken, hostedLinkUrl \| null, expiration }` |
| | `{ provider: "plaid", step: "complete", publicToken? \| linkToken? }` | `{ account: ConnectorAccount }` |
| | `{ provider, step: "disconnect", connectorAccountId }` | `{ ok: true }` |
| `connector-sync` | `{ connectorAccountId? }` | `{ report: SyncReport }`; with header `X-Vixera-Sync-Secret` (pg_cron) runs every user ⇒ `{ users, outcomes, errors, skippedForBudget }` |
| `ingest-process` | `{ ingestItemId? }` | `{ processed, documentIds, failed, items }` |

The Field learns that a link finished by subscribing to `connector_accounts`
(Realtime) or polling `listConnectorAccounts()` every 3 s for up to 3 min.

## Identity

`_shared/auth.ts` is the server-side realization of `currentUser()`: identity
is resolved per request from the verified Bearer token and threaded into a
`SupabaseSpineStore` bound to that user id. `setCurrentUserProvider()` is never
called in a function (one isolate serves many users). The service role is only
used after identity is established, through user-bound stores; user ids never
come from a body, a query string or provider data. The OAuth callback carries
identity in an HMAC-signed, expiring state token (`_shared/state.ts`).

## Layout

```
_shared/env.ts          typed Deno.env access; missing provider secrets ⇒ provider absent
_shared/http.ts         json/error envelope, CORS, body limit, route(), serveWith(), logger()
_shared/auth.ts         authenticate(req, authClient) → { userId }
_shared/spine.ts        service/anon clients, spineForUser(), scheduled-sync user list
_shared/credentials.ts  VaultCredentialStore (vx_credential_get/put/delete)
_shared/connectors.ts   buildRegistry(env): Google, Microsoft, Plaid, Mock (dev only)
_shared/sync.ts         runSync / runSyncForUser with a wall-clock budget
_shared/actions.ts      every ActionType handler + dispatchAction (idempotent, audited)
_shared/ingest.ts       processIngestItem — THE ingestion pipeline
_shared/link.ts         OAuth / Plaid link flows + persistLinkedAccount + disconnect
_shared/state.ts        signed link state tokens
_shared/*_test.ts       Deno tests against InMemorySpineStore (no network)
<function>/index.ts     Deno.serve handlers
```

## Secrets (server configuration; never in git)

```bash
supabase secrets set \
  GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  MICROSOFT_CLIENT_ID=... MICROSOFT_CLIENT_SECRET=... MICROSOFT_TENANT=common \
  PLAID_CLIENT_ID=... PLAID_SECRET=... PLAID_ENV=sandbox \
  VIXERA_SYNC_SECRET=<random 32+ chars> \
  VIXERA_LINK_STATE_SECRET=<random 32+ chars> \
  VIXERA_FUNCTIONS_URL=https://<ref>.supabase.co/functions/v1
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected
by the platform. `VIXERA_LINK_STATE_SECRET` falls back to a key derived from
the service role key; `VIXERA_FUNCTIONS_URL` falls back to
`SUPABASE_URL + "/functions/v1"`. Register
`<VIXERA_FUNCTIONS_URL>/connector-link/callback` as the redirect URI in the
Google and Microsoft app registrations. `VIXERA_ENABLE_MOCK_CONNECTOR=true`
(local only) registers the `MockConnector` under provider `mock`.

Locally, put the same names in `supabase/functions/.env` (git-ignored) and run
`supabase functions serve --env-file supabase/functions/.env`.

## Deploy

```bash
supabase functions deploy action-dispatch connector-link connector-sync ingest-process
```

`config.toml` sets `verify_jwt = false` for `connector-link` (the OAuth
callback has no Vixera session) and `connector-sync` (pg_cron authenticates
with the shared secret); both verify the JWT themselves on the user paths.
