import assert from "node:assert/strict";
import { ConnectorRegistry, DEV_USER_ID, InMemoryCredentialStore, type ConnectorCapability } from "@vixera/domain";
import { InMemorySpineStore, MOCK_NOW, MockConnector, seedMockAccount, tickingClock } from "@vixera/sync";
import { runSync, summarizeReport } from "./sync.ts";

function world(stepMs = 1000) {
  const clock = tickingClock(MOCK_NOW, stepMs);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  const credentials = new InMemoryCredentialStore();
  const connector = new MockConnector();
  const registry = new ConnectorRegistry().register(connector);
  const noFetch = (() => Promise.reject(new Error("no network in tests"))) as unknown as typeof fetch;
  return { store, credentials, connector, registry, clock, deps: { store, credentials, registry, now: clock, fetch: noFetch } };
}

Deno.test("runSync: every capability of every active account runs; a second run adds nothing", async () => {
  const w = world();
  await seedMockAccount(w.store, w.credentials);
  const first = await runSync(w.deps);
  assert.equal(first.accounts, 1);
  assert.equal(first.ok, 3);
  assert.equal(first.errors, 0);
  assert.equal(first.skippedForBudget, 0);
  assert.equal((await store(w).listPeople()).length, 2);
  const second = await runSync(w.deps);
  assert.equal(second.ok, 3);
  assert.equal(second.counts.contextEvents, 0);
  const summary = summarizeReport(second);
  assert.equal(summary.ok, 3);
  assert.equal((summary.outcomes as unknown[]).length, 3);
});

Deno.test("runSync: one account only, and an unknown account id is an error", async () => {
  const w = world();
  const a = await seedMockAccount(w.store, w.credentials, { externalAccountId: "a", address: "a@example.com" });
  await seedMockAccount(w.store, w.credentials, { externalAccountId: "b", address: "b@example.com" });
  const report = await runSync(w.deps, { accountId: a.id });
  assert.equal(report.accounts, 1);
  assert.ok(report.outcomes.every((o) => o.connectorAccountId === a.id));
  await assert.rejects(() => runSync(w.deps, { accountId: crypto.randomUUID() }), { name: "SyncAccountNotFoundError" });
});

Deno.test("runSync: the wall-clock budget stops starting capabilities and reports them as skipped", async () => {
  // Each clock read advances 30 s, so the budget of 45 s allows exactly one capability to start.
  const w = world(30_000);
  await seedMockAccount(w.store, w.credentials);
  const report = await runSync(w.deps, { budgetMs: 45_000 });
  assert.equal(report.ok, 1);
  assert.equal(report.skippedForBudget, 2);
  assert.equal(report.skipped, 2);
  assert.ok(report.outcomes.filter((o) => o.status === "skipped").every((o) => o.reason === "time budget exhausted"));
  // A later run resumes the skipped capabilities.
  const next = await runSync({ ...w.deps, now: tickingClock(MOCK_NOW, 1) }, { budgetMs: 45_000 });
  assert.equal(next.ok, 3);
});

Deno.test("runSync: a pass that cannot resume runs before the others, and is skipped rather than started when the budget left is too short", async () => {
  class BankFirst extends MockConnector {
    readonly nonResumable: readonly ConnectorCapability[] = ["bank"];
  }
  const w = world();
  const registry = new ConnectorRegistry().register(new BankFirst());
  await seedMockAccount(w.store, w.credentials);
  const report = await runSync({ ...w.deps, registry });
  assert.deepEqual(report.outcomes.map((o) => o.capability), ["bank", "mail", "calendar"]);
  assert.equal(report.ok, 3);

  // 20 s of budget (each clock read costs 100 ms): too short for a pass that cannot resume, enough for the resumable ones.
  const tight = world(100);
  await seedMockAccount(tight.store, tight.credentials);
  const short = await runSync({ ...tight.deps, registry: new ConnectorRegistry().register(new BankFirst()) }, { budgetMs: 20_000 });
  const bank = short.outcomes.find((o) => o.capability === "bank")!;
  assert.equal(bank.status, "skipped");
  assert.match(bank.reason ?? "", /cannot resume/);
  assert.equal(short.skippedForBudget, 1);
  assert.equal(short.ok, 2);
  assert.equal(summarizeReport(short).skippedForBudget, 1);
});

Deno.test("runSync: paused / disconnected accounts are skipped, failures do not stop the run", async () => {
  const w = world();
  await seedMockAccount(w.store, w.credentials, { externalAccountId: "paused", status: "paused" });
  await seedMockAccount(w.store, w.credentials, { externalAccountId: "live" });
  w.connector.failOn("mail");
  const report = await runSync(w.deps);
  assert.equal(report.accounts, 2);
  assert.equal(report.skipped, 3);
  assert.equal(report.errors, 1);
  assert.equal(report.ok, 2);
});

function store(w: ReturnType<typeof world>) {
  return w.store;
}
