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
  key, so nothing is deleted on a full resync — which also means rows the
  provider removed during the gap are **not** reconciled; see the Gmail and
  Google Calendar notes below).
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
| `mail` | Gmail (every label except Spam, Trash, Drafts, Chats; Sent kept without a sender), Graph inbox | `mail_messages`, attachment `documents` (metadata only, `location.kind = "provider"`), `people`, `relationships`, `context_events` |
| `calendar` | Google Calendar, Graph calendarView | `time_events`, `people`, `relationships`, `context_events` |
| `bank` | Plaid `/transactions/sync` + `/accounts/get` | `money_accounts` (balances), `money_transactions`, `relationships`, `context_events` |
| `document` | Praxion (local) | never paged by the engine; `runCapability` reports it as skipped rather than failing every cycle |

An account's `capabilities` array says what it feeds; a Google account feeds
mail **and** calendar with one credential — or only one of them: Google's
consent screen lets the user untick scopes, and `discoverAccount` derives the
capabilities from the scopes actually granted (`capabilitiesForScopes`:
`gmail.readonly`, `gmail.modify` or `https://mail.google.com/` → `mail`;
`calendar.readonly` or `calendar` → `calendar`. `gmail.metadata` and
`calendar.events*` grant nothing, because the sync cannot run under them —
no `q` filter or `format=full` on Gmail, no calendarList read on Calendar —
and claiming a capability that fails every cycle is what this exists to
avoid. A grant covering neither fails the link with a `400` that names the
problem). Each capability has its own `connector_sync_states` row (ADR-004).

Known limitation: a calendar checkpoint written before series tracking
existed (a `syncToken` and no `series`) does not fan out a cancelled
recurring master to its stored instances until that calendar re-lists (a
`410`, or a rejected page token). No production account has synced yet, so
no such checkpoint exists; if one ever does, clearing the calendar's token
once re-lists it idempotently. Gmail's `metadata.direction` (`sent` /
`received`) is recorded on every message and read by nothing yet; the linker
still scores sent mail as received-mail attention (roadmap).

## Multi-account model

One user → many `connector_accounts`, possibly several per provider (personal
Gmail + Workspace Gmail + two Plaid items). The natural key is
`(user_id, provider, external_account_id)`; re-linking the same provider
identity updates the existing row instead of creating a second one. For Plaid
the identity is the Item id, and only a Link **update mode** session keeps
it: a fresh Link session for the same bank creates a second Item (new
item_id, account_ids and transaction_ids) and therefore a second row with a
full backfill — see the Plaid link flow below. There is no `user.hasGoogle`:
code asks the store for accounts and their capabilities.

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
  backfill lists `messages.list?q=newer_than:<backfillDays>d -in:drafts -in:chats`
  (default 30 days, 100 ids per page, message fetch concurrency 4;
  `messages.list` already leaves out Spam and Trash). While `backfill` is
  present each page carries the next `pageToken`, so a crash resumes the
  backfill page-by-page. The last page drops `backfill`. A stored page token
  Gmail later rejects (400) is thrown as `checkpoint_invalid`.
* Incremental: `history.list?startHistoryId=<historyId>` (500 records/page,
  no label filter — Sent and archived mail must flow too); the checkpoint
  advances to the last history record id of each page, so a multi-page
  history run is restartable.
* **Label semantics** (`GMAIL_HIDDEN_LABELS` = `TRASH`, `SPAM`, `DRAFT`,
  `CHAT`): messages carrying any of these never reach the spine, and both
  paths agree, so a mailbox yields the same rows whichever ran. History
  records are folded in order (`planHistory`): `messagesAdded` whose ref is
  already hidden is skipped without a fetch; `labelsAdded` TRASH/SPAM on a
  stored message is a **deletion without a fetch** (Gmail's
  `messagesDeleted` means purged, not trashed — trashing arrives as a label
  change); `labelsRemoved` TRASH/SPAM re-fetches the message; the last move
  wins within a page and a purge always wins. Any fetched message that turns
  out hidden is emitted as a deletion. `UNREAD` changes re-fetch; other label
  changes are ignored.
