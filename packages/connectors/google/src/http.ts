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
    /** google.rpc style (`ErrorInfo.reason`, e.g. ACCESS_TOKEN_SCOPE_INSUFFICIENT). */
    readonly details?: readonly { readonly reason?: string }[];
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
  const reasons = [...(body?.error?.errors ?? []), ...(body?.error?.details ?? [])].map((e) => e.reason ?? "").filter(Boolean);
  const message = body?.error?.message ?? `HTTP ${status}`;
  const detail = reasons.length ? `${message} [${reasons.join(",")}]` : message;
  if (status === 401) return new ConnectorError("unauthorized", `Google rejected the credential (${detail})`, false);
  if (status === 429) return new ConnectorError("rate_limited", `Google rate limit (${detail})`, true);
  if (status === 403) {
    const quota = reasons.some((r) => /rateLimit|quota|userRateLimit|dailyLimit/i.test(r));
    if (quota) return new ConnectorError("rate_limited", `Google quota exceeded (${detail})`, true);
    // The token is fine, it just does not cover this API: a scope the user
    // declined. That limits one capability; `unauthorized` would retire the
    // whole account (needs_reauth) and stop the capabilities that do work.
    const scope = reasons.some((r) => /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(r));
    if (scope) return new ConnectorError("unsupported", `Google grant does not cover this API (${detail}); re-link to allow it`, false);
    // Any other 403 (a Workspace user without a Gmail licence, an API the admin
    // turned off, a calendar the user cannot read) is still not a dead
    // credential — Google answers 401 for those. It limits this capability.
    return new ConnectorError("unsupported", `Google denied this API (${detail})`, false);
  }
  if (status >= 500) return new ConnectorError("provider_unavailable", `Google API error ${status} (${detail})`, true);
  return new ConnectorError("unknown", `Google API error ${status} (${detail})`, false);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight; results keep input
 * order. The first failure stops the queue: no further item is started, the
 * items already in flight are allowed to settle, and only then does the
 * promise reject with that first error. A sync that just hit a 429 or a dead
 * token must not keep hammering the provider from workers nobody awaits.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const queue: { next: number; failure: { error: unknown } | null } = { next: 0, failure: null };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (queue.failure === null && queue.next < items.length) {
      const index = queue.next++;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error) {
        // The first failure stops the queue; a later, non-retryable one from an
        // item already in flight (a rejected token) is the one worth reporting,
        // since the engine acts on it and would otherwise only see a hiccup.
        // Re-read through an assertion: the loop condition narrowed `queue.failure`
        // to null, and another worker may have failed during the await.
        const current = queue.failure as { error: unknown } | null;
        if (current === null || (isRetryable(current.error) && !isRetryable(error))) queue.failure = { error };
      }
    }
  });
  await Promise.all(workers);
  if (queue.failure) throw queue.failure.error;
  return results;
}

function isRetryable(error: unknown): boolean {
  return error instanceof ConnectorError && error.retryable;
}
