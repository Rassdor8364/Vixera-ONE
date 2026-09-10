import { describe, expect, it } from "vitest";
import { ConnectorError, ConnectorRegistry, supports, type ConnectorCredential } from "@vixera/domain";
import multipart from "./__fixtures__/gmail-message-multipart.json";
import profile from "./__fixtures__/gmail-profile.json";
import { GOOGLE_USERINFO_ENDPOINT, GoogleConnector } from "./connector.ts";
import { GMAIL_API } from "./gmail/sync.ts";
import { GOOGLE_TOKEN_ENDPOINT } from "./oauth.ts";
import { FAKE_CREDENTIAL, FAKE_OAUTH, collect, makeContext } from "./testing/context.ts";
import { createFakeFetch, sequence } from "./testing/fake-fetch.ts";

const connector = new GoogleConnector({ oauth: FAKE_OAUTH, backfillDays: 7, concurrency: 1 });
const tokenRoute = { match: GOOGLE_TOKEN_ENDPOINT, method: "POST", reply: { json: { access_token: "fake-access-token-2", expires_in: 3600, token_type: "Bearer" } } };
const unauthorized = { status: 401, json: { error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } } };

describe("GoogleConnector identity", () => {
  it("is the google provider with mail + calendar and registers once", () => {
    expect(connector.provider).toBe("google");
    expect(connector.capabilities).toEqual(["mail", "calendar"]);
    const registry = new ConnectorRegistry().register(connector);
    expect(supports(registry.get("google"), "mail")).toBe(true);
    expect(supports(registry.get("google"), "bank")).toBe(false);
  });

  it("discovers the account from userinfo: sub is the external id, email the label/address", async () => {
    const fake = createFakeFetch([{ match: GOOGLE_USERINFO_ENDPOINT, reply: { json: { sub: "fake-google-sub-1", email: "Me@Example.com", email_verified: true, name: "Me" } } }]);
    const { account: _drop, ...ctx } = makeContext(fake.fetch);
    const discovered = await connector.discoverAccount(ctx);
    expect(discovered).toEqual({
      externalAccountId: "fake-google-sub-1",
      label: "me@example.com",
      address: "me@example.com",
      capabilities: ["mail", "calendar"],
      metadata: { name: "Me", emailVerified: true },
    });
    expect(discovered).not.toHaveProperty("userId");
  });
});

