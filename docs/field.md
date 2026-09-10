# The Field

The Field is the React surface of Vixera One (`apps/desktop/src`), rendered by
Tauri 2 on Windows and, as the companion, on Android. It reads the spine
through `SpineReader`, mutates only through the server action seam, and shows
eight things: NOW, Threads, People, Time, Money, Files, Quiet and One Command.
Nothing else (brief: no module sidebar, card dashboard, KPI grid, permanent
chat panel, app launcher).

Layout (`field/Field.tsx`): a context line on top (current area · focused
entity · state mark · Praxion mark · sign out), a quiet row of area labels, the
area itself, and the One Command bar at the bottom. One column below 720 px.

## Composition

| Layer | File | Role |
| --- | --- | --- |
| Config | `bootstrap/config.ts` | `VITE_*` public values; `VITE_VIXERA_DEV_FIXTURES=true` selects dev-fixture mode |
| Shell | `bootstrap/runtime.ts` `createShell` | once per launch: device identity (Rust `device_identity`), Praxion client, screen-context registry, and either the Supabase client + `SessionCurrentUserProvider` or the in-memory dev world |
| Session runtime | `createSessionRuntime` | once per signed-in user: `SpineReader` bound to that user, action dispatcher, Edge Function client, storage, `OneCommand`, `registerDevice` |
| Identity | `bootstrap/identity.ts` | `currentUser()` provider: Supabase session (throws `NoCurrentUserError` while signed out) or the fixed `DEV_USER_ID` |
| Data | `data/hooks.ts`, `spine-provider.tsx` | read hooks over the reader; a version counter bumped by Realtime and by completed actions makes every hook re-read |
| Actions | `data/actions.ts`, `functions.ts` | `buildEnvelope` → `POST action-dispatch`; idempotency keys (subject-derived for dismiss / quiet / snooze / handoff.accept, fresh uuid otherwise); `ActionInProgressError` on 409 |
| Areas | `field/areas/*.tsx` | one component per area |
| Field API | `field/field-context.tsx` | location (area + focus), `act`, `openDoc`, `handoff`, Praxion availability |
| Platform | `platform/*.ts` | bindings over Rust commands and Tauri plugins; every binding degrades in a plain browser |

The Field never calls a provider API and never writes a context row through
supabase-js. The two client-side writes are the artifact upload
(`data/storage.ts`) and this device's own `devices` row
(`registerDevice`, device identity rather than context state).

## Areas

**NOW** (`areas/Now.tsx`) — greeting, "N things changed since you last looked"
(from a local timestamp), "On screen now" when Praxion has a focused document
(`useScreenContext`, polled every 15 s while Praxion is available), "Left on
another device" (pending handoffs, Continue accepts and reconstructs), then
Needs you / Changed / Next 24 hours / Can wait from `deriveNow()` (see
[`sync.md`](./sync.md) §6). Row actions: Open thread, Open document, Later
(`context_event.quiet`), Dismiss (`context_event.dismiss`). Empty state with no
connected source explains the product in two sentences and offers Connect
Google / Microsoft / bank; with sources connected it says "Quiet for now".

**Threads** (`areas/Threads.tsx`) — list (active first) and a detail: Vixera's
conclusions, people, documents, mail, time, money gathered through one
`neighbors()` hop. New thread (`thread.create`, attaching the focused entity),
Attach by id or "Attach focused entity" (`thread.attach`), Continue on
another device.

**People** (`areas/People.tsx`) — search, list (merged people hidden), detail
with identities, threads, documents, mail (from the graph plus
`fromPersonId`), events, money (graph plus `counterpartyPersonId`). Add to
thread, Continue on.

**Time** (`areas/Time.tsx`) — today plus seven days grouped by day; participants
link to people; the focused event offers Add to thread and Continue on.

**Money** (`areas/Money.tsx`) — accounts with balances, searchable
transactions; a focused transaction shows its counterparty and threads and
offers Add to thread. Read only: no payment affordance exists.

**Files** (`areas/Files.tsx`) — drop zone (Tauri `drag-drop` event on
Windows, HTML drop in a browser), Pick files, "Arriving" (ingest items still
`received`), searchable documents with a location mark (On this device /
Synced / At source). Open uses Praxion when present and the OS viewer or a
signed URL otherwise; Add to thread; Continue on; Compare and Annotate stay
visible but disabled with the reason ("Needs Praxion on this device" or
"contract version is incompatible").

