/**
 * `BankProvider`: the provider-neutral adapter seam of the bank connector.
 *
 * The aggregator (Plaid today) can change without touching `BankConnector`,
 * the sync engine or the Field: an adapter only has to describe the linked
 * item, list its accounts (balances travel with the accounts) and page
 * through transaction changes behind a cursor. Everything it returns is a
 * normalized domain object; provider schemas stay inside the adapter.
 *
 * READ-ONLY by construction. There is no method on this interface that can
 * move money, create a payment, or write anything to the provider. The Phase 1
 * brief forbids payment execution; the interface makes it impossible to add
 * one by accident without changing this file.
 */
import type { ConnectorCredential, JsonObject, NormalizedMoneyAccount, NormalizedMoneyTransaction, SyncContext } from "@vixera/domain";

/** Which aggregator an adapter talks to. Also the `ProviderId` the connector reports. */
export type BankProviderId = "plaid" | "mock";

/**
 * What an adapter call needs from its caller: a fetch (injectable for tests
 * and for the Tauri HTTP plugin), the account's credential, a clock and an
 * optional logger. Deliberately a subset of `SyncContext` — the adapter never
 * sees the `ConnectorAccount` row, so it can never read a user id out of it.
 */
export interface BankProviderContext {
  readonly fetch: typeof fetch;
  readonly credential: ConnectorCredential;
  readonly now: () => Date;
  readonly log?: (message: string, data?: JsonObject) => void;
}

/** Projects a connector `SyncContext` (with or without account) onto the adapter contract. */
export function toProviderContext(ctx: Omit<SyncContext, "account">): BankProviderContext {
  return ctx.log ? { fetch: ctx.fetch, credential: ctx.credential, now: ctx.now, log: ctx.log } : { fetch: ctx.fetch, credential: ctx.credential, now: ctx.now };
}

/** Identity of the linked item (one bank login), used to create the `ConnectorAccount`. */
export interface BankItemDescription {
  readonly externalAccountId: string;
  readonly label: string;
  readonly institutionName: string | null;
}

/** One page of transaction changes since `cursor`. */
export interface BankTransactionsPage {
  readonly added: readonly NormalizedMoneyTransaction[];
  readonly modified: readonly NormalizedMoneyTransaction[];
  /** External ids of transactions the provider removed (e.g. a pending one that settled under a new id). */
  readonly removed: readonly string[];
  /** Cursor to continue from after this page; null when the provider has no cursor concept. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface BankProvider {
  readonly id: BankProviderId;
  describeItem(ctx: BankProviderContext): Promise<BankItemDescription>;
  /** All accounts of the item with their current balances. */
  listAccounts(ctx: BankProviderContext): Promise<NormalizedMoneyAccount[]>;
  /**
   * Pages of transaction changes from `cursor` (null = from the beginning).
   * Pull-based: the next page is fetched only when the consumer asks for it,
   * so a consumer that commits each page before pulling the next always
   * knows its last committed cursor.
   */
  syncTransactions(ctx: BankProviderContext, cursor: string | null): AsyncIterable<BankTransactionsPage>;
}

/**
 * Thrown by an adapter when the provider reports that the data set changed
 * underneath a pagination pass and the pass must be restarted from the last
 * committed cursor. Provider-neutral so `BankConnector` can handle it for any
 * adapter; Plaid raises the `PlaidMutationDuringPaginationError` subclass.
 */
export class BankPaginationMutationError extends Error {
  constructor(
    message: string,
    /** The cursor the adapter was paginating from when the provider rejected the pass. */
    readonly cursor: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BankPaginationMutationError";
  }
}
