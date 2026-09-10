# Vixera One — Phase 1 brief (product owner, September 2026)

This is the brief the Phase 1 codebase was built from. It is the reference for
scope questions: if something is not here, it is not Phase 1.

## Product
Vixera One is an intelligence layer that sits beside existing operating systems
(Windows, macOS, iOS, iPadOS, Android). It does NOT replace the OS. It connects
information from the user's existing digital life and lets the user work from
context instead of switching between applications. The OS knows "this is a PDF";
Vixera knows "this is Eric's $4,800 invoice, attached to the Brand thread, due
tomorrow, and currently unpaid."

## Build target
Solo-built internal version. One user. Personal use now; public product 2027.
Not disposable prototype code; not over-engineered for speculative features.

Phase 1 objectives, in order:
1. Working sync spine
2. Windows Vixera Field
3. Praxion local connector
4. Mail connector
5. Calendar connector
6. Bank READ connector
7. Android companion foundation for capture / share / context

Deferred: floating overlays over arbitrary Windows apps, Android accessibility /
assist screen reading, OCR-everything, complex shell integration.

## Locked stack
Backend: Supabase (PostgreSQL, Edge Functions, Realtime where appropriate,
Storage only where Vixera needs synchronized artifacts/context payloads).
App: Tauri 2, React, TypeScript, Rust. Same core app architecture for Windows and
Android; Kotlin through the Tauri plugin bridge only where required.
Domain must not depend on React; business logic must not depend on Tauri.
Separate domain / sync / connectors / platform / UI.

## Platform priority
Windows is the first full Field. Android is the first companion (explicit
capture, share-to-Vixera, receiving synchronized context, basic NOW when
practical). No parity requirement.

## Repository and identity
Vixera One is its own repository; Praxion is separate (repo, release cadence,
app identity, package identity, data stores, runtime). Vixera must install and
run where Praxion does not exist. Identifiers: `ai.vixera.one`, `ai.vixera.praxion`.

## Vixera vs Praxion
Praxion owns the artifact: PDF/page rendering, annotation, comparison, signing,
Pencil, document editing state, page state, structured document content.
Vixera owns context: threads, people, money, time, connectors, relationships,
context graph, AI conclusions, cross-device context, actions.
Praxion behaves like a third-party connector. No shared database, no importing
Praxion internals, no direct access to Praxion's persistence.

## Praxion local contract
Versioned local connector contract; loopback HTTP unless a platform limitation
makes IPC substantially safer/simpler; transport behind an interface.
Capabilities: health/availability, contract version, open document, current
document, current page/location, structured content, selected content,
document metadata, request supported artifact action. Mock adapter for dev.
Example: `/v1/health`, `/v1/context/current`, `/v1/documents/{id}/content`,
`/v1/documents/{id}/location` (names not sacred; separation and versioning are).

## Screen reading
Behind a swappable `ScreenContextAdapter`. Praxion structured content is
primary; explicit capture second. No generalized OCR surveillance.

## Praxion document sync
Praxion stays local-first, login-free, single-user, and does not sync. Vixera
owns transport during handoff: artifact payload when required, artifact
identity, current context, location, related thread/people, conclusions. On the
receiving device: hand to Praxion if present, else OS viewer.

## Four mandatory seams
1. `user_id` on every persisted domain row (hard-coded dev user allowed).
2. `currentUser()` — one source of truth; no scattered emails / machine names.
3. Connector interface for every external service; multiple accounts per
   provider (one user, many connectors, many accounts). Never `user.hasGoogle`.
4. `ScreenContextAdapter` for all screen/document context ingestion.

## Token storage
Never in source, committed .env, plain JSON or unencrypted rows. Per-account
credential storage abstraction; platform secure storage for installed apps;
server secrets in secure server configuration. Accounts reference credentials.

## Sync spine (Phase 1 priority)
Entities: users, connector accounts, people, threads, documents, money records,
time records, relationships, context events, device/handoff records. Everything
meaningful can relate to everything else via a typed relationship model in
PostgreSQL (no exotic graph DB, no one-off join tables).

