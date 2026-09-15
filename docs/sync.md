# Sync flow

How external context becomes spine rows, how the spine becomes NOW, and how
the other write paths (ingestion, handoff, server actions) work. Code lives in
`packages/sync` (`SpineStore`, `ContextLinker`, `SyncEngine`),
`packages/domain/src/now`, and `supabase/functions/`. Connector specifics are
in [`connectors.md`](./connectors.md); the tables in [`schema.md`](./schema.md).

## 1. End to end

```
pg_cron (*/10 min)
  └─ vx_trigger_scheduled_sync()          migration 20260910000500: pg_net POST, URL + secret from Vault
       └─ POST /functions/v1/connector-sync   header X-Vixera-Sync-Secret
            ├─ listActiveConnectorUserIds()   connector_accounts.status in (active, error), service role
            └─ per user: runSyncForUser(userId, { deadlineAt })
                 ├─ SupabaseSpineStore(client, userId)      every read/write bound to that user
                 ├─ VaultCredentialStore(client, userId)
                 ├─ buildRegistry(env)                       Google / Microsoft / Plaid (/ mock)
                 └─ runSync(): for each account × capability (until the budget is spent)
                      └─ SyncEngine.runCapability(account, capability)
                           ├─ credential: Vault get → refresh if expired
                           ├─ for await page of connector.sync<Cap>(ctx, checkpoint)
                           │    ├─ ContextLinker.apply<Cap>Batch(account, page.batch)
                           │    │    └─ rows (mail / time / money) + people + documents
                           │    │       + relationships + context_events
                           │    └─ upsertSyncState({ checkpoint: page.checkpoint })   AFTER the batch
                           └─ upsertSyncState({ status: idle, lastSuccessAt, consecutiveFailures: 0 })
```

Same engine, other triggers:

| Trigger | Path | Budget |
| --- | --- | --- |
| Schedule | `pg_cron` job `vixera-connector-sync`, every 10 min, all users | 100 s wall clock shared by all users (`DEFAULT_SYNC_BUDGET_MS`); users not started in time count as `usersSkipped` |
| Field "Sync now" | `POST connector-sync { connectorAccountId? }` with the user JWT (`FieldServices.syncNow`) | 100 s for that user |
| Server action | `connector.sync_now` through `action-dispatch` | 60 s (the client is waiting) |
| Dev-fixture mode | `SyncEngine.runAll()` in-process over `InMemorySpineStore` + `MockConnector` | none |

The wall-clock budget stops **starting** new (account, capability) pairs, and
`runCapability` also takes the deadline. After each page, if the deadline has
passed: when that page **moved** the checkpoint — a checkpoint that differs from
the one the pass started from; an echoed cursor is not progress — the pass stops
there, at a durable resume point, and reports `ok` with a reason naming the
budget. When it did not (the connector echoed its cursor, or yields one only at
the end, as Graph delta and the Google calendar window do) the pass stops
anyway and reports `ok` with `interrupted: true`: the pages applied are kept
(idempotent), the checkpoint is unchanged, `lastSuccessAt` is not touched, and
the next run starts that pass over. Bounded is the point — before this, such a
pass ran until the Edge runtime killed the invocation, which left the state
`running` forever and starved every later user. A pass that is *always*
interrupted needs a connector that emits per-page checkpoints (Gmail does, via
its page token); a longer budget does not fix it. Skipped pairs are reported as
`skipped` with reason "time budget exhausted". `runSync` also computes `selfAddresses` from
every account's `address`, so the user never becomes a person in their own
graph.

## 2. Per (account, capability)

`SyncEngine.runCapability` (`packages/sync/src/engine/sync-engine.ts`):

