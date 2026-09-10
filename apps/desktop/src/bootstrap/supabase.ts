/**
 * The one Supabase client of the Field. The session is persisted through the
 * platform credential store (Windows Credential Manager / Android Keystore;
 * process memory in a browser) under `CREDENTIAL_KEYS.supabaseSession`.
 *
 * NOTE for the integrator: `createSpineClient` (@vixera/sync) has no
 * `storageKey` option, but `TauriCredentialStore` only accepts keys in the
 * Vixera namespace, so the supabase-js default (`sb-<ref>-auth-token`) would
 * be refused by the keychain adapter. Until `SpineClientOptions.storageKey`
 * exists, the client is built here with the same defaults `createSpineClient`
 * applies (no URL detection, persisted + auto-refreshed session).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CREDENTIAL_KEYS, createCredentialStore } from "../platform/credentials.ts";

export function createFieldSupabaseClient(url: string, anonKey: string): SupabaseClient {
  if (!url) throw new Error("createFieldSupabaseClient: url is required");
  if (!anonKey) throw new Error("createFieldSupabaseClient: anon key is required");
  return createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: createCredentialStore(),
      storageKey: CREDENTIAL_KEYS.supabaseSession,
    },
    global: { headers: { "x-vixera-client": "field" } },
  });
}
