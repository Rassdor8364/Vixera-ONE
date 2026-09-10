import { createClient, type SupabaseClient, type SupabaseClientOptions } from "@supabase/supabase-js";

/**
 * The one place that wraps `createClient`. Everything else accepts a
 * `SupabaseClient` (see `SupabaseSpineStore`), so tests can pass a fake and
 * the Tauri app / Edge Functions can construct the client with their own
 * auth storage and fetch.
 *
 * Defaults: no session persistence, no auto refresh, no URL detection —
 * the safe defaults for a server (Edge Function with the service role) or a
 * one-shot script. Installed apps opt in with `persistSession: true` and a
 * `storage` adapter backed by the platform keychain.
 */
export interface SpineClientOptions {
  /** Keep the auth session across restarts. Default false. */
  readonly persistSession?: boolean;
  /** Refresh the access token in the background. Default = persistSession. */
  readonly autoRefreshToken?: boolean;
  /** Custom session storage (platform keychain adapter). Only used when persisting. */
  readonly storage?: SessionStorageAdapter;
  /** Key the session is stored under. Needed when the adapter only accepts namespaced keys. */
  readonly storageKey?: string;
  /** Custom fetch (Tauri HTTP plugin, test stub). */
  readonly fetch?: typeof fetch;
  /** Extra headers on every request (e.g. an app identifier). */
  readonly headers?: Readonly<Record<string, string>>;
  /** Postgres schema. Default "public". */
  readonly schema?: string;
}

/** Minimal storage contract supabase-js needs; sync or async implementations both work. */
export interface SessionStorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export function createSpineClient(url: string, anonKey: string, options: SpineClientOptions = {}): SupabaseClient {
  if (!url) throw new Error("createSpineClient: url is required");
  if (!anonKey) throw new Error("createSpineClient: key is required");
  const persistSession = options.persistSession ?? false;
  const auth: NonNullable<SupabaseClientOptions<"public">["auth"]> = {
    persistSession,
    autoRefreshToken: options.autoRefreshToken ?? persistSession,
    detectSessionInUrl: false,
  };
  if (options.storage) auth.storage = options.storage;
  if (options.storageKey) auth.storageKey = options.storageKey;
  const clientOptions: SupabaseClientOptions<"public"> = { auth };
  if (options.fetch) clientOptions.global = { fetch: options.fetch, ...(options.headers ? { headers: { ...options.headers } } : {}) };
  else if (options.headers) clientOptions.global = { headers: { ...options.headers } };
  if (options.schema) clientOptions.db = { schema: options.schema as "public" };
  return createClient(url, anonKey, clientOptions);
}
