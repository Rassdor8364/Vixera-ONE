/**
 * `MockBankProvider`: deterministic, in-memory `BankProvider` for development
 * and tests. No network, no credential validation.
 *
 * Fixtures: one USD checking account with balances and a handful of
 * transactions, including a 12400.00 inflow from Northwind Co. and a
 * -2400.00 outflow to Lindqvist Studio (the invoice story from the brief).
 *
 * Cursor semantics mirror a real aggregator: the change log is an ordered
 * list; a cursor is a position in it. The first sync (cursor null) returns
 * everything; later syncs return only what was appended after the cursor,
 * which is nothing until a test hook (`addTransaction`, `removeTransaction`,
 * `modifyTransaction`) appends to the log. `pageSize` splits the log into
 * pages so multi-page behaviour can be exercised.
 *
 * Failure injection: `failNext()` makes the next call of one method throw a
 * given error, optionally after it has already yielded some pages.
 */
import type { NormalizedMoneyAccount, NormalizedMoneyTransaction } from "@vixera/domain";
import type { BankItemDescription, BankProvider, BankProviderContext, BankTransactionsPage } from "../provider.ts";

export const MOCK_ITEM_ID = "mock-item-1";
export const MOCK_CHECKING_ACCOUNT_ID = "mock-acct-checking-1";
export const MOCK_INSTITUTION_NAME = "Mock Bank";

export const MOCK_ACCOUNTS: readonly NormalizedMoneyAccount[] = [
  {
    externalId: MOCK_CHECKING_ACCOUNT_ID,
    name: "Everyday Checking",
    officialName: "Mock Bank Everyday Checking",
    type: "checking",
    currency: "USD",
    balanceCurrent: "18420.55",
    balanceAvailable: "18120.55",
    balanceAsOf: "2026-09-10T06:00:00.000Z",
    mask: "4821",
    metadata: { subtype: "checking", institution: MOCK_INSTITUTION_NAME },
  },
];

export const MOCK_TRANSACTIONS: readonly NormalizedMoneyTransaction[] = [
  {
    externalId: "mock-txn-northwind-1",
    accountExternalId: MOCK_CHECKING_ACCOUNT_ID,
    amount: "12400.00",
    currency: "USD",
    description: "NORTHWIND CO INVOICE 2026-041",
    merchantName: "Northwind Co.",
    postedOn: "2026-09-08",
    authorizedAt: "2026-09-08T09:12:00.000Z",
    pending: false,
    category: ["INCOME", "INCOME_OTHER_INCOME"],
    metadata: { payment_channel: "other", pending_transaction_id: null },
  },
  {
    externalId: "mock-txn-lindqvist-1",
    accountExternalId: MOCK_CHECKING_ACCOUNT_ID,
    amount: "-2400.00",
    currency: "USD",
    description: "LINDQVIST STUDIO",
    merchantName: "Lindqvist Studio",
    postedOn: "2026-09-09",
    authorizedAt: "2026-09-09T14:30:00.000Z",
    pending: false,
    category: ["GENERAL_SERVICES", "GENERAL_SERVICES_CONSULTING_AND_LEGAL"],
    metadata: { payment_channel: "online", pending_transaction_id: null },
  },
  {
    externalId: "mock-txn-rent-1",
    accountExternalId: MOCK_CHECKING_ACCOUNT_ID,
    amount: "-1850.00",
    currency: "USD",
    description: "RENT SEPTEMBER",
    merchantName: null,
    postedOn: "2026-09-01",
    authorizedAt: null,
    pending: false,
    category: ["RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT"],
    metadata: { payment_channel: "other", pending_transaction_id: null },
  },
  {
    externalId: "mock-txn-coffee-1",
    accountExternalId: MOCK_CHECKING_ACCOUNT_ID,
    amount: "-6.40",
    currency: "USD",
    description: "KAFFE CENTRAL",
    merchantName: "Kaffe Central",
    postedOn: "2026-09-10",
    authorizedAt: "2026-09-10T07:41:00.000Z",
    pending: true,
    category: ["FOOD_AND_DRINK", "FOOD_AND_DRINK_COFFEE"],
    metadata: { payment_channel: "in store", pending_transaction_id: null },
  },
];

export type MockBankMethod = "describeItem" | "listAccounts" | "syncTransactions";

export interface MockFailure {
  readonly method: MockBankMethod;
  readonly error: Error;
  /** For `syncTransactions`: throw after this many pages have been yielded (default 0 = before the first). */
  readonly afterPages?: number;
}

export interface MockBankProviderOptions {
  /** Transactions per page. Default: everything in one page. */
  readonly pageSize?: number;
  readonly accounts?: readonly NormalizedMoneyAccount[];
  readonly transactions?: readonly NormalizedMoneyTransaction[];
}

