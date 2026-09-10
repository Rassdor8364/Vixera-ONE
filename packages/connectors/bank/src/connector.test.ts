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
    expect(pages).toHaveLength(2);

    const [first, second] = pages as [SyncPage<BankSyncBatch>, SyncPage<BankSyncBatch>];
    expect(first.batch.accounts.map((a) => a.externalId)).toEqual(accountsFixture.accounts.map((a) => a.account_id));
    expect(first.batch.transactions.map((t) => [t.externalId, t.amount])).toEqual([
      ["fake-txn-northwind", "12400.00"],
      ["fake-txn-lindqvist", "-2400.00"],
      ["fake-txn-coffee-pending", "-6.40"],
    ]);
    expect(first.batch.deleted).toEqual([]);
    expect(first.checkpoint).toEqual({ cursor: "fake-cursor-page-1" });
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

  it("restarts from the last committed cursor when Plaid reports a mutation during pagination", async () => {
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

    expect(pages).toHaveLength(2);
    expect(applied).toEqual(["fake-cursor-page-1", "fake-cursor-page-2"]);
    const cursors = ff.callsTo("/transactions/sync").map((c) => (JSON.parse(c.body ?? "{}") as { cursor?: string }).cursor ?? null);
    // page 1, failed page 2, page 2 again from the cursor the engine had persisted — not from scratch.
    expect(cursors).toEqual([null, "fake-cursor-page-1", "fake-cursor-page-1"]);
    expect(pages[0]!.batch.accounts).toHaveLength(6);
    expect(pages[1]!.batch.accounts).toEqual([]);
    expect(pages[1]!.batch.deleted).toEqual([{ externalId: "fake-txn-coffee-pending" }]);
    expect(ctx.logs.find((l) => l.message === "bank.sync.restart")?.data).toMatchObject({ attempt: 1, cursor: "fake-cursor-page-1", pagesBeforeRestart: 1 });
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

  it("with the mock provider, the committed cursor only moves after a page was consumed", async () => {
    const mock = new MockBankProvider({ pageSize: 2 });
    mock.failNext({ method: "syncTransactions", error: new BankPaginationMutationError("mutated", null), afterPages: 1 });
    const connector = new BankConnector(mock);
    const account: ConnectorAccount = { ...FAKE_ACCOUNT, provider: "mock", externalAccountId: "mock-item-1" };
    const ctx = makeContext(noFetch, { account, credential: { kind: "access_token", accessToken: "fake-token" } });

    const pages = await collect(connector.syncBank(ctx, null));
    expect(mock.calls.filter((c) => c.method === "syncTransactions").map((c) => c.cursor)).toEqual([null, "mock-cursor-2"]);
    expect(pages.map((p) => [p.batch.accounts.length, p.batch.transactions.length, readBankCheckpoint(p.checkpoint), p.done])).toEqual([
      [1, 2, "mock-cursor-2", false],
      [0, 2, "mock-cursor-4", true],
    ]);

    // Second cycle from the persisted checkpoint: accounts refreshed, no transactions, done.
    const next = await collect(connector.syncBank(ctx, pages[1]!.checkpoint));
    expect(next).toHaveLength(1);
    expect(next[0]!.batch).toEqual({ accounts: await mock.listAccounts(ctx), transactions: [], deleted: [] });
    expect(next[0]!.done).toBe(true);
  });
});
