/**
 * Authenticated HTTP client for Microsoft Graph, shared by the mail and
 * calendar sync sources.
 *
 * Responsibilities:
 *   - attach the bearer token from the `SyncContext` credential
 *   - refresh the credential once (proactively when it is known to be expired,
 *     or reactively on the first 401), hand the new credential to
 *     `ctx.onCredentialRefreshed`, and retry the request once; a second 401
 *     surfaces as `ConnectorError("unauthorized")`
 *   - map Graph failures onto `ConnectorError` codes the engine understands:
 *     429 → `rate_limited` (Retry-After is carried as metadata only; nothing
 *     here ever sleeps), 5xx → `provider_unavailable`
 *   - let callers tolerate specific statuses (410 for an expired delta token)
 *
 * Nothing here logs URLs, headers, bodies or tokens.
 */
import { ConnectorError, isExpired, type ConnectorCredential, type SyncContext } from "@vixera/domain";
import { refreshAccessToken, type MicrosoftOAuthConfig } from "./oauth.ts";

export const GRAPH_API = "https://graph.microsoft.com/v1.0";

export type ApiContext = Omit<SyncContext, "account">;

export interface ApiResponse<T> {
  readonly status: number;
  /** Parsed JSON body, or null when the body was empty / not JSON. */
  readonly body: T | null;
  readonly headers: Headers;
}

export interface GetOptions {
  /** Non-2xx statuses returned to the caller instead of being thrown. */
  readonly tolerate?: readonly number[];
  /** Extra request headers (e.g. `Prefer`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** Graph error envelope (provider schema, stays here). */
interface GraphErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly innerError?: { readonly code?: string; readonly "request-id"?: string; readonly date?: string };
  };
}

/** `rate_limited` with the provider's suggested wait as metadata. Callers decide whether to honor it. */
export class GraphRateLimitedError extends ConnectorError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super("rate_limited", message, true);
    this.name = "GraphRateLimitedError";
  }
}

export class GraphApiClient {
  #credential: ConnectorCredential;
  #refreshAttempted = false;

  constructor(
    private readonly ctx: ApiContext,
    private readonly oauth: MicrosoftOAuthConfig,
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
    let response = await this.send(url, options.headers);
    if (response.status === 401 && !this.#refreshAttempted) {
      await this.refresh();
      response = await this.send(url, options.headers);
    }
    const tolerated = options.tolerate?.includes(response.status) ?? false;
    const body = await parseJson<T & GraphErrorBody>(response);
    if (response.ok || tolerated) return { status: response.status, body, headers: response.headers };
    throw mapError(response.status, response.headers, body);
  }

  private async send(url: string | URL, extraHeaders: Readonly<Record<string, string>> | undefined): Promise<Response> {
    try {
      return await this.ctx.fetch(url instanceof URL ? url.toString() : url, {
        method: "GET",
        headers: { ...(extraHeaders ?? {}), authorization: `Bearer ${accessTokenOf(this.#credential)}`, accept: "application/json" },
      });
    } catch (cause) {
      throw new ConnectorError("provider_unavailable", "Microsoft Graph unreachable", true, { cause });
    }
  }

  private async refresh(): Promise<void> {
    this.#refreshAttempted = true;
    this.ctx.log?.("microsoft.credential.refresh");
    const fresh = await refreshAccessToken(this.ctx.fetch, this.oauth, this.#credential, this.ctx.now);
    this.#credential = fresh;
    await this.ctx.onCredentialRefreshed?.(fresh);
  }
}

function accessTokenOf(credential: ConnectorCredential): string {
  if (credential.kind === "api_key") {
    throw new ConnectorError("unsupported", "Microsoft connector requires an OAuth credential", false);
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

/** Parses a Retry-After header (seconds or HTTP date) into seconds, or null. */
export function parseRetryAfter(value: string | null, now: () => Date = () => new Date()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((at - now().getTime()) / 1000));
}

function mapError(status: number, headers: Headers, body: GraphErrorBody | null): ConnectorError {
  const code = body?.error?.code;
  const message = body?.error?.message ?? `HTTP ${status}`;
  const detail = code ? `${code}: ${message}` : message;
  if (status === 401) return new ConnectorError("unauthorized", `Microsoft Graph rejected the credential (${detail})`, false);
  if (status === 403) return new ConnectorError("unauthorized", `Microsoft Graph denied access (${detail})`, false);
  if (status === 429) {
    const retryAfter = parseRetryAfter(headers.get("retry-after"));
    const suffix = retryAfter !== null ? `, retry after ${retryAfter}s` : "";
    return new GraphRateLimitedError(`Microsoft Graph rate limit (${detail}${suffix})`, retryAfter);
  }
  if (status === 410) return new ConnectorError("checkpoint_invalid", `Microsoft Graph delta token expired (${detail})`, false);
  if (status >= 500) return new ConnectorError("provider_unavailable", `Microsoft Graph error ${status} (${detail})`, true);
  return new ConnectorError("unknown", `Microsoft Graph error ${status} (${detail})`, false);
}

/**
 * Builds a Graph URL with OData query options. `URLSearchParams` would encode
 * `$select` as `%24select` and spaces as `+`; Graph expects the literal `$`
 * and `%20`, so the query string is assembled by hand.
 */
export function graphUrl(path: string, params: Readonly<Record<string, string>>): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/%2C/g, ",").replace(/%3A/g, ":")}`)
    .join("&");
  return query ? `${path}?${query}` : path;
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