* **Sent mail** (`SENT` label) is kept as the user's own context — recipients
  still resolve to people — but with `from: null` and
  `metadata.direction = "sent"`, so it is never "received from" the user and
  never creates a person for the user's own address. Everything else carries
  `metadata.direction = "received"`.
* A `messages.get` that answers 404 is a deletion (gone between list and
  get). A 2xx whose body is empty or not JSON is a retryable
  `invalid_response`: the run fails and retries from the same `historyId`,
  it never becomes a deletion.
* `history.list` **404** (Gmail no longer holds history back to our id) →
  the source yields a fresh backfill with `fullResync: true`. The re-list
  only upserts: messages purged at Gmail during the gap stay in
  `mail_messages` (known limitation; trashed ones are caught the next time
  their labels change).
* Message ids are the natural key; unread is derived from the `UNREAD` label.

### Google Calendar — `packages/connectors/google/src/calendar/sync.ts`

```
{ calendars: { [calendarId]: { syncToken?: string,
                               page?: { token: string, timeMin?: IsoDateTime, timeMax?: IsoDateTime, fullResync?: true },
                               series?: { [masterEventId]: instanceEventId[] } } } }
```

* Calendars: every `calendarList` entry that is selected and more than
  free/busy, plus `primary` always (`selectCalendars`). Each calendar syncs
  independently; state for calendars that no longer exist is dropped.
* First run per calendar: `events.list?singleEvents=true&showDeleted=true`
  over the window (default 30 days back, 90 ahead, 250 per page). **Every
  page is a resume point**: it checkpoints the calendar's `nextPageToken`
  as `page`, together with the `timeMin`/`timeMax` the token was issued for
  (Google requires every parameter except `pageToken` to match), so the
  engine can stop at its deadline after any page and the next run continues
  that calendar from the same page with the same window. The last page
  replaces `page` with the calendar's `nextSyncToken`. A stored page token
  Google rejects (400) re-lists just that calendar from scratch with a fresh
  window; the other calendars are untouched. Pages of a multi-page sync-token
  response checkpoint their page token the same way (without a window).
* Incremental: `events.list?syncToken=…`; `status: cancelled` → deletion.
* **Recurring series.** Instances are stored under their own ids
  (`metadata.recurringEventId` names the master). `series` remembers which
  stored instance ids belong to which master; when Google reports the
  **master** id as cancelled (the user deleted the whole series), the page
  emits a deletion for every instance under it and forgets the series. An
  instance cancelled on its own is deleted and dropped from the map.
  Instances whose id dates them (`<master>_<YYYYMMDD[THHMMSSZ]>`) are
  forgotten once they leave the past window, so the map stays bounded;
  undatable ids are kept.
* **410** on a sync-token request → that calendar re-lists from scratch with
  `fullResync: true`. A 410 without a token is a real error. The re-list
  only upserts: events removed at Google during the gap stay in
  `time_events` (known limitation).

### Microsoft Graph mail — `packages/connectors/microsoft/src/mail/sync.ts`

```
{ deltaLink: string }                                    // a complete delta round
{ backfill: { nextLink: string, fullResync?: true } }    // initial backfill in progress
```

* First run: `GET /me/mailFolders/inbox/messages/delta?$select=…&$filter=receivedDateTime ge <now − backfillDays>`
  (inbox only, bodies as text via `Prefer: outlook.body-content-type="text"`,
  page size 50 via `Prefer: odata.maxpagesize`). Attachment metadata is one
  extra request per message with `hasAttachments`, fetched 4 wide through
  the one `GraphApiClient` of the run.
* **Backfill pages are resume points.** Every intermediate page of the
  initial backfill carries its `@odata.nextLink` as `backfill.nextLink`
  (on the assumption — Graph documents it for `deltaLink`, not for
  `nextLink` — that the skiptoken carries the same sync state hours later;
  a rejected one falls back to the restart below), so a backfill larger than
  one run's time budget stops
  at the deadline on a checkpoint and continues from that page next run
  instead of restarting. The last page drops `backfill` and carries the new
  `@odata.deltaLink`.
