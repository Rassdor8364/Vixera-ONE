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

## ADR-017 · A full resync does not reconcile deletions (known limitation, decided)
When a provider invalidates a checkpoint (Gmail history too old, Graph 410,
Calendar 410, a rejected Plaid cursor) the source re-lists from scratch with
`fullResync: true` and the engine upserts by natural key. Rows the provider
deleted during the gap are **not** removed: nothing in the re-list names them,
and the engine keeps no "seen set" to subtract from. They persist with their
context events until the provider mentions them again (it will not) or the user
removes them. Decided against fixing now: the correct fix is a per-capability
reconciliation pass — record the external ids a full resync touched, then delete
the rows of that account and capability it did not touch — whose seen set must
survive a pass that the run budget splits across runs, so it belongs in the
checkpoint or a side table, not in memory. It is a roadmap task, and the
engine, the sync docs and the connector docs say so rather than implying the
gap is closed. Also noted as audit SYNC-4 / MS-4.
