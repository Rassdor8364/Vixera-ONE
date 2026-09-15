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
 * Checkpoint: `{ cursor }`, and only a cursor the provider guarantees. Plaid's
 * `/transactions/sync` contract: an update is the whole run of pages up to
 * `has_more: false`; only that final `next_cursor` is durable, and a failure
 * mid-update (`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`) means the whole
 * update must be requested again from the cursor it began with. So:
 *   - intermediate pages (`hasMore`) echo the checkpoint the pass started
 *     from (the engine treats an unchanged checkpoint as "no resume point");
 *   - the final page carries the new cursor; an empty one (Plaid's "initial
 *     update not ready") keeps the previous checkpoint;
 *   - a `BankPaginationMutationError` restarts the pass from that same
 *     starting cursor, never from an intra-pass cursor (max 3 attempts, then
 *     a `ConnectorError("unknown")`). Replayed pages are idempotent by
 *     natural key, so applying page 1 twice is harmless.
 * A run the engine stops mid-update (time budget) therefore restarts the
 * update next time instead of resuming from a cursor Plaid may have discarded.
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
  /** /transactions/sync keeps only the cursor of a completed update: a pass cannot resume mid-way. */
  readonly nonResumable: readonly ConnectorCapability[] = BANK_CAPABILITIES;
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
    // The only cursor with a guarantee behind it: the one the previous update ended with.
    const startCursor = readBankCheckpoint(checkpoint);
    const startCheckpoint: BankCheckpoint | null = startCursor ? { cursor: startCursor } : null;
    let first = true;
    let attempt = 0;

    for (;;) {
      attempt += 1;
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
            // Intermediate cursors are not resume points: echo the starting checkpoint until the update completes.
            checkpoint: !page.hasMore && page.nextCursor ? { cursor: page.nextCursor } : startCheckpoint,
            done: !page.hasMore,
            // From a null cursor Plaid lists everything it has: the pass covers the whole account.
            ...(startCursor === null ? { resyncScope: { kind: "all" as const } } : {}),
          };
          first = false;
          yield out;
          if (!page.hasMore) return;
        }
        if (first) {
          // Provider yielded nothing at all: still refresh accounts once.
          yield { batch: { accounts, transactions: [], deleted: [] }, checkpoint: startCheckpoint, done: true, ...(startCursor === null ? { resyncScope: { kind: "all" as const } } : {}) };
        }
        return;
      } catch (err) {
        if (!(err instanceof BankPaginationMutationError)) throw err;
        ctx.log?.("bank.sync.restart", { provider: this.#bank.id, attempt, pagesBeforeRestart: pagesThisAttempt, cursor: startCursor });
        if (attempt >= this.#maxAttempts) {
          throw new ConnectorError("unknown", `Bank transactions kept changing during pagination after ${attempt} attempts`, false, { cause: err });
        }
      }
    }
  }
}

function mergeTransactions(page: BankTransactionsPage): readonly NormalizedMoneyTransaction[] {
  if (page.modified.length === 0 && page.removed.length === 0) return page.added;
  // Same external id in both lists (unusual): the modified version wins.
  const byId = new Map<string, NormalizedMoneyTransaction>();
  for (const t of page.added) byId.set(t.externalId, t);
  for (const t of page.modified) byId.set(t.externalId, t);
  // Plaid does not promise `removed` is disjoint from the other two. A removal is the
  // later fact, so the id leaves the upsert list: the outcome no longer depends on
  // whether the consumer applies upserts or deletions first.
  for (const externalId of page.removed) byId.delete(externalId);
  return [...byId.values()];
}