* Intermediate pages of an **incremental** round keep the previous
  `deltaLink`: rounds are small and replaying one is cheaper than losing the
  last complete round. A crash mid-round replays it, which the natural keys
  absorb.
* `@removed` tombstones → deletions. **410** on a delta link → restart from
  the initial backfill with `fullResync: true`; a 410 on a fresh query is
  thrown as `checkpoint_invalid`. A **400 or 410 on any stored link**
  (`deltaLink` or `backfill.nextLink`) is a dead checkpoint and takes the
  same restart, so a rejected link self-heals instead of failing every run
  as `unknown`; a 400 on a fresh query or on a link Graph issued during the
  run stays an `unknown` error.
* `parseMailCheckpoint` refuses a `deltaLink` or `backfill.nextLink` that is
  not a `graph.microsoft.com` URL, and a checkpoint carrying both shapes, so
  a corrupted checkpoint can never send a bearer token elsewhere.

### Microsoft Graph calendar — `packages/connectors/microsoft/src/calendar/sync.ts`

```
{ deltaLink: string, window: { start: IsoDateTime, end: IsoDateTime } }
```

* `GET /me/calendarView/delta?startDateTime=<now − pastDays>&endDateTime=<now + futureDays>`
  over the default calendar, UTC times (`Prefer: outlook.timezone="UTC"`),
  then the delta link. `isCancelled` and `@removed` → deletions.