Threads: something happening in the user's life/work; can contain people,
documents, mail, events, money, context events, conclusions.
People: normalized across sources with a sane identity model (email, phone,
provider identity, name) without claiming perfect entity resolution.
Documents: context only (identity, name, source, location, Praxion ref,
relationships, metadata). Money: READ only (accounts, balances, transactions,
merchant, amount, currency, date, source account, relationships). Time:
calendar (account, event id, title, start, end, participants, location,
source, relationships). No scheduling engine, no payment execution.

Mail / calendar / bank connectors: connect account, store tokens securely, sync
what context needs, normalize, link people/documents. Each connector account
tracks provider, identity, status, last success, cursor, error, credential
ref. One failure must not break the cycle. Restartable and idempotent.

## Supabase
Postgres as source of truth. Migrations for everything. RLS with user_id-aware
policies even for one user.

## Server action rule
Notification actions execute through authenticated server-side logic (Edge
Functions), durable, idempotent, auditable, retry-safe — never dependent on the
client staying alive. Applies on Windows too.

## Field (Windows)
Not a SaaS dashboard: no permanent module sidebar, card dashboard, KPI grid,
permanent AI chat panel, app launcher. Areas: NOW, Threads, People, Time, Money,
Files, Quiet, One Command. Nothing more.
NOW: what matters / changed / needs me / can wait, derived from the spine with
deterministic logic first. Quiet: lower-priority context. No hardcoded demo
data in production; useful empty state without connectors.
One Command: text input, intent routing interface, context awareness, basic
navigation/query actions over normalized data (e.g. "Find Eric", "Show Eric's
documents", "Show today's events", "Find the invoice from Eric", "Show recent
files", "Show transactions related to Brand").
Intelligence: model abstraction, no marketplace, only what Phase 1 needs.

## Windows app
Real Tauri desktop app; React renders the Field; Rust handles platform
capabilities. No overlay, no Explorer extension, no tray workflows yet.

## Android
Same Tauri project. Explicit capture, share-to-Vixera, context ingestion,
synchronization, receiving context. Kotlin only where required. No
accessibility screen reading, no overlays.

## Share / capture
User explicitly hands Vixera an object (PDF, image, URL/text, capture). One
normalized ingestion pipeline determines type, source, metadata, document
representation, known people/thread relationships.

## Cross-device handoff
Source device, destination device, focus object, thread, document reference,
artifact payload/reference, Praxion location/page state, timestamp, state.
Receiver reconstructs context; uses Praxion if present.

## Local Praxion degradation
Detect at runtime; use structured content when available; otherwise Vixera
still launches, documents remain, OS viewer used, only Praxion-specific
features (compare, annotation, page state) disabled.

## Development user
Stable dev identity (`DEV_USER_ID`), returned by `currentUser()`. Not the
owner's email, not the Windows account, not inferred from the machine.

## Engineering priorities
1 correct data boundaries · 2 working sync · 3 connector isolation ·
4 Praxion independence · 5 reliable relationships · 6 Windows Field ·
7 Android ingestion · 8 developer experience · 9 visual polish.

## Tests (minimum)
currentUser abstraction; connector normalization; multi-account separation;
relationship/graph operations; sync idempotency; Praxion unavailable behavior;
Praxion contract version handling; notification server-action handling.

## Documentation
Architecture, schema, connector contract, Praxion contract, sync flow,
currentUser strategy, credential storage, screen-context adapter, Windows
build, Android build, Supabase local/deployment, decision log.

## Definition of done
Supabase/Postgres spine exists; all rows use user_id; currentUser() central;
multi-account connector accounts; credentials behind a secure abstraction; mail,
calendar and bank READ feed normalized context; people/threads/documents/money/
time relate; Windows app launches as an installed Tauri app; Field reads real
spine data; NOW/Threads/People/Time/Money/Files/Quiet have initial surfaces; One
Command answers basic queries; Praxion detected via versioned contract, used if
present, absent is fine; Android builds with share/capture → ingestion; Vixera-
owned handoff architecture; notification actions are server actions.

## Do not build
Overlays, Android accessibility reading, OCR pipeline, Explorer extension,
macOS/iPhone/iPad clients, public onboarding, Praxion login/cloud/shared DB,
agent marketplace, automation builder, payment execution, social, team admin,
large settings suite. No features not in this brief.

VIXERA ONE — Everything Connects.
