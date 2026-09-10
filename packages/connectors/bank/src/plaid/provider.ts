/**
 * `PlaidBankProvider`: the Plaid adapter behind `BankProvider`.
 *
 * Credential kind: `access_token` (the Plaid access_token issued at link
 * time). The client id / secret pair is server configuration carried by the
 * `PlaidClient`, never by the credential.
 *
 * Pagination: `syncTransactions` is a plain pull-based pass over
 * `/transactions/sync`. When Plaid reports that the data changed mid-pass it
 * throws `PlaidMutationDuringPaginationError`; the adapter does not restart
 * on its own because only the consumer (`BankConnector`) knows which cursor
 * it has committed, and that is the cursor the restart must begin from.
 */
import { ConnectorError, type ConnectorCredential, type NormalizedMoneyAccount } from "@vixera/domain";
import type { BankItemDescription, BankProvider, BankProviderContext, BankTransactionsPage } from "../provider.ts";
import { DEFAULT_TRANSACTIONS_PAGE_SIZE, PlaidClient, type PlaidConfig } from "./client.ts";
import { normalizeAccount, normalizeTransaction } from "./normalize.ts";

export interface PlaidBankProviderOptions {
  readonly config: PlaidConfig;
  /** Transactions per `/transactions/sync` page. Default 500 (Plaid's maximum). */
  readonly pageSize?: number;
}

export class PlaidBankProvider implements BankProvider {
  readonly id = "plaid" as const;
  readonly #config: PlaidConfig;
  readonly #pageSize: number;

  constructor(options: PlaidBankProviderOptions) {
    this.#config = options.config;
    this.#pageSize = options.pageSize ?? DEFAULT_TRANSACTIONS_PAGE_SIZE;
  }

  client(ctx: BankProviderContext): PlaidClient {
    return new PlaidClient(ctx.fetch, this.#config);
  }

  async describeItem(ctx: BankProviderContext): Promise<BankItemDescription> {
    const token = accessTokenOf(ctx.credential);
    const { item } = await this.client(ctx).getItem(token);
    const institutionName = item.institution_name?.trim() || null;
    return {
      externalAccountId: item.item_id,
      label: institutionName ?? "Bank account",
      institutionName,
    };
  }

  async listAccounts(ctx: BankProviderContext): Promise<NormalizedMoneyAccount[]> {
    const token = accessTokenOf(ctx.credential);
    const res = await this.client(ctx).getAccounts(token);
    const context = { institutionName: res.item?.institution_name?.trim() || null, asOf: ctx.now().toISOString() };
    return res.accounts.map((a) => normalizeAccount(a, context));
  }

  async *syncTransactions(ctx: BankProviderContext, cursor: string | null): AsyncIterable<BankTransactionsPage> {
    const token = accessTokenOf(ctx.credential);
    const client = this.client(ctx);
    let current = cursor;
    let pages = 0;
    for (;;) {
      const res = await client.transactionsSync(token, current, this.#pageSize);
      pages += 1;
      ctx.log?.("plaid.transactions.page", { page: pages, added: res.added.length, modified: res.modified.length, removed: res.removed.length, hasMore: res.has_more });
      const page: BankTransactionsPage = {
        added: res.added.map(normalizeTransaction),
        modified: res.modified.map(normalizeTransaction),
        removed: res.removed.map((r) => r.transaction_id),
        nextCursor: res.next_cursor || null,
        hasMore: res.has_more,
      };
      yield page;
      if (!res.has_more) return;
      current = res.next_cursor;
    }
  }
}

export function accessTokenOf(credential: ConnectorCredential): string {
  if (credential.kind !== "access_token") {
    throw new ConnectorError("unsupported", `Plaid requires an access_token credential, got ${credential.kind}`, false);
  }
  if (!credential.accessToken) throw new ConnectorError("unauthorized", "Plaid access token is empty", false);
  return credential.accessToken;
}
