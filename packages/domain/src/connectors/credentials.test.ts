import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore, isExpired, redact } from "./credentials.ts";

describe("CredentialStore", () => {
  it("returns an opaque ref and round-trips a credential", async () => {
    const store = new InMemoryCredentialStore();
    const ref = await store.put(null, { kind: "api_key", apiKey: "secret" });
    expect(ref).not.toContain("secret");
    expect(await store.get(ref)).toEqual({ kind: "api_key", apiKey: "secret" });
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  });

  it("overwrites in place when a ref is supplied", async () => {
    const store = new InMemoryCredentialStore();
    const ref = await store.put(null, { kind: "access_token", accessToken: "a" });
    const same = await store.put(ref, { kind: "access_token", accessToken: "b" });
    expect(same).toBe(ref);
    expect(store.size).toBe(1);
  });

  it("detects expiry with skew", () => {
    const now = new Date("2026-09-10T12:00:00Z");
    const soon = { kind: "oauth2" as const, accessToken: "x", refreshToken: null, expiresAt: "2026-09-10T12:00:30Z", scopes: [] };
    expect(isExpired(soon, now)).toBe(true);
    expect(isExpired({ ...soon, expiresAt: "2026-09-10T13:00:00Z" }, now)).toBe(false);
    expect(isExpired({ kind: "api_key", apiKey: "k" }, now)).toBe(false);
  });

  it("never prints secrets", () => {
    expect(redact({ kind: "api_key", apiKey: "topsecret" })).not.toContain("topsecret");
    expect(redact({ kind: "oauth2", accessToken: "tok", refreshToken: "r", expiresAt: null, scopes: ["mail"] })).not.toContain("tok");
  });
});
