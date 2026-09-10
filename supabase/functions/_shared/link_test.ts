import assert from "node:assert/strict";
import { ConnectorRegistry, DEV_USER_ID, InMemoryCredentialStore, type Connector, type ConnectorCredential, type UserId } from "@vixera/domain";
import { InMemorySpineStore, MOCK_NOW, MockConnector, tickingClock } from "@vixera/sync";
import type { FunctionEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import { completeOAuthCallback, disconnectAccount, linkResultPage, persistLinkedAccount, startOAuthLink, type LinkDeps } from "./link.ts";
import { signLinkState } from "./state.ts";

const env: FunctionEnv = {
  supabaseUrl: "https://x.supabase.co",
  supabaseAnonKey: "anon",
  supabaseServiceRoleKey: "service",
  google: { clientId: "google-id", clientSecret: "google-secret-value" },
  microsoft: null,
  plaid: null,
  syncSecret: null,
  linkStateSecret: "state-secret",
  functionsUrl: "https://x.supabase.co/functions/v1",
  enableMockConnector: false,
};

/** A Google-shaped connector that never touches the network. */
function fakeGoogle(): Connector {
  const mock = new MockConnector({ externalAccountId: "google-sub-1", address: "me@gmail.example" });
  return { provider: "google", capabilities: mock.capabilities, discoverAccount: () => mock.discoverAccount() };
}

function world() {
  const clock = tickingClock(MOCK_NOW, 1000);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  const vault = new InMemoryCredentialStore();
  const disconnected: string[] = [];
  const exchanges: string[] = [];
  const deps: LinkDeps = {
    env,
    registry: new ConnectorRegistry().register(fakeGoogle()),
    stateSecret: "state-secret",
    storeFor: (userId: UserId) => {
      assert.equal(userId, DEV_USER_ID);
      return store;
    },
    credentialsFor: () => ({ putForAccount: (accountId, credential) => vault.put(`vault:${accountId}`, credential) }),
    disconnect: async (_userId, accountId) => {
      disconnected.push(accountId);
      await store.updateConnectorAccount(accountId, { status: "disconnected", credentialRef: null, credentialLocation: "none" });
    },
    fetch: (() => Promise.reject(new Error("no network in tests"))) as unknown as typeof fetch,
    now: clock,
    exchangeCode: (_provider, code) => {
      exchanges.push(code);
      const credential: ConnectorCredential = { kind: "oauth2", accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: null, scopes: ["mail"] };
      return Promise.resolve(credential);
    },
  };
  return { store, vault, deps, disconnected, exchanges, clock };
}

Deno.test("start: consent URL carries the redirect URI, scopes and a signed state; unconfigured providers are refused", async () => {
  const w = world();
  const start = await startOAuthLink(w.deps, DEV_USER_ID, "google");
  const url = new URL(start.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("redirect_uri"), "https://x.supabase.co/functions/v1/connector-link/callback");
  assert.equal(url.searchParams.get("client_id"), "google-id");
  assert.ok(!start.authorizationUrl.includes("google-secret-value"));
  assert.ok(url.searchParams.get("state")?.includes("."));
  assert.ok(Date.parse(start.expiresAt) > MOCK_NOW.getTime());
  await assert.rejects(() => startOAuthLink(w.deps, DEV_USER_ID, "microsoft"), (e: unknown) => e instanceof HttpError && e.code === "provider_not_configured");
});

Deno.test("callback: exchanges the code, creates the account, stores the credential ref, creates sync states", async () => {
  const w = world();
  const { token } = await signLinkState("state-secret", { userId: DEV_USER_ID, provider: "google" }, w.clock());
  const { provider, account } = await completeOAuthCallback(w.deps, { code: "auth-code", state: token, error: null });
  assert.equal(provider, "google");
  assert.deepEqual(w.exchanges, ["auth-code"]);
  assert.equal(account.provider, "google");
  assert.equal(account.externalAccountId, "google-sub-1");
  assert.equal(account.address, "me@gmail.example");
  assert.equal(account.status, "active");
  assert.equal(account.credentialLocation, "server_vault");
  assert.equal(account.credentialRef, `vault:${account.id}`);
  assert.deepEqual((await w.vault.get(account.credentialRef!))?.kind, "oauth2");
  const states = await w.store.listSyncStates(account.id);
  assert.deepEqual(states.map((s) => s.capability).sort(), ["bank", "calendar", "mail"]);
  assert.ok(states.every((s) => s.enabled && s.status === "idle"));

  // Re-linking the same provider account updates in place (unique user+provider+external id) and keeps one row.
  const { token: token2 } = await signLinkState("state-secret", { userId: DEV_USER_ID, provider: "google" }, w.clock());
  const again = await completeOAuthCallback(w.deps, { code: "auth-code-2", state: token2, error: null });
  assert.equal(again.account.id, account.id);
  assert.equal((await w.store.listConnectorAccounts()).length, 1);
});

Deno.test("callback: bad / expired state and provider errors are 400s and never exchange a code", async () => {
  const w = world();
  await assert.rejects(() => completeOAuthCallback(w.deps, { code: "c", state: null, error: null }), (e: unknown) => e instanceof HttpError && e.code === "invalid_state");
  await assert.rejects(() => completeOAuthCallback(w.deps, { code: "c", state: "nope.nope", error: null }), (e: unknown) => e instanceof HttpError && e.code === "invalid_state");
  const { token: expired } = await signLinkState("state-secret", { userId: DEV_USER_ID, provider: "google" }, new Date(MOCK_NOW.getTime() - 3600_000));
  await assert.rejects(() => completeOAuthCallback(w.deps, { code: "c", state: expired, error: null }), (e: unknown) => e instanceof HttpError && e.status === 400 && /expired/.test(e.message));
  const { token: foreign } = await signLinkState("other-secret", { userId: DEV_USER_ID, provider: "google" }, w.clock());
  await assert.rejects(() => completeOAuthCallback(w.deps, { code: "c", state: foreign, error: null }), (e: unknown) => e instanceof HttpError && e.code === "invalid_state");
  const { token } = await signLinkState("state-secret", { userId: DEV_USER_ID, provider: "google" }, w.clock());
  await assert.rejects(() => completeOAuthCallback(w.deps, { code: null, state: token, error: "access_denied" }), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.deepEqual(w.exchanges, []);
});

Deno.test("disconnect: only the user's own accounts; re-link after disconnect re-enables sync states", async () => {
  const w = world();
  const account = await persistLinkedAccount(w.deps, DEV_USER_ID, "google", { externalAccountId: "google-sub-1", label: "Me", address: "me@gmail.example", capabilities: ["mail"] }, { kind: "api_key", apiKey: "k" });
  await w.store.upsertSyncState(account.id, "mail", { enabled: false });
  await assert.rejects(() => disconnectAccount(w.deps, DEV_USER_ID, crypto.randomUUID()), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.deepEqual(await disconnectAccount(w.deps, DEV_USER_ID, account.id), { ok: true });
  assert.deepEqual(w.disconnected, [account.id]);
  const relinked = await persistLinkedAccount(w.deps, DEV_USER_ID, "google", { externalAccountId: "google-sub-1", label: "Me", address: "me@gmail.example", capabilities: ["mail"] }, { kind: "api_key", apiKey: "k2" });
  assert.equal(relinked.id, account.id);
  assert.equal(relinked.status, "active");
  assert.equal((await w.store.getSyncState(account.id, "mail"))?.enabled, true);
});

Deno.test("result page: plain HTML, escaped, no secrets", () => {
  const ok = linkResultPage(true, "");
  assert.ok(ok.includes("Connected — return to Vixera One."));
  const bad = linkResultPage(false, '<script>alert("x")</script>');
  assert.ok(!bad.includes("<script>"));
  assert.ok(bad.includes("&lt;script&gt;"));
});
