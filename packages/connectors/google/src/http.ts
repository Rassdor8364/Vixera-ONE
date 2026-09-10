/**
 * Authenticated HTTP client for Google APIs, shared by the Gmail and Calendar
 * sync sources.
 *
 * Responsibilities:
 *   - attach the bearer token from the `SyncContext` credential
 *   - refresh the credential once (proactively when it is known to be expired,
 *     or reactively on the first 401), hand the new credential to
 *     `ctx.onCredentialRefreshed`, and retry the request once
 *   - map provider failures onto `ConnectorError` codes the engine understands
 *   - let callers tolerate specific statuses (404 history, 410 sync token)
 *
 * Nothing here logs URLs, headers, bodies or tokens.
 */
import { ConnectorError, isExpired, type ConnectorCredential, type SyncContext } from "@vixera/domain";
import { refreshAccessToken, type GoogleOAuthConfig } from "./oauth.ts";

export type ApiContext = Omit<SyncContext, "account">;

export interface ApiResponse<T> {
  readonly status: number;
  /** Parsed JSON body, or null when the body was empty / not JSON. */
  readonly body: T | null;
}

export interface GetOptions {
  /** Non-2xx statuses returned to the caller instead of being thrown. */
  readonly tolerate?: readonly number[];
}

/** Shape of a Google API error body (provider schema, stays here). */
interface GoogleErrorBody {
  readonly error?: {
    readonly code?: number;
    readonly message?: string;
    readonly status?: string;
    readonly errors?: readonly { readonly reason?: string; readonly message?: string }[];
  };
}

export class GoogleApiClient {
  #credential: ConnectorCredential;
  #refreshAttempted = false;
  /** The single in-flight (or settled) refresh; concurrent 401s all wait on it instead of racing. */
  #refresh: Promise<void> | null = null;

  constructor(
    private readonly ctx: ApiContext,
    private readonly oauth: GoogleOAuthConfig,
  ) {
    this.#credential = ctx.credential;
  }

  /** The credential currently in use (possibly refreshed during this sync). */
  get credential(): ConnectorCredential {
    return this.#credential;
  }

  async getJson<T>(url: string | URL, options: GetOptions = {}): Promise<ApiResponse<T>> {
    if (!this.#refreshAttempted && isExpired(this.#credential, this.ctx.now())) {
      await this.refresh();
    }
    const token = accessTokenOf(this.#credential);
    let response = await this.send(url, token);
    if (response.status === 401) {
      // Refresh once per client; requests that raced with that refresh (bounded
      // concurrency) wait for it and retry with the new token instead of failing.
      if (!this.#refreshAttempted) await this.refresh();
      else if (this.#refresh) await this.#refresh;
      const fresh = accessTokenOf(this.#credential);
      if (fresh !== token) response = await this.send(url, fresh);
    }
    const tolerated = options.tolerate?.includes(response.status) ?? false;
    const body = await parseJson<T & GoogleErrorBody>(response);
    if (response.ok || tolerated) return { status: response.status, body };
    throw mapError(response.status, body);
  }

  private async send(url: string | URL, token: string): Promise<Response> {
    try {
      return await this.ctx.fetch(url instanceof URL ? url.toString() : url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (cause) {
      throw new ConnectorError("provider_unavailable", "Google API unreachable", true, { cause });
    }
  }

  private refresh(): Promise<void> {
    if (this.#refresh) return this.#refresh;
    this.#refreshAttempted = true;
    this.ctx.log?.("google.credential.refresh");
    this.#refresh = (async () => {
      const fresh = await refreshAccessToken(this.ctx.fetch, this.oauth, this.#credential, this.ctx.now);
      this.#credential = fresh;
      await this.ctx.onCredentialRefreshed?.(fresh);
    })();
    return this.#refresh;
  }
}

function accessTokenOf(credential: ConnectorCredential): string {
  if (credential.kind === "api_key") {
    throw new ConnectorError("unsupported", "Google connector requires an OAuth credential", false);
  }
  return credential.accessToken;
}

async function parseJson<T>(response: Response): Promise<T | null> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function mapError(status: number, body: GoogleErrorBody | null): ConnectorError {
  const reasons = (body?.error?.errors ?? []).map((e) => e.reason ?? "").filter(Boolean);
  const message = body?.error?.message ?? `HTTP ${status}`;
  const detail = reasons.length ? `${message} [${reasons.join(",")}]` : message;
  if (status === 401) return new ConnectorError("unauthorized", `Google rejected the credential (${detail})`, false);
  if (status === 429) return new ConnectorError("rate_limited", `Google rate limit (${detail})`, true);
  if (status === 403) {
    const quota = reasons.some((r) => /rateLimit|quota|userRateLimit|dailyLimit/i.test(r));
    return quota
      ? new ConnectorError("rate_limited", `Google quota exceeded (${detail})`, true)
      : new ConnectorError("unauthorized", `Google denied access (${detail})`, false);
  }
  if (status >= 500) return new ConnectorError("provider_unavailable", `Google API error ${status} (${detail})`, true);
  return new ConnectorError("unknown", `Google API error ${status} (${detail})`, false);
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
