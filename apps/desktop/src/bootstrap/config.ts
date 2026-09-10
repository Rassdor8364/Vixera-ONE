/**
 * Public client configuration, read once from Vite's `import.meta.env`.
 * Nothing here is secret (see docs/credentials.md): the Supabase anon key is
 * public by design, the dev identity is a fixed UUID, the Praxion base URL is
 * loopback. Provider secrets never reach the Field.
 */
import { DEV_USER_ID, type UserId } from "@vixera/domain";
import { PRAXION_DEFAULT_BASE_URL } from "@vixera/praxion";

export type AppMode = "supabase" | "dev-fixtures";

export interface AppConfig {
  readonly mode: AppMode;
  readonly supabaseUrl: string;
  readonly supabaseAnonKey: string;
  /** Only meaningful in dev-fixture mode. */
  readonly devUserId: UserId;
  /** Informational only (sign-in form prefill in local development). Never a key. */
  readonly devUserEmail: string | null;
  readonly praxionBaseUrl: string;
}

export interface RawEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_DEV_USER_ID?: string;
  readonly VITE_DEV_USER_EMAIL?: string;
  readonly VITE_PRAXION_BASE_URL?: string;
  readonly VITE_VIXERA_DEV_FIXTURES?: string;
}

export function parseConfig(env: RawEnv): AppConfig {
  const devFixtures = (env.VITE_VIXERA_DEV_FIXTURES ?? "").trim().toLowerCase() === "true";
  const supabaseUrl = (env.VITE_SUPABASE_URL ?? "").trim();
  const supabaseAnonKey = (env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  const mode: AppMode = devFixtures ? "dev-fixtures" : "supabase";
  if (mode === "supabase" && (!supabaseUrl || !supabaseAnonKey)) {
    throw new ConfigError("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are required (or set VITE_VIXERA_DEV_FIXTURES=true)");
  }
  return {
    mode,
    supabaseUrl,
    supabaseAnonKey,
    devUserId: ((env.VITE_DEV_USER_ID ?? "").trim() || DEV_USER_ID) as UserId,
    devUserEmail: (env.VITE_DEV_USER_EMAIL ?? "").trim() || null,
    praxionBaseUrl: (env.VITE_PRAXION_BASE_URL ?? "").trim() || PRAXION_DEFAULT_BASE_URL,
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The configuration of this build. */
export function loadConfig(): AppConfig {
  return parseConfig(import.meta.env as unknown as RawEnv);
}

/** Edge Function base: `<supabaseUrl>/functions/v1`. */
export function functionsBaseUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`;
}
