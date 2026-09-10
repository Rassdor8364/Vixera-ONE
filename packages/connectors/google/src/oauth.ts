/**
 * Google OAuth 2.0 helpers for the Google connector.
 *
 * The client secret is server configuration: it is passed in as
 * `GoogleOAuthConfig` and used only when talking to Google's token endpoint.
 * It is never part of a `ConnectorCredential`, never logged and never put in
 * an error message. Credentials produced here are plain `oauth2` domain
 * credentials that the engine stores behind the `CredentialStore` seam.
 *
 * Runtime neutral: only `fetch`, `URL`/`URLSearchParams` and `Date`.
 */
import { ConnectorError, type ConnectorCredential } from "@vixera/domain";

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/** Everything the connector needs: read-only mail + calendar and the account identity. */
export const GOOGLE_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
];

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export interface AuthorizationUrlOptions {
  readonly scopes: readonly string[];
  /** Opaque anti-CSRF value the caller verifies on the redirect. */
  readonly state: string;
  readonly loginHint?: string;
}

/**
 * Builds the consent URL. `access_type=offline` + `prompt=consent` make Google
 * return a refresh token on every link, so re-linking an account never leaves
 * us with an access token that cannot be renewed server-side.
 */
export function buildAuthorizationUrl(config: GoogleOAuthConfig, options: AuthorizationUrlOptions): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", options.scopes.join(" "));
  url.searchParams.set("state", options.state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
  return url.toString();
}

/** Google token endpoint response (provider schema; stays in this file). */
interface GoogleTokenResponse {
  readonly access_token?: string;
  readonly expires_in?: number;
  readonly refresh_token?: string;
  readonly scope?: string;
  readonly token_type?: string;
  readonly id_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

/** Exchanges an authorization code for an `oauth2` credential. */
export async function exchangeAuthorizationCode(
  fetchImpl: typeof fetch,
  config: GoogleOAuthConfig,
  code: string,
  now: () => Date = () => new Date(),
): Promise<ConnectorCredential> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  const token = await postToken(fetchImpl, body);
  if (!token.access_token) {
    throw new ConnectorError("invalid_response", "Google token exchange returned no access token", false);
  }
  return toCredential(token, token.refresh_token ?? null, now());
}

/**
 * Refreshes an `oauth2` credential. The refresh token is kept (Google only
 * rotates it when the user re-consents); if Google does send a new one it wins.
 */
export async function refreshAccessToken(
  fetchImpl: typeof fetch,
  config: GoogleOAuthConfig,
  credential: ConnectorCredential,
  now: () => Date = () => new Date(),
): Promise<ConnectorCredential> {
  if (credential.kind !== "oauth2" || !credential.refreshToken) {
    throw new ConnectorError("unauthorized", "Google credential has no refresh token; the account must be re-linked", false);
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  const token = await postToken(fetchImpl, body);
  if (!token.access_token) {
    throw new ConnectorError("invalid_response", "Google token refresh returned no access token", false);
  }
  const fresh = toCredential(token, token.refresh_token ?? credential.refreshToken, now());
  // Google omits `scope` on some refresh responses; keep what we already know.
  return fresh.kind === "oauth2" && fresh.scopes.length === 0 ? { ...fresh, scopes: credential.scopes } : fresh;
}

async function postToken(fetchImpl: typeof fetch, body: URLSearchParams): Promise<GoogleTokenResponse> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
  } catch (cause) {
    throw new ConnectorError("provider_unavailable", "Google token endpoint unreachable", true, { cause });
  }
  const json = (await response.json().catch(() => ({}))) as GoogleTokenResponse;
  if (response.ok) return json;
  // `error` is a short code such as invalid_grant; the description is Google prose.
  // Neither contains our secret or the user's tokens, so both are safe to surface.
  const reason = [json.error, json.error_description].filter(Boolean).join(": ") || `HTTP ${response.status}`;
  if (response.status === 400 || response.status === 401) {
    throw new ConnectorError("unauthorized", `Google token request rejected (${reason})`, false);
  }
  if (response.status === 429) throw new ConnectorError("rate_limited", `Google token endpoint rate limited (${reason})`, true);
  if (response.status >= 500) throw new ConnectorError("provider_unavailable", `Google token endpoint failed (${reason})`, true);
  throw new ConnectorError("unknown", `Google token request failed (${reason})`, false);
}

function toCredential(token: GoogleTokenResponse, refreshToken: string | null, now: Date): ConnectorCredential {
  const expiresAt =
    typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
      ? new Date(now.getTime() + token.expires_in * 1000).toISOString()
      : null;
  const credential: ConnectorCredential = {
    kind: "oauth2",
    accessToken: token.access_token ?? "",
    refreshToken,
    expiresAt,
    scopes: (token.scope ?? "").split(/\s+/).filter(Boolean),
    ...(token.token_type ? { tokenType: token.token_type } : {}),
  };
  return credential;
}
