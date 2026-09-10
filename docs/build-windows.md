# Windows build (Vixera One Field)

The Windows app is a real Tauri 2 desktop application (`apps/desktop`,
identifier `ai.vixera.one`, product name "Vixera One"). React renders the
Field; Rust (`apps/desktop/src-tauri` + `crates/vixera-platform`) handles
platform capabilities. There is **no overlay, no tray workflow and no Explorer
shell extension in Phase 1**; the app is a normal window.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Rust | stable, >= 1.85 (`rustup default stable`) | MSVC toolchain: `x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | 2022 | workload "Desktop development with C++" (MSVC v143, Windows 10/11 SDK) |
| WebView2 | Evergreen runtime | preinstalled on Windows 10 21H2+/11; the installer downloads the bootstrapper otherwise (`bundle.windows.webviewInstallMode`) |
| Node.js | 22.x | |
| pnpm | 10.x (`corepack enable`) | `packageManager` in the root `package.json` |
| NSIS / WiX | fetched by the Tauri CLI on first `tauri build` | needed only for installers |

## Commands

```powershell
pnpm install                 # workspace deps (Tauri CLI, plugins, React)
pnpm dev:desktop             # = pnpm --filter @vixera/desktop tauri dev  (Vite on :1420 + Rust debug build)
pnpm tauri build             # release build + installers
```

`pnpm tauri build` writes to `target/release/bundle/`:

* `nsis/Vixera One_0.1.0_x64-setup.exe` — per-user NSIS installer (`installMode: currentUser`, no admin prompt)
* `msi/Vixera One_0.1.0_x64_en-US.msi` — WiX MSI

Both install the same binary; use NSIS for day-to-day, MSI for managed installs.
`pnpm tauri build --debug` keeps devtools and symbols.

Useful checks that do not need Windows:

```bash
cargo check --workspace          # Rust shell + platform crate + share plugin (desktop code paths)
cargo test -p vixera-platform    # credentials, device identity, hashing, loopback probe
pnpm --filter @vixera/desktop typecheck
```

## Runtime layout on Windows

| What | Where |
| --- | --- |
| Device identity (`device.json`, random UUID v4, see `crates/vixera-platform/src/device.rs`) | `%APPDATA%\ai.vixera.one\device.json` (Tauri `app_data_dir`) |
| Supabase session + device key | **Windows Credential Manager**, generic credentials, service `ai.vixera.one` (dev builds: `ai.vixera.one.dev`), account = key (`supabase.session`, `device.key`) |
| Provider tokens (Google, Microsoft, Plaid) | never on the device — Supabase Vault (`docs/credentials.md`) |
| Vite dev server | `http://localhost:1420` (`tauri.conf.json` → `build.devUrl`) |

Inspect credentials with *Control Panel → Credential Manager → Windows
Credentials → Generic Credentials* (entries named `ai.vixera.one/<key>`), or
`cmdkey /list`. Deleting an entry simply signs the app out.

## Praxion (optional, loopback)

Praxion is a separate product. Vixera looks for it on
`http://127.0.0.1:47815` (`PRAXION_DEFAULT_PORT`): the Rust command
`probe_praxion` does a 150 ms TCP probe as a hint, and `@vixera/praxion`
negotiates the versioned contract over HTTP (`GET /v1/health`,
`X-Praxion-Contract`). The Field uses `TauriPraxionTransport`
(`apps/desktop/src/platform/praxion-transport.ts`, Tauri HTTP plugin) so
loopback calls bypass WebView CORS; `capabilities/default.json` allows
`http://127.0.0.1:*`. Praxion absent → documents open with the OS viewer
(`openWithSystem`, opener plugin). Run `pnpm praxion:mock` for a fake Praxion.

## Field capabilities exposed by Rust

Commands (`apps/desktop/src-tauri/src/commands.rs`, bindings in
`apps/desktop/src/platform/`): `credential_get/set/delete`, `device_identity`,
`hash_file` (streaming SHA-256), `platform_info`, `probe_praxion`. Plugins:
`http`, `opener`, `dialog`, `fs`, `notification`, `os`. File drop uses Tauri's
built-in `tauri://drag-drop` window event (`dragDropEnabled: true`); the Field
listens to it directly.

## Troubleshooting

* **`error: linker link.exe not found`** — install the C++ build tools and open a
  "Developer PowerShell for VS 2022", or run `rustup default stable-msvc`.
* **Blank window / `WebView2` missing** — install the Evergreen runtime from
  Microsoft; the NSIS installer does this automatically for end users.
* **Port 1420 in use** — `strictPort` is on; stop the other Vite instance.
* **"credential store failure"** in the Field — Credential Manager is locked
  down by policy; the app cannot persist a session and shows the sign-in state.