**Quiet** (`areas/Quiet.tsx`) — context events with `attention = quiet`
(60 days), each with "Needs attention" (`context_event.attend`, which also
clears a snooze) and Dismiss (`context_event.dismiss`), followed by Sources:
connected accounts with sync
state, last success and error, Sync now, Disconnect, and the Connect
buttons (`areas/Connectors.tsx`).

**One Command** — below.

Notifications (Windows only, `field/notifications.ts`): each new "needs me"
context event is announced once per device (ids in `localStorage`), the first
batch after launch is not announced, and the notification carries no action
buttons; actions run from NOW through the server.

State marks: Offline (browser offline or Realtime channel down), Processing
(ingest items pending or a share batch in flight), On this device
(dev-fixture mode), Synced (Realtime live), Connecting; plus
"Praxion <version>" when Praxion is available.

## One Command

`packages/command` (`@vixera/command`); the bar is
`field/command/OneCommandBar.tsx`. Alt+Space or Ctrl+K (⌘K) focuses it, Esc
closes results. Results render inline above the bar; a navigate result moves
the Field; a single resolved entity focuses it; clicking a result item
navigates to it.

```
OneCommand.run(text, { area, focus, now, timezone })
  ├─ IntentRouter.route()   RuleBasedIntentRouter: grammar.ts parse → names.ts classification
  └─ CommandExecutor.execute(intent) → CommandResult { kind: navigate | results | answer | unknown, area?, focus?, title, items, message? }
```

Grammar (`grammar.ts`, first matching rule wins, over lower-cased text with
politeness stripped):

| Rule | Examples | Intent |
| --- | --- | --- |
| `open_area` | "open threads", "go to money", "now" | `open_area` |
| `show_thread` | "show thread Brand", "open the Brand thread" | `show_thread` |
| `show_events.*` | "today", "show tomorrow's events", "what's on this week" | `show_events { today \| tomorrow \| week }` |
| `show_recent_files` | "recent files", "show my last 5 documents", "latest invoices" | `show_recent_files { limit }` / `find_document { kind }` |
| `find_document.kind_from_person` | "find the invoice from Eric" | `find_document { kind, fromPersonQuery }` |
| `possessive` | "Eric's documents", "Eric's mail", "Brand's transactions" | `show_person_documents` / `show_person_mail` / transactions for |
| `from_person` | "documents from Eric", "mail from Priya" | as above |
| `show_transactions.for` | "transactions related to Brand this month" | `show_transactions { scope, range }` |
| `show_transactions.all` | "transactions", "spending this week" | `show_transactions` |
| `find_document.kind` / `.named` | "find the contract", "documents called agenda" | `find_document` |
| `scoped_noun` | "documents", "mail", "transactions" | scoped to the focused person / thread |
| `find_person.*` | "who is Eric", "find the person Priya" | `find_person` |
| `find` | "find Eric", "find Brand", "find agreement" | person, thread or document, decided by name match |