describe("GoogleConnector credential handling", () => {
  it("refreshes once on 401, reports the new credential, retries with it, and stays quiet about secrets", async () => {
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/profile`, reply: sequence(unauthorized, { json: profile }) },
      { match: (url) => url.pathname.endsWith("/users/me/messages"), reply: { json: {} } },
      tokenRoute,
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(connector.syncMail(ctx, null));

    expect(pages).toHaveLength(1);
    expect(ctx.refreshed).toHaveLength(1);
    expect(ctx.refreshed[0]).toMatchObject({ kind: "oauth2", accessToken: "fake-access-token-2", refreshToken: "fake-refresh-token" });
    const profileCalls = fake.callsTo("/profile");
    expect(profileCalls.map((c) => c.headers.authorization)).toEqual(["Bearer fake-access-token-1", "Bearer fake-access-token-2"]);
    expect(fake.callsTo("/users/me/messages?")[0]?.headers.authorization).toBe("Bearer fake-access-token-2");
    expect(fake.callsTo(GOOGLE_TOKEN_ENDPOINT)).toHaveLength(1);

    // the client secret never lands in a credential, a log or a page; tokens never in logs or pages
    expect(JSON.stringify(ctx.refreshed)).not.toContain(FAKE_OAUTH.clientSecret);
    const observable = JSON.stringify({ logs: ctx.logs, pages });
    expect(observable).not.toContain(FAKE_OAUTH.clientSecret);
    expect(observable).not.toContain("fake-access-token");
    expect(observable).not.toContain("fake-refresh-token");
    for (const call of fake.calls) {
      if (call.url.toString() !== GOOGLE_TOKEN_ENDPOINT) {
        expect(call.url.toString()).not.toContain(FAKE_OAUTH.clientSecret);
        expect(call.body ?? "").not.toContain(FAKE_OAUTH.clientSecret);
      }
    }
  });

  it("refreshes exactly once when several concurrent requests hit 401 together and retries all of them", async () => {
    const parallel = new GoogleConnector({ oauth: FAKE_OAUTH, backfillDays: 7, concurrency: 4 });
    const ids = ["c1", "c2", "c3", "c4"];
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/profile`, reply: { json: profile } },
      { match: (url) => url.pathname.endsWith("/users/me/messages"), reply: { json: { messages: ids.map((id) => ({ id })) } } },
      {
        match: /\/users\/me\/messages\/[^?]+\?format=full/,
        reply: async ({ call }) => {
          // every fetch is in flight before any of them answers, so all four see the stale token
          await new Promise((r) => setTimeout(r, 2));
          if (call.headers.authorization !== "Bearer fake-access-token-2") return unauthorized;
          const id = call.url.pathname.split("/").pop() ?? "";
          return { json: { ...(multipart as Record<string, unknown>), id, threadId: id } };
        },
      },
      tokenRoute,
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(parallel.syncMail(ctx, null));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.batch.messages.map((m) => m.externalId).sort()).toEqual(ids);
    expect(fake.callsTo(GOOGLE_TOKEN_ENDPOINT)).toHaveLength(1);
    expect(ctx.refreshed).toHaveLength(1);
    // each message: one 401 with the old token, one success with the new one
    expect(fake.callsTo("format=full")).toHaveLength(8);
  });

  it("throws unauthorized (not retryable) when the refreshed credential is rejected too", async () => {
    const fake = createFakeFetch([{ match: `${GMAIL_API}/profile`, reply: unauthorized }, tokenRoute]);
    const ctx = makeContext(fake.fetch);
    await expect(collect(connector.syncMail(ctx, null))).rejects.toMatchObject({ code: "unauthorized", retryable: false });
    expect(fake.callsTo(GOOGLE_TOKEN_ENDPOINT)).toHaveLength(1);
    expect(fake.callsTo("/profile")).toHaveLength(2);
    expect(ctx.refreshed).toHaveLength(1);
  });

  it("refreshes proactively when the credential is already expired", async () => {
    const fake = createFakeFetch([{ match: GOOGLE_USERINFO_ENDPOINT, reply: { json: { sub: "s", email: "me@example.com" } } }, tokenRoute]);
    const expired: ConnectorCredential = { kind: "oauth2", accessToken: "fake-access-token-1", refreshToken: "fake-refresh-token", expiresAt: "2026-09-10T11:00:00.000Z", scopes: [] };
    const { account: _drop, ...ctx } = makeContext(fake.fetch, { credential: expired });
    await connector.discoverAccount(ctx);
    expect(fake.calls.map((c) => c.url.toString())).toEqual([GOOGLE_TOKEN_ENDPOINT, GOOGLE_USERINFO_ENDPOINT]);
    expect(fake.callsTo(GOOGLE_USERINFO_ENDPOINT)[0]?.headers.authorization).toBe("Bearer fake-access-token-2");
  });

  it("refreshCredential goes through the token endpoint and keeps the refresh token", async () => {
    const fake = createFakeFetch([tokenRoute]);
    const { account: _drop, ...ctx } = makeContext(fake.fetch);
    const fresh = await connector.refreshCredential(ctx);
    expect(fresh).toMatchObject({ kind: "oauth2", accessToken: "fake-access-token-2", refreshToken: "fake-refresh-token" });
    expect(JSON.stringify(fresh)).not.toContain(FAKE_OAUTH.clientSecret);
  });
});

describe("GoogleConnector error mapping", () => {
  const expectCode = async (reply: { status: number; json?: unknown }, code: ConnectorError["code"], retryable: boolean) => {
    const fake = createFakeFetch([{ match: `${GMAIL_API}/profile`, reply }]);
    const error = await collect(connector.syncMail(makeContext(fake.fetch), null)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code, retryable });
  };

  it("429 -> rate_limited (retryable)", () => expectCode({ status: 429, json: { error: { message: "Too many" } } }, "rate_limited", true));
  it("403 quota -> rate_limited (retryable)", () =>
    expectCode({ status: 403, json: { error: { message: "Quota", errors: [{ reason: "userRateLimitExceeded" }] } } }, "rate_limited", true));
  it("403 permission -> unauthorized", () =>
    expectCode({ status: 403, json: { error: { message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } } }, "unauthorized", false));
  it("503 -> provider_unavailable (retryable)", () => expectCode({ status: 503 }, "provider_unavailable", true));

  it("network failure -> provider_unavailable (retryable)", async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(collect(connector.syncMail(makeContext(failing), null))).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
  });
});
