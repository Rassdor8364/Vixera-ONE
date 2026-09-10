/**
 * Bank link flow, as plain functions for the `connector-link` Edge Function.
 *
 *   1. `beginBankLink`    server: create a Plaid Link token for the Vixera user
 *   2. (client)           open Plaid Link with that token → `public_token`
 *   3. `completeBankLink` server: exchange the public token for an
 *                         access_token, wrap it as an `access_token`
 *                         credential and describe the item through the
 *                         connector so the engine can create the
 *                         `ConnectorAccount` (credential goes to Vault,
 *                         never into the account row).
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
}

export function beginBankLink(client: PlaidClient, input: BeginBankLinkInput): Promise<LinkToken> {
  return client.createLinkToken({
    userId: input.userId,
    products: ["transactions"],
    clientName: BANK_LINK_CLIENT_NAME,
    countryCodes: input.countryCodes ?? DEFAULT_COUNTRY_CODES,
    language: input.language ?? DEFAULT_LANGUAGE,
    ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
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
  const ctx: Omit<SyncContext, "account"> = {
    credential,
    fetch: deps.fetch,
    now: deps.now ?? (() => new Date()),
    ...(deps.log ? { log: deps.log } : {}),
  };
  const discovered = await deps.connector.discoverAccount(ctx);
  if (discovered.externalAccountId !== exchanged.itemId) {
    deps.log?.("bank.link.item_mismatch", { exchanged: exchanged.itemId, described: discovered.externalAccountId });
  }
  return { credential, discovered };
}

/** Convenience for the Edge Function: a Plaid-backed connector from server config. */
export function createPlaidBankConnector(config: PlaidConfig, options: { pageSize?: number } = {}): BankConnector {
  return new BankConnector(new PlaidBankProvider({ config, ...(options.pageSize ? { pageSize: options.pageSize } : {}) }));
}

/** The whole flow as one object, for callers that prefer injecting it. */
export interface BankLinkFlow {
  readonly begin: typeof beginBankLink;
  readonly complete: typeof completeBankLink;
}

export const bankLinkFlow: BankLinkFlow = { begin: beginBankLink, complete: completeBankLink };
