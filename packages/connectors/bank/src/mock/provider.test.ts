import { describe, expect, it } from "vitest";
import { BankPaginationMutationError, toProviderContext } from "../provider.ts";
import { collect, makeContext, noFetch } from "../testing/context.ts";
import { MOCK_CHECKING_ACCOUNT_ID, MOCK_ITEM_ID, MockBankProvider } from "./provider.ts";

const ctx = toProviderContext(makeContext(noFetch, { credential: { kind: "access_token", accessToken: "fake-token" } }));

describe("MockBankProvider", () => {
  it("is deterministic across instances and never touches the network", async () => {
    const a = new MockBankProvider();
    const b = new MockBankProvider();
    expect(await a.describeItem(ctx)).toEqual(await b.describeItem(ctx));
    expect(await a.listAccounts(ctx)).toEqual(await b.listAccounts(ctx));
    expect(await collect(a.syncTransactions(ctx, null))).toEqual(await collect(b.syncTransactions(ctx, null)));
    expect((await a.describeItem(ctx)).externalAccountId).toBe(MOCK_ITEM_ID);
  });

  it("ships the brief's fixtures: one USD checking account, the Northwind inflow and the Lindqvist outflow", async () => {
    const mock = new MockBankProvider();
    const accounts = await mock.listAccounts(ctx);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ externalId: MOCK_CHECKING_ACCOUNT_ID, type: "checking", currency: "USD", balanceCurrent: "18420.55", balanceAvailable: "18120.55" });
    const [page] = await collect(mock.syncTransactions(ctx, null));
    const northwind = page!.added.find((t) => t.merchantName === "Northwind Co.");
    const lindqvist = page!.added.find((t) => t.merchantName === "Lindqvist Studio");
    expect(northwind).toMatchObject({ amount: "12400.00", currency: "USD", accountExternalId: MOCK_CHECKING_ACCOUNT_ID });
    expect(lindqvist).toMatchObject({ amount: "-2400.00", currency: "USD" });
    expect(page!.added.every((t) => /^-?\d+\.\d{2}$/.test(t.amount))).toBe(true);
  });

  it("returns everything on the first sync and nothing afterwards until a hook appends a change", async () => {
    const mock = new MockBankProvider();
    const [first] = await collect(mock.syncTransactions(ctx, null));
    expect(first!.added).toHaveLength(4);
    expect(first!.hasMore).toBe(false);
    const cursor = first!.nextCursor!;
    expect(cursor).toBe(mock.latestCursor);

    const [again] = await collect(mock.syncTransactions(ctx, cursor));
    expect(again).toMatchObject({ added: [], modified: [], removed: [], nextCursor: cursor, hasMore: false });

    mock.addTransaction({ ...first!.added[0]!, externalId: "mock-txn-new", amount: "-42.00" }).removeTransaction("mock-txn-coffee-1");
    const [delta] = await collect(mock.syncTransactions(ctx, cursor));
    expect(delta!.added.map((t) => t.externalId)).toEqual(["mock-txn-new"]);
    expect(delta!.removed).toEqual(["mock-txn-coffee-1"]);
    expect(delta!.nextCursor).not.toBe(cursor);
    expect((await collect(mock.syncTransactions(ctx, delta!.nextCursor)))[0]!.added).toEqual([]);
  });

  it("pages when a page size is set", async () => {
    const mock = new MockBankProvider({ pageSize: 3 });
    const pages = await collect(mock.syncTransactions(ctx, null));
    expect(pages.map((p) => [p.added.length, p.hasMore, p.nextCursor])).toEqual([
      [3, true, "mock-cursor-3"],
      [1, false, "mock-cursor-4"],
    ]);
    await expect(collect(mock.syncTransactions(ctx, "not-a-cursor"))).rejects.toThrow(/unknown cursor/);
  });

  it("injects a configurable failure once", async () => {
    const mock = new MockBankProvider({ pageSize: 2 });
    mock.failNext({ method: "listAccounts", error: new Error("boom") });
    await expect(mock.listAccounts(ctx)).rejects.toThrow("boom");
    await expect(mock.listAccounts(ctx)).resolves.toHaveLength(1);

    mock.failNext({ method: "syncTransactions", error: new BankPaginationMutationError("mutated", null), afterPages: 1 });
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const p of mock.syncTransactions(ctx, null)) seen.push(p.added.length);
      })(),
    ).rejects.toBeInstanceOf(BankPaginationMutationError);
    expect(seen).toEqual([2]);
    expect(mock.calls.filter((c) => c.method === "syncTransactions")).toHaveLength(1);
  });
});