* **No `$select`** (and no `$expand`/`$filter`/`$orderby`/`$search`): Graph
  documents that a delta call on a calendarView returns the same properties
  as `GET /calendarView` and "you cannot use `$select` to get only a subset
  of those properties" ([event: delta → OData query
  parameters](https://learn.microsoft.com/graph/api/event-delta)). Page size
  (`Prefer: odata.maxpagesize`) is the only lever on payload; the normalizer
  reads the fields it needs from the full event.
* A delta link only tracks the window it was opened with. When the stored
  window is more than `WINDOW_MAX_AGE_DAYS` (7) older than a fresh one would
  be, the source re-opens a new window with `fullResync: true` so upcoming
  events keep flowing. 410 → same restart, and so is a **400 on the stored
  delta link** (a link out of our checkpoint that Graph rejects — for
  instance one issued while `$select` was still being sent — is a dead
  checkpoint, not a permanent error). A 400 on the fresh window request
  itself stays an `unknown` error.
* Intermediate pages keep the previous checkpoint: the window is small
  enough that a round fits one run, so the mail-style per-page resume point
  is not needed here.
* **Time zones.** Timed events arrive in UTC and are stamped as such. If
  Graph answers in another zone, the name is resolved through `Intl` for
  IANA zones and through a CLDR Windows → IANA table
  (`src/calendar/windows-zones.ts`, 139 rows) for Windows names such as
  "New Zealand Standard Time"; an unknown name keeps the wall time as UTC
  and sets `metadata.timeZoneUnresolved`. **All-day events** are stored by
  Graph as midnight in the zone they were created in and converted to UTC
  like any other time (an Auckland holiday arrives as 11:00Z the day
  before), so the civil date is the date that instant falls on in
  `originalStartTimeZone`; only when that zone cannot be resolved does the
  normalizer fall back to the nearest UTC midnight (wrong at UTC+13/+14 and
  UTC−12) and flag the event.

### Plaid — `packages/connectors/bank/src/connector.ts`

```
{ cursor: string }
```

* `BankConnector.syncBank`: page 1 = all accounts of the item with balances
  (`/accounts/get`, always refreshed) + the first `/transactions/sync` page
  (500 per page); following pages carry transaction changes only. `added` and
  `modified` are upserted, `removed` ids become deletions; an id that appears
  in both `added`/`modified` and `removed` of one page is deleted, whichever
  order the linker applies the batch in.
* Dates: Plaid's `date` and `authorized_date` are civil dates (no timezone).
  `authorized_datetime` is returned for select institutions "as provided by
  the institution" and, per Plaid, "may contain default time values (such as
  00:00:00)". `postedOn` is `date`; `authorizedAt` is `authorized_datetime`
  when it carries a time of day, and **null** when it is absent or a midnight
  stamp on the authorized (or posting) date — never `authorized_date` stamped
  with `T00:00:00Z`, which would be the previous local day west of Greenwich.
  The civil `authorized_date` travels in `metadata.authorized_date`. The
  linker's `occurredAt` falls back to `postedOn` at UTC midnight when
  `authorizedAt` is null; that is a date rendered as an instant by
  convention, not a claim about the time of day.
* Plaid's `/transactions/sync` contract: the pages up to `has_more: false`
  are one update; only that final `next_cursor` is guaranteed (for a year),
  and a failure mid-update means the whole update is requested again from
  the cursor it began with. So intermediate pages echo the checkpoint the
  pass started from (the engine keeps it, exactly as the Graph mail source
  does), the final page carries the new cursor, and an empty `next_cursor`
  (Plaid's "initial update not ready") keeps the previous checkpoint. A
  `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts the pass from that
  same starting cursor — never from an intermediate one — up to 3 attempts,
  then `ConnectorError("unknown")`; replayed pages are idempotent by natural
  key — on the assumption, which Plaid does not state, that a restarted
  update repeats or removes everything an aborted one added. A run the
  engine's time budget stops mid-update is reported `interrupted` and
  restarts the update next run rather than resuming from a cursor Plaid may
  have discarded. Known limitation: because intermediate pages advance
  nothing, an update that does not fit in the run's remaining budget restarts
  from the same cursor on every run; the engine does not yet reserve budget
  for a source that cannot resume mid-update (a task in the roadmap).
* `PlaidClient` allow-lists read endpoints (`PLAID_READ_ENDPOINTS`); any
  other endpoint throws `unsupported`. There is no method on `BankProvider`
  that can move money. Caveat: the `connector-link` Edge Function's link-time
  calls (`/link/token/create` with `hosted_link`, `/link/token/get`) still go
  through its own `plaidPost` in `supabase/functions/_shared/link.ts`, outside
  this allowlist and outside the package's read-only test (audit BANK-003,
  open); the package now offers `beginBankLink({ hostedLink: true })` so the
  start step can move onto `PlaidClient`.
* `PlaidBankProvider.describeItem` throws the mapped error (`unauthorized`
  for `ITEM_LOGIN_REQUIRED`) when `/item/get` reports `item.error`, so an
  Item the user has not repaired is never described as healthy.
* `src/sync-roundtrip.test.ts` drives `BankConnector` (mock and Plaid with a
  fake fetch) through `SyncEngine` + `ContextLinker` + `InMemorySpineStore`
  (`@vixera/sync` is a dev dependency of the package): pending→posted leaves
  one row, a mutation replay and an interrupted update do not duplicate
  anything, a second run with the produced checkpoint changes nothing but
  the balance refresh, and an update-mode relink keeps the row and its
  checkpoint.

### Mock — `packages/sync/src/testing/mock-connector.ts`

`{ version, page }` per capability. A second run with the previous checkpoint
returns one empty page unless a test hook changed the fixtures.

## Errors → engine behaviour

`ConnectorError(code, message, retryable)`; `retryable` defaults to true for
`rate_limited` and `provider_unavailable`.

| Code | Raised by | Engine (`SyncEngine.runCapability`) |
| --- | --- | --- |
| `unauthorized` | 401 after one refresh attempt, 403 without a quota or scope reason, refresh without refresh token, Google token endpoint `invalid_grant`, Plaid `ITEM_LOGIN_REQUIRED` / `INVALID_ACCESS_TOKEN` / `ITEM_NOT_FOUND` | account `status = needs_reauth` (+ `last_error`), sync state `error`; the remaining capabilities of that account are skipped ("account needs_reauth") until the user re-links (Plaid: through Link update mode — `beginBankLink({ accessToken })` + `completeBankRelink` exist in the package, but `connector-link` still starts a fresh link, which duplicates the Item; see "Repairing a needs_reauth Item") |
| `checkpoint_invalid` | Graph 410 on a fresh query, corrupted checkpoint the source cannot repair | checkpoint cleared and the capability retried **once** from scratch in the same run; a second failure is recorded as an error |
| `rate_limited` | 429, Google 403 quota, Plaid `RATE_LIMIT_EXCEEDED` | state `error`, `consecutive_failures + 1`; nothing sleeps — the next scheduled run retries from the persisted checkpoint once the backoff below has elapsed |
| `provider_unavailable` | network failure, 5xx | same as rate limited |
| `invalid_response` | provider body missing required fields | state `error`; not retried within the run, and subject to the same backoff |
| `unsupported` | capability not implemented by the connector, wrong credential kind, disallowed Plaid endpoint, any Google 403 that is not a quota (`insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` for a scope the user declined; `forbidden` for a Workspace user without a Gmail licence or an API the admin turned off — Google answers 401, not 403, for a dead credential): limits one capability, the account stays active and its other capabilities keep syncing (engine-tested) | state `error` |
| `unknown` | anything else; Google token endpoint 400/401 other than `invalid_grant` (`invalid_client`, `unauthorized_client`, … — our OAuth client configuration, retryable so accounts recover once it is fixed) | state `error` |
| *(missing credential)* | `credentialRef` null or Vault returns nothing | account `needs_reauth`, outcome `errorCode: "credential_missing"` |

**Backoff.** A state in `error` is not retried until `lastAttemptAt +
backoffMs(consecutiveFailures)`: 10 min after the first failure, doubling,
capped at 6 h. A state marked `running` within the last 15 min is left alone.
A user's Sync now (`connector.sync_now`, `POST connector-sync` with `force`)
ignores both. Re-linking resets the count. The provider's `Retry-After` is not
yet honoured precisely (the doubling stands in for it).

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
4. **Repairing a `needs_reauth` Item (Link update mode).** Plaid's
   `ITEM_LOGIN_REQUIRED` is fixed by re-authenticating the *existing* Item,
   never by linking again: a fresh Link session issues a new item_id and
   duplicates every account and transaction. The package side:
   `beginBankLink(client, { userId, accessToken, hostedLink: true })` sends
   `access_token` (no `products`) to `/link/token/create`, which opens Link
   in update mode; a public token an update-mode session may still deliver
   must **not** be exchanged (the `access_token` is unchanged) —
   `completeBankRelink({ client, connector, fetch }, { credential })`
   re-describes the Item with the account's existing Vault credential
   (`/item/get`; still `item.error` → `unauthorized`, leave the account in
   `needs_reauth`) and returns the same `externalAccountId`, so
   `persistLinkedAccount` can find the existing row by (provider, external id)
   as it does for a re-link after disconnect (`link_test.ts`); the package
   round-trip test performs that persistence step by hand. **Status: package
   support only (fixture-tested).** Update mode repairs `ITEM_LOGIN_REQUIRED`;
   an account parked for `INVALID_ACCESS_TOKEN` or `ITEM_NOT_FOUND` has no Item
   left to repair and needs a fresh link with the old row disconnected — the
   engine does not yet record which code parked the account, so the Field
   cannot tell the two apart. Edge Function wiring (pending): `start` accepts
   `connectorAccountId` for a Plaid account in `needs_reauth`, loads its
   credential from Vault and calls `beginBankLink` with it; `complete` with
   that `connectorAccountId` reads the finished hosted session as today, then
   calls `completeBankRelink` instead of `completeBankLink`; the Field offers
   "Reconnect" on such an account instead of "Connect bank".

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
   only (`@vixera/sync` as a *dev* dependency for the engine round-trip test
   in step 6). Implement `Connector`: `discoverAccount`, optional
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
   accounts of the same provider through one instance — Google has this in
   `connector.test.ts`; add it for the others), checkpoint round-trip and
   error mapping. Connector packages depend on `@vixera/domain` only, so the
   engine round-trip (a second run with the produced checkpoint changes
   nothing) lives in `packages/sync/src/engine/sync-engine.test.ts` against
   the mock connector, not per provider; nothing is tested against a live
   provider.

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
