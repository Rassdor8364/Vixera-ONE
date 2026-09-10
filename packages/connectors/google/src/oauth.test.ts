import { describe, expect, it } from "vitest";
import { GOOGLE_SCOPES, GOOGLE_TOKEN_ENDPOINT, buildAuthorizationUrl, exchangeAuthorizationCode, refreshAccessToken } from "./oauth.ts";
import { FAKE_CREDENTIAL, FAKE_OAUTH } from "./testing/context.ts";
import { createFakeFetch } from "./testing/fake-fetch.ts";

const now = () => new Date("2026-09-10T12:00:00.000Z");

describe("buildAuthorizationUrl", () => {
  it("asks for offline access with forced consent and the requested scopes", () => {
    const url = new URL(buildAuthorizationUrl(FAKE_OAUTH, { scopes: GOOGLE_SCOPES, state: "state-123", loginHint: "me@example.com" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(FAKE_OAUTH.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(FAKE_OAUTH.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("login_hint")).toBe("me@example.com");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...GOOGLE_SCOPES]);
    expect(url.toString()).not.toContain(FAKE_OAUTH.clientSecret);
  });
});

describe("exchangeAuthorizationCode", () => {
  it("posts the code with the secret and returns an oauth2 credential with computed expiry", async () => {
    const fake = createFakeFetch([
      {
        match: GOOGLE_TOKEN_ENDPOINT,
        method: "POST",
        reply: { json: { access_token: "fake-access-token-x", expires_in: 3599, refresh_token: "fake-refresh-x", scope: "openid https://www.googleapis.com/auth/gmail.readonly", token_type: "Bearer" } },
      },
    ]);
    const cred = await exchangeAuthorizationCode(fake.fetch, FAKE_OAUTH, "auth-code-1", now);
    expect(cred).toEqual({
      kind: "oauth2",
      accessToken: "fake-access-token-x",
      refreshToken: "fake-refresh-x",
      expiresAt: "2026-09-10T12:59:59.000Z",
      scopes: ["openid", "https://www.googleapis.com/auth/gmail.readonly"],
      tokenType: "Bearer",
    });
    const body = new URLSearchParams(fake.calls[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("client_secret")).toBe(FAKE_OAUTH.clientSecret);
    expect(body.get("redirect_uri")).toBe(FAKE_OAUTH.redirectUri);
    expect(JSON.stringify(cred)).not.toContain(FAKE_OAUTH.clientSecret);
  });

  it("maps invalid_grant to a non-retryable unauthorized error", async () => {
    const fake = createFakeFetch([{ match: GOOGLE_TOKEN_ENDPOINT, reply: { status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } } }]);
    await expect(exchangeAuthorizationCode(fake.fetch, FAKE_OAUTH, "bad", now)).rejects.toMatchObject({ code: "unauthorized", retryable: false });
  });
});

describe("refreshAccessToken", () => {
  it("keeps the refresh token and scopes when Google omits them", async () => {
    const fake = createFakeFetch([{ match: GOOGLE_TOKEN_ENDPOINT, reply: { json: { access_token: "fake-access-token-2", expires_in: 3600, token_type: "Bearer" } } }]);
    const cred = await refreshAccessToken(fake.fetch, FAKE_OAUTH, FAKE_CREDENTIAL, now);
    expect(cred).toMatchObject({ kind: "oauth2", accessToken: "fake-access-token-2", refreshToken: "fake-refresh-token", expiresAt: "2026-09-10T13:00:00.000Z" });
    expect(cred.kind === "oauth2" && cred.scopes).toEqual(FAKE_CREDENTIAL.kind === "oauth2" ? FAKE_CREDENTIAL.scopes : []);
    const body = new URLSearchParams(fake.calls[0]?.body ?? "");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("fake-refresh-token");
  });

  it("refuses to refresh a credential without a refresh token", async () => {
    const fake = createFakeFetch([]);
    await expect(refreshAccessToken(fake.fetch, FAKE_OAUTH, { kind: "access_token", accessToken: "x" }, now)).rejects.toMatchObject({ code: "unauthorized" });
    expect(fake.calls).toHaveLength(0);
  });
});
