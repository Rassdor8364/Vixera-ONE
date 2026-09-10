# Vixera One

Vixera One is an intelligence layer that sits beside the operating systems
people already use. It does not replace the OS. It connects information from
the user's existing digital life — mail, calendar, bank, documents, devices —
into one context graph and lets the user work from context instead of
switching between applications.

The OS knows: "This is a PDF." Vixera knows: "This is Eric's $4,800 invoice,
attached to the Brand thread, due tomorrow, and currently unpaid."

This repository is Vixera One only (`ai.vixera.one`). Praxion, the document
artifact product (`ai.vixera.praxion`), lives in its own repository and is
treated here as a local connector.

## Layout

```
packages/domain                 pure domain model, currentUser(), context graph, NOW engine, action contracts
packages/sync                   SpineStore (Supabase + in-memory), ContextLinker, SyncEngine, mock connector
packages/connectors/google      Gmail + Google Calendar connector
packages/connectors/microsoft   Microsoft Graph mail + calendar connector
packages/connectors/bank        read-only bank connector (Plaid adapter + mock)
packages/connectors/praxion     versioned Praxion local contract, client, mock server
packages/connectors/screen-context  ScreenContextAdapter implementations
packages/command                One Command intent routing + execution
packages/intelligence           model provider abstraction (null provider in Phase 1)
apps/desktop                    Tauri 2 application: Windows Field and Android companion (React)
apps/desktop/src-tauri          Rust shell (credentials, device identity, hashing, Praxion probe)
plugins/tauri-plugin-vixera-share   Android share-sheet intake + Keystore secure storage (Kotlin)
crates/vixera-platform          platform-neutral Rust (credential store, device identity, SHA-256)
supabase/                       migrations, seed, Edge Functions, config
scripts/                        verify-migrations.sh, check-functions.sh, SQL shim + assertions
docs/                           engineering documentation
```

## Prerequisites

Node 22, pnpm 10 (`corepack enable`), Rust stable ≥ 1.85. Optional per task:
PostgreSQL 15/16 binaries (migration verification), Deno 2 (Edge Function
checks), Docker + Supabase CLI (full local stack), Visual Studio Build Tools
+ WebView2 (Windows build), Android SDK/NDK + JDK 17 (Android build).

Copy `.env.example` to `.env` (git-ignored). It holds public values only:
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_DEV_USER_ID`,
`VITE_DEV_USER_EMAIL`, `VITE_PRAXION_BASE_URL`. Provider secrets are server
configuration (`supabase secrets set`), never in this file.

## Quick start

All commands are defined in the root `package.json` unless noted.

### TypeScript packages

```bash
pnpm install
pnpm typecheck                     # tsc in every workspace package
pnpm test                          # vitest across packages/*, packages/connectors/*, apps/desktop
pnpm test:watch
pnpm --filter @vixera/sync test    # one package
pnpm check                         # typecheck + test + cargo check --workspace
```

### Rust

```bash
cargo check --workspace            # shell + platform crate + share plugin (desktop code paths)
cargo test -p vixera-platform      # credentials, device identity, hashing, loopback probe
```

### Database

```bash
pnpm db:verify                     # throwaway PostgreSQL: shim + every migration + seed + scripts/sql/verify.sql
DATABASE_URL=postgres://... pnpm db:verify   # same assertions against an existing database
```

`db:verify` needs local PostgreSQL binaries (`PGBIN` overrides the
auto-detected `/usr/lib/postgresql/<v>/bin`) or `DATABASE_URL`; no Docker.

### Local Supabase (Docker)

```bash
supabase start                     # Postgres, Auth, Storage, Realtime, Edge runtime
supabase db reset                  # migrations + seed.sql (dev identity dev@vixera.local / vixera-dev-password)
supabase functions serve --env-file supabase/functions/.env
supabase status                    # URL + anon key for .env
```

### Edge Functions

```bash
pnpm functions:check               # deno check per function + deno test supabase/functions/_shared/*_test.ts
```

Requires Deno 2 (`DENO=/path/to/deno` overrides). Contract, secrets and
deployment: `supabase/functions/README.md` and `docs/supabase.md`.

### Field without a backend (dev fixtures)

```bash
VITE_VIXERA_DEV_FIXTURES=true pnpm --filter @vixera/desktop dev   # Vite on http://localhost:1420
```

In-memory spine with the mock connector's world; no Supabase, no secrets.
Set the same variable in `.env` to use it inside Tauri.

### Windows Field

```bash
pnpm dev:desktop                   # = pnpm --filter @vixera/desktop tauri dev
pnpm tauri build                   # NSIS + MSI installers in target/release/bundle/
pnpm tauri build --debug
```

See `docs/build-windows.md`.

### Android companion

```bash
pnpm tauri android init            # once; then edit the generated AndroidManifest.xml (docs/build-android.md)
pnpm tauri android dev             # debug build on the connected device / emulator
pnpm tauri android build --apk     # release APK(s); --target aarch64 for one ABI
```

### Praxion mock server

```bash
pnpm praxion:mock                  # in-memory fake Praxion on http://127.0.0.1:47815
curl -s http://127.0.0.1:47815/v1/health
```

## Documentation

| Document | Content |
| --- | --- |
| [`docs/phase-1-brief.md`](docs/phase-1-brief.md) | the product brief the code was built from; the reference for scope |
| [`docs/architecture.md`](docs/architecture.md) | layering, seams, runtime topology, Phase 1 status against the definition of done |
| [`docs/schema.md`](docs/schema.md) | tables, enums, graph, invariants verified by `db:verify` |
| [`docs/connectors.md`](docs/connectors.md) | Connector interface, accounts, credentials, checkpoints per provider, error handling, link flows, adding a provider |
| [`docs/sync.md`](docs/sync.md) | sync flow end to end, idempotency, linker rules, NOW derivation, Realtime, ingestion, handoff, server actions |
| [`docs/field.md`](docs/field.md) | the Field areas, One Command, dev-fixture mode, Android companion, what the Field is not |
| [`docs/praxion-contract.md`](docs/praxion-contract.md) | the versioned Praxion local contract and client |
| [`docs/screen-context.md`](docs/screen-context.md) | `ScreenContextAdapter` implementations |
| [`docs/current-user.md`](docs/current-user.md) | `currentUser()` strategy |
| [`docs/credentials.md`](docs/credentials.md) | where every secret lives, rotation and revocation |
| [`docs/supabase.md`](docs/supabase.md) | local stack, Edge Functions, secrets, deployment |
| [`docs/build-windows.md`](docs/build-windows.md) | Windows prerequisites, build, runtime layout |
| [`docs/build-android.md`](docs/build-android.md) | Android prerequisites, build, share intake, secure storage |
| [`docs/decisions.md`](docs/decisions.md) | architectural decision log |
| [`supabase/functions/README.md`](supabase/functions/README.md) | Edge Function HTTP contract and secrets |
