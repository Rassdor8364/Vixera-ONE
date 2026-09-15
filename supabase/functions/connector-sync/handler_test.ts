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
import { DEFAULT_SYNC_BUDGET_MS, SyncAccountNotFoundError } from "../_shared/sync.ts";
import { connectorSyncHandler, type ConnectorSyncDeps } from "./handler.ts";

interface Call {
  readonly userId: UserId;
  readonly options: Parameters<ConnectorSyncDeps["runSyncForUser"]>[1];
}

function world(overrides: Partial<ConnectorSyncDeps> = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const deps: ConnectorSyncDeps = {
    syncSecret: "cron-secret",
    userRequest: fakeUserRequest,
    listActiveConnectorUserIds: () => Promise.resolve([USER, "22222222-2222-4222-8222-222222222222" as UserId]),
    runSyncForUser: (userId, options) => {
      calls.push({ userId, options });
      return Promise.resolve(report({ outcomes: [{} as never, {} as never], errors: 1, skippedForBudget: 1 }));
    },
    now: () => (t += 1000),
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { handler: connectorSyncHandler(deps), calls, logs };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/connector-sync/`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? null : JSON.stringify(body) });
}

Deno.test("connector-sync: without a session the user path is 401 and nothing runs; OPTIONS and GET are handled by the router", async () => {
  const w = world();
  const res = await w.handler(post({}));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "unauthorized");
  assert.equal(w.calls.length, 0);
  assert.equal((await w.handler(new Request(`${BASE}/connector-sync/`, { method: "OPTIONS", headers: { origin: "http://localhost:1420" } }))).status, 204);
  assert.equal((await w.handler(new Request(`${BASE}/connector-sync/`, { method: "GET" }))).status, 405);
});

Deno.test("connector-sync: a session runs that user's accounts, one account when asked, and the body is validated", async () => {
  const w = world();
  const all = await w.handler(post({}, { authorization: "Bearer user-token" }));
  assert.equal(all.status, 200);
  assert.deepEqual(Object.keys(await all.json()), ["report"]);
  assert.deepEqual(w.calls, [{ userId: USER, options: { accountId: null } }]);

  const id = "33333333-3333-4333-8333-333333333333";
  const one = await w.handler(post({ connectorAccountId: id }, { authorization: "Bearer user-token" }));
  assert.equal(one.status, 200);
  assert.deepEqual(w.calls[1], { userId: USER, options: { accountId: id } });

  const bad = await w.handler(post({ connectorAccountId: "not-a-uuid" }, { authorization: "Bearer user-token" }));
  assert.equal(bad.status, 400);
  assert.equal(w.calls.length, 2);

  const missing = world({ runSyncForUser: () => Promise.reject(new SyncAccountNotFoundError(id)) });
  const res = await missing.handler(post({ connectorAccountId: id }, { authorization: "Bearer user-token" }));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "not_found");
});

Deno.test("connector-sync: the scheduled path takes the secret alone — a wrong one is 401 even beside a valid session, and never falls through to the user path", async () => {
  const w = world();
  const wrong = await w.handler(post({}, { authorization: "Bearer user-token", "x-vixera-sync-secret": "guess" }));
  assert.equal(wrong.status, 401);
  assert.equal(w.calls.length, 0);
  // an empty header value is a presented secret too
  assert.equal((await w.handler(post({}, { "x-vixera-sync-secret": "" }))).status, 401);
  // no secret configured: the scheduled path does not exist, whatever is presented
  const unset = world({ syncSecret: null });
  assert.equal((await unset.handler(post({}, { "x-vixera-sync-secret": "cron-secret" }))).status, 401);
  assert.equal(unset.calls.length, 0);
});

Deno.test("connector-sync: the scheduled run visits every active user under one shared deadline, counts a failed user and stops starting users past the deadline", async () => {
  const w = world();
  const res = await w.handler(post(undefined, { "x-vixera-sync-secret": "cron-secret" }));
  assert.equal(res.status, 200);
  const summary = await res.json();
  assert.equal(summary.users, 2);
  assert.equal(summary.outcomes, 4);
  assert.equal(summary.errors, 2);
  assert.equal(summary.skippedForBudget, 2);
  assert.equal(summary.usersSkipped, 0);
  assert.equal(typeof summary.durationMs, "number");
  assert.equal(w.calls.length, 2);
  const deadlines = new Set(w.calls.map((c) => c.options.deadlineAt));
  assert.equal(deadlines.size, 1);
  const [deadline] = [...deadlines];
  assert.ok(typeof deadline === "number" && deadline - 1_001_000 === DEFAULT_SYNC_BUDGET_MS, "deadline = start + DEFAULT_SYNC_BUDGET_MS");
  assert.ok(w.calls.every((c) => c.options.accountId === undefined));
  assert.ok(w.logs.includes("scheduled sync: finished"));

  // one user's run throwing is that user's error, the next user still runs
  let n = 0;
  const failing = world({
    runSyncForUser: () => (++n === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(report())),
  });
  const partial = await (await failing.handler(post(undefined, { "x-vixera-sync-secret": "cron-secret" }))).json();
  assert.equal(partial.errors, 1);
  assert.equal(n, 2);
  assert.ok(failing.logs.includes("scheduled sync: user run failed"));

  // a clock that jumps past the deadline: the remaining users are not started, and say so
  let t = 0;
  const slow = world({ now: () => (t += DEFAULT_SYNC_BUDGET_MS) });
  const late = await (await slow.handler(post(undefined, { "x-vixera-sync-secret": "cron-secret" }))).json();
  assert.equal(late.usersSkipped, 2);
  assert.equal(slow.calls.length, 0);
});
