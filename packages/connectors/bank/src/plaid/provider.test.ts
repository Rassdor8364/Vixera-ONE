import { describe, expect, it } from "vitest";
import accountsFixture from "../__fixtures__/plaid-accounts.json";
import itemFixture from "../__fixtures__/plaid-item.json";
import page1 from "../__fixtures__/plaid-transactions-sync-page1.json";
import page2 from "../__fixtures__/plaid-transactions-sync-page2.json";
import { toProviderContext } from "../provider.ts";
import { FAKE_PLAID_CONFIG, collect, makeContext } from "../testing/context.ts";
import { createFakeFetch, type FakeRequest } from "../testing/fake-fetch.ts";
import { PlaidMutationDuringPaginationError } from "./client.ts";
import { PlaidBankProvider } from "./provider.ts";

const provider = new PlaidBankProvider({ config: FAKE_PLAID_CONFIG, pageSize: 3 });

const syncByCursor = ({ call }: FakeRequest) => {
  const body = JSON.parse(call.body ?? "{}") as { cursor?: string };
  if (!body.cursor) return { json: page1 };
  if (body.cursor === "fake-cursor-page-1") return { json: page2 };
  return { json: { added: [], modified: [], removed: [], next_cursor: body.cursor, has_more: false } };
};

describe("PlaidBankProvider", () => {
  it("describes the item from /item/get", async () => {
    const ff = createFakeFetch([{ match: "/item/get", reply: { json: itemFixture } }]);
    const ctx = toProviderContext(makeContext(ff.fetch));
    expect(await provider.describeItem(ctx)).toEqual({ externalAccountId: "fake-item-id-1", label: "Example Bank", institutionName: "Example Bank" });
    expect(JSON.parse(ff.calls[0]!.body ?? "{}")).toMatchObject({ access_token: "access-sandbox-fake-token-1" });
  });

  it("lists normalized accounts with balances", async () => {
    const ff = createFakeFetch([{ match: "/accounts/get", reply: { json: accountsFixture } }]);
    const accounts = await provider.listAccounts(toProviderContext(makeContext(ff.fetch)));
    expect(accounts.map((a) => [a.externalId, a.type, a.currency, a.balanceCurrent])).toEqual([
      ["fake-acct-checking", "checking", "USD", "110.25"],
      ["fake-acct-savings", "savings", "USD", "210.00"],
      ["fake-acct-credit", "credit", "USD", "410.00"],
      ["fake-acct-loan", "loan", "EUR", "56302.06"],
      ["fake-acct-brokerage", "investment", "BTC", "23631.9805"],
      ["fake-acct-cd", "other", "USD", "1000.00"],
    ]);
    expect(accounts[1]!.balanceAsOf).toBe("2026-09-10T12:00:00.000Z");
  });

  it("pages transactions/sync until has_more is false, sending each next_cursor", async () => {
    const ff = createFakeFetch([{ match: "/transactions/sync", reply: syncByCursor }]);
    const pages = await collect(provider.syncTransactions(toProviderContext(makeContext(ff.fetch)), null));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ nextCursor: "fake-cursor-page-1", hasMore: true, removed: [] });
    expect(pages[0]!.added.map((t) => t.externalId)).toEqual(["fake-txn-northwind", "fake-txn-lindqvist", "fake-txn-coffee-pending"]);
    expect(pages[1]).toMatchObject({ nextCursor: "fake-cursor-page-2", hasMore: false, removed: ["fake-txn-coffee-pending"] });
    expect(pages[1]!.added.map((t) => t.externalId)).toEqual(["fake-txn-coffee-posted"]);
    expect(pages[1]!.modified.map((t) => [t.externalId, t.description])).toEqual([["fake-txn-lindqvist", "LINDQVIST STUDIO AB"]]);
    const bodies = ff.callsTo("/transactions/sync").map((c) => JSON.parse(c.body ?? "{}") as Record<string, unknown>);
    expect(bodies.map((b) => b.cursor ?? null)).toEqual([null, "fake-cursor-page-1"]);
    expect(bodies.every((b) => b.count === 3)).toBe(true);
  });

  it("resumes from a given cursor", async () => {
    const ff = createFakeFetch([{ match: "/transactions/sync", reply: syncByCursor }]);
    const pages = await collect(provider.syncTransactions(toProviderContext(makeContext(ff.fetch)), "fake-cursor-page-2"));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ added: [], modified: [], removed: [], nextCursor: "fake-cursor-page-2", hasMore: false });
  });

  it("surfaces ITEM_LOGIN_REQUIRED as unauthorized and mutation as the typed error", async () => {
    const ff = createFakeFetch([
      { match: "/accounts/get", reply: { status: 400, json: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" } } },
      { match: "/transactions/sync", reply: { status: 400, json: { error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } } },
    ]);
    const ctx = toProviderContext(makeContext(ff.fetch));
    await expect(provider.listAccounts(ctx)).rejects.toMatchObject({ name: "ConnectorError", code: "unauthorized" });
    await expect(collect(provider.syncTransactions(ctx, "c1"))).rejects.toBeInstanceOf(PlaidMutationDuringPaginationError);
  });

  it("refuses credentials that are not a Plaid access token, before any network call", async () => {
    const ff = createFakeFetch([]);
    const ctx = toProviderContext(makeContext(ff.fetch, { credential: { kind: "api_key", apiKey: "fake" } }));
    await expect(provider.describeItem(ctx)).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.describeItem({ ...ctx, credential: { kind: "access_token", accessToken: "" } })).rejects.toMatchObject({ code: "unauthorized" });
    expect(ff.calls).toHaveLength(0);
  });
});
