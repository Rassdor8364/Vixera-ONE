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
import { InMemorySpineStore, MOCK_NOW, tickingClock } from "@vixera/sync";
import { SYNC_NOW_BUDGET_MS, actionDispatchHandler, type ActionDispatchDeps } from "./handler.ts";

function world() {
  const clock = tickingClock(MOCK_NOW, 1000);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  const syncs: { userId: UserId; options: Parameters<ActionDispatchDeps["runSyncForUser"]>[1] }[] = [];
  const deps: ActionDispatchDeps = {
    userRequest: async (req) => ({ ...(await fakeUserRequest(req)), store }),
    runSyncForUser: (userId, options) => {
      syncs.push({ userId, options });
      return Promise.resolve(report({ ok: 1 }));
    },
    now: clock,
    log: () => {},
  };
  return { handler: actionDispatchHandler(deps), store, syncs };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/action-dispatch/`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const asUser = { authorization: "Bearer user-token" };

Deno.test("action-dispatch: 401 without a session, 400 for anything that is not an envelope, 405 for GET", async () => {
  const w = world();
  assert.equal((await w.handler(post({ actionType: "thread.create", idempotencyKey: "k", payload: { title: "x" } }))).status, 401);
  for (const body of [{}, { actionType: "thread.delete", idempotencyKey: "k", payload: {} }, { actionType: "thread.create", idempotencyKey: "", payload: { title: "x" } }, { actionType: "thread.create", idempotencyKey: "k", payload: "nope" }]) {
    const res = await w.handler(post(body, asUser));
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).error.code, "invalid_envelope");
  }
  assert.equal((await w.handler(new Request(`${BASE}/action-dispatch/`, { method: "GET", headers: asUser }))).status, 405);
  assert.equal((await w.store.listThreads()).length, 0);
});

Deno.test("action-dispatch: an action runs once for its key and replays the same outcome", async () => {
  const w = world();
  const env = { actionType: "thread.create", idempotencyKey: "thread-1", payload: { title: "Brand identity" } };
  const first = await w.handler(post(env, asUser));
  assert.equal(first.status, 200);
  const outcome = await first.json();
  assert.equal(outcome.status, "done");
  assert.equal(outcome.replayed, false);
  assert.equal((await w.store.listThreads()).length, 1);
  const replay = await (await w.handler(post(env, asUser))).json();
  assert.equal(replay.status, "done");
  assert.equal(replay.replayed, true);
  assert.equal(replay.actionRequestId, outcome.actionRequestId);
  assert.equal((await w.store.listThreads()).length, 1);
});

Deno.test("action-dispatch: Sync now runs the caller's user with its own budget and `force`, so a held capability still runs", async () => {
  const w = world();
  const res = await w.handler(post({ actionType: "connector.sync_now", idempotencyKey: crypto.randomUUID(), payload: {} }, asUser));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "done");
  assert.deepEqual(w.syncs, [{ userId: USER, options: { accountId: null, budgetMs: SYNC_NOW_BUDGET_MS, force: true } }]);
});