1. Skip when the account is `disconnected` / `paused`, the sync state is
   `enabled = false`, the capability is not on the account, or it is
   `document` (Praxion is local, never paged). Unless the run is `force`d (a
   user's Sync now), also skip a state in `error` whose backoff has not
   elapsed — 10 min after the first failure, doubling per consecutive
   failure, capped at 6 h (`backoffMs`) — and a state marked `running` within
   the last 15 min (another run has it; a crashed run's mark goes stale). Both
   are reported as `skipped` with the reason.
2. Mark the state `running` with `lastAttemptAt`.
3. Load the credential by `account.credentialRef`. Missing → account
   `needs_reauth`, state `error` (`errorCode: credential_missing`).
4. Refresh an expired credential (`connector.refreshCredential`) and persist
   it under the same ref; connectors that refresh reactively report through
   `ctx.onCredentialRefreshed`.
5. Page: apply the batch through the linker **first**, then persist the page
   checkpoint. A crash between the two replays an idempotent page on the next
   run; it never skips one. `MAX_PAGES` (10 000) guards against a runaway
   provider.
6. `ConnectorError` handling: `unauthorized` → account `needs_reauth` and the
   account's remaining capabilities are skipped (the account is re-read
   between capabilities); `checkpoint_invalid` → checkpoint cleared and one
   retry from scratch; anything → state `error`, `lastError` (credentials
   redacted, 1000 chars), `consecutiveFailures + 1`, and the run continues
   with the next pair.
7. Success → state `idle`, `lastSuccessAt`, `consecutiveFailures = 0`; an
   account in `error` status goes back to `active`. An interrupted pass goes
   `idle` with `consecutiveFailures = 0` but keeps its old `lastSuccessAt`.
   Re-linking an account (`persistLinkedAccount`) resets its states to `idle`
   with `consecutiveFailures = 0`, so a fresh credential is never held by the
   old one's backoff.

The report (`SyncReport` / `BudgetedSyncReport`) carries one `SyncOutcome`
per pair: status `ok | error | skipped`, reason, `errorCode`, pages, link
counts, `checkpointAdvanced`, `interrupted`, timings, and an `interrupted`
count at the top. `summarizeReport` is what the
`connector.sync_now` action stores as its result.

## 3. Idempotency and failure isolation

Guarantees, and where each is enforced:

| Guarantee | Mechanism |
| --- | --- |
| Re-applying a page changes nothing | every connector row is upserted on its natural key (`mail_messages (user, account, external_id)`, `time_events (user, account, calendar, external_id)`, `money_accounts` / `money_transactions (user, account, external_id)`); `SupabaseSpineStore` collapses duplicate keys inside one page so PostgREST never updates the same row twice |
| Context events never duplicate | `context_events (user_id, dedupe_key)`; `upsertContextEvents` returns existing rows unchanged, so a user's attention decision (quiet / dismissed) is never overwritten by a re-sync |
| Edges never duplicate | `relationships (user, from, kind, to)`; `vx_relate` / `relate()` is idempotent (raises confidence on conflict) and rejects endpoints that do not exist for the same user |
| People never duplicate per provider | `person_identities (user, kind, value)` with normalized values (`normalizeEmail`); `upsertPersonIdentity` returns the existing identity, and a lost race falls back to the winner's person and folds the row the loser created into it (`mergedIntoId`), so it never lingers in the People list |
| Documents from attachments never duplicate | `findDocumentBySourceRef(account, { messageExternalId, attachmentId })` before `upsertDocument` |
| A crash never loses data | apply-then-checkpoint ordering; intermediate pages keep a resumable checkpoint (Gmail backfill page token, Plaid cursor) or the previous one (Graph) — the engine persists a checkpoint only when it differs from the one the pass started from |
| One failure never blocks the rest | errors are caught per capability, per account, per user; `runAll` / `runSync` / the scheduled loop never throw for a connector failure |
| Provider tokens never leak | `redactCredential` on every persisted / logged message; Vault access only through user-bound stores |
| Deletions are safe | store deletes cascade edges, context events and conclusions of the removed row through `vx_on_entity_deleted` triggers; deletions emit no context event |

Tests: `packages/sync/src/engine/sync-engine.test.ts` (second run is a no-op,
checkpoint per page, failure isolation, needs_reauth, checkpoint_invalid
retry), `context-linker.test.ts`, `supabase/functions/_shared/sync_test.ts`
(budget, skips), and each connector's `sync.test.ts`.

## 4. What the linker writes

`ContextLinker` (`packages/sync/src/linker/context-linker.ts`) is the only
code that decides "who is this address" and "what does this batch mean".

**People.** Every `from` / `to` / `cc` address and every calendar
participant / organizer resolves to one `Person` by normalized email
identity: found → that person (following `mergedIntoId`); not found →
`upsertPerson` (name from the address, else `displayNameFromEmail`) plus an
`email` identity carrying the provider and account. Addresses of the user
(`selfAddresses`, the account's own address, participants with `isSelf`) never
become people. Per batch the same address is resolved once, and "known before
this batch" stays stable for the importance rule.

**Edges** (all `source: "connector"` unless noted):

| From | Kind | To |
| --- | --- | --- |
| `mail_message` | `has_person` | every resolved from/to/cc person |
| attachment `document` | `originated_from` | its `mail_message` |
| attachment `document` | `has_person` | the sender |
| `time_event` | `has_person` | every resolved participant and organizer |
| `money_transaction` | `has_person` (source `rule`, confidence 0.8) | the person whose display name or organization equals the merchant name (case-insensitive exact match); also stored as `counterpartyPersonId` |

Threads are never created or attached by the linker; that is the user's
decision (`thread.create` / `thread.attach` actions, `mentions` from
ingestion).

**Dedupe keys** (exported from `context-linker.ts`):

| Kind | `dedupe_key` | Emitted |
| --- | --- | --- |
| `mail.received` | `mail:<accountId>:<externalId>` | once per message |
| `time.event.created` / `time.event.changed` / `time.event.cancelled` | `time:<accountId>:<calendarId>:<externalId>:<version>` with `version = FNV-1a(title, startsAt, endsAt, status)` | `created` at first sight, `changed` when the version differs, nothing for an unchanged re-sync. Every prior version's event is retired (`dismissed`, `supersededBy = <current key>`) whether or not the current key was seen before, so a meeting moved to 16:00 and back to 15:00 leaves exactly one live event, at 15:00: the 15:00 event that a later version retired is re-opened. A dismissal the user made (no `supersededBy`) is never re-opened |
| `money.transaction.posted` | `money:<accountId>:<externalId>` | once per transaction |
| `ingest.received` | `ingest:<ingestItemId>` | once per ingest item (ingestion pipeline) |
| `handoff.created` | `handoff:<handoffId>` | once per handoff (`handoff.create` action) |

## 5. Importance and attention rules

`packages/sync/src/linker/rules.ts` — deterministic baseline, 0–100. Every
constant is exported so tests and the Field name the rule instead of a number.

| Event | Importance | Attention |
| --- | --- | --- |
| Unread mail from a person known before this batch, with attachments | 60 (`MAIL_UNREAD_KNOWN_WITH_ATTACHMENT`) | `needs_attention`, or `quiet` when received more than 14 days ago (`MAIL_QUIET_AFTER_DAYS`) |
| Other unread mail | 45 | same |
| Read mail | 25 | same |
| Confirmed/tentative event starting within 48 h and not yet ended | 55 (`TIME_EVENT_SOON`) | `needs_attention`; `quiet` once the event has ended |
| Other events | 35 | same |
| Cancelled event | 50 | same |
| Transaction with `abs(amount) >= 1000` | 50 (`MONEY_TRANSACTION_LARGE`) | `needs_attention` |
| Merchant name equal (case-insensitive) to exactly one person's display name or organization | — | the transaction gets `counterpartyPersonId` and a `has_person` edge at 0.8; a name two different people share links to **nobody** rather than to whichever sorts first |
| Other transactions | 30 | `needs_attention` |
| Ingested item | 40 (`INGEST_IMPORTANCE`, `_shared/ingest.ts`) | `needs_attention` |
| Handoff created | 60 (`HANDOFF_IMPORTANCE`, `_shared/actions.ts`), `dueAt = expiresAt` | `needs_attention` |

`dueAt` is the event start for time events, the expiry for handoffs, null
otherwise. `occurredAt` is the mail `receivedAt`, the sync time for time
events (a change is "now"), the transaction `authorizedAt` or posted date.

## 6. NOW derivation

`deriveNow()` (`packages/domain/src/now/derive-now.ts`) is pure. The Field
feeds it from `useNow()` (`apps/desktop/src/data/hooks.ts`):

| Input | Query |
| --- | --- |
| `contextEvents` | attention `needs_attention` or `quiet`, `occurredAt` within 30 days, limit 500 |
| `timeEvents` | −1 day … +7 days |
| `moneyTransactions` | posted within 30 days, limit 200 (reserved; not used by the Phase 1 scoring) |
| `threads`, `relationships` | limit 200 / 5000 — the thread index tells which subjects belong to a thread |
| `now` | wall clock |

Per context event (dismissed events are skipped):

```
score  = clamp(importance, 0, 100)
       + time:   time-like & already ended −20 · time-like & started +20
                 otherwise dueAt overdue +30 · ≤24h +25 · ≤48h +15 · ≤7d +5
       + age:    ≤6h +10 · older than changedWindow (48h) −15
       + thread: attached to a thread +8
bucket = snoozed (quiet + metadata.snoozedUntil in the future)  → quiet
         attention quiet (and snooze not elapsed)               → quiet
         score ≥ 70 → needs_me · ≥ 45 and within 48h → changed · ≥ 20 → can_wait · else quiet
```

`NOW_THRESHOLDS = { needsMe: 70, changed: 45, canWait: 20 }`. Each item
carries its `reasons` (e.g. `["importance 60", "due within 24h", "recent"]`)
for explainability. `upcoming` is the next 24 h of non-cancelled time events
independent of context events. A snooze whose time has passed competes again
("snooze elapsed").

The **Quiet** area does not use `deriveNow().quiet`; it lists context events
with `attention = quiet` from the last 60 days directly (`useQuiet`). The
NOW area shows `needsMe`, `changed`, `upcoming` and `canWait`.

### Full resync reconciliation (ADR-017)

A from-scratch listing re-lists and upserts, and it declares what it covers:
every page carries `resyncScope` (`{ kind: "mail", receivedSince }`,
`{ kind: "calendar", calendarIds, from, to }` or `{ kind: "all" }`). When the
pass is a real resync — `fullResync: true` from the source, or a pass the
engine restarted after the store rejected a checkpoint — the engine records
`[{ since, scope }]` on the capability's sync state
(`connector_sync_states.reconcile`, migration 12), one entry per listing
unit — a mail window, one calendar inside its window, a whole Item — with
`since` the sync state's own `updated_at` stamp from the run in which that
unit's listing began (`declareResync`): a page that declares a unit's very
same scope is the listing continuing and keeps the watermark; any other
declaration for the unit is a listing starting over and replaces it with a
watermark at this run's start — never the union of two windows. When the
pass reports `done`, `SpineStore.deleteUntouched(account, capability, unit)`
runs for each unit and deletes the rows of that account and capability
inside the unit's scope whose `updated_at` is older than its `since`:
everything the pass touched was stamped later by the `updated_at` triggers,
changed or not, and both stamps come from the database clock. Calendar edges
are exclusive, as both providers list them. Deleted rows count in the run
report's `deleted` and take their context events, conclusions and handoff
focus with them like any deletion; the log line is `sync: full resync
reconciled`. A stored `reconcile` that is not in the shape the engine writes
reads as "no pass in progress" (`reconcileFromDb`), so a damaged value never
widens a deletion.

The state is persisted, so a pass the run budget splits across runs
reconciles when it finally completes, and a run that dies mid-pass leaves the
state for the next one. Deliberately not reconciled: a first-ever sync (not a
resync, and nothing is older than it), a source that declares no scope
(nothing is deleted, as before), rows outside the declared scope (a 30-day
mail backfill never deletes older mail it did not list), and money accounts
(a closed account keeps its history; transactions are reconciled).

## 7. Realtime refresh

`apps/desktop/src/data/realtime.ts` opens one channel `field:<userId>` over
`postgres_changes` for `context_events`, `handoffs`, `connector_accounts`,
`connector_sync_states`, `ingest_items`, `threads` with
`filter: user_id=eq.<userId>`. Every change bumps the `SpineProvider`
version and every `useSpineQuery` re-reads. The publication is set in
migrations `20260910000400` (`context_events`, `handoffs`, `threads`,
`ingest_items`, `connector_sync_states`, `action_requests`) and
`20260910000700` (`connector_accounts`). Completed actions bump the version as
well, so the Field never depends on Realtime to see its own writes. Channel
status drives the state mark (Connecting / Synced / Offline).

RLS applies to INSERT and UPDATE events, not to DELETE events: Supabase
Realtime sends every delete on a published table to every subscriber, carrying
the old row as far as the table's replica identity exposes it. Migrations 4
and 7 had set `replica identity full` on `handoffs`, `context_events` and
`connector_accounts`, which broadcast deleted rows whole, across users.
Migration 9 (`20260914000100`) returns them to the default identity: a DELETE
event now carries only the primary key, the `user_id` filter cannot match it,
and the channel receives no DELETE events at all. Deletions surface on the
next read (any other change, or launch); nothing in the Field assumes it is
told about one. `check-migrations.sh` fails any migration set that leaves a
table on full identity, and `verify.sql` asserts it against the database.

## 8. Ingest pipeline

One pipeline for every explicit input — Android share sheet, Windows file
drop, file picker, pasted text/URL (`apps/desktop/src/data/ingest.ts` →
`ingest.submit` action → `supabase/functions/_shared/ingest.ts`).

Client (`ingestFiles` / `ingestText`):

1. Load bytes (`readFileBytes` for device paths, `File` in a browser), hash
   them (Rust `hash_file`, streaming SHA-256; WebCrypto in a browser).
2. `findDocumentByHash(sha256)`: a known document with a Storage location is
   reused (`deduplicated: true`, no second upload). Otherwise upload to the
   private bucket `artifacts` at `<userId>/ingest/<uuid>-<safe name>`
   (`sanitizeFilename`). The upload is the only client-side write besides
   device registration.
3. Dispatch `ingest.submit` with `deviceId`, `kind` (`file | image | url | text`),
   `source` (`share | capture | drop | clipboard | command`), `title`,
   `mimeType`, `sizeBytes`, `storagePath`, and `metadata.contentHash`,
   `filename`, `originalPath`, `existingDocumentId`.
4. After a batch the Field calls `ingest-process` (all `received` items of
   the user) as a safety net and refreshes.

Server (`ingest.submit` handler → `processIngestItem`):

1. `createIngestItem` (status `received`), then process **once**;
   re-processing is idempotent.
2. `file | image | url` → a `Document`: found by source ref
   `{ ingestItemId }`, else by `contentHash`; else created with
   `source = share | drop | capture`, `location = storage | url | none`,
   size and hash from metadata. `text` → no document; the ingest item is the
   subject.
3. Links: `metadata.threadId` → `belongs_to` thread; `metadata.personId` →
   `has_person`. Without explicit links, exact case-insensitive word-bounded
   mentions of known people (display names) and thread titles in title +
   text become `mentions` edges (confidence 0.6, source `rule`).
4. Context event `ingest.received` (importance 40, dedupe `ingest:<id>`),
   item marked `processed` with `documentId`. A failure is one of two kinds:
   a transient one (`isTransientStoreError` — the database or PostgREST
   unavailable, a cancelled statement, a lost transaction race, a codeless
   failed fetch) leaves the item `received` with the error text and
   `attempts` incremented, and the action answers `deferred: true`; the next
   `ingest-process` run retries it (the Field calls one after every submit,
   at launch and when the connection returns), and after
   `MAX_INGEST_ATTEMPTS` (5) runs it is marked `failed`. Any other error
   marks it `failed` at once, with the error text — retrying a constraint
   violation only repeats it.

`POST ingest-process { ingestItemId? }` re-runs the pipeline for one item
(any status) or every `received` item (max 200 per call). Documents ingested
this way are opened later with Praxion (via a cached copy from Storage) or
the OS viewer / a signed URL (`open-document.ts`). Dev-fixture mode runs a
local equivalent (`processIngestLocally`) with slightly different event kinds
(`ingest.<kind>`, importance 55).

## 9. Handoff lifecycle

Vixera owns cross-device handoff (ADR-007); Praxion stays login-free.
States: `pending → accepted`, or `expired`; `delivered` and `cancelled` exist
in the enum but nothing sets them in Phase 1 (there is no delivery
acknowledgement and no cancel action).

1. **Create** — "Continue on <device>" (`ContinueOn`, `createHandoff`) →
   `handoff.create`: validates source/target device, thread, document
   (all must be the user's rows); `focus`, `threadId`, `documentId`,
   `praxionLocation`, `conclusions`, `commandHistory` (the One Command ring).
   `praxionLocation` is filled in by `createHandoff` from the
   `ScreenContextRegistry` when the focused screen document is provably the one
   being handed off (same Praxion document id, or the same device path when
   neither side names a Praxion id) — Vixera never calls Praxion from UI code;
   `artifactStoragePath` when the document lives in Storage. TTL 24 h
   (`expiresAt`). A `handoff.created` context event (importance 60, `dueAt =
   expiresAt`) makes it show up in NOW on every device.
2. **Receive** — the other device lists open handoffs
   (`listHandoffs({ state: [pending, delivered] })`), keeps those addressed
   to it or to any device, not created by itself and not expired
   (`pendingHandoffsFor`), and shows "Left on another device" in NOW with
   Realtime keeping it fresh.
3. **Accept** — `handoff.accept { handoffId, deviceId }` (idempotency key
   `handoff.accept:<handoffId>:<deviceId>`): rejects handoffs accepted by
   another device, targeted elsewhere, cancelled, or expired (marking them
   `expired`); sets `accepted`, `acceptedAt`, `deliveredAt`, `targetDeviceId`
   and dismisses the `handoff.*` context events. Accepting again from the
   same device replays (`alreadyAccepted: true`).
4. **Reconstruct** — the receiver loads the document (or the focus document),
   substitutes the artifact Storage path when it carried one, and calls
   `openDocument`: Praxion by `praxionDocumentId` or by a cached local path
   with the carried `praxionLocation`, else the OS viewer, else a signed URL
   in the browser. Focus moves to the handoff's focus entity.

## 10. Server actions (`action-dispatch`)

ADR-005: every durable context mutation the Field makes is an
`ActionEnvelope` `{ actionType, idempotencyKey, payload, actorDeviceId? }`
POSTed to `action-dispatch` with the user JWT
(`supabase/functions/_shared/actions.ts`). The client never has to stay
alive to finish one.

```
parseEnvelope        400 invalid_envelope / invalid_payload (hand-written guards per type)
createActionRequest  upsert on (user_id, idempotency_key), ignoreDuplicates → created | existing
existing done|failed → return the stored outcome, replayed: true, never re-executed
existing running < 10 min, or queued < 30 s (never run) → 409 in_progress
existing queued after a transient failure, or stale → retried (attempts + 1)
running → handler → done (result) | failed (error)   both recorded, returned as ActionOutcome
         transient failure (store outage, retryable provider error) → back to queued,
         outcome failed + retryable: true; the key is not spent until MAX_ACTION_ATTEMPTS (5)
same key, different actionType → 409 conflict
```

`action_requests` is the audit trail (`status: queued | running | done |
failed`, `attempts`, `result`, `error`, `actor_device_id`; `updated_at`
maintained by trigger so the staleness check is valid). Clients cannot write
the table.

| Action | Handler behaviour | Field key |
| --- | --- | --- |
| `context_event.dismiss` / `context_event.quiet` | `setContextEventAttention` | `<type>:<contextEventId>` (subject-keyed: repeating is a replay) |
| `context_event.snooze` | attention `quiet` + `metadata.snoozedUntil` | `<type>:<contextEventId>:<until>` |
| `thread.create` | new thread (+ attach list) | fresh uuid |
| `thread.attach` | `entity belongs_to thread` plus the thread-side edge (`has_person` / `has_document` / `has_time` / `has_money` / `has_mail`), idempotent by natural key | fresh uuid |
| `handoff.create` / `handoff.accept` | see §9 | fresh uuid / `handoff.accept:<handoffId>:<deviceId>` |
| `ingest.submit` | see §8 | fresh uuid |
| `connector.sync_now` | `runSync` for the user (60 s budget), result = `summarizeReport` | fresh uuid |
| `person.merge` | moves every edge of the merged person to the survivor, copies missing `primaryEmail` / `organization` / `notes`, sets `mergedIntoId`; identities stay on the merged person (readers follow `mergedIntoId`) | fresh uuid |

Handlers receive a store bound to the request's user and never see a user id.
Every handler is idempotent on its own, so a retry after a crash between the
`running` and `done` writes is safe. In dev-fixture mode
`createDevActionDispatcher` mimics the same contract over
`InMemorySpineStore`.
