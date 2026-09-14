import { ConnectorError } from "@vixera/domain";
import { describe, expect, it } from "vitest";
import { GRAPH_API, GraphApiClient } from "./http.ts";
import { FAKE_CREDENTIAL, FAKE_OAUTH, makeContext } from "./testing/context.ts";
import { createFakeFetch, type FakeReply, type FakeRoute } from "./testing/fake-fetch.ts";

const RESOURCE = `${GRAPH_API}/me/messages/AAMkAGfake/attachments`;
const REJECTED: FakeReply = { status: 401, json: { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } } };

/** 200 for the given bearer, 401 for anything else. */
function acceptOnly(token: string): FakeRoute {
  return { match: RESOURCE, reply: ({ call }) => (call.headers.authorization === `Bearer ${token}` ? { json: { value: [], token } } : REJECTED) };
}

function tokenRoute(accessToken: string, expiresIn = 3600, gate: Promise<void> = Promise.resolve()): FakeRoute {
  return { match: "/oauth2/v2.0/token", reply: async () => (await gate, { json: { access_token: accessToken, refresh_token: "fake-refresh-2", expires_in: expiresIn } }) };
}

describe("GraphApiClient refresh", () => {
  it("shares one in-flight refresh across concurrent 401s instead of failing the late ones as unauthorized", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fake = createFakeFetch([tokenRoute("fake-access-token-2", 3600, gate), acceptOnly("fake-access-token-2")]);
    const ctx = makeContext(fake.fetch);
    const client = new GraphApiClient(ctx, FAKE_OAUTH);

    // Four requests go out on the old token at once (the attachment fetch runs 4-wide); all four 401.
    const inFlight = Promise.all([1, 2, 3, 4].map(() => client.getJson<{ token: string }>(RESOURCE).then((r) => r.body?.token ?? "?", (e: unknown) => (e as ConnectorError).code)));
    // Let the 401s land and the refresh start before the token endpoint answers.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(1);
    release();

    expect(await inFlight).toEqual(["fake-access-token-2", "fake-access-token-2", "fake-access-token-2", "fake-access-token-2"]);
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(1);
    expect(ctx.refreshed).toHaveLength(1);
    // Every request was retried exactly once, with the refreshed bearer.
    const retries = fake.callsTo(RESOURCE).filter((c) => c.headers.authorization === "Bearer fake-access-token-2");
    expect(retries).toHaveLength(4);
    expect(client.credential).toMatchObject({ kind: "oauth2", accessToken: "fake-access-token-2" });
  });

  it("refreshes again when the refreshed credential's own lifetime has elapsed mid-run", async () => {
    let now = new Date("2026-09-10T12:00:00.000Z");
    let issued = 0;
    const fake = createFakeFetch([
      { match: "/oauth2/v2.0/token", reply: () => ({ json: { access_token: `fake-access-token-${++issued + 1}`, refresh_token: `fake-refresh-${issued + 1}`, expires_in: 600 } }) },
      { match: RESOURCE, reply: ({ call }) => (call.headers.authorization === `Bearer fake-access-token-${issued + 1}` && issued > 0 ? { json: { value: [] } } : REJECTED) },
    ]);
    const ctx = makeContext(fake.fetch, { now: () => now });
    const client = new GraphApiClient(ctx, FAKE_OAUTH);

    await client.getJson(RESOURCE); // 401 → refresh (token 2, valid 10 min) → retry ok
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(1);

    now = new Date("2026-09-10T12:05:00.000Z");
    await client.getJson(RESOURCE); // token 2 still valid: no refresh
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(1);

    // 20 minutes later token 2 has expired by its own expiresAt: a long run refreshes once more instead of ending unauthorized.
    now = new Date("2026-09-10T12:20:00.000Z");
    await client.getJson(RESOURCE);
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(2);
    expect(ctx.refreshed.map((c) => (c.kind === "oauth2" ? c.accessToken : ""))).toEqual(["fake-access-token-2", "fake-access-token-3"]);
    expect(fake.callsTo(RESOURCE).at(-1)?.headers.authorization).toBe("Bearer fake-access-token-3");
  });

  it("still gives up as unauthorized when the refreshed credential is rejected too, without a second refresh", async () => {
    const fake = createFakeFetch([tokenRoute("fake-access-token-2"), { match: RESOURCE, reply: REJECTED }]);
    const client = new GraphApiClient(makeContext(fake.fetch), FAKE_OAUTH);
    const errors = await Promise.all([client.getJson(RESOURCE).catch((e: unknown) => e), client.getJson(RESOURCE).catch((e: unknown) => e)]);
    for (const error of errors) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as ConnectorError).code).toBe("unauthorized");
    }
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(1);
    // A later request on the same client does not refresh again either: the credential is live by its clock and Graph rejects it.
    await expect(client.getJson(RESOURCE)).rejects.toMatchObject({ code: "unauthorized" });
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(1);
  });

  it("maps 403 to unauthorized (needs_reauth) with the Graph error code in the message", async () => {
    const fake = createFakeFetch([{ match: RESOURCE, reply: { status: 403, json: { error: { code: "ErrorAccessDenied", message: "Access is denied." } } } }]);
    const client = new GraphApiClient(makeContext(fake.fetch), FAKE_OAUTH);
    const error = await client.getJson(RESOURCE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect(error).toMatchObject({ code: "unauthorized", retryable: false });
    expect((error as ConnectorError).message).toContain("ErrorAccessDenied");
    expect(fake.callsTo("/oauth2/v2.0/token")).toHaveLength(0);
  });

  it("refuses api_key credentials before sending anything", async () => {
    const fake = createFakeFetch([{ match: RESOURCE, reply: { json: {} } }]);
    const client = new GraphApiClient(makeContext(fake.fetch, { credential: { kind: "api_key", apiKey: "nope" } as never }), FAKE_OAUTH);
    await expect(client.getJson(RESOURCE)).rejects.toMatchObject({ code: "unsupported" });
    expect(fake.calls).toHaveLength(0);
    expect(FAKE_CREDENTIAL.kind).toBe("oauth2");
  });
});
