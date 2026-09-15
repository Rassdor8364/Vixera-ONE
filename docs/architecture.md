# Vixera One — Architecture (Phase 1)

> The operating system manages the device. Vixera manages context. Praxion manages the
> document artifact. Connectors bring external information in. The sync spine connects it.
> The Field makes that context usable.

This document is the source of truth for how the Phase 1 codebase is put together.
Companion documents live beside it in `docs/`:

| Topic | Document |
| --- | --- |
| Installers (Windows .exe, Android .apk) | [`installers.md`](./installers.md) |
| Database schema | [`schema.md`](./schema.md) |
| Connector contract | [`connectors.md`](./connectors.md) |
| Praxion local contract | [`praxion-contract.md`](./praxion-contract.md) |
| Sync flow, ingestion, handoff, server actions | [`sync.md`](./sync.md) |
| The Field (areas, One Command, dev fixtures, Android) | [`field.md`](./field.md) |
| currentUser strategy | [`current-user.md`](./current-user.md) |
| Credential storage | [`credentials.md`](./credentials.md) |
| Screen-context adapters | [`screen-context.md`](./screen-context.md) |
| Windows build | [`build-windows.md`](./build-windows.md) |
| Android build | [`build-android.md`](./build-android.md) |
| Supabase local + deployment | [`supabase.md`](./supabase.md) |
| Decision log | [`decisions.md`](./decisions.md) |

## 1. What Vixera One is

Vixera One is an intelligence layer that sits **beside** Windows, macOS, iOS, iPadOS and
Android. It does not replace the OS. It connects information from the user's existing
digital life (mail, calendar, bank, documents, devices) into one **context graph** and lets
the user work from context instead of from applications.

Praxion is a separate product (separate repo, identity `ai.vixera.praxion`, separate data
store) that owns the document *artifact*. Vixera One (`ai.vixera.one`) owns *context*.
Praxion is treated as a third-party local connector.

## 2. Layering

