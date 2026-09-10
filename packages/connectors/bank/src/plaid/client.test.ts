import { ConnectorError } from "@vixera/domain";
import { describe, expect, it } from "vitest";
import { createFakeFetch } from "../testing/fake-fetch.ts";
import { FAKE_PLAID_CONFIG } from "../testing/context.ts";
import { PLAID_READ_ENDPOINTS, PlaidClient, PlaidMutationDuringPaginationError, mapPlaidError } from "./client.ts";
import page1 from "../__fixtures__/plaid-transactions-sync-page1.json";

const plaidError = (error_code: string, error_type = "ITEM_ERROR", status = 400) => ({
  status,
  json: { error_type, error_code, error_message: `${error_code} happened`, request_id: "req-fake-err" },
});

describe("PlaidClient", () => {
  it("POSTs JSON to <env>.plaid.com with client_id/secret in the body, never in headers or the URL", async () => {
    const ff = createFakeFetch([{ match: "/link/token/create", reply: { json: { link_token: "link-sandbox-fake", expiration: "2026-09-10T16:00:00Z" } } }]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const token = await client.createLinkToken({
      userId: "00000000-0000-4000-8000-000000000001",
      products: ["transactions"],
      clientName: "Vixera One",
      countryCodes: ["US"],
      language: "en",
      redirectUri: "https://example.com/plaid/return",
    });
    expect(token).toEqual({ linkToken: "link-sandbox-fake", expiration: "2026-09-10T16:00:00Z" });
    const call = ff.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url.toString()).toBe("https://sandbox.plaid.com/link/token/create");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(Object.values(call.headers).join(" ")).not.toContain(FAKE_PLAID_CONFIG.secret);
    const body = JSON.parse(call.body ?? "{}");
    expect(body).toMatchObject({
      client_id: FAKE_PLAID_CONFIG.clientId,
      secret: FAKE_PLAID_CONFIG.secret,
      user: { client_user_id: "00000000-0000-4000-8000-000000000001" },
      client_name: "Vixera One",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: "https://example.com/plaid/return",
    });
  });

  it("uses the production host when configured and omits an absent redirect uri", async () => {
    const ff = createFakeFetch([{ match: "/link/token/create", reply: { json: { link_token: "link-production-fake", expiration: "x" } } }]);
    const client = new PlaidClient(ff.fetch, { ...FAKE_PLAID_CONFIG, environment: "production" });
    await client.createLinkToken({ userId: "u", products: ["transactions"], clientName: "Vixera One", countryCodes: ["US"], language: "en" });
    expect(ff.calls[0]!.url.host).toBe("production.plaid.com");
    expect(JSON.parse(ff.calls[0]!.body ?? "{}")).not.toHaveProperty("redirect_uri");
  });

  it("exchanges a public token and sends the cursor + count on transactions/sync", async () => {
    const ff = createFakeFetch([
      { match: "/item/public_token/exchange", reply: { json: { access_token: "access-sandbox-fake-token-2", item_id: "fake-item-id-2" } } },
      { match: "/transactions/sync", reply: { json: page1 } },
    ]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    expect(await client.exchangePublicToken("public-sandbox-fake")).toEqual({ accessToken: "access-sandbox-fake-token-2", itemId: "fake-item-id-2" });
    expect(JSON.parse(ff.calls[0]!.body ?? "{}")).toMatchObject({ public_token: "public-sandbox-fake" });

    await client.transactionsSync("access-sandbox-fake-token-2", null, 100);
    expect(JSON.parse(ff.calls[1]!.body ?? "{}")).toEqual({ access_token: "access-sandbox-fake-token-2", count: 100, client_id: FAKE_PLAID_CONFIG.clientId, secret: FAKE_PLAID_CONFIG.secret });
    await client.transactionsSync("access-sandbox-fake-token-2", "fake-cursor-page-1");
    expect(JSON.parse(ff.calls[2]!.body ?? "{}")).toMatchObject({ cursor: "fake-cursor-page-1", count: 500 });
  });

  it("maps Plaid error codes onto ConnectorError codes", async () => {
    const ff = createFakeFetch([
      { match: "/item/get", reply: plaidError("ITEM_LOGIN_REQUIRED") },
      { match: "/accounts/get", reply: plaidError("INVALID_ACCESS_TOKEN", "INVALID_INPUT") },
      { match: "/transactions/sync", reply: plaidError("RATE_LIMIT", "RATE_LIMIT_EXCEEDED", 429) },
    ]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    await expect(client.getItem("t")).rejects.toMatchObject({ name: "ConnectorError", code: "unauthorized", retryable: false });
    await expect(client.getAccounts("t")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(client.transactionsSync("t", null)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("raises a typed error carrying the cursor on mutation-during-pagination", async () => {
    const ff = createFakeFetch([{ match: "/transactions/sync", reply: plaidError("TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "TRANSACTIONS_ERROR") }]);
    const client = new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG);
    const err = await client.transactionsSync("t", "fake-cursor-page-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidMutationDuringPaginationError);
    expect((err as PlaidMutationDuringPaginationError).cursor).toBe("fake-cursor-page-1");
    expect((err as PlaidMutationDuringPaginationError).requestId).toBe("req-fake-err");
  });

  it("maps outages, unknown errors, and bad bodies", async () => {
    expect(mapPlaidError(500, { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" }, "/x")).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(mapPlaidError(400, { error_type: "ITEM_ERROR", error_code: "PRODUCT_NOT_READY" }, "/x")).toMatchObject({ code: "unknown", retryable: false });
    // Server-side key misconfiguration must not flag the user's account as needing re-auth.
    expect(mapPlaidError(400, { error_type: "INVALID_INPUT", error_code: "INVALID_API_KEYS" }, "/x")).toMatchObject({ code: "unknown" });
    expect(mapPlaidError(400, { error_type: "ITEM_ERROR", error_code: "ITEM_NOT_FOUND" }, "/x")).toMatchObject({ code: "unauthorized" });
    expect(mapPlaidError(502, null, "/x")).toMatchObject({ code: "provider_unavailable" });
    expect(mapPlaidError(200, null, "/x")).toMatchObject({ code: "invalid_response" });
    const unreachable = new PlaidClient(async () => {
      throw new TypeError("network down");
    }, FAKE_PLAID_CONFIG);
    await expect(unreachable.getItem("t")).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    const nonJson = createFakeFetch([{ match: "/item/get", reply: { status: 200, text: "<html>" } }]);
    await expect(new PlaidClient(nonJson.fetch, FAKE_PLAID_CONFIG).getItem("t")).rejects.toBeInstanceOf(ConnectorError);
  });

  it("does not leak the server secret into error messages", async () => {
    const ff = createFakeFetch([{ match: "/item/get", reply: plaidError("ITEM_LOGIN_REQUIRED") }]);
    const err = (await new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG).getItem("access-sandbox-fake-token-1").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(FAKE_PLAID_CONFIG.secret);
    expect(err.message).not.toContain("access-sandbox-fake-token-1");
  });

  it("only knows read endpoints", () => {
    expect([...PLAID_READ_ENDPOINTS]).toEqual(["/link/token/create", "/item/public_token/exchange", "/item/get", "/accounts/get", "/transactions/sync"]);
    expect(() => new PlaidClient(async () => new Response(), { clientId: "", secret: "", environment: "sandbox" })).toThrow(ConnectorError);
  });
});
