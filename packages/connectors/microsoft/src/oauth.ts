/**
 * Microsoft identity platform (Entra ID) OAuth 2.0 helpers for the Microsoft
 * Graph connector.
 *
 * The client secret is server configuration: it arrives as
 * `MicrosoftOAuthConfig`, is used only when talking to the token endpoint and
 * is never part of a `ConnectorCredential`, never logged and never put in an
 * error message. Credentials produced here are plain `oauth2` domain
 * credentials that the engine keeps behind the `CredentialStore` seam.
 *
 * Endpoints are tenant-scoped: `login.microsoftonline.com/<tenant>/oauth2/v2.0/*`
 * where `tenant` is "common" (any work/school or personal account) unless the
 * deployment pins a directory.
 *
 * Runtime neutral: only `fetch`, `URL`/`URLSearchParams` and `Date`.
 */
import { ConnectorError, type ConnectorCredential } from "@vixera/domain";

export interface MicrosoftOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  /** Entra tenant: "common", "organizations", "consumers" or a tenant id. Default "common". */
  readonly tenant?: string;
}

export const DEFAULT_TENANT = "common";

/** Read-only mail + calendar, the account identity, and a refresh token. */
export const MICROSOFT_SCOPES: readonly string[] = ["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"];

export const MICROSOFT_LOGIN_HOST = "https://login.microsoftonline.com";

export function authorizationEndpoint(config: MicrosoftOAuthConfig): string {
  return `${MICROSOFT_LOGIN_HOST}/${encodeURIComponent(config.tenant ?? DEFAULT_TENANT)}/oauth2/v2.0/authorize`;
}

export function tokenEndpoint(config: MicrosoftOAuthConfig): string {
  return `${MICROSOFT_LOGIN_HOST}/${encodeURIComponent(config.tenant ?? DEFAULT_TENANT)}/oauth2/v2.0/token`;
}

export interface AuthorizationUrlOptions {
  readonly scopes?: readonly string[];
  /** Opaque anti-CSRF value the caller verifies on the redirect. */
  readonly state: string;
  readonly loginHint?: string;
  /** "select_account" (default) lets the user pick which Microsoft account to link. */
  readonly prompt?: "select_account" | "consent" | "login" | "none";
}

/** Builds the consent URL. `offline_access` in the scopes is what yields a refresh token. */
export function buildAuthorizationUrl(config: MicrosoftOAuthConfig, options: AuthorizationUrlOptions): string {
  const url = new URL(authorizationEndpoint(config));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", (options.scopes ?? MICROSOFT_SCOPES).join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("prompt", options.prompt ?? "select_account");
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url.toString();
}

/** Microsoft token endpoint response (provider schema; stays in this file). */
interface MicrosoftTokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
  readonly token_type?: string;
  readonly id_token?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly error_codes?: readonly number[];
}

/** Exchanges an authorization code for an `oauth2` credential. */
export async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  config: MicrosoftOAuthConfig,
  code: string,
  now: () => Date = () => new Date(),
  scopes: readonly string[] = MICROSOFT_SCOPES,
): Promise<ConnectorCredential> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    scope: scopes.join(" "),
  });
  const token = await postToken(fetchImpl, config, body);
  if (!token.access_token) {
    throw new ConnectorError("invalid_response", "Microsoft token exchange returned no access token", false);
  }
  return toCredential(token, token.refresh_token ?? null, scopes, now());
}

/**
 * Refreshes an `oauth2` credential. Microsoft rotates the refresh token on
 * most refreshes: the new one always wins; the old one is kept only when the
 * response carries none.
 */
export async function refreshAccessToken(
  fetchImpl: typeof fetch,
  config: MicrosoftOAuthConfig,
  credential: ConnectorCredential,
  now: () => Date = () => new Date(),
): Promise<ConnectorCredential> {
  if (credential.kind !== "oauth2" || !credential.refreshToken) {
    throw new ConnectorError("unauthorized", "Microsoft credential has no refresh token; the account must be re-linked", false);
  }
  const scopes = credential.scopes.length ? credential.scopes : MICROSOFT_SCOPES;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: scopes.join(" "),
  });
  const token = await postToken(fetchImpl, config, body);
  if (!token.access_token) {
    throw new ConnectorError("invalid_response", "Microsoft token refresh returned no access token", false);
  }
  return toCredential(token, token.refresh_token ?? credential.refreshToken, scopes, now());
}

async function postToken(fetchImpl: typeof fetch, config: MicrosoftOAuthConfig, body: URLSearchParams): Promise<MicrosoftTokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(tokenEndpoint(config), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
  } catch (cause) {
    throw new ConnectorError("provider_unavailable", "Microsoft token endpoint unreachable", true, { cause });
  }
  const json = (await response.json().catch(() => ({}))) as MicrosoftTokenResponse;
  if (response.ok) return json;
  // `error` is a short code (invalid_grant, interaction_required, ...). The
  // description is Microsoft prose with an AADSTS code and trace ids; neither
  // contains our secret or the user's tokens, so both are safe to surface.
  const reason = [json.error, firstLine(json.error_description)].filter(Boolean).join(": ") || `HTTP ${response.status}`;
  if (response.status === 400 || response.status === 401) {
    throw new ConnectorError("unauthorized", `Microsoft token request rejected (${reason})`, false);
  }
  if (response.status === 429) throw new ConnectorError("rate_limited", `Microsoft token endpoint rate limited (${reason})`, true);
  if (response.status >= 500) throw new ConnectorError("provider_unavailable", `Microsoft token endpoint failed (${reason})`, true);
  throw new ConnectorError("unknown", `Microsoft token request failed (${reason})`, false);
}

function firstLine(text: string | undefined): string | undefined {
  return text?.split(/\r?\n/)[0]?.trim() || undefined;
}

function toCredential(token: MicrosoftTokenResponse, refreshToken: string | null, requested: readonly string[], now: Date): ConnectorCredential {
  const expiresAt =
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
      ? new Date(now.getTime() + token.expires_in * 1000).toISOString()
      : null;
  const granted = (token.scope ?? "").split(/\s+/).filter(Boolean);
  // Microsoft never echoes `openid` / `offline_access`; keep the requested set when the response is empty.
  const scopes = granted.length ? granted : [...requested];
  return {
    kind: "oauth2",
    accessToken: token.access_token ?? "",
    refreshToken,
    expiresAt,
    scopes,
    ...(token.token_type ? { tokenType: token.token_type } : {}),
  };
}