```
┌──────────────────────────────────────────────────────────────────────────┐
│ UI          apps/desktop/src (React Field: NOW, Threads, People, Time,   │
│             Money, Files, Quiet, One Command)                            │
├──────────────────────────────────────────────────────────────────────────┤
│ Platform    apps/desktop/src-tauri (Rust: window, credentials, device    │
│             identity, opener, share/capture bridge) + Kotlin plugin      │
├──────────────────────────────────────────────────────────────────────────┤
│ Command /   packages/command (One Command intent routing + execution)    │
│ Intelligence packages/intelligence (providers behind a seam, allow-listed │
│             context selection, typed tasks, content-free audit; NOW      │
│             derivation lives in domain because it is deterministic)      │
├──────────────────────────────────────────────────────────────────────────┤
│ Connectors  packages/connectors/* (google, microsoft, bank/plaid,        │
│             praxion, screen-context) — provider specifics stop here      │
├──────────────────────────────────────────────────────────────────────────┤
│ Sync        packages/sync (SpineStore, SyncEngine, ContextLinker,        │
│             Supabase + in-memory stores)                                 │
├──────────────────────────────────────────────────────────────────────────┤
│ Domain      packages/domain (entities, ids, relationship kinds,          │
│             normalized connector objects, currentUser(), graph ops,      │
│             NOW engine, ingestion model, action contracts)               │
├──────────────────────────────────────────────────────────────────────────┤
│ Spine       supabase/ (PostgreSQL migrations, RLS, Vault, Storage,       │
│             Realtime, Edge Functions)                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

Dependency rule (enforced by package `dependencies` and reviewed in tests):

* `domain` depends on nothing (no React, no Tauri, no Supabase).
* `sync` depends on `domain` (+ `@supabase/supabase-js` in one adapter file).
* `connectors/*` depend on `domain` only, except `screen-context`, which also depends on
  `praxion` because the Praxion client is one implementation of the adapter. None of them
  import UI, sync or Tauri.
* `command` depends on `domain` and the `SpineReader` interface from `sync`; `intelligence`
  depends on `domain` only.
* `apps/desktop/src` (UI) depends on everything above through interfaces; it never calls
  a provider API directly.
* `apps/desktop/src-tauri` (Rust) knows nothing about the domain model; it exposes
  platform capabilities as Tauri commands and events.
* Edge Functions import `domain`, `sync`, `connectors` source through an import map.

## 3. The four mandatory seams

| Seam | Where | How |
| --- | --- | --- |
| `user_id` everywhere | every table in `supabase/migrations` | `user_id uuid not null references public.users(id)`; RLS `user_id = auth.uid()`; every normalized write carries `userId` |
| `currentUser()` | `packages/domain/src/identity/current-user.ts` | one function backed by a swappable `CurrentUserProvider`; dev provider returns `DEV_USER_ID` |
| Connector interface | `packages/domain/src/connectors/*.ts` | `Connector`, capability interfaces, `ConnectorAccount` rows; one user → many connector accounts per provider |
| `ScreenContextAdapter` | `packages/domain/src/screen-context/*.ts`, impls in `packages/connectors/screen-context` | Praxion structured content and explicit capture behind one interface; no OCR |

## 4. Runtime topology

```
 Windows (Tauri 2)                  Supabase                        Android (Tauri 2)
 ┌───────────────────┐   HTTPS   ┌────────────────────────┐  HTTPS  ┌──────────────────┐
 │ Field (React)     │◄────────►│ PostgreSQL (spine, RLS) │◄───────►│ Companion (React)│
 │ command / sync    │ realtime │ Vault (credentials)     │ realtime│ share / capture  │
 │ praxion client ───┼─loopback │ Storage (artifacts)     │         │ ingest / handoff │
 │ Rust: keyring,    │          │ Edge Functions:         │         │ Kotlin: share    │
 │ device id, opener │          │  action-dispatch        │         │ intent bridge    │
 └───────────────────┘          │  connector-link         │         └──────────────────┘
        │ 127.0.0.1:47815       │  connector-sync         │
        ▼                       │  ingest-process         │
 ┌───────────────────┐          │ pg_cron → connector-sync│
 │ Praxion (optional)│          └────────────────────────┘
 └───────────────────┘                    ▲
                                          │ provider APIs (Gmail, Google Calendar,
                                          │ Microsoft Graph, Plaid) — server side
```

**Connector sync runs server-side** (Edge Function `connector-sync`, scheduled by `pg_cron`
and invokable on demand by a client). Rationale: the spine must stay current when the
Windows machine is asleep, Android must receive context without Windows, and provider
tokens then never have to be distributed to devices. The same `SyncEngine` is runtime
neutral (pure TypeScript over `SpineStore` + `CredentialStore`) so a device-hosted sync is
possible later without changing connectors.

**Provider credentials live in Supabase Vault**, referenced from `connector_accounts.credential_ref`.
Devices keep their own secrets (Supabase session, device key) in platform secure storage via
the Rust `CredentialStore` (Windows Credential Manager; Android Keystore-backed
EncryptedSharedPreferences through the Kotlin plugin).

**Notification actions execute server-side**: a notification action produces an authenticated
`POST /functions/v1/action-dispatch` with an idempotency key; the function records an
`action_requests` row, executes the handler (durable, retry-safe), persists state, and the
client refreshes through Realtime/sync. The client never has to stay alive to finish an action.

## 5. Context graph

Entities (all in PostgreSQL, all with `user_id`): `people`, `threads`, `documents`,
`mail_messages`, `money_accounts`, `money_transactions`, `time_events`, `context_events`,
`conclusions`, `ingest_items`, `handoffs`.

Relationships are one typed edge table: `relationships(from_type, from_id, kind, to_type, to_id)`
with a fixed `relationship_kind` enum (`relates_to`, `belongs_to`, `originated_from`,
`has_person`, `has_time`, `has_document`, `has_money`, `has_mail`, `replaces`, `mentions`,
`attached_to`). Referential validity is enforced by a trigger that checks the target row
exists in the table named by `*_type`, and per-entity delete triggers remove dangling edges.
See `schema.md`.

People are normalized through `person_identities` (email / phone / provider identity →
person). Every connector participant is resolved through `ContextLinker.resolvePerson`
which finds-or-creates a person by normalized identity. No per-provider duplicates.

## 6. NOW and Quiet

`packages/domain/src/now/derive-now.ts` is a pure, deterministic function:

```
deriveNow({ contextEvents, timeEvents, moneyTransactions, threads, relationships, now, timeZone? })
  → { needsMe, changed, canWait, quiet, upcoming, generatedAt }
```

Score = importance (0–100, set by linker rules) + time-sensitivity boost (due/starts within
24h/48h, overdue) + recency + thread attachment. Rules that decide the bucket regardless of
score: an appointment that has ended is Quiet whatever its importance ("already happened"
stays in the reasons); an overdue item never takes the "older than window" penalty, so a
debt does not fade with age; an unparseable `occurredAt` counts as old, not new. All-day
events are stored as UTC midnight of their civil date and are judged at local midnight in
`timeZone` (the Field passes the device zone; connectors' own `timezone` is the fallback,
then UTC) — an offsite tomorrow is not "happening now" at 17:00 tonight in Los Angeles.

`context_events.attention` separates `needs_attention` from `quiet`. Snooze is
`quiet` plus `metadata.snoozedUntil`; when it elapses the item competes again. The
`context_event.quiet` action clears `snoozedUntil`, so a Quiet the user chooses after a
snooze elapsed sticks instead of being read as "snooze elapsed" forever. No learned model.

## 7. One Command

`packages/command`: `IntentRouter` interface → `HybridIntentRouter`, which runs the
`RuleBasedIntentRouter` (deterministic grammar over the user's own names: people, threads)
and consults a `ModelIntentRouter` only when the rules are unsure (ADR-015). Any intent
that did not come from the grammar crosses `parseIntent`, which accepts exactly the `Intent`
union. `CommandExecutor` runs typed queries against `SpineReader` and returns a
`CommandResult` (navigation target + result set); it is the same executor for both routers,
so a model can only choose among intents the grammar already has. The model router is wired
with `null` until a server-side classifier exists (`docs/intelligence.md`).

## 8. Praxion

`packages/connectors/praxion` holds the versioned local contract (`PRAXION_CONTRACT_VERSION`),
the `PraxionConnector` client over a swappable `PraxionTransport` (fetch / Tauri HTTP), and a
mock server used in development and tests. Praxion absent ⇒ `availability = 'unavailable'`,
document actions fall back to OS viewing through the Rust opener; the rest of Vixera is
unaffected. See `praxion-contract.md`.

## 9. Ingestion and handoff

All explicit input (Android share sheet, Windows file drop, capture) becomes an
`IngestItem` (`domain/src/ingest`). One normalized pipeline (`ingest-process` Edge Function or
the same TypeScript locally) determines type, source, metadata, creates/links a `document`,
resolves known people/threads, and emits a `context_event`.

`handoffs` rows carry source/destination device, focus object, thread, document reference,
artifact storage path, Praxion location, conclusions, timestamp and state. The receiving
device subscribes through Realtime, reconstructs context, and hands the artifact to Praxion
if present.

## 10. Build order and what is intentionally deferred

Implemented in Phase 1: spine, connectors (Google mail+calendar, Microsoft mail+calendar,
Plaid bank read), sync engine, Praxion contract/client/mock, screen-context adapters, Windows
Field, Android companion foundation (share/capture → ingest), server actions, handoff model.

Deferred on purpose: floating overlays over arbitrary apps, Android accessibility/assist
screen reading, OCR pipelines, Explorer shell extension, tray workflows, macOS/iOS/iPadOS
clients, payment execution, multi-user onboarding, Praxion accounts, model marketplace.

## 11. Phase 1 status

Each line of the brief's definition of done, where it is realized, and what is only
partially realized. Verified on 2026-09-10 in a Linux container: `pnpm typecheck` clean,
`pnpm test` (468 vitest tests / 52 files), `pnpm functions:check` (42 Deno tests),
`pnpm db:verify` (all assertions), `pnpm test:live` (the store conformance suite plus the
security assertions against a real PostgreSQL + PostgREST), `cargo check --workspace`
(also for `aarch64-linux-android`), `cargo test -p vixera-platform` (15 tests), and
`pnpm tauri android build --apk --target aarch64 --debug` (APK produced and inspected).

| Definition of done | Realized in | Status |
| --- | --- | --- |
| Supabase/Postgres spine exists | `supabase/migrations/20260910000100_spine.sql` … `000700`, `supabase/config.toml`, `seed.sql`; `scripts/verify-migrations.sh` + `scripts/sql/verify.sql`, `scripts/live-stack.sh` | Done. Migrations verified against throwaway PostgreSQL, and the schema serves a real PostgREST with RLS, cross-user FK and credential-privilege assertions; **not yet applied to a live Supabase project** in this environment |
| All rows use `user_id` | every table in `000100_spine.sql`; asserted by `verify.sql` §1; `SupabaseSpineStore` filters and sets it | Done |
| `currentUser()` central | `packages/domain/src/identity/current-user.ts`; Field `apps/desktop/src/bootstrap/identity.ts`; Edge Functions `supabase/functions/_shared/auth.ts` (per request) | Done |
| Multi-account connector accounts | `connector_accounts` natural key `(user, provider, external_account_id)`, `ConnectorRegistry`, stateless connectors, `persistLinkedAccount` (`_shared/link.ts`) | Done |
| Credentials behind a secure abstraction | `CredentialStore` (domain) → `VaultCredentialStore` (`_shared/credentials.ts`, RPCs in `000300`); devices: `crates/vixera-platform/src/credentials.rs`, `apps/desktop/src/platform/credentials.ts`, Kotlin `SharePlugin` secure store | Done. Vault RPCs exercised against a plaintext stand-in in `db:verify`, not against Supabase Vault itself |
| Mail, calendar and bank READ feed normalized context | `packages/connectors/google`, `microsoft`, `bank`; `packages/sync/src/linker`; `_shared/sync.ts`; `connector-sync` + `pg_cron` (`000500`) | Done in code with fixture-based tests. **Not exercised against live Google / Microsoft / Plaid APIs.** `SupabaseSpineStore` now runs the shared store conformance suite against a real PostgREST (`scripts/live-stack.sh`, `pnpm test:live`) |
| People / threads / documents / money / time relate | `relationships` table + triggers (`000100`, `000600`), `packages/domain/src/graph`, linker edges, `thread.attach`, `person.merge` | Done |
| Windows app launches as an installed Tauri app | `apps/desktop/src-tauri` (`tauri.conf.json`, NSIS/MSI bundle config), `docs/build-windows.md` | Code and config present; `cargo check` passes on Linux. **Windows installer build not run in this environment** |
| Field reads real spine data | `apps/desktop/src/bootstrap/runtime.ts` (`SupabaseSpineStore` reader), `data/hooks.ts`, Realtime (`data/realtime.ts`) | Done in code; end-to-end against a live project pending the first deploy |
| NOW / Threads / People / Time / Money / Files / Quiet have initial surfaces | `apps/desktop/src/field/areas/*.tsx`, `docs/field.md` | Done |
| One Command answers basic queries | `packages/command` (grammar, router, executor), `field/command/OneCommandBar.tsx`; tests in `router.test.ts`, `executor.test.ts`, `one-command.test.ts` | Done for the brief's examples; rule-based only |
| Praxion detected via versioned contract, used if present, absent is fine | `packages/connectors/praxion`, `apps/desktop/src/platform/praxion-transport.ts`, `data/praxion.ts`, `data/open-document.ts`; mock server | Done; degradation tested with the in-memory fake, no real Praxion build exists yet |
| Android builds with share/capture → ingestion | `plugins/tauri-plugin-vixera-share` (Kotlin + Rust), `apps/desktop/src-tauri/gen/android`, `apps/desktop/src/field/companion/*`, `data/ingest.ts`, `_shared/ingest.ts`, `capabilities/mobile.json` | Done. `pnpm tauri android build --apk --target aarch64 --debug` produces an APK containing `ai.vixera.one.share.SharePlugin` / `ShareInbox`, `EncryptedSharedPreferences`, `lib/arm64-v8a/libvixera_one_lib.so` and the `ACTION_SEND` / `ACTION_SEND_MULTIPLE` filters. **Not installed on a device here**, so the share journey itself is untested end to end |
| Vixera-owned handoff architecture | `handoffs` table, `handoff.create` / `handoff.accept` handlers, `apps/desktop/src/data/handoff.ts`, `ContinueOn` | Done, including Praxion page state (taken from the `ScreenContextRegistry` when the focused document is provably the one handed off) and a best-effort open on the receiver, so a document this device cannot open never loses the context. `delivered` / `cancelled` states exist but nothing sets them |
| Notification actions are server actions | `action-dispatch`, `_shared/actions.ts`, `action_requests`, `apps/desktop/src/data/actions.ts`; notifications carry no client-side actions | Done |

Partially realized or open, beyond the table: disconnect does not revoke the grant at the
provider; Plaid requires Hosted Link; notification click-to-front is unwired. Details in
`docs/field.md` (Known gaps) and `docs/connectors.md` (Deliberately not implemented).

## 12. Phase 2 status (2026-09-15)

Phase 2 hardened what Phase 1 built rather than adding surface. Verified on this branch in
a Linux container, from a clean tree: `pnpm check` (secrets, migrations and version guards;
typecheck; 704 vitest tests in 67 files; `cargo check --workspace` with `-D warnings`),
`pnpm functions:check` (4 functions, 55 Deno tests), `pnpm db:verify` (14 migrations + seed,
every `verify.sql` assertion), `pnpm test:live` (122 tests against real PostgREST 12.2.3),
`cargo test` (36 + 1), and both installers rebuilt and passed by `release:verify`.

| Area | What changed | Status |
| --- | --- | --- |
| CI | `.github/workflows/ci.yml`: hygiene (secrets, migrations, version), typecheck + tests, Edge Functions, database, live PostgREST, Rust with `-D warnings`; one required `ci-ok` check; no production credentials | Implemented; runs on push |
| Release | one version derived everywhere; signed-or-refuse; `release-verify` inspects PE resources, Authenticode, APK signer and versionCode, and ties the binary to a build manifest of the env Vite really baked; pinned project URL; dirty trees refused; one commit per release | Implemented; verified on the artifacts in `dist/installers` |
| Auth / session | tokens bound to the runtime's user; recover-by-code; sign-out this device only; dev fixtures refused in production; generation-tagged credential chunks; namespace enforced in Rust and Kotlin; iOS fails closed | Fixture-tested; the live project still needs the `{{ .Token }}` template |
| Connectors | Gmail label semantics, scope-derived capabilities, first-failure stop, honest 404s, per-page calendar checkpoints, series cancellation; Graph shared refresh, page-by-page backfill, `$select`-free calendarView, Windows zones, linear HTML; Plaid cursor contract, in-place relink of a parked Item from the Field's Reconnect, a rejected cursor re-lists once, date-only `authorized_date` | Fixture-tested and adversarially reviewed; **not integration-tested** — `docs/smoke-tests.md` |
| Graph / NOW | version comebacks re-open, ambiguous merchants link nobody, lost races merge; timezone-aware NOW windows, overdue never fades; every list read paged; `vx_neighbors` paged; conflicts on `(user_id, id)`; mail carries its direction and what the person sent is context, never attention | Fixture- and live-PostgREST-tested |
| Sync / actions | real resume points, exponential backoff, running guard; a full resync reconciles what it never listed inside its declared scope (ADR-017); a failure that will repeat is held, not probed; passes that cannot resume run first and only with budget to finish; transient failures defer ingest items and keep action keys unspent (bounded) | Fixture-tested (vitest, Deno, live PostgREST) |
| Database | Realtime DELETE events carry no row (migration 9); ingest attempts (10); a deleted focus clears its handoff and `status` is server-owned (11); a full resync in progress is remembered so it can reconcile (12); the kind of the last failure, so a repeating one is held rather than probed (13); which way a message went (14) | Verified by `db:verify`; **migrations 9–14 not yet applied to the live project** |
| Intelligence | provider seam, allow-listed and budgeted context selection, six typed tasks, capability checks, content-free audit | Fixture-tested with a scripted provider; no real provider adapter |
| One Command | hybrid router seam (rules first, model only when unsure, wired `null`); open captures leave room for a model; `last week` means last week | Fixture-tested; no model has routed a real command |
| Field | no new surface; Phase 2 Field work is a written design (`docs/field-phase-2-design.md`) | Design only |

The one known, decided limitation is the `pg_net` PUBLIC grants (`docs/supabase.md`), which
cannot be fixed from the `postgres` role. ADR-017 (full-resync reconciliation) is implemented
and fixture-tested; it has not run against a real provider.

What is deliberately absent is listed in the brief's "do not build" section and is absent:
no overlay over foreign windows, no Android accessibility or assist reading, no OCR, no
Explorer shell extension, no macOS/iOS/iPadOS client, no payment execution, no Praxion
account, no model marketplace.
