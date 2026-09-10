import { describe, expect, it } from "vitest";
import accountsFixture from "../__fixtures__/plaid-accounts.json";
import page1 from "../__fixtures__/plaid-transactions-sync-page1.json";
import page2 from "../__fixtures__/plaid-transactions-sync-page2.json";
import { mapAccountType, normalizeAccount, normalizeTransaction } from "./normalize.ts";
import type { PlaidAccount, PlaidTransaction } from "./types.ts";

const ctx = { institutionName: "Example Bank", asOf: "2026-09-10T12:00:00.000Z" };
const accounts = accountsFixture.accounts as readonly PlaidAccount[];
const byId = (id: string) => accounts.find((a) => a.account_id === id) as PlaidAccount;

describe("Plaid account normalization", () => {
  it("maps type/subtype onto MoneyAccountType", () => {
    expect(mapAccountType("depository", "checking")).toBe("checking");
    expect(mapAccountType("depository", "savings")).toBe("savings");
    expect(mapAccountType("depository", "cd")).toBe("other");
    expect(mapAccountType("credit", "credit card")).toBe("credit");
    expect(mapAccountType("loan", "mortgage")).toBe("loan");
    expect(mapAccountType("investment", "brokerage")).toBe("investment");
    expect(mapAccountType("brokerage", null)).toBe("investment");
    expect(mapAccountType("other", undefined)).toBe("other");
    expect(mapAccountType("DEPOSITORY", "Checking")).toBe("checking");
  });

  it("carries balances as decimal strings and keeps institution + subtype in metadata", () => {
    const a = normalizeAccount(byId("fake-acct-checking"), ctx);
    expect(a).toEqual({
      externalId: "fake-acct-checking",
      name: "Plaid Checking",
      officialName: "Plaid Gold Standard 0% Interest Checking",
      type: "checking",
      currency: "USD",
      balanceCurrent: "110.25",
      balanceAvailable: "100.50",
      balanceAsOf: "2026-09-10T05:00:00Z",
      mask: "0000",
      metadata: { subtype: "checking", institution: "Example Bank" },
    });
    for (const acc of accounts) {
      const n = normalizeAccount(acc, ctx);
      expect(typeof n.balanceCurrent === "string" || n.balanceCurrent === null).toBe(true);
      if (n.balanceCurrent) expect(n.balanceCurrent).toMatch(/^-?\d+\.\d{2,}$/);
    }
  });

  it("falls back on unofficial currency, then USD, and dates undated balances with the sync clock", () => {
    const brokerage = normalizeAccount(byId("fake-acct-brokerage"), ctx);
    expect(brokerage.currency).toBe("BTC");
    expect(brokerage.balanceCurrent).toBe("23631.9805");
    expect(brokerage.balanceAvailable).toBeNull();
    const cd = normalizeAccount(byId("fake-acct-cd"), ctx);
    expect(cd.currency).toBe("USD");
    expect(cd.balanceAsOf).toBe(ctx.asOf);
    const loan = normalizeAccount(byId("fake-acct-loan"), ctx);
    expect(loan.currency).toBe("EUR");
    expect(loan.officialName).toBeNull();
    const credit = normalizeAccount(byId("fake-acct-credit"), ctx);
    expect(credit.metadata).toEqual({ subtype: "credit card", institution: "Example Bank", limit: "5000.00" });
  });
});

describe("Plaid transaction normalization", () => {
  const added = page1.added as readonly PlaidTransaction[];
  const find = (id: string) => added.find((t) => t.transaction_id === id) as PlaidTransaction;

  it("flips Plaid's sign: positive Plaid amount = money out = negative amount", () => {
    const outflow = normalizeTransaction(find("fake-txn-lindqvist"));
    expect(outflow.amount).toBe("-2400.00");
    const inflow = normalizeTransaction(find("fake-txn-northwind"));
    expect(inflow.amount).toBe("12400.00");
    expect(normalizeTransaction(find("fake-txn-coffee-pending")).amount).toBe("-6.40");
  });

  it("maps every field the spine needs", () => {
    expect(normalizeTransaction(find("fake-txn-northwind"))).toEqual({
      externalId: "fake-txn-northwind",
      accountExternalId: "fake-acct-checking",
      amount: "12400.00",
      currency: "USD",
      description: "NORTHWIND CO INVOICE 2026-041",
      merchantName: "Northwind Co.",
      postedOn: "2026-09-08",
      authorizedAt: "2026-09-08T09:12:00Z",
      pending: false,
      category: ["INCOME", "INCOME_OTHER_INCOME"],
      metadata: { payment_channel: "other", pending_transaction_id: null },
    });
  });

  it("handles missing category, missing currency, pending and authorized_date fallback", () => {
    const pending = normalizeTransaction(find("fake-txn-coffee-pending"));
    expect(pending.category).toEqual([]);
    expect(pending.currency).toBe("USD");
    expect(pending.pending).toBe(true);
    expect(pending.authorizedAt).toBeNull();
    const lindqvist = normalizeTransaction(find("fake-txn-lindqvist"));
    expect(lindqvist.authorizedAt).toBe("2026-09-09T00:00:00.000Z");
    const posted = normalizeTransaction((page2.added as readonly PlaidTransaction[])[0] as PlaidTransaction);
    expect(posted.metadata).toEqual({ payment_channel: "in store", pending_transaction_id: "fake-txn-coffee-pending" });
  });

  it("never emits a number for money", () => {
    for (const t of [...added, ...(page2.added as readonly PlaidTransaction[]), ...(page2.modified as readonly PlaidTransaction[])]) {
      const n = normalizeTransaction(t);
      expect(typeof n.amount).toBe("string");
      expect(n.amount).toMatch(/^-?\d+\.\d{2,}$/);
    }
  });
});
