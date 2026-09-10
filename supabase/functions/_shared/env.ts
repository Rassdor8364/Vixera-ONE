/**
 * Typed access to the Edge Function environment.
 *
 * Nothing here throws at import time: a missing provider secret simply leaves
 * that provider unconfigured (`google: null`), and the platform values are
 * checked lazily by `requireSupabase()` inside a request. Secrets are read,
 * never logged and never echoed into responses.
 *
 *   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY   platform-provided
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET                        Google OAuth app
 *   MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_TENANT (default "common")
 *   PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV ("sandbox" | "production", default sandbox)
 *   VIXERA_SYNC_SECRET              shared secret pg_cron sends in X-Vixera-Sync-Secret
 *   VIXERA_LINK_STATE_SECRET        HMAC key for OAuth state tokens (fallback: derived
 *                                   from SUPABASE_SERVICE_ROLE_KEY, see state.ts)
 *   VIXERA_FUNCTIONS_URL            public base URL of the functions (OAuth redirect);
 *                                   fallback SUPABASE_URL + "/functions/v1"
 *   VIXERA_ENABLE_MOCK_CONNECTOR    "true" registers the MockConnector (local dev only)
 */
import type { PlaidEnvironment } from "@vixera/connector-bank";

export type EnvReader = (name: string) => string | undefined;

export interface GoogleEnv {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface MicrosoftEnv {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly tenant: string | null;
}

export interface PlaidEnv {
  readonly clientId: string;
  readonly secret: string;
  readonly environment: PlaidEnvironment;
}

export interface FunctionEnv {
  readonly supabaseUrl: string | null;
  readonly supabaseAnonKey: string | null;
  readonly supabaseServiceRoleKey: string | null;
  readonly google: GoogleEnv | null;
  readonly microsoft: MicrosoftEnv | null;
  readonly plaid: PlaidEnv | null;
  readonly syncSecret: string | null;
  /** Explicit HMAC key; null means "derive from the service role key". */
  readonly linkStateSecret: string | null;
  /** Public base URL of the Edge Functions, without a trailing slash. */
  readonly functionsUrl: string | null;
  readonly enableMockConnector: boolean;
}

export const OAUTH_CALLBACK_PATH = "/connector-link/callback";

function denoEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    // No --allow-env for this variable: behave as unset.
    return undefined;
  }
}

function nonEmpty(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function readEnv(get: EnvReader = denoEnv): FunctionEnv {
  const supabaseUrl = nonEmpty(get("SUPABASE_URL"))?.replace(/\/+$/, "") ?? null;
  const googleId = nonEmpty(get("GOOGLE_CLIENT_ID"));
  const googleSecret = nonEmpty(get("GOOGLE_CLIENT_SECRET"));
  const msId = nonEmpty(get("MICROSOFT_CLIENT_ID"));
  const msSecret = nonEmpty(get("MICROSOFT_CLIENT_SECRET"));
  const plaidId = nonEmpty(get("PLAID_CLIENT_ID"));
  const plaidSecret = nonEmpty(get("PLAID_SECRET"));
  const plaidEnvRaw = nonEmpty(get("PLAID_ENV"))?.toLowerCase() ?? "sandbox";
  const functionsUrl = nonEmpty(get("VIXERA_FUNCTIONS_URL"))?.replace(/\/+$/, "") ?? (supabaseUrl ? `${supabaseUrl}/functions/v1` : null);
  return {
    supabaseUrl,
    supabaseAnonKey: nonEmpty(get("SUPABASE_ANON_KEY")),
    supabaseServiceRoleKey: nonEmpty(get("SUPABASE_SERVICE_ROLE_KEY")),
    google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : null,
    microsoft: msId && msSecret ? { clientId: msId, clientSecret: msSecret, tenant: nonEmpty(get("MICROSOFT_TENANT")) } : null,
    plaid: plaidId && plaidSecret ? { clientId: plaidId, secret: plaidSecret, environment: plaidEnvRaw === "production" ? "production" : "sandbox" } : null,
    syncSecret: nonEmpty(get("VIXERA_SYNC_SECRET")),
    linkStateSecret: nonEmpty(get("VIXERA_LINK_STATE_SECRET")),
    functionsUrl,
    enableMockConnector: (nonEmpty(get("VIXERA_ENABLE_MOCK_CONNECTOR")) ?? "").toLowerCase() === "true",
  };
}

export interface SupabaseEnv {
  readonly url: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
}

export class EnvError extends Error {
  constructor(readonly variable: string) {
    super(`Missing server configuration: ${variable}`);
    this.name = "EnvError";
  }
}

/** The platform values every function needs. Throws `EnvError` (mapped to a 500) when absent. */
export function requireSupabase(env: FunctionEnv): SupabaseEnv {
  if (!env.supabaseUrl) throw new EnvError("SUPABASE_URL");
  if (!env.supabaseAnonKey) throw new EnvError("SUPABASE_ANON_KEY");
  if (!env.supabaseServiceRoleKey) throw new EnvError("SUPABASE_SERVICE_ROLE_KEY");
  return { url: env.supabaseUrl, anonKey: env.supabaseAnonKey, serviceRoleKey: env.supabaseServiceRoleKey };
}

/** Redirect URI registered with Google / Microsoft: `<functions url>/connector-link/callback`. */
export function oauthRedirectUri(env: FunctionEnv): string {
  if (!env.functionsUrl) throw new EnvError("VIXERA_FUNCTIONS_URL");
  return `${env.functionsUrl}${OAUTH_CALLBACK_PATH}`;
}
