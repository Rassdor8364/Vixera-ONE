# Continuous integration

`.github/workflows/ci.yml` runs on every push and on pull requests from forks
(same-repo PRs are already covered by their push; the `gate` job skips the
duplicate). A newer push to the same ref cancels the run in flight.

Every job runs a command a contributor runs locally. CI proves nothing that a
laptop cannot; it only makes sure it is proved every time.

| Job | Command | What it proves |
| --- | --- | --- |
| `hygiene` | `pnpm check:secrets`, `pnpm check:migrations`, `pnpm check:version` | No secret-shaped content or signing material is tracked. Migrations are well-named, never disable RLS, grant nothing to `anon`, and every `SECURITY DEFINER` function pins `search_path` and is revoked from client roles (or is on the documented allow-list). One version: `tauri.conf.json` derives from `apps/desktop/package.json` and `Cargo.toml` equals it. |
| `typescript` | `pnpm typecheck`, `pnpm test`, `pnpm build:desktop` | Every package type-checks; 490 fixture-only Vitest tests pass; the production frontend builds **with no `.env` present** and the dev-fixture world is not in the entry chunk. |
| `edge-functions` | `pnpm functions:check` | `deno check` on all four functions with the shared import map, then the 43 `_shared` Deno tests. |
| `database` | `pnpm db:verify` | Shim + all eight migrations + seed apply to a throwaway PostgreSQL 16, and `scripts/sql/verify.sql` passes: every table has `user_id` and RLS, a second user sees nothing, client roles cannot write credential refs / checkpoints / action requests, Vault functions are not callable. |
| `live-postgrest` | `pnpm test:live` twice, the second with `VIXERA_REST_MAX_ROWS=5` | `SupabaseSpineStore` against a real PostgREST 12.2.3: row caps, `numeric` as number, conflict targets, RPC signatures, RLS. The row-cap-5 pass is the regression test for reads silently truncating at `max_rows`. |
| `rust` | `cargo check --workspace --locked`, `cargo test -p vixera-platform --locked`, with `RUSTFLAGS=-D warnings` | The Tauri shell, the share plugin and the platform crate compile warning-free against the committed `Cargo.lock`; the 22 platform tests pass (credential chunking, device identity, hashing, loopback probe). |
| `ci-ok` | — | Passes only when every job above passed. **This is the one status to require.** |

No job needs a secret. Provider credentials are never required to prove the
code; the anon key is not needed to build the frontend; the live PostgREST
stack uses a throwaway JWT secret it generates itself.

Caching: pnpm through `actions/setup-node`'s store cache; Cargo through
`Swatinem/rust-cache` keyed on `Cargo.lock`. Cold Rust is the slowest job
(~10 min for the Tauri dependency tree); warm it is ~2 min.

Not in CI, on purpose: the Windows and Android installers. They need a signing
certificate and a keystore that are never committed, and a full `tauri build`
per platform is 20+ minutes. `scripts/build-installers.sh` plus
`pnpm release:verify` (see `docs/installers.md`) are the release gate, run by a
person with the signing material.

## Running the same checks locally

```bash
pnpm check              # secrets + migrations + version + typecheck + test + cargo check
pnpm functions:check    # needs Deno 2
pnpm db:verify          # needs PostgreSQL 15/16 binaries
pnpm test:live          # needs the postgrest binary (see README)
cargo test -p vixera-platform
```

## Branch protection

Branch protection is not configurable from the repository, so these are the
settings to enable on the default branch (Settings → Branches → Add rule):

- **Require a pull request before merging.** One approval is enough for a
  single-maintainer repo; the point is that nothing lands without CI.
- **Require status checks to pass before merging** — required check: `ci-ok`.
  Do not list the individual jobs: `ci-ok` already fails if any of them failed
  or was skipped, and requiring it alone means adding a job later does not need
  a settings change.
- **Require branches to be up to date before merging** — recommended. It costs
  one more CI run on a stale PR and rules out the "two green PRs that break
  each other" case.
- **Do not allow force pushes.**
- **Do not allow deletions.**
- Leave "Require linear history" off; merge commits are fine and rebasing
  someone else's branch is not.

Administrators should not be exempt: the rule exists to protect against the
maintainer's own mistakes, which is the only kind this repo has.
