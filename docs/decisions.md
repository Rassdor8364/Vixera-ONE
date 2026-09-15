# Architectural decision log

Short records of the choices that shape Phase 1. Newest at the bottom.

## ADR-001 · One repository, one Tauri project for Windows and Android
Vixera One is its own repo; Praxion is not in it. Windows and Android share one
Tauri 2 project (`apps/desktop`) with one React frontend; platform differences are
handled by Rust commands and a Kotlin plugin, not by forking the app.

## ADR-002 · PostgreSQL relational graph, not a graph database
The context graph is one typed edge table (`relationships`) keyed by
`(user_id, from_type, from_id, kind, to_type, to_id)`. Polymorphic targets are
validated by a trigger rather than by twelve join tables. Postgres stays the
single source of truth; no Neo4j, no per-relationship tables.

## ADR-003 · Connector sync runs server-side (Edge Functions + pg_cron)
The spine must stay current when the Windows machine sleeps, and Android must
receive context without Windows. Provider tokens therefore never leave the
server: they live in Supabase Vault, referenced by `credential_ref`. The
`SyncEngine` is runtime-neutral TypeScript so a device-hosted sync is possible
later without touching connectors.

## ADR-004 · Sync state per (account, capability)
`connector_sync_states` has one row per capability of an account with its own
cursor, error and status. A failed mail sync cannot block calendar sync of the
same account, nor any other account. Each page of a sync is persisted before the
checkpoint moves, so sync is restartable and idempotent by natural keys.

## ADR-005 · Notification actions are server actions
Every notification-triggered action is `POST action-dispatch` with an
idempotency key. The server records `action_requests`, executes, persists,
and clients refresh. The client never needs to stay alive to finish an action,
even on Windows where it could.

## ADR-006 · Praxion over loopback HTTP behind a transport interface
The Praxion contract is `http://127.0.0.1:47815/v1/*`, versioned by
`PRAXION_CONTRACT_VERSION` and negotiated via `/v1/health`. The client talks to a
`PraxionTransport` (fetch in dev/tests, Tauri HTTP plugin in the app) so the
transport can become named pipes / Unix sockets without changing callers.
Praxion absent ⇒ Vixera still launches; document actions fall back to the OS.

## ADR-007 · Vixera owns cross-device handoff; Praxion stays login-free
Praxion has no accounts and no sync. `handoffs` rows (plus Supabase Storage for
artifact bytes when needed) carry context between devices. The receiver hands
the artifact to local Praxion if present, otherwise uses the OS viewer.

## ADR-008 · Deterministic NOW before any learned model
`deriveNow()` scores context events from importance, time sensitivity, recency
and thread attachment with fixed thresholds. Quiet is `attention = 'quiet'` or a
low score. Replacing the scoring function later does not change the result shape.

## ADR-009 · Explicit `.ts` import extensions everywhere
All TypeScript imports use explicit `.ts` extensions so the same source runs
under Vite, Vitest (Node) and Deno (Edge Functions) without a build step for
packages. Deno resolves workspace packages through `supabase/functions/deno.json`.

## ADR-010 · The dev identity is a fixed UUID, never an email or machine name
`DEV_USER_ID = 00000000-0000-4000-8000-000000000001`, seeded into `auth.users`
locally. `currentUser()` is the only place identity is resolved.

## ADR-011 · Edge Functions resolve identity per request, never per process
One isolate serves many users, so `setCurrentUserProvider()` is never called in a
function. `authenticate()` verifies the Bearer token with Supabase Auth and the
user id is threaded into a `SupabaseSpineStore` bound to it; the service role is
only ever used through such a store. The OAuth callback, which has no session,
carries the user id in an HMAC-signed, expiring state token.

## ADR-012 · The Field mutates context only through `action-dispatch`
Every durable context change from a device is an `ActionEnvelope` with an
idempotency key. The two client-side writes that remain are the artifact upload
to Storage (bytes, not context) and the device's own `devices` row (identity, not
context). Dev-fixture mode keeps the same envelope contract over an in-memory
dispatcher so the Field code has one write path.

