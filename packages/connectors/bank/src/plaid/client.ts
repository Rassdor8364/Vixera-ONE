/**
 * Minimal Plaid HTTP client: the five read-only endpoints Vixera needs and
 * nothing else. Every request is `POST https://<env>.plaid.com/<endpoint>`
 * with `client_id` / `secret` in the JSON body, as Plaid requires.
 *
 * `PlaidConfig` is server configuration (Edge Function secrets). It is never
 * part of a credential, never persisted with an account and never logged.
 * The per-account secret is the Plaid `access_token`, which the sync engine
 * hands in through the credential store.
 *
 * Endpoint allowlist: `post()` refuses any endpoint outside
 * `PLAID_READ_ENDPOINTS`. The brief forbids payment execution; this makes a
 * `/transfer/*` or `/payment_initiation/*` call a thrown error rather than a
 * code review question.
 */
import { ConnectorError } from "@vixera/domain";
import { BankPaginationMutationError } from "../provider.ts";
import type {
  PlaidAccountsGetResponse,
  PlaidErrorBody,
  PlaidItemGetResponse,
  PlaidLinkTokenCreateResponse,
  PlaidPublicTokenExchangeResponse,
  PlaidTransactionsSyncResponse,
} from "./types.ts";

export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidConfig {
  readonly clientId: string;
  readonly secret: string;
  readonly environment: PlaidEnvironment;
}

export const PLAID_READ_ENDPOINTS = [
  "/link/token/create",
  "/item/public_token/exchange",
  "/item/get",
  "/accounts/get",
  "/transactions/sync",
] as const;
export type PlaidReadEndpoint = (typeof PLAID_READ_ENDPOINTS)[number];

export type PlaidProduct = "transactions";

export interface CreateLinkTokenInput {
  /** The Vixera user id. Opaque to Plaid; it only has to be stable per user. */
  readonly userId: string;
  readonly products: readonly PlaidProduct[];
  readonly clientName: string;
  readonly countryCodes: readonly string[];
  readonly language: string;
  readonly redirectUri?: string;
}

export interface LinkToken {
  readonly linkToken: string;
  /** ISO timestamp after which the link token can no longer open Plaid Link. */
  readonly expiration: string;
}

export interface ExchangedToken {
  readonly accessToken: string;
  readonly itemId: string;
}

export const DEFAULT_TRANSACTIONS_PAGE_SIZE = 500;

/**
 * Plaid's `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`: the item's data
 * changed between pages of one `/transactions/sync` pass. Plaid's own advice
 * is to restart pagination from the cursor of the last successful response,
 * which is what `BankConnector` does.
 */
export class PlaidMutationDuringPaginationError extends BankPaginationMutationError {
  constructor(
    cursor: string | null,
    readonly requestId: string | null,
  ) {
    super(`Plaid: transactions changed during pagination${requestId ? ` (request ${requestId})` : ""}`, cursor);
    this.name = "PlaidMutationDuringPaginationError";
  }
}

export class PlaidClient {
  readonly #fetch: typeof fetch;
  readonly #config: PlaidConfig;

  constructor(fetchImpl: typeof fetch, config: PlaidConfig) {
    if (!config.clientId || !config.secret) {
      throw new ConnectorError("unsupported", "Plaid client id and secret are required", false);
    }
    this.#fetch = fetchImpl;
    this.#config = config;
  }

  get environment(): PlaidEnvironment {
    return this.#config.environment;
  }

  get baseUrl(): string {
    return `https://${this.#config.environment}.plaid.com`;
  }

  async createLinkToken(input: CreateLinkTokenInput): Promise<LinkToken> {
    if (!input.userId) throw new ConnectorError("unsupported", "createLinkToken requires the Vixera user id", false);
    const body: Record<string, unknown> = {
      user: { client_user_id: input.userId },
      client_name: input.clientName,
      products: input.products,
      country_codes: input.countryCodes,
      language: input.language,
    };
    if (input.redirectUri) body.redirect_uri = input.redirectUri;
    const res = await this.#post<PlaidLinkTokenCreateResponse>("/link/token/create", body);
    if (!res.link_token) throw new ConnectorError("invalid_response", "Plaid returned no link_token", false);
    return { linkToken: res.link_token, expiration: res.expiration };
  }

