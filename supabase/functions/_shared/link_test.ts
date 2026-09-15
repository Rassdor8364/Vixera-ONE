import assert from "node:assert/strict";
import { ConnectorError, ConnectorRegistry, DEV_USER_ID, InMemoryCredentialStore, type Connector, type ConnectorCredential, type UserId } from "@vixera/domain";
import { InMemorySpineStore, MOCK_NOW, MockConnector, tickingClock } from "@vixera/sync";
import { createPlaidBankConnector } from "@vixera/connector-bank";
import plaidItem from "../../../packages/connectors/bank/src/__fixtures__/plaid-item.json" with { type: "json" };
import type { FunctionEnv } from "./env.ts";
import { HttpError } from "./http.ts";
import { completeOAuthCallback, completePlaidLink, disconnectAccount, linkResultPage, persistLinkedAccount, startOAuthLink, startPlaidLink, type LinkDeps } from "./link.ts";
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
    credentialsFor: () => ({ putForAccount: (accountId, credential, ref) => vault.put(ref ?? `vault:${accountId}`, credential), get: (ref) => vault.get(ref) }),
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

Deno.test("callback: a grant the connector cannot use is a 400 with the connector's message, and nothing is persisted", async () => {
  const w = world();
  const refusing: Connector = { provider: "google", capabilities: ["mail", "calendar"], discoverAccount: () => Promise.reject(new ConnectorError("unsupported", "Google grant includes neither Gmail nor Calendar access; re-link and allow at least one", false)) };
  const deps: LinkDeps = { ...w.deps, registry: new ConnectorRegistry().register(refusing) };
  const { token } = await signLinkState("state-secret", { userId: DEV_USER_ID, provider: "google" }, w.clock());
  const err = await completeOAuthCallback(deps, { code: "code-1", state: token, error: null }).catch((e: unknown) => e as HttpError);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 400);
  assert.match(err.message, /neither Gmail nor Calendar/);
  assert.equal((await w.store.listConnectorAccounts()).length, 0);
});

Deno.test("disconnect: only the user's own accounts; re-link after disconnect re-enables sync states", async () => {
  const w = world();
  const account = await persistLinkedAccount(w.deps, DEV_USER_ID, "google", { externalAccountId: "google-sub-1", label: "Me", address: "me@gmail.example", capabilities: ["mail"] }, { kind: "api_key", apiKey: "k" });
  // The old credential failed three times; the engine would hold this capability for 40 minutes.
  await w.store.upsertSyncState(account.id, "mail", { enabled: false, status: "error", lastError: "unauthorized", consecutiveFailures: 3 });
  await assert.rejects(() => disconnectAccount(w.deps, DEV_USER_ID, crypto.randomUUID()), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.deepEqual(await disconnectAccount(w.deps, DEV_USER_ID, account.id), { ok: true });
  assert.deepEqual(w.disconnected, [account.id]);
  const relinked = await persistLinkedAccount(w.deps, DEV_USER_ID, "google", { externalAccountId: "google-sub-1", label: "Me", address: "me@gmail.example", capabilities: ["mail"] }, { kind: "api_key", apiKey: "k2" });
  assert.equal(relinked.id, account.id);
  assert.equal(relinked.status, "active");
  const state = await w.store.getSyncState(account.id, "mail");
  assert.equal(state?.enabled, true);
  // A fresh credential is a fresh start: no backoff carried over from the old one.
  assert.equal(state?.status, "idle");
  assert.equal(state?.consecutiveFailures, 0);
  assert.equal(state?.lastError, null);
});

Deno.test("result page: plain HTML, escaped, no secrets", () => {
  const ok = linkResultPage(true, "");
  assert.ok(ok.includes("Connected — return to Vixera One."));
  const bad = linkResultPage(false, '<script>alert("x")</script>');
  assert.ok(!bad.includes("<script>"));
  assert.ok(bad.includes("&lt;script&gt;"));
});

// ---------------------------------------------------------------------------
// Plaid: repairing a parked Item through Link update mode
// ---------------------------------------------------------------------------
const PLAID_ENV = { clientId: "plaid-id", secret: "plaid-secret-value", environment: "sandbox" as const };
const PLAID_ACCESS_TOKEN = "access-sandbox-fake-token-1";

type Route = (body: Record<string, unknown>) => { status?: number; json: unknown };

/** A Plaid the test controls: routes by pathname, every call recorded (never the secret in a log). */
function fakePlaid(routes: Record<string, Route>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path: url.pathname, body });
    const route = routes[url.pathname];
    if (!route) return new Response(JSON.stringify({ error_type: "INVALID_REQUEST", error_code: "INVALID_FIELD", error_message: `no fake route for ${url.pathname}` }), { status: 400, headers: { "content-type": "application/json" } });
    const res = route(body);
    return new Response(JSON.stringify(res.json), { status: res.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, callsTo: (path: string) => calls.filter((c) => c.path === path) };
}

