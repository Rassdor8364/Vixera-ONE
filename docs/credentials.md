# Credential storage

Brief rule: tokens are never in source, in a committed `.env`, in plain JSON or
in unencrypted rows. Every secret sits behind an abstraction with one owner.
This page is the end-to-end map.

## What is stored where

| Secret | Where | Owner | Reference |
| --- | --- | --- | --- |
| Provider tokens (Google, Microsoft, Plaid access/refresh tokens, Plaid item ids) | **Supabase Vault** (encrypted at rest, server-only) | Edge Functions (`connector-link`, `connector-sync`) | `connector_accounts.credential_ref` = Vault secret uuid; `credential_location = 'server_vault'` |
| Provider client ids/secrets, `VIXERA_SYNC_SECRET` | `supabase secrets set` (Edge Function environment) | ops | not referenced from the DB |
| Cron secrets (`vixera_functions_url`, `vixera_sync_secret`) | Vault, created by hand once (`20260910000500_scheduled_sync.sql`) | ops | by name |
| Supabase session (JWT + refresh token) | **device keychain** | the app on that device | key `supabase.session` |
| Device key (per-device secret for device-scoped operations) | **device keychain** | the app on that device | key `device.key` |
| Public config (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_PRAXION_BASE_URL`) | `.env` (git-ignored, from `.env.example`) | developer | not secret |

Provider tokens never reach a device: connector sync runs server-side (ADR-003),
so the Windows Field and the Android companion only ever hold their own session.

## Server: Supabase Vault

`supabase/migrations/20260910000300_credentials_vault.sql` defines three
`security definer` functions callable **only by the service role** (`revoke ...
from public, anon, authenticated`):

| Function | Purpose |
| --- | --- |
| `vx_credential_put(p_account_id uuid, p_secret jsonb, p_ref uuid default null) → uuid` | create or replace the secret for a connector account; stores the returned uuid in `connector_accounts.credential_ref` and sets `credential_location = 'server_vault'` |
| `vx_credential_get(p_ref uuid) → jsonb` | decrypt for use inside an Edge Function |
| `vx_credential_delete(p_ref uuid)` | remove the secret and clear the account's reference (`credential_location = 'none'`) |
| `vx_connector_account_disconnect(p_account_id uuid)` | maintenance helper: delete the credential, mark the account disconnected, disable its sync states |

`credential_ref` is opaque (`text`, <= 256 chars, never a secret; the check
constraint and column comment say so) and `authenticated` cannot update it or
`credential_location` (`20260910000200_security.sql`). The TypeScript side sees
the Vault through the `CredentialStore` interface in `@vixera/sync`; connectors
receive decrypted tokens only inside a server request and never persist them.

## Devices: `vixera-platform` `CredentialStore`

`crates/vixera-platform/src/credentials.rs`:

```rust
pub trait CredentialStore {
    fn get(&self, key: &str) -> Result<Option<String>, CredentialError>;
    fn set(&self, key: &str, value: &str) -> Result<(), CredentialError>;
    fn delete(&self, key: &str) -> Result<(), CredentialError>;
}
pub const CREDENTIAL_SERVICE: &str = "ai.vixera.one";
```

Keys are namespaced ASCII (`supabase.session`, `device.key`,
`connector.<accountId>` reserved for a future device-hosted sync); values are
opaque strings. Errors may name the key, never the value; nothing is logged.
`is_vixera_credential_key` names the namespace the webview may touch:
`supabase.session` and its `supabase.session-*` siblings, `device.key`,
`connector.<id>`. The Tauri commands (`commands.rs`) and the Kotlin `secure_*`
plugin commands both refuse anything else, so the TypeScript adapter's check is
not the only one and a script running in the webview cannot read arbitrary
entries of the keychain, nor the `:c<n>` chunk entries (a colon is never part
of a caller-visible key).

| Platform | Implementation | Backend |
| --- | --- | --- |
| Windows | `KeyringCredentialStore` (`keyring` crate, `windows-native`) | Windows Credential Manager, generic credential `ai.vixera.one/<key>` |
| macOS (not a Phase 1 client) | `KeyringCredentialStore` (`apple-native`) | login Keychain, service `ai.vixera.one` |
| Linux (dev only) | `KeyringCredentialStore` (`linux-native`) | kernel keyutils — per login session, not persisted across reboot |
| Android | `android::PluginCredentialStore` in the app shell → `tauri-plugin-vixera-share` `secure_*` | `EncryptedSharedPreferences("ai.vixera.one.secure")`, Keystore master key AES256-GCM |
| iOS (not a client) | `UnavailableCredentialStore` | none — every call fails with `CredentialError::Unavailable`, so the app launches to the sign-in screen and explains itself instead of panicking |
| tests / browser | `InMemoryCredentialStore` (Rust), `MemoryCredentialStore` (TS) | process memory |

Dev desktop builds (`debug_assertions`) use the service name `ai.vixera.one.dev`
so `pnpm dev:desktop` never touches the installed app's session.

The Field reaches the store through the Rust commands `credential_get`,
`credential_set`, `credential_delete` and the TypeScript adapter
`TauriCredentialStore` (`apps/desktop/src/platform/credentials.ts`), which has
the `getItem/setItem/removeItem` shape supabase-js accepts:

```ts
createClient(url, anonKey, {
  auth: { storage: createCredentialStore(), storageKey: CREDENTIAL_KEYS.supabaseSession, persistSession: true, autoRefreshToken: true },
});
```

The adapter refuses any key outside the Vixera namespace (`supabase.session`
and the `supabase.session-*` siblings supabase-js derives from `storageKey`,
`device.key`, `connector.<accountId>`), so no library can turn the keychain
into a general cache. In a browser it falls back to memory —
never `localStorage`. The Field builds this client in
`apps/desktop/src/bootstrap/supabase.ts` with `createClient` directly, because
`createSpineClient` (`@vixera/sync`) has no `storageKey` option and the
supabase-js default key would be refused by the adapter.

## Forbidden

* Secrets in source or in any committed file; `.env` and `.env.*` are
  git-ignored, only `.env.example` (public values) is tracked.
* Plain JSON / SQLite / preferences files holding tokens on a device.
* Token columns on `connector_accounts` or any other table; only `credential_ref`.
* Logging a credential value, echoing it in an error, or sending it to a client.
* Reading a user id from provider data; the store is bound to `currentUser()`.
* Device-resident provider tokens (would require a device-hosted sync — not Phase 1).

## Rotation and revocation

| Situation | Action |
| --- | --- |
| Provider refresh (normal operation) | `connector-sync` refreshes tokens and calls `vx_credential_put(account, new_secret, existing_ref)`; the ref is unchanged |
| User disconnects an account | `vx_connector_account_disconnect(account_id)` (service role, via `connector-link` step `disconnect`) — Vault row deleted, account `disconnected`, sync states disabled. Revocation at the provider (Google/Microsoft token revocation endpoint, Plaid `/item/remove`) is **not** performed in Phase 1; revoke manually in the provider's account settings if needed |
| Provider revokes / token invalid | the engine sets the account `needs_reauth` with `last_error` and skips it; the user connects the same provider again from the Field (Quiet → Sources), which re-links the existing account row: `vx_credential_put` replaces the secret, the account becomes `active`, checkpoints are kept |
| Rotate `VIXERA_SYNC_SECRET` | `supabase secrets set VIXERA_SYNC_SECRET=...` then update the Vault secret `vixera_sync_secret` used by `pg_cron` |
| Rotate provider client secret | `supabase secrets set ...`; existing refresh tokens keep working for Google/Microsoft; Plaid needs no re-link |
| Sign out a device | Field "sign out" calls `supabase.auth.signOut({ scope: "local" })`: supabase-js removes `supabase.session` from the store and the server revokes *this device's* refresh token only — other devices stay signed in. If the server call fails the local session is dropped anyway |
| Lost / wiped device | revoke its sessions from the Supabase dashboard (Auth → user → sessions) and mark its `devices` row inactive; the device key becomes useless because nothing device-side can mint a session |
| Rotate the Android master key | uninstall/reinstall (Keystore key and preferences are per install); the user signs in again |
| Suspected Vault key compromise | Supabase project-level: rotate the Vault key via support, then re-link every connector account (each `vx_credential_put` re-encrypts) |

Audit trail: `action_requests` records server actions; `connector_sync_states`
records per-capability errors; Vault access is only possible from Edge
Functions with the service role, whose invocations are in the Supabase function
logs.

## The Windows 2560-byte credential cap

Windows Credential Manager limits `CredentialBlob` to 2560 bytes, and the blob is
the value encoded as **UTF-16**, so an entry holds at most 1280 code units —
roughly 1280 ASCII characters. A Supabase session is well past that: an access
JWT, a refresh token, and the serialized user object including `user_metadata`.
Storing it unsplit fails, and `keyring` surfaces it as:

```
credential value rejected for key supabase.session: password encoded as UTF-16 exceeds 2560
```

`ChunkedCredentialStore` wraps the keychain store and splits oversized values
across chunk entries, with the primary entry holding a manifest
(`U+0001 vx-chunked:<count>:<generation>`). Chunks are generation-tagged:
`supabase.session:a:c0 … :a:cN-1` or `…:b:c0 …`, and every rewrite goes into the
generation the live manifest does *not* point at, so the chunks a live manifest
names are never overwritten in place. Entries written by an older build
(`supabase.session:c0 …`, manifest without a generation) still read and are
migrated by the next write. It is transparent in both directions:

- a value that fits is written whole, so entries written before this existed —
  and entries on platforms with roomier stores — read back unchanged;
- the manifest is prefixed with U+0001, which cannot begin any value Vixera
  stores (they are JSON or base64), so a plain value is never mistaken for one.

Chunks are written **before** the manifest and into the other generation, so an
interrupted write leaves the previous value readable rather than publishing a
half-written session — including when the new value is shorter than the old,
which an in-place layout would tear. The previous generation and any legacy
chunks are deleted only after the manifest has flipped; a cleanup interrupted
midway is finished by the next write, which scans a little past a hole
(`GAP_TOLERANCE`) so a torn cleanup cannot strand chunks forever. A torn
value — manifest present, a chunk missing — reads as absent rather than as an
error, because for every caller it means what a missing credential means: sign in
again. A manifest claiming zero chunks (which `set` never writes) is treated the
same way; a manifest whose count is not a number is a `Backend` error, since it
is corruption rather than a torn write, as is a manifest naming a generation
that does not exist. A count larger than reality stops at the first missing
chunk, so a bogus "four billion" never means four billion lookups.

Keys too long to take a `:cN` suffix (over 125 bytes) still store values that
fit; only a value that would need chunks under such a key is refused, and it is
refused before anything is written, never torn.

Tested (`cargo test -p vixera-platform`, 36 tests): round-trips at, over and
far over the cap; the cap counted in UTF-16 units, not bytes or chars; splits
landing inside a surrogate pair and between a base letter and a combining mark;
a crash before the manifest; a rewrite never touching the live chunks; a torn
cleanup finished across a hole; the legacy layout read and migrated; stale
chunks after shrinking; deletion; corrupt, zero, huge and unknown-generation
manifests; an entry written before chunking existed; chunk keys unreachable
from any caller; the unavailable store failing without panicking; and that an
error never carries a value.

It wraps all three desktop targets rather than sitting behind a Windows `cfg`, so
macOS and Linux exercise the same code path the tests cover. Android is not
wrapped: `EncryptedSharedPreferences` has no comparable limit.

The cap is per entry, not per service, so the sibling keys supabase-js derives
(`supabase.session-code-verifier` and friends) are unaffected — they are small.
