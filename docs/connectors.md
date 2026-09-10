# Connector contract

Every external service sits behind the `Connector` interface in
`packages/domain/src/connectors/connector.ts` (mandatory seam #3 of the brief).
A connector knows its provider's API; nothing else in the codebase does. This
page describes the interface, the account/credential model, the checkpoint
each provider persists, how errors map to engine behaviour, the link flows, and
how to add a provider. The sync loop that drives connectors is in
[`sync.md`](./sync.md).

Packages:

| Package | Provider id | Capabilities | Notes |
| --- | --- | --- | --- |
| `packages/connectors/google` (`@vixera/connector-google`) | `google` | `mail`, `calendar` | Gmail + Google Calendar, OAuth 2.0 |
| `packages/connectors/microsoft` (`@vixera/connector-microsoft`) | `microsoft` | `mail`, `calendar` | Microsoft Graph (Outlook mail + calendar), Entra ID OAuth 2.0 |
| `packages/connectors/bank` (`@vixera/connector-bank`) | `plaid` (or `mock`) | `bank` | READ-only over a `BankProvider` adapter: `PlaidBankProvider`, `MockBankProvider` |
| `packages/sync/src/testing/mock-connector.ts` | `mock` | `mail`, `calendar`, `bank` | Deterministic fixtures for tests and dev-fixture mode |
| `packages/connectors/praxion` | `praxion` | `document` (local) | Not a sync source; see [`praxion-contract.md`](./praxion-contract.md) |

Connector packages depend on `@vixera/domain` only: no React, no Tauri, no
Supabase, no `@vixera/sync`. They run unchanged in Deno (Edge Functions),
Node (Vitest) and a browser, using only `fetch`, `URL` and `Date`.

## The interface

```ts
interface Connector extends Partial<MailSyncSource>, Partial<CalendarSyncSource>, Partial<BankSyncSource> {
  readonly provider: ProviderId;                      // "google" | "microsoft" | "plaid" | "praxion" | "mock"
  readonly capabilities: readonly ConnectorCapability[]; // subset of "mail" | "calendar" | "bank" | "document"
  discoverAccount(ctx: Omit<SyncContext, "account">): Promise<DiscoveredAccount>;
  refreshCredential?(ctx: Omit<SyncContext, "account">): Promise<ConnectorCredential>;
}
interface MailSyncSource     { syncMail(ctx, checkpoint): AsyncIterable<SyncPage<MailSyncBatch>> }
interface CalendarSyncSource { syncCalendar(ctx, checkpoint): AsyncIterable<SyncPage<CalendarSyncBatch>> }
interface BankSyncSource     { syncBank(ctx, checkpoint): AsyncIterable<SyncPage<BankSyncBatch>> }
```

* **Stateless per account.** One connector instance serves every account of
  its provider; everything account-specific arrives in the `SyncContext`
  (`account`, `credential`, `now`, `fetch`, `onCredentialRefreshed`, `log`).
  Provider client ids/secrets are constructor options (server configuration),
  never part of a credential and never logged.
* **`discoverAccount`** resolves who a freshly obtained credential belongs to
  (`externalAccountId`, `label`, `address`, `capabilities`, `metadata`). The
  link flow turns this into a `connector_accounts` row. Google uses the OpenID
  `sub`, Microsoft the Graph user id, Plaid the item id.
* **Pages.** A sync source is an async iterable of `SyncPage<TBatch>`:
  `{ batch, checkpoint, done, fullResync? }`. The engine applies `batch`
  through the `ContextLinker` first and only then persists `checkpoint`
  (`null` = keep the previous one). `done: false` asks for another page.
  `fullResync: true` says the provider invalidated the previous checkpoint and
  this page starts from scratch (logged; the store still upserts by natural
  key, so nothing is deleted on a full resync).
* **Batches** contain only normalized domain objects from
  `packages/domain/src/connectors/normalized.ts`: `NormalizedMailMessage`,
  `NormalizedTimeEvent`, `NormalizedMoneyAccount`, `NormalizedMoneyTransaction`
  and `NormalizedDeletion` (`{ externalId, externalCalendarId? }`). Provider
  JSON never leaves the connector package (`src/*/types.ts` are private).
  Money amounts are decimal strings (`canonicalDecimal`), negative = leaves
  the account.
* **`supports(connector, capability)`** is the type guard the engine uses to
  pick the page source.

`ConnectorRegistry` (`packages/domain/src/connectors/registry.ts`) maps
provider id → instance and is the only place that knows which providers
exist. On the server `buildRegistry(env)` in
`supabase/functions/_shared/connectors.ts` registers Google, Microsoft and
Plaid when their secrets are set, and the mock connector when
`VIXERA_ENABLE_MOCK_CONNECTOR=true`. A provider without secrets is simply
absent: linking returns `provider_not_configured`, syncing its accounts records
"No connector registered" per capability, nothing crashes at import.

## Capabilities

| Capability | Source | Rows written by the linker |
| --- | --- | --- |
| `mail` | Gmail, Graph inbox | `mail_messages`, attachment `documents` (metadata only, `location.kind = "provider"`), `people`, `relationships`, `context_events` |
| `calendar` | Google Calendar, Graph calendarView | `time_events`, `people`, `relationships`, `context_events` |
| `bank` | Plaid `/transactions/sync` + `/accounts/get` | `money_accounts` (balances), `money_transactions`, `relationships`, `context_events` |
| `document` | Praxion (local) | never paged by the engine; `runCapability` reports it as skipped rather than failing every cycle |

An account's `capabilities` array says what it feeds; a Google account feeds
mail **and** calendar with one credential. Each capability has its own
`connector_sync_states` row (ADR-004).

## Multi-account model

One user → many `connector_accounts`, possibly several per provider (personal
Gmail + Workspace Gmail + two Plaid items). The natural key is
`(user_id, provider, external_account_id)`; re-linking the same provider
identity updates the existing row instead of creating a second one. There is
no `user.hasGoogle`: code asks the store for accounts and their capabilities.

```
connector_accounts            one row per linked provider identity
  provider, external_account_id, label, address, capabilities[]
  status: active | paused | needs_reauth | error | disconnected
  credential_location: server_vault | device | none
  credential_ref: opaque Vault id (never the secret), last_error, metadata
connector_sync_states         one row per (account, capability)
  enabled, status: idle | running | error, checkpoint jsonb,
  last_attempt_at, last_success_at, last_error, consecutive_failures
```

`authenticated` clients may update only `label`, `status`, `metadata` on
accounts and `enabled` on sync states; everything else is written by the
server (`connector-link`, the engine). The Field lists accounts and sync
states read-only (`useConnectorAccounts`) and triggers link / sync / disconnect
through Edge Functions.

## Credentials

`packages/domain/src/connectors/credentials.ts`:

```ts
type ConnectorCredential =
  | { kind: "oauth2"; accessToken; refreshToken: string | null; expiresAt: IsoDateTime | null; scopes: string[]; tokenType? }
  | { kind: "access_token"; accessToken; expiresAt?: IsoDateTime | null }   // Plaid
  | { kind: "api_key"; apiKey };
interface CredentialStore {
  put(ref: CredentialRef | null, credential): Promise<CredentialRef>;
  get(ref): Promise<ConnectorCredential | null>;
  delete(ref): Promise<void>;
}
```

* Accounts reference credentials by `credentialRef`; the secret itself lives
  in Supabase Vault (`VaultCredentialStore`,
  `supabase/functions/_shared/credentials.ts`, RPCs `vx_credential_put/get/delete`
  from migration `20260910000300`). `InMemoryCredentialStore` serves tests
  and dev-fixture mode. Full map: [`credentials.md`](./credentials.md).
* **Refresh.** Before paging, the engine checks `isExpired(credential, now)`
  (60 s skew). If expired and the connector has `refreshCredential`, the
  engine calls it and persists the result with `put(existingRef, …)` (same
  ref). Google and Microsoft also refresh reactively: their HTTP clients
  retry one 401 after a refresh and report the new credential through
  `ctx.onCredentialRefreshed`, which the engine persists the same way.
  Concurrent 401s share one in-flight refresh.
* Google requests `access_type=offline&prompt=consent` so every link yields a
  refresh token; Microsoft requests `offline_access`. A credential without a
  refresh token cannot be renewed and surfaces as `unauthorized` → the
  account needs re-linking.
* `redact()` and `redactCredential()` strip token material from anything
  persisted in `last_error` or logged.

## Checkpoints per provider

`connector_sync_states.checkpoint` is opaque JSON to the engine and owned by
the provider module that wrote it. Each module has a `parse…Checkpoint`
function that treats anything malformed as "no checkpoint" (a full backfill),
never as an error.

### Gmail — `packages/connectors/google/src/gmail/sync.ts`

```
{ historyId: string, backfill?: { pageToken: string | null, since: IsoDateTime, fullResync?: true } }
```

* First run: `users/me/profile` → `historyId` is captured **before** the
  backfill lists `messages.list?q=newer_than:<backfillDays>d` (default 30
  days, 100 ids per page, message fetch concurrency 4). While `backfill` is
  present each page carries the next `pageToken`, so a crash resumes the
  backfill page-by-page. The last page drops `backfill`.
* Incremental: `history.list?startHistoryId=<historyId>` (500 records/page);
  the checkpoint advances to the last history record id of each page, so a
  multi-page history run is restartable.
* `history.list` **404** (Gmail no longer holds history back to our id) →
  the source yields a fresh backfill with `fullResync: true`.
* Message ids are the natural key; deletions come from history
  `messagesDeleted`; unread is derived from the `UNREAD` label.

### Google Calendar — `packages/connectors/google/src/calendar/sync.ts`

```
{ calendars: { [calendarId]: { syncToken: string } } }
```

* Calendars: every `calendarList` entry that is selected and more than
  free/busy, plus `primary` always (`selectCalendars`). Each calendar syncs
  independently; tokens for calendars that no longer exist are dropped.
* First run per calendar: `events.list?singleEvents=true&showDeleted=true`
  over the window (default 30 days back, 90 ahead, 250 per page). The
  calendar's `nextSyncToken` is written only after its last page, so a crash
  mid-calendar re-lists just that calendar.
* Incremental: `events.list?syncToken=…`; `status: cancelled` → deletion.
* **410** on a sync-token request → that calendar re-lists from scratch with
  `fullResync: true`. A 410 without a token is a real error.

### Microsoft Graph mail — `packages/connectors/microsoft/src/mail/sync.ts`

```
{ deltaLink: string }
```

* First run: `GET /me/mailFolders/inbox/messages/delta?$select=…&$filter=receivedDateTime ge <now − backfillDays>`
  (inbox only, bodies as text via `Prefer: outlook.body-content-type="text"`,
  page size 50 via `Prefer: odata.maxpagesize`). Attachment metadata is one
  extra request per message with `hasAttachments`.
* Every `@odata.nextLink` page is one `SyncPage` that keeps the **previous**
  checkpoint (a nextLink is not durable); the final page carries the new
  `@odata.deltaLink`. A crash mid-round replays the last complete delta
  round, which the natural keys absorb.
* `@removed` tombstones → deletions. **410** on a delta link → restart from
  the initial backfill with `fullResync: true`; a 410 on a fresh query is
  thrown as `checkpoint_invalid`.
* `parseMailCheckpoint` refuses a `deltaLink` that is not a
  `graph.microsoft.com` URL, so a corrupted checkpoint can never send a
  bearer token elsewhere.

### Microsoft Graph calendar — `packages/connectors/microsoft/src/calendar/sync.ts`

```
{ deltaLink: string, window: { start: IsoDateTime, end: IsoDateTime } }
```

* `GET /me/calendarView/delta?startDateTime=<now − pastDays>&endDateTime=<now + futureDays>`
  over the default calendar, UTC times (`Prefer: outlook.timezone="UTC"`),
  then the delta link. `isCancelled` and `@removed` → deletions.
* A delta link only tracks the window it was opened with. When the stored
  window is more than `WINDOW_MAX_AGE_DAYS` (7) older than a fresh one would
  be, the source re-opens a new window with `fullResync: true` so upcoming
  events keep flowing. 410 → same restart.

### Plaid — `packages/connectors/bank/src/connector.ts`

```
{ cursor: string }
```

* `BankConnector.syncBank`: page 1 = all accounts of the item with balances
  (`/accounts/get`, always refreshed) + the first `/transactions/sync` page
  (500 per page); following pages carry transaction changes only. `added` and
  `modified` are upserted, `removed` ids become deletions.
* Each page's `checkpoint` is that page's `next_cursor`. The connector's own
  "committed cursor" advances only after the consumer asked for the next
  page, so a restart after Plaid's
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` begins at exactly the cursor
  the engine persisted (max 3 attempts, then `ConnectorError("unknown")`).
* `PlaidClient` allow-lists read endpoints (`PLAID_READ_ENDPOINTS`); any
  other endpoint throws `unsupported`. There is no method on `BankProvider`
  that can move money.

### Mock — `packages/sync/src/testing/mock-connector.ts`

`{ version, page }` per capability. A second run with the previous checkpoint
returns one empty page unless a test hook changed the fixtures.

## Errors → engine behaviour

`ConnectorError(code, message, retryable)`; `retryable` defaults to true for
`rate_limited` and `provider_unavailable`.

| Code | Raised by | Engine (`SyncEngine.runCapability`) |
| --- | --- | --- |
| `unauthorized` | 401 after one refresh attempt, 403 without a quota reason, refresh without refresh token, Plaid `ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN` / `ITEM_NOT_FOUND` | account `status = needs_reauth` (+ `last_error`), sync state `error`; the remaining capabilities of that account are skipped ("account needs_reauth") until the user re-links |
| `checkpoint_invalid` | Graph 410 on a fresh query, corrupted checkpoint the source cannot repair | checkpoint cleared and the capability retried **once** from scratch in the same run; a second failure is recorded as an error |
| `rate_limited` | 429, Google 403 quota, Plaid `RATE_LIMIT_EXCEEDED` | state `error`, `consecutive_failures + 1`; nothing sleeps — the next scheduled run (10 min) retries from the persisted checkpoint |
| `provider_unavailable` | network failure, 5xx | same as rate limited |
| `invalid_response` | provider body missing required fields | state `error`; not retried within the run |
| `unsupported` | capability not implemented by the connector, wrong credential kind, disallowed Plaid endpoint | state `error` |
| `unknown` | anything else | state `error` |
| *(missing credential)* | `credentialRef` null or Vault returns nothing | account `needs_reauth`, outcome `errorCode: "credential_missing"` |

Every failure is isolated to one (account, capability): `runAll()` and
`runSync()` never throw because a connector failed; the `SyncReport` lists an
outcome per pair. Messages persisted in `last_error` are passed through
`redactCredential` and cut to 1000 chars. An account in `error` status that
later syncs successfully is set back to `active`.

## Link flows (`connector-link` Edge Function)

Linking happens **server-side** so provider tokens never reach a device
(ADR-003). Code: `supabase/functions/_shared/link.ts`, `state.ts`; Field side
`apps/desktop/src/data/link.ts` and `field/areas/Connectors.tsx`.

### OAuth (Google, Microsoft)

1. Field `POST connector-link { provider, step: "start" }` (user JWT).
2. Server signs a state token
   `base64url(JSON{ userId, provider, exp, nonce }) + "." + base64url(HMAC-SHA256)`
   (`signLinkState`, TTL 10 min, key `VIXERA_LINK_STATE_SECRET` or a key
   derived from the service role key) and returns `{ authorizationUrl, expiresAt }`
   with `redirect_uri = <VIXERA_FUNCTIONS_URL>/connector-link/callback`
   (`GOOGLE_SCOPES` = gmail.readonly, calendar.readonly, userinfo.email,
   openid; `MICROSOFT_SCOPES` = openid, offline_access, User.Read, Mail.Read,
   Calendars.Read).
3. Field opens the URL in the **system browser** (`openUrl`) and waits for a
   new `connector_accounts` row (Realtime refresh, or polling every 3 s for
   up to 3 min in `waitForNewAccount`).
4. The provider redirects the browser to `GET …/connector-link/callback?code&state`.
   There is no Vixera session on that request (`verify_jwt = false` in
   `config.toml`); identity comes only from the verified state. Tampered,
   foreign-key or expired states → 400 `invalid_state`; `?error=` from the
   provider → 400.
5. `exchangeAuthorizationCode` (client secret from the function environment),
   `connector.discoverAccount`, then `persistLinkedAccount`: find-or-create
   the account by `(provider, externalAccountId)`, `vx_credential_put` →
   `credential_ref` + `credential_location = server_vault`, status `active`,
   and a `connector_sync_states` row per capability (existing disabled states
   are re-enabled; checkpoints are kept, so a re-link does not re-backfill).
6. The browser shows "Connected — return to Vixera One"; the Field's
   Realtime subscription on `connector_accounts` (publication in migration
   `20260910000700`) refreshes the list.

### Plaid

1. `POST connector-link { provider: "plaid", step: "start" }` → server calls
   `/link/token/create` for `products: ["transactions"]`, `country_codes: ["US"]`,
   `client_user_id = <Vixera user id>` with `hosted_link: {}`; if the Plaid
   client has no Hosted Link it falls back to a plain Link token. Response
   `{ linkToken, hostedLinkUrl | null, expiration }`.
2. The Field requires `hostedLinkUrl` (it has no Plaid Link web widget) and
   opens it in the system browser; it shows "I finished linking the bank".
3. `POST connector-link { provider: "plaid", step: "complete", linkToken }` →
   server reads the finished hosted session (`/link/token/get`,
   `link_sessions[].results.item_add_results[].public_token`; not finished →
   409 `conflict`), then `completeBankLink`: `/item/public_token/exchange` →
   `access_token` credential, `discoverAccount` (`/item/get` → item id,
   institution name), `persistLinkedAccount`. A caller that ran Plaid Link
   itself can send `publicToken` instead of `linkToken`.

### Disconnect

`POST connector-link { provider, step: "disconnect", connectorAccountId }` →
`vx_connector_account_disconnect(account)`: Vault secret deleted,
`credential_ref` cleared, account `disconnected`, sync states disabled. Rows
already synced from that account stay in the spine. The provider-side grant is
**not** revoked (see below).

## Adding a provider

1. **Domain**: add the id to `PROVIDER_IDS` in
   `packages/domain/src/entities/connector-account.ts` and to the SQL enum
   `provider_id` in a new migration (`schema-sync.test.ts` fails if they
   drift). Add a capability only if it is genuinely new.
2. **Package** `packages/connectors/<name>` depending on `@vixera/domain`
   only. Implement `Connector`: `discoverAccount`, optional
   `refreshCredential`, one `sync<Capability>` async generator per
   capability. Keep provider JSON in `src/**/types.ts`, normalization in
   `normalize.ts` (pure, unit-tested against fixtures in `__fixtures__/`),
   HTTP + error mapping in `http.ts`, and a `parse<X>Checkpoint` that
   degrades to a full backfill. Add `vitest.config.ts`, `tsconfig.json`,
   register the package in the root `vitest.config.ts` projects list if the
   glob does not already cover it.
3. **Page discipline**: yield a checkpoint only for a page that is safe to
   resume from; keep the previous checkpoint on intermediate pages; mark
   `fullResync` when the provider forced a restart; never throw for
   conditions you can repair (re-list); throw `ConnectorError` with the right
   code for the rest.
4. **Server**: register it in `buildRegistry` (`_shared/connectors.ts`) behind
   its env variables (`_shared/env.ts`), add the import to
   `supabase/functions/deno.json`, and — for OAuth — extend `LinkProvider` in
   `_shared/state.ts` and the start/exchange branches in `_shared/link.ts`.
5. **Field**: add the provider to `PROVIDERS` in
   `apps/desktop/src/field/areas/Connectors.tsx` and to `LinkProvider` in
   `apps/desktop/src/data/link.ts`; add the workspace dependency to
   `apps/desktop/package.json` if the Field imports anything from it.
6. **Tests**: normalization from fixtures, multi-account separation (two
   accounts of the same provider through one instance), checkpoint
   round-trip, error mapping, and an engine run against `InMemorySpineStore`
   proving a second run with the produced checkpoint changes nothing.

## Deliberately not implemented

* Provider-side revocation on disconnect (Google/Microsoft token revocation,
  Plaid `/item/remove`); disconnect only deletes the Vault secret.
* Plaid Link web widget in the Field: Hosted Link is required; without it the
  Field reports "Plaid Hosted Link is not enabled for this project".
* Push notifications / webhooks (Gmail watch, Graph subscriptions, Plaid
  webhooks): sync is pull-based on a 10-minute schedule plus on-demand runs.
* Attachment bytes: mail attachments are documents with
  `location.kind = "provider"` (message id + attachment id); nothing is
  downloaded. Files reach Storage only through explicit ingestion.
* Mail folders other than the inbox (Graph), calendars the user deselected
  (Google), shared mailboxes, contacts/directory sync, Drive/OneDrive.
* Any write: sending mail, creating events, moving money. The interfaces have
  no such methods.
* Device-hosted sync with device-resident provider tokens (`credential_location = "device"`
  exists in the enum; nothing writes it).
* The `mock` provider outside tests / dev-fixture mode / `VIXERA_ENABLE_MOCK_CONNECTOR=true`.
