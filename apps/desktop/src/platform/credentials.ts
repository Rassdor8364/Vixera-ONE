/**
 * Device credential storage for the Field.
 *
 * `TauriCredentialStore` has the storage-adapter shape supabase-js accepts
 * (`getItem` / `setItem` / `removeItem`, async allowed) and is backed by the
 * Rust `credential_*` commands: Windows Credential Manager on desktop, Android
 * Keystore-backed EncryptedSharedPreferences on Android (see docs/credentials.md).
 * In a plain browser it degrades to a process-local memory store so development
 * and tests never write secrets to localStorage.
 *
 * Wire it as:
 *   createClient(url, anonKey, { auth: { storage: createCredentialStore(), storageKey: CREDENTIAL_KEYS.supabaseSession, persistSession: true } })
 *
 * Keys are namespaced (`supabase.session`, `device.key`); values are opaque.
 * Only the keys listed in `CREDENTIAL_KEYS` (or a `connector.<accountId>` key)
 * are accepted, so a stray library cannot use the keychain as a general cache.
 */
import { invoke, isTauri } from "./tauri.ts";

export const CREDENTIAL_KEYS = {
  supabaseSession: "supabase.session",
  deviceKey: "device.key",
} as const;

export const CONNECTOR_CREDENTIAL_PREFIX = "connector.";

/** The subset of `SupportedStorage` supabase-js needs; also usable on its own. */
export interface CredentialStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * supabase-js derives sibling keys from `storageKey` (`<storageKey>-user` on
 * sign-out, `<storageKey>-code-verifier` / `<storageKey>-flow-<id>-code-verifier`
 * / `<storageKey>-flows-code-verifier` for PKCE), so `supabase.session-*` is
 * part of the session namespace and must be accepted too.
 */
export function isAllowedCredentialKey(key: string): boolean {
  if (key === CREDENTIAL_KEYS.supabaseSession || key === CREDENTIAL_KEYS.deviceKey) return true;
  if (key.startsWith(`${CREDENTIAL_KEYS.supabaseSession}-`) && key.length > CREDENTIAL_KEYS.supabaseSession.length + 1) return true;
  return key.startsWith(CONNECTOR_CREDENTIAL_PREFIX) && key.length > CONNECTOR_CREDENTIAL_PREFIX.length;
}

function assertAllowed(key: string): void {
  if (!isAllowedCredentialKey(key)) {
    throw new Error(`credential key "${key}" is not a Vixera credential key`);
  }
}

/** Backed by the Rust commands; throws outside Tauri. */
export class TauriCredentialStore implements CredentialStorage {
  async getItem(key: string): Promise<string | null> {
    assertAllowed(key);
    const value = await invoke<string | null>("credential_get", { key });
    return value ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    assertAllowed(key);
    await invoke<void>("credential_set", { key, value });
  }

  async removeItem(key: string): Promise<void> {
    assertAllowed(key);
    await invoke<void>("credential_delete", { key });
  }
}

/** Process-local store for the browser, development and tests. Nothing persists. */
export class MemoryCredentialStore implements CredentialStorage {
  private readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    assertAllowed(key);
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    assertAllowed(key);
    this.values.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    assertAllowed(key);
    this.values.delete(key);
  }

  get size(): number {
    return this.values.size;
  }
}

/** The store for this runtime: keychain-backed inside Tauri, memory in the browser. */
export function createCredentialStore(): CredentialStorage {
  return isTauri() ? new TauriCredentialStore() : new MemoryCredentialStore();
}