type LogEntry =
  | { readonly kind: "added"; readonly txn: NormalizedMoneyTransaction }
  | { readonly kind: "modified"; readonly txn: NormalizedMoneyTransaction }
  | { readonly kind: "removed"; readonly externalId: string };

const CURSOR_PREFIX = "mock-cursor-";

export class MockBankProvider implements BankProvider {
  readonly id = "mock" as const;
  readonly #accounts: NormalizedMoneyAccount[];
  readonly #log: LogEntry[] = [];
  readonly #pageSize: number;
  #failure: MockFailure | null = null;
  readonly calls: { method: MockBankMethod; cursor?: string | null }[] = [];

  constructor(options: MockBankProviderOptions = {}) {
    this.#accounts = [...(options.accounts ?? MOCK_ACCOUNTS)];
    this.#pageSize = options.pageSize ?? Number.POSITIVE_INFINITY;
    for (const txn of options.transactions ?? MOCK_TRANSACTIONS) this.#log.push({ kind: "added", txn });
  }

  // -- test hooks ----------------------------------------------------------

  /** Appends a new transaction to the change log; the next sync from the current cursor returns it. */
  addTransaction(txn: NormalizedMoneyTransaction): this {
    this.#log.push({ kind: "added", txn });
    return this;
  }

  modifyTransaction(txn: NormalizedMoneyTransaction): this {
    this.#log.push({ kind: "modified", txn });
    return this;
  }

  removeTransaction(externalId: string): this {
    this.#log.push({ kind: "removed", externalId });
    return this;
  }

  setBalances(externalId: string, balances: { current: string | null; available: string | null; asOf: string }): this {
    const i = this.#accounts.findIndex((a) => a.externalId === externalId);
    const existing = this.#accounts[i];
    if (i < 0 || !existing) throw new Error(`mock account not found: ${externalId}`);
    this.#accounts[i] = { ...existing, balanceCurrent: balances.current, balanceAvailable: balances.available, balanceAsOf: balances.asOf };
    return this;
  }

  /** The next call of `failure.method` throws `failure.error` (once). */
  failNext(failure: MockFailure): this {
    this.#failure = failure;
    return this;
  }

  /** Cursor that points at the end of the current change log. */
  get latestCursor(): string {
    return `${CURSOR_PREFIX}${this.#log.length}`;
  }

  // -- BankProvider ----------------------------------------------------------

  async describeItem(_ctx: BankProviderContext): Promise<BankItemDescription> {
    this.calls.push({ method: "describeItem" });
    this.#maybeFail("describeItem");
    return { externalAccountId: MOCK_ITEM_ID, label: MOCK_INSTITUTION_NAME, institutionName: MOCK_INSTITUTION_NAME };
  }

  async listAccounts(_ctx: BankProviderContext): Promise<NormalizedMoneyAccount[]> {
    this.calls.push({ method: "listAccounts" });
    this.#maybeFail("listAccounts");
    return this.#accounts.map((a) => structuredClone(a));
  }

  async *syncTransactions(_ctx: BankProviderContext, cursor: string | null): AsyncIterable<BankTransactionsPage> {
    this.calls.push({ method: "syncTransactions", cursor });
    const failure = this.#takeFailure("syncTransactions");
    if (failure && (failure.afterPages ?? 0) === 0) throw failure.error;
    let position = parseCursor(cursor);
    let yielded = 0;
    do {
      const end = Math.min(this.#log.length, position + this.#pageSize);
      const slice = this.#log.slice(position, end);
      const page: BankTransactionsPage = {
        added: slice.filter((e): e is Extract<LogEntry, { kind: "added" }> => e.kind === "added").map((e) => structuredClone(e.txn)),
        modified: slice.filter((e): e is Extract<LogEntry, { kind: "modified" }> => e.kind === "modified").map((e) => structuredClone(e.txn)),
        removed: slice.filter((e): e is Extract<LogEntry, { kind: "removed" }> => e.kind === "removed").map((e) => e.externalId),
        nextCursor: `${CURSOR_PREFIX}${end}`,
        hasMore: end < this.#log.length,
      };
      yield page;
      yielded += 1;
      if (failure && yielded >= (failure.afterPages ?? 0)) throw failure.error;
      position = end;
    } while (position < this.#log.length);
  }

  #maybeFail(method: MockBankMethod): void {
    const failure = this.#takeFailure(method);
    if (failure) throw failure.error;
  }

  #takeFailure(method: MockBankMethod): MockFailure | null {
    if (this.#failure?.method !== method) return null;
    const failure = this.#failure;
    this.#failure = null;
    return failure;
  }
}

function parseCursor(cursor: string | null): number {
  if (cursor === null || cursor === "") return 0;
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new Error(`mock bank: unknown cursor ${cursor}`);
  const n = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isInteger(n) || n < 0) throw new Error(`mock bank: unknown cursor ${cursor}`);
  return n;
}
