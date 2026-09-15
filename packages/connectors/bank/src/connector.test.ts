import type { BankSyncBatch, Connector, ConnectorAccount, SyncPage } from "@vixera/domain";
import { ConnectorError, ConnectorRegistry, supports } from "@vixera/domain";
import { describe, expect, it } from "vitest";
import accountsFixture from "./__fixtures__/plaid-accounts.json";
import itemFixture from "./__fixtures__/plaid-item.json";
import page1 from "./__fixtures__/plaid-transactions-sync-page1.json";
import page2 from "./__fixtures__/plaid-transactions-sync-page2.json";
import { BankConnector, readBankCheckpoint } from "./connector.ts";
import { MockBankProvider } from "./mock/provider.ts";
import { PlaidBankProvider } from "./plaid/provider.ts";
import { BankPaginationMutationError } from "./provider.ts";
import { FAKE_ACCOUNT, FAKE_PLAID_CONFIG, collect, makeContext, noFetch } from "./testing/context.ts";
import { createFakeFetch, type FakeReply, type FakeRequest } from "./testing/fake-fetch.ts";

const MUTATION: FakeReply = { status: 400, json: { error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", request_id: "req-fake-mut" } };

function plaidRoutes(syncReply: (req: FakeRequest, cursor: string | null) => FakeReply) {
  return createFakeFetch([
    { match: "/item/get", reply: { json: itemFixture } },
    { match: "/accounts/get", reply: { json: accountsFixture } },
    { match: "/transactions/sync", reply: (req) => syncReply(req, (JSON.parse(req.call.body ?? "{}") as { cursor?: string }).cursor ?? null) },
  ]);
}

const happyPath = (_req: FakeRequest, cursor: string | null): FakeReply =>
  cursor === null ? { json: page1 } : cursor === "fake-cursor-page-1" ? { json: page2 } : { json: { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false } };

const plaidConnector = () => new BankConnector(new PlaidBankProvider({ config: FAKE_PLAID_CONFIG }));

const syncBody = (added: unknown[], next_cursor: string, has_more: boolean) => ({ added, modified: [], removed: [], next_cursor, has_more });

/**
 * A three-page update starting from `start` (null = first sync): the cursors
 * are c1 → c2 → c3, one of page1's transactions per page, and c3 is the only
 * cursor Plaid guarantees (has_more: false).
 */
const threePages =
  (start: string | null) =>
  (_req: FakeRequest, cursor: string | null): FakeReply => {
    const [t1, t2, t3] = page1.added;
    if (cursor === start) return { json: syncBody([t1], "c1", true) };
    if (cursor === "c1") return { json: syncBody([t2], "c2", true) };
    if (cursor === "c2") return { json: syncBody([t3], "c3", false) };
    return { json: syncBody([], cursor ?? "", false) };
  };

const sentCursors = (ff: ReturnType<typeof createFakeFetch>) => ff.callsTo("/transactions/sync").map((c) => (JSON.parse(c.body ?? "{}") as { cursor?: string }).cursor ?? null);

/** Drains pages the way the engine does: each page is "applied" before the next is pulled. */
async function drain(pages: AsyncIterable<SyncPage<BankSyncBatch>>, onPage?: (p: SyncPage<BankSyncBatch>) => void) {
  const out: SyncPage<BankSyncBatch>[] = [];
  for await (const p of pages) {
    onPage?.(p);
    out.push(p);
  }
  return out;
}

describe("BankConnector", () => {
  it("is a bank-capability Connector whose provider id comes from the adapter", () => {
    const plaid = plaidConnector();
    const mock = new BankConnector(new MockBankProvider());
    expect(plaid.provider).toBe("plaid");
    expect(mock.provider).toBe("mock");
    expect(plaid.capabilities).toEqual(["bank"]);
    expect(supports(plaid, "bank")).toBe(true);
    expect(supports(plaid, "mail")).toBe(false);
    const asConnector: Connector = plaid;
    expect(asConnector.syncMail).toBeUndefined();
    expect(asConnector.syncCalendar).toBeUndefined();
    expect(asConnector.refreshCredential).toBeUndefined();
    const registry = new ConnectorRegistry().register(plaid).register(mock);
    expect(registry.providers().sort()).toEqual(["mock", "plaid"]);
  });

  it("discovers the account from the item without inventing an address or a user id", async () => {
    const ff = plaidRoutes(happyPath);
    const { account: _drop, ...ctx } = makeContext(ff.fetch);
    const discovered = await plaidConnector().discoverAccount(ctx);
    expect(discovered).toEqual({
      externalAccountId: "fake-item-id-1",
      label: "Example Bank",
      address: null,
      capabilities: ["bank"],
      metadata: { institutionName: "Example Bank", bankProvider: "plaid" },
    });
    expect(JSON.stringify(discovered)).not.toMatch(/user/i);
  });

  it("yields accounts on the first page only, transactions on every page, removed ids as deletions", async () => {
    const ff = plaidRoutes(happyPath);
    const ctx = makeContext(ff.fetch);
    const pages = await drain(plaidConnector().syncBank(ctx, null));
    // a pass from no cursor is a complete listing: every page declares the whole account as its reconciliation scope
    expect(pages.map((p) => p.resyncScope)).toEqual([{ kind: "all" }, { kind: "all" }]);
    expect(pages).toHaveLength(2);

    const [first, second] = pages as [SyncPage<BankSyncBatch>, SyncPage<BankSyncBatch>];
    expect(first.batch.accounts.map((a) => a.externalId)).toEqual(accountsFixture.accounts.map((a) => a.account_id));
    expect(first.batch.transactions.map((t) => [t.externalId, t.amount])).toEqual([
      ["fake-txn-northwind", "12400.00"],
      ["fake-txn-lindqvist", "-2400.00"],
      ["fake-txn-coffee-pending", "-6.40"],
    ]);
    expect(first.batch.deleted).toEqual([]);
    // has_more: true — Plaid guarantees nothing about this cursor, so it is not a resume point.
    expect(first.checkpoint).toBeNull();
    expect(first.done).toBe(false);

    expect(second.batch.accounts).toEqual([]);
    expect(second.batch.transactions.map((t) => [t.externalId, t.description])).toEqual([
      ["fake-txn-coffee-posted", "KAFFE CENTRAL"],
      ["fake-txn-lindqvist", "LINDQVIST STUDIO AB"],
    ]);
    expect(second.batch.deleted).toEqual([{ externalId: "fake-txn-coffee-pending" }]);
    expect(second.checkpoint).toEqual({ cursor: "fake-cursor-page-2" });
    expect(second.done).toBe(true);

    expect(ff.callsTo("/accounts/get")).toHaveLength(1);
    expect(ff.callsTo("/transactions/sync")).toHaveLength(2);
    expect(JSON.stringify(ctx.logs)).not.toContain(FAKE_PLAID_CONFIG.secret);
    expect(JSON.stringify(ctx.logs)).not.toContain(ctx.credential.kind === "access_token" ? ctx.credential.accessToken : "");
  });

  it("resumes from the persisted checkpoint and still refreshes accounts", async () => {
    const ff = plaidRoutes(happyPath);
    const pages = await drain(plaidConnector().syncBank(makeContext(ff.fetch), { cursor: "fake-cursor-page-2" }));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.batch.accounts).toHaveLength(6);
    expect(pages[0]!.batch.transactions).toEqual([]);
    expect(pages[0]!.checkpoint).toEqual({ cursor: "fake-cursor-page-2" });
    expect(pages[0]!.done).toBe(true);
    expect(JSON.parse(ff.callsTo("/transactions/sync")[0]!.body ?? "{}")).toMatchObject({ cursor: "fake-cursor-page-2" });
    expect(readBankCheckpoint(null)).toBeNull();
    expect(readBankCheckpoint({ cursor: "" })).toBeNull();
    expect(readBankCheckpoint({ other: 1 })).toBeNull();
  });

  it("commits a cursor only after has_more is false; intermediate pages echo the cursor the pass started from", async () => {
    const fresh = plaidRoutes(threePages(null));
    const pages = await drain(plaidConnector().syncBank(makeContext(fresh.fetch), null));
    expect(pages.map((p) => p.checkpoint)).toEqual([null, null, { cursor: "c3" }]);
    expect(pages.map((p) => p.done)).toEqual([false, false, true]);
    expect(pages.map((p) => p.batch.transactions.map((t) => t.externalId))).toEqual([["fake-txn-northwind"], ["fake-txn-lindqvist"], ["fake-txn-coffee-pending"]]);
    expect(sentCursors(fresh)).toEqual([null, "c1", "c2"]);

    // Resuming from a persisted cursor: that cursor stays the checkpoint until the update completes.
    const resumed = plaidRoutes(threePages("c0"));
    const later = await drain(plaidConnector().syncBank(makeContext(resumed.fetch), { cursor: "c0" }));
    expect(later.map((p) => p.checkpoint)).toEqual([{ cursor: "c0" }, { cursor: "c0" }, { cursor: "c3" }]);
    expect(later.every((p) => p.resyncScope === undefined)).toBe(true); // an update from a cursor is not a listing
    expect(sentCursors(resumed)).toEqual(["c0", "c1", "c2"]);
  });

  it("restarts the whole update from the cursor the pass started with when Plaid reports a mutation during pagination", async () => {
    let mutations = 0;
    const ff = plaidRoutes((req, cursor) => {
      if (cursor === "fake-cursor-page-1" && mutations === 0) {
        mutations += 1;
        return MUTATION;
      }
      return happyPath(req, cursor);
    });
    const ctx = makeContext(ff.fetch);
    const applied: (string | null)[] = [];
    const pages = await drain(plaidConnector().syncBank(ctx, null), (p) => applied.push(readBankCheckpoint(p.checkpoint)));

    // page 1, failed page 2, then the update again from its first cursor (null): page 1 replayed, page 2.
    expect(sentCursors(ff)).toEqual([null, "fake-cursor-page-1", null, "fake-cursor-page-1"]);
    expect(pages).toHaveLength(3);
    expect(applied).toEqual([null, null, "fake-cursor-page-2"]);
    expect(pages[0]!.batch.accounts).toHaveLength(6);
    expect(pages[1]!.batch.accounts).toEqual([]);
    expect(pages[1]!.batch.transactions.map((t) => t.externalId)).toEqual(pages[0]!.batch.transactions.map((t) => t.externalId));
    expect(pages[2]!.batch.deleted).toEqual([{ externalId: "fake-txn-coffee-pending" }]);
    expect(pages[2]!.done).toBe(true);
    expect(ctx.logs.find((l) => l.message === "bank.sync.restart")?.data).toMatchObject({ attempt: 1, cursor: null, pagesBeforeRestart: 1 });
  });

  it("restarts from the persisted cursor, never from an intermediate one, on every mutation of the pass", async () => {
    const mutated = new Set<string>();
    const ff = plaidRoutes((req, cursor) => {
      if ((cursor === "c1" || cursor === "c2") && !mutated.has(cursor)) {
        mutated.add(cursor);
        return MUTATION;
      }
      return threePages("c0")(req, cursor);
    });
    const ctx = makeContext(ff.fetch);
    const pages = await drain(plaidConnector().syncBank(ctx, { cursor: "c0" }));
    // attempt 1: c0 ok, c1 mutated; attempt 2: c0, c1 ok, c2 mutated; attempt 3: c0, c1, c2 done.
    expect(sentCursors(ff)).toEqual(["c0", "c1", "c0", "c1", "c2", "c0", "c1", "c2"]);
    expect(pages.map((p) => p.checkpoint)).toEqual([{ cursor: "c0" }, { cursor: "c0" }, { cursor: "c0" }, { cursor: "c0" }, { cursor: "c0" }, { cursor: "c3" }]);
    expect(pages.filter((p) => p.done)).toHaveLength(1);
    expect(ctx.logs.filter((l) => l.message === "bank.sync.restart").map((l) => l.data?.cursor)).toEqual(["c0", "c0"]);
  });

  it("an id in both added/modified and removed of one page ends up deleted, whatever order the consumer applies", async () => {
    const [northwind, lindqvist] = page1.added;
    const ff = plaidRoutes(() => ({
      json: { added: [northwind, lindqvist], modified: [{ ...lindqvist, name: "LINDQVIST STUDIO AB" }], removed: [{ transaction_id: lindqvist!.transaction_id }], next_cursor: "c1", has_more: false },
    }));
    const [page] = await drain(plaidConnector().syncBank(makeContext(ff.fetch), null));
    expect(page!.batch.transactions.map((t) => t.externalId)).toEqual(["fake-txn-northwind"]);
    expect(page!.batch.deleted).toEqual([{ externalId: "fake-txn-lindqvist" }]);
  });

  it("keeps the previous checkpoint when Plaid answers with an empty next_cursor (initial update not ready)", async () => {
    const ff = plaidRoutes(() => ({ json: syncBody([], "", false) }));
    const fresh = await drain(plaidConnector().syncBank(makeContext(ff.fetch), null));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ checkpoint: null, done: true });
    expect(fresh[0]!.batch.accounts).toHaveLength(6);
    expect(fresh[0]!.batch.transactions).toEqual([]);

    const resumed = await drain(plaidConnector().syncBank(makeContext(ff.fetch), { cursor: "c0" }));
    expect(resumed[0]!.checkpoint).toEqual({ cursor: "c0" });
  });

  it("gives up after three attempts with a non-retryable unknown ConnectorError", async () => {
    const ff = plaidRoutes(() => MUTATION);
    const err = await drain(plaidConnector().syncBank(makeContext(ff.fetch), { cursor: "c0" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ code: "unknown", retryable: false });
    expect((err as ConnectorError).cause).toBeInstanceOf(BankPaginationMutationError);
    expect(ff.callsTo("/transactions/sync")).toHaveLength(3);
    expect(ff.callsTo("/transactions/sync").every((c) => (JSON.parse(c.body ?? "{}") as { cursor?: string }).cursor === "c0")).toBe(true);
  });

  it("honours maxAttempts and passes other errors straight through", async () => {
    const ff = plaidRoutes(() => MUTATION);
    await expect(drain(new BankConnector(new PlaidBankProvider({ config: FAKE_PLAID_CONFIG }), { maxAttempts: 1 }).syncBank(makeContext(ff.fetch), null))).rejects.toMatchObject({ code: "unknown" });
    expect(ff.callsTo("/transactions/sync")).toHaveLength(1);

    const unauthorized = plaidRoutes(() => ({ status: 400, json: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" } }));
    await expect(drain(plaidConnector().syncBank(makeContext(unauthorized.fetch), null))).rejects.toMatchObject({ code: "unauthorized", retryable: false });
    expect(unauthorized.callsTo("/transactions/sync")).toHaveLength(1);
  });

  it("with the mock provider, a mutation mid-pass replays the pass and only the final page carries a cursor", async () => {
    const mock = new MockBankProvider({ pageSize: 2 });
    mock.failNext({ method: "syncTransactions", error: new BankPaginationMutationError("mutated", null), afterPages: 1 });
    const connector = new BankConnector(mock);
    const account: ConnectorAccount = { ...FAKE_ACCOUNT, provider: "mock", externalAccountId: "mock-item-1" };
    const ctx = makeContext(noFetch, { account, credential: { kind: "access_token", accessToken: "fake-token" } });

    const pages = await collect(connector.syncBank(ctx, null));
    expect(mock.calls.filter((c) => c.method === "syncTransactions").map((c) => c.cursor)).toEqual([null, null]);
    expect(pages.map((p) => [p.batch.accounts.length, p.batch.transactions.length, readBankCheckpoint(p.checkpoint), p.done])).toEqual([
      [1, 2, null, false],
      [0, 2, null, false],
      [0, 2, "mock-cursor-4", true],
    ]);

    // Second cycle from the persisted checkpoint: accounts refreshed, no transactions, cursor echoed, done.
    const next = await collect(connector.syncBank(ctx, pages[2]!.checkpoint));
    expect(next).toHaveLength(1);
    expect(next[0]!.batch).toEqual({ accounts: await mock.listAccounts(ctx), transactions: [], deleted: [] });
    expect(next[0]!.checkpoint).toEqual({ cursor: "mock-cursor-4" });
    expect(next[0]!.done).toBe(true);
  });
});
