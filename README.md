# Vixera One

**Everything connects.**

Vixera One is an intelligence layer that sits beside the operating systems people already
use (Windows, macOS, iOS, iPadOS, Android). It does not replace the OS. It connects
information from the user's existing digital life — mail, calendar, bank, documents,
devices — into one context graph, and lets the user work from context instead of switching
between applications.

The OS knows: *"This is a PDF."*
Vixera knows: *"This is Eric's $4,800 invoice, attached to the Brand thread, due tomorrow, and currently unpaid."*

This repository is Vixera One only. Praxion (the document artifact product, `ai.vixera.praxion`)
lives in its own repository and is treated here as a local connector.

## Layout

```
packages/domain              pure domain model, currentUser(), context graph, NOW engine
packages/sync                SpineStore + SyncEngine + ContextLinker (Supabase + in-memory)
packages/connectors/google   Gmail + Google Calendar connector
packages/connectors/microsoft Microsoft Graph mail + calendar connector
packages/connectors/bank     read-only bank connector (Plaid adapter + mock)
packages/connectors/praxion  versioned Praxion local contract, client, mock server
packages/connectors/screen-context  ScreenContextAdapter implementations
packages/command             One Command intent routing + execution
packages/intelligence        model provider abstraction
apps/desktop                 Tauri 2 application (Windows Field, Android companion)
crates/vixera-platform       platform-neutral Rust (credential store, device identity)
supabase/                    migrations, seed, Edge Functions, config
docs/                        engineering documentation
```

Start with [`docs/architecture.md`](docs/architecture.md).

## Quick start

```bash
pnpm install
pnpm typecheck && pnpm test          # TypeScript packages
cargo check --workspace              # Rust
pnpm db:verify                       # apply migrations to a throwaway local Postgres
supabase start && supabase db reset  # full local Supabase (requires Docker)
pnpm dev:desktop                     # Windows Field (requires Rust + WebView2)
```

See `docs/build-windows.md`, `docs/build-android.md` and `docs/supabase.md`.
