import { DEV_USER_ID } from "@vixera/domain";
import { describe, expect, it } from "vitest";
import itemFixture from "./__fixtures__/plaid-item.json";
import { bankLinkFlow, beginBankLink, completeBankLink, createPlaidBankConnector } from "./link.ts";
import { PlaidClient } from "./plaid/client.ts";
import { FAKE_PLAID_CONFIG } from "./testing/context.ts";
import { createFakeFetch } from "./testing/fake-fetch.ts";

describe("bank link flow", () => {
  it("creates a link token for the Vixera user id with the read-only transactions product", async () => {
    const ff = createFakeFetch([{ match: "/link/token/create", reply: { json: { link_token: "link-sandbox-fake", expiration: "2026-09-10T16:00:00Z" } } }]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const token = await beginBankLink(client, { userId: DEV_USER_ID });
    expect(token.linkToken).toBe("link-sandbox-fake");
    expect(JSON.parse(ff.calls[0]!.body ?? "{}")).toMatchObject({
      user: { client_user_id: DEV_USER_ID },
      client_name: "Vixera One",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });
    expect(bankLinkFlow.begin).toBe(beginBankLink);
    expect(bankLinkFlow.complete).toBe(completeBankLink);
  });

  it("exchanges the public token into an access_token credential and a discovered account", async () => {
    const ff = createFakeFetch([
      { match: "/item/public_token/exchange", reply: { json: { access_token: "access-sandbox-fake-token-9", item_id: "fake-item-id-1" } } },
      { match: "/item/get", reply: { json: itemFixture } },
    ]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const connector = createPlaidBankConnector(FAKE_PLAID_CONFIG);
    const logs: string[] = [];
    const result = await completeBankLink({ client, connector, fetch: ff.fetch, now: () => new Date("2026-09-10T12:00:00Z"), log: (m) => logs.push(m) }, { publicToken: "public-sandbox-fake" });

    expect(result.credential).toEqual({ kind: "access_token", accessToken: "access-sandbox-fake-token-9", expiresAt: null });
    expect(result.discovered).toMatchObject({ externalAccountId: "fake-item-id-1", label: "Example Bank", capabilities: ["bank"], address: null });
    expect(JSON.parse(ff.callsTo("/item/get")[0]!.body ?? "{}")).toMatchObject({ access_token: "access-sandbox-fake-token-9" });
    expect(logs).not.toContain("bank.link.item_mismatch");
    // The credential is the only thing the caller has to store; it is not on the discovered account.
    expect(JSON.stringify(result.discovered)).not.toContain("access-sandbox-fake-token-9");
  });
});
