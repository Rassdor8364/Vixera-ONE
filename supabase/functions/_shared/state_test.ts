import assert from "node:assert/strict";
import { DEV_USER_ID } from "@vixera/domain";
import type { FunctionEnv } from "./env.ts";
import { LinkStateError, base64UrlDecode, base64UrlEncode, linkStateSecret, signLinkState, verifyLinkState } from "./state.ts";

const now = new Date("2026-09-10T09:00:00Z");
const secret = "test-secret-not-real";

Deno.test("link state round-trips and carries user + provider + expiry", async () => {
  const { token, expiresAt } = await signLinkState(secret, { userId: DEV_USER_ID, provider: "google" }, now);
  assert.equal(token.split(".").length, 2);
  assert.ok(!token.includes(DEV_USER_ID)); // base64url payload, not plaintext
  const state = await verifyLinkState(secret, token, new Date(now.getTime() + 60_000));
  assert.equal(state.userId, DEV_USER_ID);
  assert.equal(state.provider, "google");
  assert.equal(new Date(state.exp).toISOString(), expiresAt);
  assert.equal(state.exp - now.getTime(), 10 * 60_000);
});

Deno.test("tampered payload, tampered signature and a foreign key are rejected", async () => {
  const { token } = await signLinkState(secret, { userId: DEV_USER_ID, provider: "google" }, now);
  const [payload, sig] = token.split(".") as [string, string];
  const json = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)));
  const forged = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ ...json, userId: "22222222-2222-4222-8222-222222222222" })));
  await assert.rejects(() => verifyLinkState(secret, `${forged}.${sig}`, now), (e: unknown) => e instanceof LinkStateError && e.reason === "signature");
  // Flip a character in the middle: the final char only carries padding bits in base64url.
  const flipped = sig.slice(0, 5) + (sig[5] === "A" ? "B" : "A") + sig.slice(6);
  await assert.rejects(() => verifyLinkState(secret, `${payload}.${flipped}`, now), (e: unknown) => e instanceof LinkStateError && e.reason === "signature");
  await assert.rejects(() => verifyLinkState("another-secret", token, now), (e: unknown) => e instanceof LinkStateError && e.reason === "signature");
  await assert.rejects(() => verifyLinkState(secret, "garbage", now), (e: unknown) => e instanceof LinkStateError && e.reason === "malformed");
  await assert.rejects(() => verifyLinkState(secret, `${payload}.`, now), (e: unknown) => e instanceof LinkStateError && e.reason === "malformed");
});

Deno.test("expired state is rejected", async () => {
  const { token } = await signLinkState(secret, { userId: DEV_USER_ID, provider: "microsoft" }, now, 1000);
  await verifyLinkState(secret, token, new Date(now.getTime() + 500));
  await assert.rejects(() => verifyLinkState(secret, token, new Date(now.getTime() + 1000)), (e: unknown) => e instanceof LinkStateError && e.reason === "expired");
});

Deno.test("the HMAC key comes from VIXERA_LINK_STATE_SECRET, else is derived from the service role key", async () => {
  const base: FunctionEnv = {
    supabaseUrl: "https://x.supabase.co",
    supabaseAnonKey: "anon",
    supabaseServiceRoleKey: "service-role-key",
    google: null,
    microsoft: null,
    plaid: null,
    syncSecret: null,
    linkStateSecret: null,
    functionsUrl: "https://x.supabase.co/functions/v1",
    enableMockConnector: false,
  };
  const derived = await linkStateSecret(base);
  assert.equal(derived, await linkStateSecret(base)); // stable
  assert.notEqual(derived, "service-role-key"); // never the raw key
  assert.notEqual(derived, await linkStateSecret({ ...base, supabaseServiceRoleKey: "other" }));
  assert.equal(await linkStateSecret({ ...base, linkStateSecret: "explicit" }), "explicit");
  await assert.rejects(() => linkStateSecret({ ...base, supabaseServiceRoleKey: null }), { name: "EnvError" });
});