const finishedSession = { link_sessions: [{ link_session_id: "s1", finished_at: "2026-09-10T12:05:00Z", on_success: { public_token: "public-sandbox-should-not-be-exchanged" }, on_exit: null, results: { item_add_results: [] } }] };
const linkTokenRoute: Route = (body) => ({ json: { link_token: body.access_token ? "link-sandbox-update" : "link-sandbox-new", expiration: "2026-09-10T16:00:00Z", hosted_link_url: "https://hosted.plaid.com/link/fake" } });
const healthyItem: Route = () => ({ json: plaidItem });

async function plaidWorld(routes: Record<string, Route>, park: { code?: string | null; status?: "needs_reauth" | "active" } = {}) {
  const base = world();
  const plaid = fakePlaid(routes);
  const deps: LinkDeps = { ...base.deps, env: { ...env, plaid: PLAID_ENV }, registry: new ConnectorRegistry().register(createPlaidBankConnector(PLAID_ENV)), fetch: plaid.fetchImpl };
  const account = await base.store.createConnectorAccount({
    provider: "plaid",
    externalAccountId: plaidItem.item.item_id,
    label: "Example Bank",
    address: null,
    capabilities: ["bank"],
    status: park.status ?? "needs_reauth",
    credentialLocation: "server_vault",
    credentialRef: null,
    lastError: "Plaid /transactions/sync rejected the credential (ITEM_LOGIN_REQUIRED)",
    metadata: { institutionName: "Example Bank", reauthCode: park.code === undefined ? "ITEM_LOGIN_REQUIRED" : park.code, reauthAt: "2026-09-10T11:00:00Z" },
  });
  const credentialRef = await base.vault.put(`vault:${account.id}`, { kind: "access_token", accessToken: PLAID_ACCESS_TOKEN, expiresAt: null });
  await base.store.updateConnectorAccount(account.id, { credentialRef });
  await base.store.upsertSyncState(account.id, "bank", { enabled: true, status: "error", checkpoint: { cursor: "fake-cursor-page-3" }, consecutiveFailures: 3, lastError: "unauthorized" });
  return { ...base, deps, plaid, account: (await base.store.getConnectorAccount(account.id))! };
}

Deno.test("plaid relink: start opens Link update mode on the stored credential; complete re-describes the same Item without an exchange and reactivates the row with its checkpoint", async () => {
  const w = await plaidWorld({ "/link/token/create": linkTokenRoute, "/link/token/get": () => ({ json: finishedSession }), "/item/get": healthyItem });
  const start = await startPlaidLink(w.deps, DEV_USER_ID, { connectorAccountId: w.account.id });
  assert.equal(start.connectorAccountId, w.account.id);
  assert.equal(start.linkToken, "link-sandbox-update");
  assert.equal(start.hostedLinkUrl, "https://hosted.plaid.com/link/fake");
  const create = w.plaid.callsTo("/link/token/create")[0]!;
  assert.equal(create.body.access_token, PLAID_ACCESS_TOKEN);
  assert.equal(create.body.products, undefined, "update mode sends no products");
  assert.deepEqual(create.body.hosted_link, {});
  assert.equal(create.body.user && (create.body.user as { client_user_id: string }).client_user_id, DEV_USER_ID);

  const { account } = await completePlaidLink(w.deps, DEV_USER_ID, { publicToken: null, linkToken: start.linkToken, connectorAccountId: w.account.id });
  assert.equal(account.id, w.account.id, "the same row, not a second Item");
  assert.equal(account.status, "active");
  assert.equal(account.lastError, null);
  assert.equal(account.credentialRef, w.account.credentialRef, "the Vault secret was replaced in place");
  assert.equal(account.metadata.reauthCode, undefined);
  assert.equal(account.metadata.reauthAt, undefined);
  assert.equal(account.metadata.institutionName, "Example Bank");
  assert.equal(w.plaid.callsTo("/item/public_token/exchange").length, 0, "an update-mode public token is never exchanged");
  assert.equal((await w.store.listConnectorAccounts()).length, 1);
  const state = (await w.store.getSyncState(account.id, "bank"))!;
  assert.deepEqual(state.checkpoint, { cursor: "fake-cursor-page-3" });
  assert.equal(state.enabled, true);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.status, "idle");
  assert.deepEqual(await w.vault.get(account.credentialRef!), { kind: "access_token", accessToken: PLAID_ACCESS_TOKEN, expiresAt: null });
});

