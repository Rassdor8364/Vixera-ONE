/**
 * The brief forbids payment execution. These tests pin that down at the
 * package surface: no exported class or object carries a method that could
 * move money, and a full link + sync cycle only ever reaches the read
 * endpoints of the provider.
 */
import { describe, expect, it } from "vitest";
import accountsFixture from "./__fixtures__/plaid-accounts.json";
import itemFixture from "./__fixtures__/plaid-item.json";
import page1 from "./__fixtures__/plaid-transactions-sync-page1.json";
import * as bank from "./index.ts";
import { FAKE_PLAID_CONFIG, makeContext } from "./testing/context.ts";
import { createFakeFetch } from "./testing/fake-fetch.ts";

/** Verbs that would indicate a write path to the provider. Compared whole-word against camelCase segments. */
const FORBIDDEN_WORDS = new Set([
  "transfer", "payment", "payments", "payout", "pay", "send", "move", "withdraw", "withdrawal", "deposit",
  "initiate", "authorize", "debit", "write", "post", "put", "patch", "delete", "update", "create", "cancel", "refund",
]);
/** Names that contain a forbidden verb but demonstrably do not move money (link token creation is Plaid Link setup). */
const ALLOWED_NAMES = new Set(["createLinkToken", "createPlaidBankConnector"]);

function offendingWord(name: string): string | null {
  if (ALLOWED_NAMES.has(name)) return null;
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().split(" ");
  return words.find((w) => FORBIDDEN_WORDS.has(w)) ?? null;
}

function methodNames(target: object): string[] {
  const names = new Set<string>();
  let proto: object | null = target;
  while (proto && proto !== Object.prototype && proto !== Function.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (name !== "constructor" && typeof desc?.value === "function") names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...names];
}

describe("read-only guarantee", () => {
  it("exposes no method or export that could move money", () => {
    const client = new bank.PlaidClient(async () => new Response(), FAKE_PLAID_CONFIG);
    const plaid = new bank.PlaidBankProvider({ config: FAKE_PLAID_CONFIG });
    const mock = new bank.MockBankProvider();
    const connector = new bank.BankConnector(mock);
    for (const target of [client, plaid, mock, connector]) {
      const names = methodNames(target);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(offendingWord(name), `method ${name} on ${target.constructor.name}`).toBeNull();
    }
    for (const name of Object.keys(bank)) expect(offendingWord(name), `export ${name}`).toBeNull();
    expect(offendingWord("initiatePayment")).toBe("initiate");
    expect(offendingWord("transferFunds")).toBe("transfer");
    expect(offendingWord("removeTransaction")).toBeNull();
    expect(methodNames(client).sort()).toEqual(["createLinkToken", "exchangePublicToken", "getAccounts", "getItem", "transactionsSync"]);
    for (const endpoint of bank.PLAID_READ_ENDPOINTS) expect(endpoint).not.toMatch(/transfer|payment|bank_transfer|processor|deposit_switch/i);
  });

  it("a full link + sync cycle only calls read endpoints", async () => {
    const ff = createFakeFetch([
      { match: "/link/token/create", reply: { json: { link_token: "link-sandbox-fake", expiration: "x" } } },
      { match: "/item/public_token/exchange", reply: { json: { access_token: "access-sandbox-fake-token-1", item_id: "fake-item-id-1" } } },
      { match: "/item/get", reply: { json: itemFixture } },
      { match: "/accounts/get", reply: { json: accountsFixture } },
      { match: "/transactions/sync", reply: { json: { ...page1, has_more: false } } },
    ]);
    const client = new bank.PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const connector = bank.createPlaidBankConnector(FAKE_PLAID_CONFIG);
    await bank.beginBankLink(client, { userId: "00000000-0000-4000-8000-000000000001" });
    const linked = await bank.completeBankLink({ client, connector, fetch: ff.fetch }, { publicToken: "public-sandbox-fake" });
    const ctx = makeContext(ff.fetch, { credential: linked.credential });
    for await (const page of connector.syncBank(ctx, null)) expect(page.batch.transactions.length).toBeGreaterThan(0);

    const paths = ff.calls.map((c) => c.url.pathname);
    expect(paths).toEqual(["/link/token/create", "/item/public_token/exchange", "/item/get", "/accounts/get", "/transactions/sync"]);
    expect(ff.calls.every((c) => c.method === "POST")).toBe(true);
    expect(paths.every((p) => (bank.PLAID_READ_ENDPOINTS as readonly string[]).includes(p))).toBe(true);
  });
});
