import { DEV_USER_ID } from "@vixera/domain";
import { describe, expect, it } from "vitest";
import itemFixture from "./__fixtures__/plaid-item.json";
import { bankLinkFlow, beginBankLink, completeBankLink, completeBankRelink, createPlaidBankConnector } from "./link.ts";
import { PlaidClient } from "./plaid/client.ts";
import { FAKE_CREDENTIAL, FAKE_PLAID_CONFIG } from "./testing/context.ts";
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
    expect(JSON.parse(ff.calls[0]!.body ?? "{}")).not.toHaveProperty("access_token");
    expect(token).not.toHaveProperty("hostedLinkUrl");
    expect(bankLinkFlow.begin).toBe(beginBankLink);
    expect(bankLinkFlow.complete).toBe(completeBankLink);
    expect(bankLinkFlow.relink).toBe(completeBankRelink);
  });

  it("asks for a Hosted Link session when the caller has no Link widget and passes the URL through", async () => {
    const ff = createFakeFetch([
      { match: "/link/token/create", reply: { json: { link_token: "link-sandbox-hosted", expiration: "2026-09-10T16:00:00Z", hosted_link_url: "https://hosted.plaid.com/link/fake" } } },
    ]);
    const token = await beginBankLink(new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG), { userId: DEV_USER_ID, hostedLink: true });
    expect(token).toEqual({ linkToken: "link-sandbox-hosted", expiration: "2026-09-10T16:00:00Z", hostedLinkUrl: "https://hosted.plaid.com/link/fake" });
    expect(JSON.parse(ff.calls[0]!.body ?? "{}")).toMatchObject({ hosted_link: {}, products: ["transactions"] });
  });

  it("opens Link update mode for an existing item (needs_reauth): access_token instead of products, same user", async () => {
    const ff = createFakeFetch([{ match: "/link/token/create", reply: { json: { link_token: "link-sandbox-update", expiration: "2026-09-10T16:00:00Z" } } }]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const token = await beginBankLink(client, { userId: DEV_USER_ID, accessToken: "access-sandbox-fake-token-1", hostedLink: true });
    expect(token.linkToken).toBe("link-sandbox-update");
    const body = JSON.parse(ff.calls[0]!.body ?? "{}");
    expect(body).toMatchObject({
      user: { client_user_id: DEV_USER_ID },
      access_token: "access-sandbox-fake-token-1",
      client_name: "Vixera One",
      country_codes: ["US"],
      language: "en",
      hosted_link: {},
    });
    // Update mode repairs the Item's existing consent; asking for products would start a new one.
    expect(body).not.toHaveProperty("products");
    expect(ff.calls).toHaveLength(1);
  });

  it("completes an update-mode session without a public token: no exchange, the same item id, the same credential", async () => {
    const ff = createFakeFetch([
      { match: "/item/public_token/exchange", reply: { status: 400, json: { error_type: "INVALID_INPUT", error_code: "INVALID_PUBLIC_TOKEN" } } },
      { match: "/item/get", reply: { json: itemFixture } },
    ]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const connector = createPlaidBankConnector(FAKE_PLAID_CONFIG);
    const result = await completeBankRelink({ client, connector, fetch: ff.fetch, now: () => new Date("2026-09-10T12:00:00Z") }, { credential: FAKE_CREDENTIAL });

    expect(ff.calls.map((c) => c.url.pathname)).toEqual(["/item/get"]);
    expect(JSON.parse(ff.calls[0]!.body ?? "{}")).toMatchObject({ access_token: "access-sandbox-fake-token-1" });
    // The Item (and so the connector_accounts natural key) survives: persisting this finds the existing row.
    expect(result.discovered.externalAccountId).toBe("fake-item-id-1");
    expect(result.discovered).toMatchObject({ label: "Example Bank", capabilities: ["bank"], address: null });
    expect(result.credential).toEqual(FAKE_CREDENTIAL);
  });

  it("does not report an item repaired while Plaid still flags it ITEM_LOGIN_REQUIRED", async () => {
    const stillBroken = { ...itemFixture, item: { ...itemFixture.item, error: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details of this item have changed" } } };
    const ff = createFakeFetch([{ match: "/item/get", reply: { json: stillBroken } }]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const connector = createPlaidBankConnector(FAKE_PLAID_CONFIG);
    await expect(completeBankRelink({ client, connector, fetch: ff.fetch }, { credential: FAKE_CREDENTIAL })).rejects.toMatchObject({ name: "ConnectorError", code: "unauthorized", retryable: false });
    await expect(completeBankRelink({ client, connector, fetch: ff.fetch }, { credential: { kind: "api_key", apiKey: "x" } })).rejects.toMatchObject({ code: "unsupported" });
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