Name classification (`names.ts`): exact display name / title (3), a whole
name token such as "eric" in "Eric Lindqvist" (2), prefix (1), only the
reader's substring search (0). "find X" prefers a person over a thread on a
tie and falls back to document search; a bare known thread title opens it,
a bare known person finds them. Ambiguity is a result, not a guess: the
executor returns the candidates with a message. Ranges ("today", "this
week", "this month") are computed in the Field's IANA timezone
(`time-range.ts`, `Intl` only).

The executor answers graph questions with one or two `neighbors()` hops over
a `CommandReader` (a `SpineReader` slice) bound to the current user; no SQL,
no user id in any query. `CommandHistory` keeps the last 20 inputs and feeds
`Handoff.commandHistory`.

The seam: `IntentRouter` is an interface. A model-backed router
(`@vixera/intelligence` `ModelProvider`, server-side only, keys in Supabase
secrets) can implement it later and be composed with the rule-based one;
Phase 1 ships only the rules and the `NullModelProvider`.

## Dev-fixture mode vs production

| | Production (`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`) | Dev fixtures (`VITE_VIXERA_DEV_FIXTURES=true`) |
| --- | --- | --- |
| Identity | Supabase session via `SessionCurrentUserProvider`; sign-in form (email + password, no sign-up) | `DEV_USER_ID` (`VITE_DEV_USER_ID`) installed as a static provider |
| Session storage | `TauriCredentialStore` (Windows Credential Manager / Android Keystore) under `supabase.session`; memory in a browser | none |
| Reader | `SupabaseSpineStore(client, userId)` (RLS + explicit filter) | `InMemorySpineStore(DEV_USER_ID)` |
| Data | whatever the spine holds; empty state without connectors | `MockConnector` synced once at startup (Eric's invoice mail with PDF, Priya's agenda, Northwind kickoff, checking account with two transactions) plus a seeded "Brand" thread with a conclusion |
| Mutations | `POST action-dispatch` | `createDevActionDispatcher` over the in-memory store, same envelope contract and replay semantics |
| Sync now / ingest | `connector-sync`, `ingest-process` Edge Functions | in-process `SyncEngine.runAll()`; ingestion handled inside the dispatcher |
| Storage | bucket `artifacts` | in-memory map |
| Realtime | channel `field:<userId>` | reported as live |
| Connect accounts | `connector-link` flows | not available (mock account is already connected) |
| State mark | Synced / Connecting / Offline | On this device |

`bootstrap/dev-fixtures.ts` is loaded with a dynamic import only in that mode
and is the only place with demo data. Run it in a browser with
`VITE_VIXERA_DEV_FIXTURES=true pnpm --filter @vixera/desktop dev` or inside
Tauri with `pnpm dev:desktop` and the variable in `.env`.

## Android companion

Same code, same areas, phone layout. What differs (`platform/tauri.ts`
`isAndroid()`):

* Starts on NOW every launch (Windows remembers the last area in
  `localStorage`); a **Capture** entry (paste text / a link, pick a file) sits
  above NOW (also shown on any narrow window).
* **Share to Vixera** (`field/companion/useShareIntake.ts`, `share-intake.ts`):
  on mount `getPendingShares()`, then `onShare` for shares while running.
  `drainShares` ingests the batch (files: read bytes → hash → upload →
  `ingest.submit`; text/URL: `ingest.submit`), re-reads the queue for shares
  that arrived meanwhile, and clears the queue only when every item was
  dispatched; a failed batch leaves the queue for the next launch. Then
  `ingest-process` and a refresh. Plugin details and the manifest edit are in
  [`build-android.md`](./build-android.md).
* No OS notifications from NOW (`NeedsMeWatcher` is desktop only).
* Praxion is never present: Open uses the OS viewer through a cached copy
  when the fs capability allows writing, otherwise a signed URL in the
  browser. Compare / Annotate stay disabled.
* Handoffs work in both directions ("Continue on <phone>", and accepting on
  the phone).
* The sign-out button sits in the context line at every width.

No accessibility service, no overlay, no screen reading, no background
capture: the user hands Vixera an object explicitly.

## What the Field deliberately is not

* Not a dashboard: no sidebar of modules, cards, KPIs, charts, launcher or
  permanent AI panel; the areas are labels in one row.
* Not a client with business logic: importance, NOW buckets, name resolution
  and intent parsing live in `@vixera/domain` / `@vixera/command`; the Field
  renders results.
* Not a writer: no direct row mutations, no provider calls, no tokens. It
  uploads bytes and registers its own device row; everything else is a server
  action.
* Not a document viewer: Praxion or the OS renders artifacts; the Field only
  opens them and shows their context.
* Not an onboarding flow: sign-in into an existing Supabase user only; no
  sign-up, no settings suite, no team features.
* Not Praxion-dependent: with Praxion absent everything except structured
  content, compare, annotate and page state works unchanged.

## Known gaps (Phase 1)

* Notification click-to-front is not wired (the notification plugin exposes
  no click handler from the WebView).
* `NeedsMeWatcher` and the NOW area both call `useNow()`, so the NOW queries
  run twice per refresh while NOW is open.
* `bootstrap/supabase.ts` builds the client with `createClient` directly.
  `createSpineClient` now takes `storageKey`, so this can be switched over.

Closed since the first draft: Quiet can move an item back to the attention
stream (`context_event.attend`), the desktop and Android capabilities allow
writing into `$APPCACHE/**` and opening a path (so a Storage artifact opens
locally rather than only through a signed URL), and sign out is reachable at
phone width.