  async exchangePublicToken(publicToken: string): Promise<ExchangedToken> {
    const res = await this.#post<PlaidPublicTokenExchangeResponse>("/item/public_token/exchange", { public_token: publicToken });
    if (!res.access_token || !res.item_id) throw new ConnectorError("invalid_response", "Plaid exchange returned no access token", false);
    return { accessToken: res.access_token, itemId: res.item_id };
  }

  async getItem(accessToken: string): Promise<PlaidItemGetResponse> {
    const res = await this.#post<PlaidItemGetResponse>("/item/get", { access_token: accessToken });
    if (!res.item?.item_id) throw new ConnectorError("invalid_response", "Plaid /item/get returned no item", false);
    return res;
  }

  async getAccounts(accessToken: string): Promise<PlaidAccountsGetResponse> {
    const res = await this.#post<PlaidAccountsGetResponse>("/accounts/get", { access_token: accessToken });
    if (!Array.isArray(res.accounts)) throw new ConnectorError("invalid_response", "Plaid /accounts/get returned no accounts", false);
    return res;
  }

  async transactionsSync(accessToken: string, cursor: string | null, count = DEFAULT_TRANSACTIONS_PAGE_SIZE): Promise<PlaidTransactionsSyncResponse> {
    const body: Record<string, unknown> = { access_token: accessToken, count };
    if (cursor) body.cursor = cursor;
    let res: PlaidTransactionsSyncResponse;
    try {
      res = await this.#post<PlaidTransactionsSyncResponse>("/transactions/sync", body);
    } catch (err) {
      if (err instanceof PlaidMutationDuringPaginationError) throw new PlaidMutationDuringPaginationError(cursor, err.requestId);
      throw err;
    }
    if (!Array.isArray(res.added) || !Array.isArray(res.modified) || !Array.isArray(res.removed) || typeof res.next_cursor !== "string") {
      throw new ConnectorError("invalid_response", "Plaid /transactions/sync returned an unexpected body", false);
    }
    return res;
  }

  async #post<T>(endpoint: PlaidReadEndpoint, body: Record<string, unknown>): Promise<T> {
    if (!(PLAID_READ_ENDPOINTS as readonly string[]).includes(endpoint)) {
      throw new ConnectorError("unsupported", `Plaid endpoint not allowed by the read-only bank connector: ${endpoint}`, false);
    }
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...body, client_id: this.#config.clientId, secret: this.#config.secret }),
      });
    } catch (cause) {
      throw new ConnectorError("provider_unavailable", "Plaid API unreachable", true, { cause });
    }
    const parsed = await parseJson<T & PlaidErrorBody>(response);
    if (response.ok && parsed && !parsed.error_type) return parsed;
    throw mapPlaidError(response.status, parsed, endpoint);
  }
}

async function parseJson<T>(response: Response): Promise<T | null> {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Maps a Plaid error body onto the connector error vocabulary. Plaid puts the
 * meaning in `error_type` / `error_code`, not in the HTTP status, so the
 * status is only a fallback.
 */
export function mapPlaidError(status: number, body: PlaidErrorBody | null, endpoint: string): ConnectorError | PlaidMutationDuringPaginationError {
  const type = body?.error_type ?? "";
  const code = body?.error_code ?? "";
  const requestId = body?.request_id ?? null;
  const detail = `${code || type || `HTTP ${status}`}${body?.error_message ? `: ${body.error_message}` : ""}`;
  const where = `Plaid ${endpoint}`;

  if (code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") return new PlaidMutationDuringPaginationError(null, requestId);
  // Only failures of the per-account credential are `unauthorized`: the engine turns that into a sticky
  // needs_reauth on the user's account. A bad server client_id/secret (INVALID_API_KEYS) is server
  // configuration, not something re-linking can fix, so it stays `unknown`.
  if (code === "ITEM_LOGIN_REQUIRED" || code === "INVALID_ACCESS_TOKEN" || code === "ITEM_NOT_FOUND") {
    return new ConnectorError("unauthorized", `${where} rejected the credential (${detail})`, false);
  }
  if (type === "RATE_LIMIT_EXCEEDED" || code === "RATE_LIMIT_EXCEEDED" || status === 429) {
    return new ConnectorError("rate_limited", `${where} rate limited (${detail})`, true);
  }
  if (type === "API_ERROR" || status >= 500) {
    return new ConnectorError("provider_unavailable", `${where} unavailable (${detail})`, true);
  }
  if (!body) return new ConnectorError("invalid_response", `${where} returned a non-JSON body (HTTP ${status})`, false);
  return new ConnectorError("unknown", `${where} failed (${detail})`, false);
}