## ADR-013 · Linking runs in the system browser against server-held secrets
OAuth consent and Plaid Hosted Link open in the system browser; the code / public
token exchange happens in `connector-link` with client secrets from the function
environment, and the Field only waits for the `connector_accounts` row (Realtime
or polling). No WebView-embedded OAuth, no provider SDK in the app, no token on
a device. Consequence: Plaid Hosted Link must be enabled for the Plaid client.

## ADR-014 · Dev-fixture mode is the only place with demo data
`VITE_VIXERA_DEV_FIXTURES=true` swaps in `InMemorySpineStore` + `MockConnector`
(the brief's Eric / Priya / Northwind world) behind a dynamic import. Production
has no demo rows and shows a useful empty state until a connector is linked.

## ADR-015 · Rules route first; a model only when the rules are unsure
One Command keeps its deterministic grammar. `HybridIntentRouter` consults a
`ModelIntentRouter` only below a confidence threshold, uses its answer only if
it is more confident, and caps model confidence below a certain grammar match.
Model output is untrusted JSON until `parseIntent` accepts it as the `Intent`
union; the executor never sees another shape. A model therefore cannot execute,
mutate, or widen what a command can do — it can only pick among the intents the
grammar already has. The classifier receives no names, ids or context items.

## ADR-016 · A model sees an explicit, allow-listed, budgeted selection — never "the context"
`@vixera/intelligence` has no way to hand a model an entity: it hands it a
`ContextSelection`, reduced to per-type allow-listed fields (no bodies, no
addresses, no tokens), under byte/item/field budgets, with a deterministic
serialization and a content-free manifest. Replies may only cite refs from the
selection. Every run is audited by reference and size, never by content. Task
outputs are data; suggestions are notes, never actions. Provider adapters that
hold keys are server-side only.

## ADR-017 · A full resync reconciles by watermark, inside the scope the source declares
When a provider invalidates a checkpoint (Gmail history too old, a Graph delta
link rejected or expired, a Calendar sync token gone or its window stale, a
rejected Plaid cursor) the source re-lists from scratch with `fullResync: true`
and the engine upserts by natural key. Rows the provider deleted during the
gap are never mentioned again, so upserting alone kept them forever — the
state this ADR first recorded as a known limitation (audit SYNC-4 / MS-4).
The engine now reconciles, without a seen set: every page of a from-scratch
listing declares what it covers (`SyncPage.resyncScope` — mail received since
a moment, a set of calendars inside a window, or `all` for a bank Item); on a
real resync (`fullResync: true`, or a pass the engine restarted after the
store rejected a checkpoint) the engine records `{ since, scope }` on the
capability's sync state (`connector_sync_states.reconcile`, migration 12),
with `since` the sync state's own `updated_at` stamp from the moment the pass
began; when the pass reports `done` it deletes the rows of that account and
capability inside the scope whose `updated_at` is older than `since`. Every
row the pass touched carries a newer stamp — the `updated_at` triggers fire on
every upsert, changed or not — and both stamps come from the database clock,
so no device clock takes part. Chosen over a seen set of external ids because
the watermark costs one column and no per-id bookkeeping, and over "delete
whatever the last listing did not name" because the scope keeps a 30-day mail
backfill from deleting older mail it never listed. The state is kept per listing unit (a mail window, one calendar inside its
window, a whole Item) and persisted, so a pass the run budget splits across
runs reconciles when it finally completes: a resumed page declares the very
same scope and keeps its unit's watermark, while a listing that starts over
(a fresh window after a rejected page token or link) replaces its unit with a
watermark at the new start — never the union of the two windows, because the
earlier, partial listing cannot vouch for rows the new window does not cover. Not reconciled, deliberately: a first-ever sync (not a resync, and
nothing is older than it), a source that declares no scope (nothing is
deleted, as before — every source in this repository declares one), rows
outside the declared scope, and money accounts (a closed account keeps its
history; transactions are reconciled). Deleted rows take their context
events, conclusions and handoff focus with them like any other deletion.
