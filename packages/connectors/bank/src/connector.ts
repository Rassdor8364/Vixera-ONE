/**
 * `BankConnector`: the domain `Connector` (capability "bank") over any
 * `BankProvider`. Stateless across accounts — one instance serves every
 * linked bank item of its provider.
 *
 * Sync shape (`syncBank`):
 *   - page 1 carries the item's accounts (always refreshed, balances
 *     included) plus the first page of transaction changes;
 *   - following pages carry transaction changes only;
 *   - `removed` ids become `batch.deleted`; `modified` are upserted like
 *     `added` (natural key = external id).
 *
 * Checkpoint: `{ cursor }`. Each page's `checkpoint` is the cursor to persist
 * once that page is applied. The connector's own notion of "committed cursor"
 * advances only after the page has been yielded and the consumer asked for
 * the next one, so a restart after `BankPaginationMutationError` begins at
 * exactly the cursor the engine persisted (max 3 attempts, then a
 * `ConnectorError("unknown")`).
 *
 * There is no write path. `Connector` has none, `BankProvider` has none.
 */
import type { BankSyncBatch, Checkpoint, Connector, ConnectorCapability, DiscoveredAccount, JsonObject, NormalizedMoneyTransaction, ProviderId, SyncContext, SyncPage } from "@vixera/domain";
import { ConnectorError } from "@vixera/domain";
import { BankPaginationMutationError, toProviderContext, type BankProvider, type BankTransactionsPage } from "./provider.ts";

export interface BankCheckpoint extends JsonObject {
  readonly cursor: string;
}

export interface BankConnectorOptions {
  /** Attempts at one pagination pass before giving up on a provider mutation error. Default 3. */
  readonly maxAttempts?: number;
}

export const BANK_CAPABILITIES: readonly ConnectorCapability[] = ["bank"];

export function readBankCheckpoint(checkpoint: Checkpoint | null): string | null {
  const cursor = checkpoint?.cursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

export class BankConnector implements Connector {
  readonly provider: ProviderId;
  readonly capabilities: readonly ConnectorCapability[] = BANK_CAPABILITIES;
  readonly #bank: BankProvider;
  readonly #maxAttempts: number;

  constructor(provider: BankProvider, options: BankConnectorOptions = {}) {
    this.#bank = provider;
    this.provider = provider.id;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  }

  async discoverAccount(ctx: Omit<SyncContext, "account">): Promise<DiscoveredAccount> {
    const item = await this.#bank.describeItem(toProviderContext(ctx));
    return {
      externalAccountId: item.externalAccountId,
      label: item.label,
      address: null,
      capabilities: this.capabilities,
      metadata: { institutionName: item.institutionName, bankProvider: this.#bank.id },
    };
  }

  async *syncBank(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<BankSyncBatch>> {
    const pctx = toProviderContext(ctx);
    const accounts = await this.#bank.listAccounts(pctx);
    let committedCursor = readBankCheckpoint(checkpoint);
    let first = true;
    let attempt = 0;

    for (;;) {
      attempt += 1;
      const startCursor = committedCursor;
      let pagesThisAttempt = 0;
      try {
        for await (const page of this.#bank.syncTransactions(pctx, startCursor)) {
          pagesThisAttempt += 1;
          const out: SyncPage<BankSyncBatch> = {
            batch: {
              accounts: first ? accounts : [],
              transactions: mergeTransactions(page),
              deleted: page.removed.map((externalId) => ({ externalId })),
            },
            checkpoint: page.nextCursor ? { cursor: page.nextCursor } : null,
            done: !page.hasMore,
          };
          first = false;
          yield out;
          // The consumer has applied and persisted this page; only now is its cursor "committed".
          if (page.nextCursor) committedCursor = page.nextCursor;
          if (!page.hasMore) return;
        }
        if (first) {
          // Provider yielded nothing at all: still refresh accounts once.
          yield { batch: { accounts, transactions: [], deleted: [] }, checkpoint: null, done: true };
        }
        return;
      } catch (err) {
        if (!(err instanceof BankPaginationMutationError)) throw err;
        ctx.log?.("bank.sync.restart", { provider: this.#bank.id, attempt, pagesBeforeRestart: pagesThisAttempt, cursor: committedCursor });
        if (attempt >= this.#maxAttempts) {
          throw new ConnectorError("unknown", `Bank transactions kept changing during pagination after ${attempt} attempts`, false, { cause: err });
        }
      }
    }
  }
}

function mergeTransactions(page: BankTransactionsPage): readonly NormalizedMoneyTransaction[] {
  if (page.modified.length === 0) return page.added;
  // Same external id in both lists (unusual): the modified version wins.
  const byId = new Map<string, NormalizedMoneyTransaction>();
  for (const t of page.added) byId.set(t.externalId, t);
  for (const t of page.modified) byId.set(t.externalId, t);
  return [...byId.values()];
}
