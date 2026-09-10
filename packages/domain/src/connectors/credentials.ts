import type { IsoDateTime } from "../entities/common.ts";

/**
 * Credentials are never in source, .env, plain JSON or unencrypted rows.
 * A connector account references a credential by an opaque `CredentialRef`.
 * Implementations: Supabase Vault (server), platform keychain (device),
 * in-memory (tests).
 */
export type CredentialRef = string;

export type ConnectorCredential =
  | {
      readonly kind: "oauth2";
      readonly accessToken: string;
      readonly refreshToken: string | null;
      readonly expiresAt: IsoDateTime | null;
      readonly scopes: readonly string[];
      readonly tokenType?: string;
    }
  | {
      readonly kind: "access_token";
      readonly accessToken: string;
      readonly expiresAt?: IsoDateTime | null;
    }
  | {
      readonly kind: "api_key";
      readonly apiKey: string;
    };

export interface CredentialStore {
  /** Stores a credential and returns the reference to persist on the account. */
  put(ref: CredentialRef | null, credential: ConnectorCredential): Promise<CredentialRef>;
  get(ref: CredentialRef): Promise<ConnectorCredential | null>;
  delete(ref: CredentialRef): Promise<void>;
}

export class CredentialNotFoundError extends Error {
  constructor(ref: CredentialRef) {
    super(`Credential not found: ${ref}`);
    this.name = "CredentialNotFoundError";
  }
}

/** Test/dev implementation. Nothing leaves process memory. */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<CredentialRef, ConnectorCredential>();
  private counter = 0;

  async put(ref: CredentialRef | null, credential: ConnectorCredential): Promise<CredentialRef> {
    const key = ref ?? `mem:${++this.counter}`;
    this.map.set(key, credential);
    return key;
  }
  async get(ref: CredentialRef): Promise<ConnectorCredential | null> {
    return this.map.get(ref) ?? null;
  }
  async delete(ref: CredentialRef): Promise<void> {
    this.map.delete(ref);
  }
  get size(): number {
    return this.map.size;
  }
}

/** True when an OAuth credential is expired or expires within `skewSeconds`. */
export function isExpired(credential: ConnectorCredential, now: Date, skewSeconds = 60): boolean {
  if (credential.kind === "api_key") return false;
  const exp = credential.expiresAt;
  if (!exp) return false;
  return new Date(exp).getTime() - skewSeconds * 1000 <= now.getTime();
}

/** Redacts a credential for logs and error messages. */
export function redact(credential: ConnectorCredential): string {
  switch (credential.kind) {
    case "oauth2":
      return `oauth2(scopes=${credential.scopes.join(" ")}, expiresAt=${credential.expiresAt ?? "-"})`;
    case "access_token":
      return "access_token(***)";
    case "api_key":
      return "api_key(***)";
  }
}