Deno.test("plaid relink: refused when Plaid no longer knows the Item, when the account is not parked, and for an unknown id", async () => {
  const gone = await plaidWorld({ "/link/token/create": linkTokenRoute }, { code: "INVALID_ACCESS_TOKEN" });
  const err = await startPlaidLink(gone.deps, DEV_USER_ID, { connectorAccountId: gone.account.id }).catch((e: unknown) => e as HttpError);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 409);
  assert.equal(err.code, "relink_impossible");
  assert.match(err.message, /INVALID_ACCESS_TOKEN/);
  assert.equal(gone.plaid.calls.length, 0, "nothing was asked of Plaid");

  const active = await plaidWorld({ "/link/token/create": linkTokenRoute }, { status: "active", code: null });
  const conflict = await startPlaidLink(active.deps, DEV_USER_ID, { connectorAccountId: active.account.id }).catch((e: unknown) => e as HttpError);
  assert.ok(conflict instanceof HttpError && conflict.status === 409 && conflict.code === "conflict");

  const missing = await startPlaidLink(active.deps, DEV_USER_ID, { connectorAccountId: crypto.randomUUID() }).catch((e: unknown) => e as HttpError);
  assert.ok(missing instanceof HttpError && missing.status === 404);
});

Deno.test("plaid relink: an unfinished session is 409, a session the person left is 400, and an Item still in error stays parked", async () => {
  const unfinished = await plaidWorld({ "/link/token/get": () => ({ json: { link_sessions: [{ link_session_id: "s1", finished_at: null }] } }), "/item/get": healthyItem });
  const notYet = await completePlaidLink(unfinished.deps, DEV_USER_ID, { publicToken: null, linkToken: "link-sandbox-update", connectorAccountId: unfinished.account.id }).catch((e: unknown) => e as HttpError);
  assert.ok(notYet instanceof HttpError && notYet.status === 409 && notYet.code === "conflict");
  assert.equal(unfinished.plaid.callsTo("/item/get").length, 0);

  const left = await plaidWorld({ "/link/token/get": () => ({ json: { link_sessions: [{ link_session_id: "s1", finished_at: "2026-09-10T12:05:00Z", on_exit: { error: { error_code: "INVALID_CREDENTIALS" } } }] } }), "/item/get": healthyItem });
  const exited = await completePlaidLink(left.deps, DEV_USER_ID, { publicToken: null, linkToken: "link-sandbox-update", connectorAccountId: left.account.id }).catch((e: unknown) => e as HttpError);
  assert.ok(exited instanceof HttpError && exited.status === 400);
  assert.match(exited.message, /INVALID_CREDENTIALS/);

  const broken = await plaidWorld({
    "/link/token/get": () => ({ json: finishedSession }),
    "/item/get": () => ({ json: { ...plaidItem, item: { ...plaidItem.item, error: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "the login details of this item have changed" } } } }),
  });
  const still = await completePlaidLink(broken.deps, DEV_USER_ID, { publicToken: null, linkToken: "link-sandbox-update", connectorAccountId: broken.account.id }).catch((e: unknown) => e as HttpError);
  assert.ok(still instanceof HttpError && still.status === 409 && still.code === "conflict");
  assert.match(still.message, /ITEM_LOGIN_REQUIRED/);
  assert.equal((await broken.store.getConnectorAccount(broken.account.id))?.status, "needs_reauth");
});

Deno.test("plaid: a fresh link goes through the package client (hosted first, plain when Plaid refuses hosted) and never touches a parked row", async () => {
  let hostedRefused = true;
  const w = await plaidWorld({
    "/link/token/create": (body) => (hostedRefused && body.hosted_link ? ((hostedRefused = false), { status: 400, json: { error_type: "INVALID_REQUEST", error_code: "INVALID_FIELD", error_message: "hosted_link not enabled" } }) : { json: { link_token: "link-sandbox-new", expiration: "2026-09-10T16:00:00Z" } }),
  });
  const start = await startPlaidLink(w.deps, DEV_USER_ID);
  assert.equal(start.connectorAccountId, null);
  assert.equal(start.linkToken, "link-sandbox-new");
  assert.equal(start.hostedLinkUrl, null);
  const creates = w.plaid.callsTo("/link/token/create");
  assert.equal(creates.length, 2);
  assert.deepEqual(creates[0]!.body.hosted_link, {});
  assert.equal(creates[1]!.body.hosted_link, undefined);
  assert.deepEqual(creates[1]!.body.products, ["transactions"]);
  assert.equal(creates[1]!.body.access_token, undefined);
});
