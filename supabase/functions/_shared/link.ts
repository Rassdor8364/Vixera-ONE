/**
 * Connector link flows for `connector-link`, as plain functions over
 * injectable dependencies (tests use InMemorySpineStore + fake exchanges).
 *
 *   google / microsoft   start   → signed state + provider consent URL
 *                        callback→ exchange code (server-held client secret),
 *                                  discover the account, persist (below)
 *   plaid                start   → Link token (+ Hosted Link URL when Plaid
 *                                  grants it); complete → exchange the public
 *                                  token (from Plaid Link) or fetch it from a
 *                                  finished hosted session (/link/token/get)
 *   any                  disconnect → vx_connector_account_disconnect
 *
 * Persisting a linked account: find-or-create `connector_accounts` by
 * (provider, externalAccountId), put the credential in Vault
 * (`credential_ref` on the row, never the token), and make sure every
 * capability has a `connector_sync_states` row. Re-linking an existing account
 * refreshes its credential and reactivates it; checkpoints are kept.
 */
import {
  type Connector,
  type ConnectorAccount,
  type ConnectorCredential,
  type ConnectorRegistry,
  type DiscoveredAccount,
  type JsonObject,
  type ProviderId,
  type UserId,
} from "@vixera/domain";
import type { SpineStore } from "@vixera/sync";
import { GOOGLE_SCOPES, buildAuthorizationUrl as googleAuthUrl, exchangeAuthorizationCode as googleExchange } from "@vixera/connector-google";
import { buildAuthorizationUrl as microsoftAuthUrl, exchangeAuthorizationCode as microsoftExchange } from "@vixera/connector-microsoft";
import { BankConnector, PlaidClient, completeBankLink } from "@vixera/connector-bank";
import { oauthRedirectUri, type FunctionEnv, type PlaidEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import { LinkStateError, signLinkState, verifyLinkState, type LinkProvider } from "./state.ts";

export interface LinkCredentialStore {
  putForAccount(accountId: string, credential: ConnectorCredential): Promise<string>;
}

export interface LinkDeps {
  readonly env: FunctionEnv;
  readonly registry: ConnectorRegistry;
  readonly stateSecret: string;
  readonly storeFor: (userId: UserId) => SpineStore;
  readonly credentialsFor: (userId: UserId) => LinkCredentialStore;
  /** Server-side disconnect (Vault delete + account disconnected + sync states disabled). */
  readonly disconnect: (userId: UserId, accountId: string) => Promise<void>;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly log?: (message: string, data?: JsonObject) => void;
  /** Test hook; default exchanges through the provider's token endpoint. */
  readonly exchangeCode?: (provider: LinkProvider, code: string) => Promise<ConnectorCredential>;
}

export interface OAuthStart {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface PlaidStart {
  readonly linkToken: string;
  readonly hostedLinkUrl: string | null;
  readonly expiration: string;
}

// ---------------------------------------------------------------------------
// OAuth (Google, Microsoft)
// ---------------------------------------------------------------------------
export async function startOAuthLink(deps: LinkDeps, userId: UserId, provider: LinkProvider): Promise<OAuthStart> {
  requireProvider(deps, provider);
  const { token, expiresAt } = await signLinkState(deps.stateSecret, { userId, provider }, deps.now());
  const redirectUri = oauthRedirectUri(deps.env);
  let authorizationUrl: string;
  if (provider === "google") {
    const g = deps.env.google as NonNullable<FunctionEnv["google"]>;
    authorizationUrl = googleAuthUrl({ clientId: g.clientId, clientSecret: g.clientSecret, redirectUri }, { scopes: GOOGLE_SCOPES, state: token });
  } else {
    const m = deps.env.microsoft as NonNullable<FunctionEnv["microsoft"]>;
    authorizationUrl = microsoftAuthUrl({ clientId: m.clientId, clientSecret: m.clientSecret, redirectUri, ...(m.tenant ? { tenant: m.tenant } : {}) }, { state: token });
  }
  deps.log?.("link: started", { provider });
  return { authorizationUrl, expiresAt };
}

export interface OAuthCallbackInput {
  readonly code: string | null;
  readonly state: string | null;
  /** Provider-side error code (e.g. access_denied). */
  readonly error: string | null;
}

export async function completeOAuthCallback(deps: LinkDeps, input: OAuthCallbackInput): Promise<{ provider: LinkProvider; account: ConnectorAccount }> {
  if (!input.state) throw new HttpError(400, "invalid_state", "Missing state");
  let state;
  try {
    state = await verifyLinkState(deps.stateSecret, input.state, deps.now());
  } catch (err) {
    const reason = err instanceof LinkStateError ? err.reason : "malformed";
    throw new HttpError(400, "invalid_state", `The link request is ${reason === "expired" ? "expired" : "invalid"}; start again from Vixera One`);
  }
  if (input.error) throw new HttpError(400, "bad_request", `The provider refused the link (${input.error.slice(0, 80)})`);
  if (!input.code) throw new HttpError(400, "bad_request", "Missing authorization code");
  const connector = requireProvider(deps, state.provider);

  const credential = await (deps.exchangeCode ?? defaultExchange(deps))(state.provider, input.code);
  const discovered = await connector.discoverAccount({ credential, fetch: deps.fetch, now: deps.now, ...(deps.log ? { log: deps.log } : {}) });
  const account = await persistLinkedAccount(deps, state.userId, state.provider, discovered, credential);
  return { provider: state.provider, account };
}

function defaultExchange(deps: LinkDeps): (provider: LinkProvider, code: string) => Promise<ConnectorCredential> {
  return (provider, code) => {
    const redirectUri = oauthRedirectUri(deps.env);
    if (provider === "google") {
      const g = deps.env.google as NonNullable<FunctionEnv["google"]>;
      return googleExchange(deps.fetch, { clientId: g.clientId, clientSecret: g.clientSecret, redirectUri }, code, deps.now);
    }
    const m = deps.env.microsoft as NonNullable<FunctionEnv["microsoft"]>;
    return microsoftExchange(deps.fetch, { clientId: m.clientId, clientSecret: m.clientSecret, redirectUri, ...(m.tenant ? { tenant: m.tenant } : {}) }, code, deps.now);
  };
}

// ---------------------------------------------------------------------------
// Plaid
// ---------------------------------------------------------------------------
export async function startPlaidLink(deps: LinkDeps, userId: UserId): Promise<PlaidStart> {
  requireProvider(deps, "plaid");
  const cfg = deps.env.plaid as PlaidEnv;
  const base: Record<string, unknown> = {
    user: { client_user_id: userId },
    client_name: "Vixera One",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  };
  // Hosted Link lets the system browser run Plaid Link without a web app; not every
  // Plaid client has it enabled, so fall back to a plain Link token.
  let res = await plaidPost(deps.fetch, cfg, "/link/token/create", { ...base, hosted_link: {} });
  if (!res.ok) {
    deps.log?.("link: plaid hosted link unavailable, falling back", { errorCode: res.errorCode });
    res = await plaidPost(deps.fetch, cfg, "/link/token/create", base);
  }
  if (!res.ok) throw new HttpError(500, "provider_error", `Plaid could not create a link token (${res.errorCode ?? "unknown"})`);
  const body = res.body;
  const linkToken = typeof body.link_token === "string" ? body.link_token : null;
  if (!linkToken) throw new HttpError(500, "provider_error", "Plaid returned no link token");
  return {
    linkToken,
    hostedLinkUrl: typeof body.hosted_link_url === "string" ? body.hosted_link_url : null,
    expiration: typeof body.expiration === "string" ? body.expiration : new Date(deps.now().getTime() + 4 * 3600_000).toISOString(),
  };
}

export interface PlaidCompleteInput {
  readonly publicToken: string | null;
  readonly linkToken: string | null;
}

export async function completePlaidLink(deps: LinkDeps, userId: UserId, input: PlaidCompleteInput): Promise<{ account: ConnectorAccount }> {
  const connector = requireProvider(deps, "plaid");
  if (!(connector instanceof BankConnector)) throw new HttpError(500, "internal", "The plaid connector is not a BankConnector");
  const cfg = deps.env.plaid as PlaidEnv;
  let publicToken = input.publicToken;
  if (!publicToken && input.linkToken) publicToken = await hostedSessionPublicToken(deps, cfg, input.linkToken);
  if (!publicToken) throw new HttpError(400, "bad_request", "publicToken or linkToken is required");

  const client = new PlaidClient(deps.fetch, { clientId: cfg.clientId, secret: cfg.secret, environment: cfg.environment });
  const completed = await completeBankLink({ client, connector, fetch: deps.fetch, now: deps.now, ...(deps.log ? { log: deps.log } : {}) }, { publicToken });
  const account = await persistLinkedAccount(deps, userId, "plaid", completed.discovered, completed.credential);
  return { account };
}

/** Reads the public token of a completed Hosted Link session. Null-safe: not finished → 409. */
async function hostedSessionPublicToken(deps: LinkDeps, cfg: PlaidEnv, linkToken: string): Promise<string> {
  const res = await plaidPost(deps.fetch, cfg, "/link/token/get", { link_token: linkToken });
  if (!res.ok) throw new HttpError(500, "provider_error", `Plaid could not read the link session (${res.errorCode ?? "unknown"})`);
  const sessions = Array.isArray(res.body.link_sessions) ? (res.body.link_sessions as unknown[]) : [];
  for (const session of sessions) {
    if (typeof session !== "object" || session === null) continue;
    const results = (session as { results?: { item_add_results?: unknown[] } }).results;
    for (const item of results?.item_add_results ?? []) {
      const token = (item as { public_token?: unknown })?.public_token;
      if (typeof token === "string" && token) return token;
    }
  }
  throw new HttpError(409, "conflict", "The Plaid Link session has not completed yet");
}

interface PlaidResult {
  readonly ok: boolean;
  readonly body: Record<string, unknown>;
  readonly errorCode: string | null;
}

/** Link-time Plaid calls not covered by the read-only `PlaidClient` allowlist. Secrets go in the body, never in logs. */
async function plaidPost(fetchImpl: typeof fetch, cfg: PlaidEnv, endpoint: "/link/token/create" | "/link/token/get", body: Record<string, unknown>): Promise<PlaidResult> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${cfg.environment}.plaid.com${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ ...body, client_id: cfg.clientId, secret: cfg.secret }),
    });
  } catch {
    throw new HttpError(500, "provider_error", "Plaid is unreachable");
  }
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const errorCode = typeof parsed.error_code === "string" ? parsed.error_code : response.ok ? null : `HTTP ${response.status}`;
  return { ok: response.ok && !parsed.error_code, body: parsed, errorCode };
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------
export async function persistLinkedAccount(deps: LinkDeps, userId: UserId, provider: ProviderId, discovered: DiscoveredAccount, credential: ConnectorCredential): Promise<ConnectorAccount> {
  const store = deps.storeFor(userId);
  const existing = await store.findConnectorAccount(provider, discovered.externalAccountId);
  const metadata: JsonObject = { ...(existing?.metadata ?? {}), ...(discovered.metadata ?? {}), linkedAt: deps.now().toISOString() };
  let account: ConnectorAccount;
  if (existing) {
    account = await store.updateConnectorAccount(existing.id, {
      label: discovered.label,
      address: discovered.address,
      capabilities: discovered.capabilities,
      status: "active",
      lastError: null,
      metadata,
    });
  } else {
    account = await store.createConnectorAccount({
      provider,
      externalAccountId: discovered.externalAccountId,
      label: discovered.label,
      address: discovered.address,
      capabilities: discovered.capabilities,
      status: "active",
      credentialLocation: "none",
      credentialRef: null,
      lastError: null,
      metadata,
    });
  }
  const credentialRef = await deps.credentialsFor(userId).putForAccount(account.id, credential);
  // vx_credential_put already set these columns; writing them through the store keeps in-memory stores honest too.
  account = await store.updateConnectorAccount(account.id, { credentialRef, credentialLocation: "server_vault" });
  for (const capability of discovered.capabilities) {
    const state = await store.getSyncState(account.id, capability);
    if (!state) await store.upsertSyncState(account.id, capability, { enabled: true, status: "idle" });
    else if (!state.enabled) await store.upsertSyncState(account.id, capability, { enabled: true, status: "idle", lastError: null });
  }
  deps.log?.("link: account persisted", { provider, connectorAccountId: account.id, relinked: existing !== null });
  return account;
}

export async function disconnectAccount(deps: LinkDeps, userId: UserId, accountId: string): Promise<{ ok: true }> {
  const store = deps.storeFor(userId);
  const account = await store.getConnectorAccount(accountId);
  if (!account) throw new HttpError(404, "not_found", `connector account ${accountId} not found`);
  await deps.disconnect(userId, accountId);
  deps.log?.("link: account disconnected", { provider: account.provider, connectorAccountId: accountId });
  return { ok: true };
}

function requireProvider(deps: LinkDeps, provider: ProviderId): Connector {
  if (!deps.registry.has(provider)) throw new HttpError(400, "provider_not_configured", `Provider ${provider} is not configured on this server`);
  return deps.registry.get(provider);
}

/** The page the system browser shows after the OAuth callback. */
export function linkResultPage(ok: boolean, message: string): string {
  const title = ok ? "Connected" : "Not connected";
  const body = ok ? "Connected — return to Vixera One." : `${escapeHtml(message)} — return to Vixera One and try again.`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Vixera One</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e8e9ec}main{max-width:32rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{margin:0;color:#a7abb4}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
