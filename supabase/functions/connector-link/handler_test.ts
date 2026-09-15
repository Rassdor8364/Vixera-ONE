import assert from "node:assert/strict";
import { DEV_USER_ID, type UserId } from "@vixera/domain";
import { emptyCounts } from "@vixera/sync";
import { HttpError } from "../_shared/http.ts";
import type { BudgetedSyncReport } from "../_shared/sync.ts";

const USER = DEV_USER_ID as UserId;
const BASE = "https://x.supabase.co/functions/v1";

/** The production `userRequest`, reduced to its contract: one token is a session, anything else is 401. */
function fakeUserRequest(req: Request): Promise<{ userId: UserId }> {
  if (req.headers.get("authorization") === "Bearer user-token") return Promise.resolve({ userId: USER });
  return Promise.reject(new HttpError(401, "unauthorized", "Invalid or expired session"));
}

function report(overrides: Partial<BudgetedSyncReport> = {}): BudgetedSyncReport {
  return { startedAt: "2026-09-10T12:00:00.000Z", finishedAt: "2026-09-10T12:00:01.000Z", durationMs: 1000, accounts: 1, outcomes: [], ok: 0, errors: 0, skipped: 0, interrupted: 0, counts: emptyCounts(), skippedForBudget: 0, ...overrides };
}
import { ConnectorRegistry, InMemoryCredentialStore, type Connector } from "@vixera/domain";
import { InMemorySpineStore, MOCK_NOW, MockConnector, mockAccountInput, tickingClock } from "@vixera/sync";
import type { FunctionEnv } from "../_shared/env.ts";
import type { LinkDeps } from "../_shared/link.ts";
import { connectorLinkHandler, type ConnectorLinkDeps } from "./handler.ts";

const env: FunctionEnv = {
  supabaseUrl: "https://x.supabase.co",
  supabaseAnonKey: "anon",
  supabaseServiceRoleKey: "service",
  google: { clientId: "google-id", clientSecret: "google-secret-value" },
  microsoft: null,
  plaid: null,
  syncSecret: null,
  linkStateSecret: "state-secret",
  functionsUrl: BASE,
  enableMockConnector: false,
};

function fakeGoogle(): Connector {
  const mock = new MockConnector({ externalAccountId: "google-sub-1", address: "me@gmail.example" });
  return { provider: "google", capabilities: mock.capabilities, discoverAccount: () => mock.discoverAccount() };
}

function world() {
  const clock = tickingClock(MOCK_NOW, 1000);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  const vault = new InMemoryCredentialStore();
  const disconnected: string[] = [];
  const link: LinkDeps = {
    env,
    registry: new ConnectorRegistry().register(fakeGoogle()),
    stateSecret: "state-secret",
    storeFor: () => store,
    credentialsFor: () => ({ putForAccount: (accountId, credential, ref) => vault.put(ref ?? `vault:${accountId}`, credential), get: (ref) => vault.get(ref) }),
    disconnect: (_userId, accountId) => {
      disconnected.push(accountId);
      return Promise.resolve();
    },
    fetch: () => Promise.reject(new Error("no network in tests")),
    now: clock,
    log: () => {},
  };
  const deps: ConnectorLinkDeps = { userRequest: fakeUserRequest, linkDeps: () => Promise.resolve(link), log: () => {} };
  return { handler: connectorLinkHandler(deps), store, disconnected };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/connector-link/`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const asUser = { authorization: "Bearer user-token" };

Deno.test("connector-link: the POST steps need a session; provider and step are validated before anything is built", async () => {
  const w = world();
  assert.equal((await w.handler(post({ provider: "google", step: "start" }))).status, 401);
  for (const body of [{ provider: "dropbox", step: "start" }, { provider: "google", step: "complete" }, { provider: "google", step: "disconnect", connectorAccountId: "nope" }, { provider: "plaid", step: "dance" }, { provider: "plaid", step: "start", connectorAccountId: 7 }]) {
    const res = await w.handler(post(body, asUser));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, "bad_request");
  }
  assert.deepEqual(w.disconnected, []);
});

Deno.test("connector-link: start returns the provider's authorization URL with a signed state, and disconnect goes through the server-side routine", async () => {
  const w = world();
  const res = await w.handler(post({ provider: "google", step: "start" }, asUser));
  assert.equal(res.status, 200);
  const { authorizationUrl, expiresAt } = await res.json();
  const url = new URL(authorizationUrl);
  assert.equal(url.searchParams.get("client_id"), "google-id");
  assert.equal(url.searchParams.get("redirect_uri"), `${BASE}/connector-link/callback`);
  assert.ok((url.searchParams.get("state") ?? "").length > 20);
  assert.ok(!authorizationUrl.includes("google-secret-value"));
  assert.equal(typeof expiresAt, "string");

  const account = await w.store.createConnectorAccount(mockAccountInput({ provider: "google", externalAccountId: "google-sub-1", address: "me@gmail.example" }));
  const gone = await w.handler(post({ provider: "google", step: "disconnect", connectorAccountId: account.id }, asUser));
  assert.equal(gone.status, 200);
  assert.deepEqual(await gone.json(), { ok: true });
  assert.deepEqual(w.disconnected, [account.id]);
});

Deno.test("connector-link: the callback needs no session, answers a human with HTML, and never leaks the provider secret", async () => {
  const w = world();
  const res = await w.handler(new Request(`${BASE}/connector-link/callback?code=abc`, { method: "GET" }));
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  const page = await res.text();
  assert.ok(!page.includes("google-secret-value"));
  assert.ok(!page.includes("abc"));
  const denied = await w.handler(new Request(`${BASE}/connector-link/callback?error=access_denied&state=x`, { method: "GET" }));
  assert.equal(denied.status, 400);
  assert.equal((await w.handler(new Request(`${BASE}/connector-link/callback`, { method: "POST", headers: asUser }))).status, 405);
});
