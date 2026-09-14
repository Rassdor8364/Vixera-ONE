/**
 * Bank link flow, as plain functions for the `connector-link` Edge Function.
 * (Today the function calls `completeBankLink` and builds its Hosted Link
 * token through its own client — audit BANK-003; `beginBankLink` with
 * `hostedLink` is the path it should move onto.)
 *
 * New Item:
 *   1. `beginBankLink`    server: create a Plaid Link token for the Vixera user
 *                         (`hostedLink: true` for a Hosted Link URL the system
 *                         browser can open)
 *   2. (client)           open Plaid Link with that token → `public_token`
 *   3. `completeBankLink` server: exchange the public token for an
 *                         access_token, wrap it as an `access_token`
 *                         credential and describe the item through the
 *                         connector so the engine can create the
 *                         `ConnectorAccount` (credential goes to Vault,
 *                         never into the account row).
 *
 * Existing Item in `needs_reauth` (Plaid ITEM_LOGIN_REQUIRED) — Link
 * **update mode**, so the repair lands on the existing account instead of
 * linking a second Item that duplicates every account and transaction:
 *   1. `beginBankLink`      with the account's `accessToken` (from Vault) →
 *                           update-mode Link token, no products
 *   2. (client)             the user re-enters credentials in Link
 *   3. `completeBankRelink` no public token exists to exchange: re-describe
 *                           the Item with the same credential; it still has
 *                           the same item_id (so persisting it finds the
 *                           existing `connector_accounts` row) and its
 *                           checkpoint stays valid. A still-broken Item
 *                           throws `unauthorized`, so the account is not set
 *                           back to active early.
 *
 * The user id passed to Plaid is the Vixera user id from `currentUser()`; it
 * is opaque to Plaid and never derived from provider data.
 */
import type { ConnectorCredential, DiscoveredAccount, JsonObject, SyncContext } from "@vixera/domain";
import { BankConnector } from "./connector.ts";
import type { LinkToken, PlaidClient, PlaidConfig } from "./plaid/client.ts";
import { PlaidBankProvider } from "./plaid/provider.ts";

export const BANK_LINK_CLIENT_NAME = "Vixera One";
export const DEFAULT_COUNTRY_CODES: readonly string[] = ["US"];
export const DEFAULT_LANGUAGE = "en";

export interface BeginBankLinkInput {
  /** From `currentUser().id`. */
  readonly userId: string;
  readonly countryCodes?: readonly string[];
  readonly language?: string;
  readonly redirectUri?: string;
  /** Link update mode: the existing Item's access token (the account's Vault credential) instead of a new Item. */
  readonly accessToken?: string;
  /** Request a Hosted Link URL (the Field has no Plaid Link web widget). */
  readonly hostedLink?: boolean;
}

export function beginBankLink(client: PlaidClient, input: BeginBankLinkInput): Promise<LinkToken> {
  return client.createLinkToken({
    userId: input.userId,
    ...(input.accessToken ? { accessToken: input.accessToken } : { products: ["transactions"] }),
    clientName: BANK_LINK_CLIENT_NAME,
    countryCodes: input.countryCodes ?? DEFAULT_COUNTRY_CODES,
    language: input.language ?? DEFAULT_LANGUAGE,
    ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
    ...(input.hostedLink ? { hostedLink: true } : {}),
  });
}

export interface CompleteBankLinkDeps {
  readonly client: PlaidClient;
  /** The connector the engine will sync this account with; must be a Plaid-backed `BankConnector`. */
  readonly connector: BankConnector;
  readonly fetch: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (message: string, data?: JsonObject) => void;
}

export interface CompleteBankLinkInput {
  readonly publicToken: string;
}

export interface CompletedBankLink {
  /** Store this in the credential store; put the returned ref on the account. */
  readonly credential: ConnectorCredential;
  /** Feed to the engine's account creation (externalAccountId = Plaid item id). */
  readonly discovered: DiscoveredAccount;
}

export async function completeBankLink(deps: CompleteBankLinkDeps, input: CompleteBankLinkInput): Promise<CompletedBankLink> {
  const exchanged = await deps.client.exchangePublicToken(input.publicToken);
  const credential: ConnectorCredential = { kind: "access_token", accessToken: exchanged.accessToken, expiresAt: null };
  const discovered = await deps.connector.discoverAccount(discoveryContext(deps, credential));
  if (discovered.externalAccountId !== exchanged.itemId) {
    deps.log?.("bank.link.item_mismatch", { exchanged: exchanged.itemId, described: discovered.externalAccountId });
  }
  return { credential, discovered };
}

export interface CompleteBankRelinkInput {
  /** The account's existing credential (from Vault): update mode issues no new access token. */
  readonly credential: ConnectorCredential;
}

/**
 * Completion of a Link **update mode** session. There is no public token to
 * exchange — the Item and its access_token are unchanged — so the Item is
 * re-described with the existing credential. `/item/get` still reporting an
 * error (the user abandoned Link) throws `unauthorized`; the caller then
 * leaves the account in `needs_reauth`. On success, persist `discovered` the
 * same way as a fresh link: the item id is the same, so the existing row is
 * found, its status goes back to active and its checkpoint is kept.
 */
export async function completeBankRelink(deps: CompleteBankLinkDeps, input: CompleteBankRelinkInput): Promise<CompletedBankLink> {
  const discovered = await deps.connector.discoverAccount(discoveryContext(deps, input.credential));
  return { credential: input.credential, discovered };
}

function discoveryContext(deps: CompleteBankLinkDeps, credential: ConnectorCredential): Omit<SyncContext, "account"> {
  return {
    credential,
    fetch: deps.fetch,
    now: deps.now ?? (() => new Date()),
    ...(deps.log ? { log: deps.log } : {}),
  };
}

/** Convenience for the Edge Function: a Plaid-backed connector from server config. */
export function createPlaidBankConnector(config: PlaidConfig, options: { pageSize?: number } = {}): BankConnector {
  return new BankConnector(new PlaidBankProvider({ config, ...(options.pageSize ? { pageSize: options.pageSize } : {}) }));
}

/** The whole flow as one object, for callers that prefer injecting it. */
export interface BankLinkFlow {
  readonly begin: typeof beginBankLink;
  readonly complete: typeof completeBankLink;
  readonly relink: typeof completeBankRelink;
}

export const bankLinkFlow: BankLinkFlow = { begin: beginBankLink, complete: completeBankLink, relink: completeBankRelink };
