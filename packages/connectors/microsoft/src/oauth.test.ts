import { ConnectorError } from "@vixera/domain";
import { describe, expect, it } from "vitest";
import { buildAuthorizationUrl, exchangeAuthorizationCode, MICROSOFT_SCOPES, refreshAccessToken, tokenEndpoint } from "./oauth.ts";
import { FAKE_CREDENTIAL, FAKE_OAUTH } from "./testing/context.ts";
import { createFakeFetch } from "./testing/fake-fetch.ts";

const NOW = () => new Date("2026-09-10T12:00:00.000Z");

describe("buildAuthorizationUrl", () => {
  it("targets the common tenant by default with the read-only scope set", () => {
    const url = new URL(buildAuthorizationUrl(FAKE_OAUTH, { state: "anti-csrf" }));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("client_id")).toBe(FAKE_OAUTH.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(FAKE_OAUTH.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("anti-csrf");
    expect(url.searchParams.get("scope")).toBe(MICROSOFT_SCOPES.join(" "));
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.toString()).not.toContain(FAKE_OAUTH.clientSecret);
  });

  it("honors a pinned tenant and a login hint", () => {
    const url = new URL(buildAuthorizationUrl({ ...FAKE_OAUTH, tenant: "organizations" }, { state: "s", loginHint: "me@example.com" }));
    expect(url.pathname).toBe("/organizations/oauth2/v2.0/authorize");
    expect(url.searchParams.get("login_hint")).toBe("me@example.com");
  });
});

describe("exchangeAuthorizationCode", () => {
  it("posts the code with the client secret and returns an oauth2 credential without it", async () => {
    const fake = createFakeFetch([
      {
        match: "/oauth2/v2.0/token",
        method: "POST",
        reply: { json: { token_type: "Bearer", scope: "User.Read Mail.Read Calendars.Read", expires_in: 3600, access_token: "fake-access-1", refresh_token: "fake-refresh-1" } },
      },
    ]);
    const credential = await exchangeAuthorizationCode(fake.fetch, FAKE_OAUTH, "fake-code", NOW);
    const call = fake.calls[0];
    expect(call?.url.toString()).toBe(tokenEndpoint(FAKE_OAUTH));
    const body = new URLSearchParams(call?.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("fake-code");
    expect(body.get("client_secret")).toBe(FAKE_OAUTH.clientSecret);
    expect(body.get("redirect_uri")).toBe(FAKE_OAUTH.redirectUri);
    expect(credential).toEqual({
      kind: "oauth2",
      accessToken: "fake-access-1",
      refreshToken: "fake-refresh-1",
      expiresAt: "2026-09-10T13:00:00.000Z",
      scopes: ["User.Read", "Mail.Read", "Calendars.Read"],
      tokenType: "Bearer",
    });
    expect(JSON.stringify(credential)).not.toContain(FAKE_OAUTH.clientSecret);
  });

  it("maps invalid_grant to unauthorized and keeps the secret out of the message", async () => {
    const fake = createFakeFetch([
      { match: "/oauth2/v2.0/token", reply: { status: 400, json: { error: "invalid_grant", error_description: "AADSTS70000: The code has expired.\r\nTrace ID: x" } } },
    ]);
    const error = await exchangeAuthorizationCode(fake.fetch, FAKE_OAUTH, "stale", NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe("unauthorized");
    expect((error as ConnectorError).retryable).toBe(false);
    expect((error as ConnectorError).message).toContain("invalid_grant");
    expect((error as ConnectorError).message).toContain("AADSTS70000");
    expect((error as ConnectorError).message).not.toContain("Trace ID");
    expect((error as ConnectorError).message).not.toContain(FAKE_OAUTH.clientSecret);
  });

  it("maps 5xx to provider_unavailable and network failures too", async () => {
    const down = createFakeFetch([{ match: "/oauth2/v2.0/token", reply: { status: 503, text: "" } }]);
    await expect(exchangeAuthorizationCode(down.fetch, FAKE_OAUTH, "c", NOW)).rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    const unreachable: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(exchangeAuthorizationCode(unreachable, FAKE_OAUTH, "c", NOW)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("refreshAccessToken", () => {
  it("uses the rotated refresh token when Microsoft sends one, keeps scopes otherwise", async () => {
    const fake = createFakeFetch([
      { match: "/oauth2/v2.0/token", reply: { json: { access_token: "fake-access-2", refresh_token: "fake-refresh-rotated", expires_in: 1800, token_type: "Bearer" } } },
    ]);
    const fresh = await refreshAccessToken(fake.fetch, FAKE_OAUTH, FAKE_CREDENTIAL, NOW);
    const body = new URLSearchParams(fake.calls[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("fake-refresh-token");
    expect(body.get("scope")).toBe(FAKE_CREDENTIAL.kind === "oauth2" ? FAKE_CREDENTIAL.scopes.join(" ") : "");
    expect(fresh).toMatchObject({ kind: "oauth2", accessToken: "fake-access-2", refreshToken: "fake-refresh-rotated", expiresAt: "2026-09-10T12:30:00.000Z" });
    expect(fresh.kind === "oauth2" && fresh.scopes).toEqual(FAKE_CREDENTIAL.kind === "oauth2" ? FAKE_CREDENTIAL.scopes : []);
  });

  it("keeps the previous refresh token when the response has none", async () => {
    const fake = createFakeFetch([{ match: "/oauth2/v2.0/token", reply: { json: { access_token: "fake-access-3", expires_in: 60 } } }]);
    const fresh = await refreshAccessToken(fake.fetch, FAKE_OAUTH, FAKE_CREDENTIAL, NOW);
    expect(fresh.kind === "oauth2" && fresh.refreshToken).toBe("fake-refresh-token");
  });

  it("refuses to refresh a credential without a refresh token", async () => {
    const fake = createFakeFetch([]);
    await expect(refreshAccessToken(fake.fetch, FAKE_OAUTH, { kind: "access_token", accessToken: "x" }, NOW)).rejects.toMatchObject({ code: "unauthorized" });
    expect(fake.calls).toHaveLength(0);
  });
});
