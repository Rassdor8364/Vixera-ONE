import { ConnectorError, ConnectorRegistry, supports } from "@vixera/domain";
import { describe, expect, it } from "vitest";
import me from "./__fixtures__/graph-me.json";
import { MicrosoftConnector } from "./connector.ts";
import { GraphRateLimitedError, parseRetryAfter } from "./http.ts";
import { FAKE_CREDENTIAL, FAKE_OAUTH, makeContext } from "./testing/context.ts";
import { createFakeFetch, sequence } from "./testing/fake-fetch.ts";

const connector = new MicrosoftConnector({ oauth: FAKE_OAUTH });
const tokenRoute = { match: "/oauth2/v2.0/token", reply: { json: { access_token: "fake-access-token-2", refresh_token: "fake-refresh-2", expires_in: 3600 } } };

describe("MicrosoftConnector", () => {
  it("declares provider and capabilities and registers like any other connector", () => {
    expect(connector.provider).toBe("microsoft");
    expect(connector.capabilities).toEqual(["mail", "calendar"]);
    expect(supports(connector, "mail")).toBe(true);
    expect(supports(connector, "calendar")).toBe(true);
    expect(supports(connector, "bank")).toBe(false);
    const registry = new ConnectorRegistry().register(connector);
    expect(registry.get("microsoft")).toBe(connector);
  });

  it("discovers the account from /me: id, mail over UPN, display label", async () => {
    const fake = createFakeFetch([{ match: "/v1.0/me?", reply: { json: me } }]);
    const ctx = makeContext(fake.fetch);
    const account = await connector.discoverAccount(ctx);
    expect(account).toEqual({
      externalAccountId: "fake-graph-user-1",
      label: "Me Example (me@example.com)",
      address: "me@example.com",
      capabilities: ["mail", "calendar"],
      metadata: { displayName: "Me Example", userPrincipalName: me.userPrincipalName },
    });
    expect(fake.calls[0]?.url.searchParams.get("$select")).toBe("id,mail,userPrincipalName,displayName");
    expect(fake.calls[0]?.headers.authorization).toBe("Bearer fake-access-token-1");
  });

  it("falls back to userPrincipalName when mail is empty", async () => {
    const fake = createFakeFetch([{ match: "/v1.0/me?", reply: { json: { ...me, mail: null, userPrincipalName: "Someone@Example.com" } } }]);
    const account = await connector.discoverAccount(makeContext(fake.fetch));
    expect(account.address).toBe("someone@example.com");
    expect(account.label).toBe("Me Example (someone@example.com)");
  });

  it("refreshes once on 401, persists the new credential, retries, then gives up as unauthorized", async () => {
    const fake = createFakeFetch([tokenRoute, { match: "/v1.0/me?", reply: sequence({ status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } } }, { json: me }) }]);
    const ctx = makeContext(fake.fetch);
    const account = await connector.discoverAccount(ctx);
    expect(account.externalAccountId).toBe("fake-graph-user-1");
    expect(fake.callsTo("/v1.0/me?")).toHaveLength(2);
    expect(fake.callsTo("/v1.0/me?")[1]?.headers.authorization).toBe("Bearer fake-access-token-2");
    expect(ctx.refreshed).toEqual([expect.objectContaining({ kind: "oauth2", accessToken: "fake-access-token-2", refreshToken: "fake-refresh-2" })]);

    const stubborn = createFakeFetch([tokenRoute, { match: "/v1.0/me?", reply: { status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "nope" } } } }]);
    const error = await connector.discoverAccount(makeContext(stubborn.fetch)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("unauthorized");
    expect(stubborn.callsTo("/v1.0/me?")).toHaveLength(2);
    expect(stubborn.callsTo("/oauth2/v2.0/token")).toHaveLength(1);
  });

  it("refreshes proactively when the credential is already expired", async () => {
    const fake = createFakeFetch([tokenRoute, { match: "/v1.0/me?", reply: { json: me } }]);
    const ctx = makeContext(fake.fetch, { now: () => new Date("2026-09-10T14:00:00.000Z") });
    await connector.discoverAccount(ctx);
    expect(fake.calls[0]?.url.pathname).toContain("/oauth2/v2.0/token");
    expect(fake.callsTo("/v1.0/me?")[0]?.headers.authorization).toBe("Bearer fake-access-token-2");
  });

  it("maps 429 to rate_limited with Retry-After as metadata and does not retry or sleep", async () => {
    const fake = createFakeFetch([{ match: "/v1.0/me?", reply: { status: 429, headers: { "retry-after": "17" }, json: { error: { code: "TooManyRequests", message: "Throttled" } } } }]);
    const started = Date.now();
    const error = await connector.discoverAccount(makeContext(fake.fetch)).catch((e: unknown) => e);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(error).toBeInstanceOf(GraphRateLimitedError);
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterSeconds: 17 });
    expect(fake.calls).toHaveLength(1);
    expect(parseRetryAfter("Thu, 10 Sep 2026 12:00:30 GMT", () => new Date("2026-09-10T12:00:00.000Z"))).toBe(30);
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("maps 5xx to provider_unavailable and unreachable networks too", async () => {
    const down = createFakeFetch([{ match: "/v1.0/me?", reply: { status: 503, text: "Service Unavailable" } }]);
    await expect(connector.discoverAccount(makeContext(down.fetch))).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    const unreachable: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(connector.discoverAccount(makeContext(unreachable))).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("never lets the client secret or tokens reach credentials, logs or error messages", async () => {
    const fake = createFakeFetch([
      tokenRoute,
      { match: "/v1.0/me?", reply: sequence({ status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "expired" } } }, { status: 500, text: "boom" }) },
    ]);
    const ctx = makeContext(fake.fetch);
    const error = await connector.discoverAccount(ctx).catch((e: unknown) => e as Error);
    const surfaced = JSON.stringify({ logs: ctx.logs, message: (error as Error).message, credentials: ctx.refreshed.map((c) => ({ ...c, accessToken: "", refreshToken: "" })) });
    expect(surfaced).not.toContain(FAKE_OAUTH.clientSecret);
    expect(surfaced).not.toContain("fake-access-token");
    expect(surfaced).not.toContain("fake-refresh");
    // The secret went to the token endpoint only, as form data, never in a URL or header.
    const tokenCall = fake.callsTo("/oauth2/v2.0/token")[0];
    expect(tokenCall?.body).toContain(`client_secret=${encodeURIComponent(FAKE_OAUTH.clientSecret)}`);
    expect(tokenCall?.url.toString()).not.toContain(FAKE_OAUTH.clientSecret);
    for (const call of fake.calls) {
      expect(JSON.stringify(call.headers)).not.toContain(FAKE_OAUTH.clientSecret);
      expect(call.url.toString()).not.toContain(FAKE_CREDENTIAL.kind === "oauth2" ? FAKE_CREDENTIAL.accessToken : "");
    }
  });

  it("serves two accounts from one instance without sharing credentials or refresh state", async () => {
    const fake = createFakeFetch([tokenRoute, { match: "/v1.0/me?", reply: ({ call }) => (call.headers.authorization === "Bearer fake-access-token-1" ? { status: 401, json: { error: { code: "InvalidAuthenticationToken" } } } : { json: { ...me, id: call.headers.authorization === "Bearer fake-access-token-2" ? "user-a" : "user-b" } }) }]);
    const a = makeContext(fake.fetch);
    const b = makeContext(fake.fetch, { credential: { ...FAKE_CREDENTIAL, accessToken: "other-access-token", refreshToken: "other-refresh" } as typeof FAKE_CREDENTIAL });
    const [first, second] = await Promise.all([connector.discoverAccount(a), connector.discoverAccount(b)]);
    expect(first.externalAccountId).toBe("user-a");
    expect(second.externalAccountId).toBe("user-b");
    // Only the account whose token was rejected refreshed; the other never touched the token endpoint.
    expect(a.refreshed).toHaveLength(1);
    expect(b.refreshed).toHaveLength(0);
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(1);
    expect(fake.callsTo("/v1.0/me?").map((c) => c.headers.authorization).sort()).toEqual(["Bearer fake-access-token-1", "Bearer fake-access-token-2", "Bearer other-access-token"]);
  });

  it("delegates refreshCredential to the token endpoint", async () => {
    const fake = createFakeFetch([tokenRoute]);
    const fresh = await connector.refreshCredential(makeContext(fake.fetch));
    expect(fresh).toMatchObject({ kind: "oauth2", accessToken: "fake-access-token-2" });
  });
});
