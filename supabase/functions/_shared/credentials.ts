/**
 * `CredentialStore` over Supabase Vault through the three security-definer
 * RPCs of migration 3 (`vx_credential_put/get/delete`, service role only).
 * Secrets are never logged; errors name the reference or the account id,
 * never the value.
 *
 * Scoped to one user: `put(ref, …)` only resolves connector accounts of that
 * user, so a ref belonging to someone else cannot be overwritten from a
 * request authenticated as this user.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { CredentialNotFoundError, type ConnectorCredential, type CredentialRef, type CredentialStore, type UserId } from "@vixera/domain";

/** The slice of supabase-js this store uses (so tests can pass a fake). */
export interface VaultClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        eq(column: string, value: string): { maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }> };
      };
    };
  };
}

export class VaultCredentialStore implements CredentialStore {
  private readonly client: VaultClient;

  constructor(
    client: SupabaseClient | VaultClient,
    private readonly userId: UserId,
  ) {
    this.client = client as unknown as VaultClient;
  }

  async get(ref: CredentialRef): Promise<ConnectorCredential | null> {
    const { data, error } = await this.client.rpc("vx_credential_get", { p_ref: ref });
    if (error) throw new Error(`vx_credential_get(${ref}) failed: ${error.message}`);
    if (data === null || data === undefined) return null;
    const parsed = typeof data === "string" ? safeParse(data) : data;
    return isCredential(parsed) ? parsed : null;
  }

  /** Replace the credential behind an existing ref (the engine's refresh path). */
  async put(ref: CredentialRef | null, credential: ConnectorCredential): Promise<CredentialRef> {
    if (!ref) throw new Error("VaultCredentialStore.put requires an existing ref; use putForAccount() for a first link");
    const accountId = await this.accountIdForRef(ref);
    if (!accountId) throw new CredentialNotFoundError(ref);
    return this.putForAccount(accountId, credential, ref);
  }

  /** First link: create (or replace) the Vault secret of a connector account; the RPC also updates the account row. */
  async putForAccount(accountId: string, credential: ConnectorCredential, ref: CredentialRef | null = null): Promise<CredentialRef> {
    const { data, error } = await this.client.rpc("vx_credential_put", { p_account_id: accountId, p_secret: credential, p_ref: ref });
    if (error) throw new Error(`vx_credential_put(account ${accountId}) failed: ${error.message}`);
    if (typeof data !== "string" || !data) throw new Error(`vx_credential_put(account ${accountId}) returned no reference`);
    return data;
  }

  async delete(ref: CredentialRef): Promise<void> {
    const { error } = await this.client.rpc("vx_credential_delete", { p_ref: ref });
    if (error) throw new Error(`vx_credential_delete(${ref}) failed: ${error.message}`);
  }

  private async accountIdForRef(ref: CredentialRef): Promise<string | null> {
    const { data, error } = await this.client.from("connector_accounts").select("id").eq("user_id", this.userId).eq("credential_ref", ref).maybeSingle();
    if (error) throw new Error(`connector_accounts lookup for credential ${ref} failed: ${error.message}`);
    const id = (data as { id?: unknown } | null)?.id;
    return typeof id === "string" ? id : null;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isCredential(value: unknown): value is ConnectorCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "oauth2":
      return typeof v.accessToken === "string" && (v.refreshToken === null || typeof v.refreshToken === "string") && (v.expiresAt === null || typeof v.expiresAt === "string") && Array.isArray(v.scopes);
    case "access_token":
      return typeof v.accessToken === "string";
    case "api_key":
      return typeof v.apiKey === "string";
    default:
      return false;
  }
}
