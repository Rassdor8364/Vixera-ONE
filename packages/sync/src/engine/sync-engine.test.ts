import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  ConnectorRegistry,
  DEV_USER_ID,
  InMemoryCredentialStore,
  type Checkpoint,
  type Connector,
  type ConnectorAccount,
  type JsonObject,
  type MailSyncBatch,
  type SyncContext,
  type SyncPage,
} from "@vixera/domain";
import { InMemorySpineStore } from "../store/in-memory-spine-store.ts";
import type { SpineStore } from "../store/spine-store.ts";
import { ContextLinker } from "../linker/context-linker.ts";
import { SyncEngine, backoffMs, holdReason, redactCredential } from "./sync-engine.ts";
import { MockConnector, briefWorldFixtures, NORTHWIND_KICKOFF_EVENT_ID } from "../testing/mock-connector.ts";
import { expiredCredential, fakeCredential, fixedClock, MOCK_NOW, MOCK_SELF_ADDRESS, mockAccountInput, seedMockAccount, tickingClock } from "../testing/fixtures.ts";

interface World {
  store: InMemorySpineStore;
  credentials: InMemoryCredentialStore;
  registry: ConnectorRegistry;
  connector: MockConnector;
  linker: ContextLinker;
  engine: SyncEngine;
  logs: { message: string; data?: JsonObject }[];
}

function world(connector = new MockConnector(), store: SpineStore = new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() })): World {
  const credentials = new InMemoryCredentialStore();
  const registry = new ConnectorRegistry().register(connector);
  const linker = new ContextLinker(store, { now: fixedClock(), selfAddresses: [MOCK_SELF_ADDRESS] });
  const logs: World["logs"] = [];
  const engine = new SyncEngine({
    store,
    registry,
    credentials,
    linker,
    now: tickingClock(),
    fetch: (() => Promise.reject(new Error("no network in tests"))) as unknown as typeof fetch,
    log: (message, data) => logs.push(data ? { message, data } : { message }),
  });
  return { store: store as InMemorySpineStore, credentials, registry, connector, linker, engine, logs };
}

async function rowCounts(store: SpineStore) {
  return {
    people: (await store.listPeople()).length,
    mail: (await store.listMailMessages()).length,
    time: (await store.listTimeEvents({ from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" })).length,
    accounts: (await store.listMoneyAccounts()).length,
    transactions: (await store.listMoneyTransactions()).length,
    documents: (await store.listDocuments()).length,
    relationships: (await store.listRelationships()).length,
    contextEvents: (await store.listContextEvents()).length,
  };
}

describe("SyncEngine idempotency", () => {
  it("two runs produce identical row counts, advance checkpoints and emit nothing new", async () => {
    const w = world();
    await seedMockAccount(w.store, w.credentials);

    const first = await w.engine.runAll();
    expect(first.ok).toBe(3);
    expect(first.errors).toBe(0);
    expect(first.counts.inserted).toBe(2 + 1 + 3);
    expect(first.counts.contextEvents).toBe(2 + 1 + 2);
    const after1 = await rowCounts(w.store);
    expect(after1).toEqual({ people: 2, mail: 2, time: 1, accounts: 1, transactions: 2, documents: 1, relationships: 5, contextEvents: 5 });

    const states1 = await w.store.listSyncStates();
    expect(states1).toHaveLength(3);
    for (const s of states1) {
      expect(s.status).toBe("idle");
      expect(s.checkpoint).toEqual({ version: 1, page: 1 });
      expect(s.lastSuccessAt).not.toBeNull();
      expect(s.consecutiveFailures).toBe(0);
    }

    const second = await w.engine.runAll();
    expect(second.ok).toBe(3);
    expect(second.counts.inserted).toBe(0);
    expect(second.counts.contextEvents).toBe(0);
    expect(await rowCounts(w.store)).toEqual(after1);
    // The second run resumed from the checkpoint the first one persisted.
    const secondCalls = w.connector.calls.slice(3);
    expect(secondCalls.map((c) => c.checkpoint)).toEqual([
      { version: 1, page: 1 },
      { version: 1, page: 1 },
      { version: 1, page: 1 },
    ]);
    const states2 = await w.store.listSyncStates();
    expect(states2.every((s) => s.lastSuccessAt! > states1.find((p) => p.capability === s.capability)!.lastSuccessAt!)).toBe(true);
  });

  it("a changed calendar event after a checkpoint produces exactly one time.event.changed", async () => {
    const w = world();
    await seedMockAccount(w.store, w.credentials);
    await w.engine.runAll();
    w.connector.changeEvent(NORTHWIND_KICKOFF_EVENT_ID, { startsAt: "2026-09-11T16:00:00.000Z", endsAt: "2026-09-11T17:00:00.000Z" });
    const report = await w.engine.runAll();
    expect(report.counts.contextEvents).toBe(1);
    expect(report.counts.inserted).toBe(0);
    const events = await w.store.listContextEvents({ kindPrefix: "time.event." });
    expect(events.map((e) => e.kind).sort()).toEqual(["time.event.changed", "time.event.created"]);
    expect((await w.store.getSyncState((await w.store.listConnectorAccounts())[0]!.id, "calendar"))?.checkpoint).toEqual({ version: 2, page: 1 });
  });

  it("applies every page before persisting its checkpoint", async () => {
    const connector = new MockConnector({ pageSize: 1 });
    const store = new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() });
    const trace: string[] = [];
    const spied: SpineStore = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "upsertMailMessages") return async (...args: unknown[]) => {
          trace.push("apply");
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
        if (prop === "upsertSyncState") return async (accountId: string, cap: string, patch: { checkpoint?: Checkpoint | null }) => {
          if (patch.checkpoint) trace.push(`checkpoint:${String(patch.checkpoint["page"])}`);
          return store.upsertSyncState(accountId, cap as "mail", patch);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const w = world(connector, spied);
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    const outcome = await w.engine.runCapability(account, "mail");
    expect(outcome.status).toBe("ok");
    expect(outcome.pages).toBe(2);
    expect(trace).toEqual(["apply", "checkpoint:1", "apply", "checkpoint:2"]);
  });
});

describe("SyncEngine multi-account separation", () => {
  it("two mock accounts with identical external ids get separate rows, states and no cross-talk", async () => {
    const w = world();
    const a = await seedMockAccount(w.store, w.credentials, { externalAccountId: "mock-user-a", label: "A" });
    const b = await seedMockAccount(w.store, w.credentials, { externalAccountId: "mock-user-b", label: "B", credential: fakeCredential({ accessToken: "fake-token-b" }) });
    const report = await w.engine.runAll();
    expect(report.accounts).toBe(2);
    expect(report.ok).toBe(6);

    expect(await w.store.listMailMessages({ connectorAccountId: a.id })).toHaveLength(2);
    expect(await w.store.listMailMessages({ connectorAccountId: b.id })).toHaveLength(2);
    expect(await w.store.listMailMessages()).toHaveLength(4);
    expect(await w.store.listMoneyTransactions()).toHaveLength(4);
    expect(await w.store.listSyncStates(a.id)).toHaveLength(3);
    expect(await w.store.listSyncStates(b.id)).toHaveLength(3);
    // People are shared across accounts (same person in the user's world), documents are per source.
    expect(await w.store.listPeople()).toHaveLength(2);
    expect(await w.store.listDocuments()).toHaveLength(2);
    expect((await w.store.listContextEvents()).length).toBe(10);
    // Each account's sync was driven by its own credential and its own checkpoint.
    const callsA = w.connector.calls.filter((c) => c.connectorAccountId === a.id);
    const callsB = w.connector.calls.filter((c) => c.connectorAccountId === b.id);
    expect(callsA).toHaveLength(3);
    expect(callsB).toHaveLength(3);
    expect(callsA.every((c) => c.accessToken === "fake-token")).toBe(true);
    expect(callsB.every((c) => c.accessToken === "fake-token-b")).toBe(true);
    expect(callsA.every((c) => c.checkpoint === null)).toBe(true);
  });
});

describe("SyncEngine failure isolation", () => {
  it("account A calendar throwing does not stop A mail, A bank or account B", async () => {
    const w = world();
    const a = await seedMockAccount(w.store, w.credentials, { externalAccountId: "mock-user-a", label: "A" });
    const b = await seedMockAccount(w.store, w.credentials, { externalAccountId: "mock-user-b", label: "B" });
    // The mock connector serves both accounts, so fail calendar only for A's run by wrapping the connector.
    const failing: Connector = {
      provider: "mock",
      capabilities: w.connector.capabilities,
      discoverAccount: () => w.connector.discoverAccount(),
      syncMail: (ctx, cp) => w.connector.syncMail(ctx, cp),
      syncBank: (ctx, cp) => w.connector.syncBank(ctx, cp),
      syncCalendar: (ctx, cp) => {
        if (ctx.account.id === a.id) throw new Error("calendar exploded with token fake-token inside");
        return w.connector.syncCalendar(ctx, cp);
      },
    };
    const registry = new ConnectorRegistry().register(failing);
    const engine = new SyncEngine({ store: w.store, registry, credentials: w.credentials, linker: w.linker, now: tickingClock() });

    const report = await engine.runAll();
    expect(report.errors).toBe(1);
    expect(report.ok).toBe(5);
    const failed = report.outcomes.find((o) => o.status === "error")!;
    expect(failed.connectorAccountId).toBe(a.id);
    expect(failed.capability).toBe("calendar");
    expect(failed.reason).not.toContain("fake-token");
    expect(failed.reason).toContain("***");

    const aCalendar = (await w.store.getSyncState(a.id, "calendar"))!;
    expect(aCalendar.status).toBe("error");
    expect(aCalendar.consecutiveFailures).toBe(1);
    expect(aCalendar.lastError).not.toContain("fake-token");
    expect((await w.store.getSyncState(a.id, "mail"))?.status).toBe("idle");
    expect((await w.store.getSyncState(a.id, "bank"))?.status).toBe("idle");
    expect((await w.store.getSyncState(b.id, "calendar"))?.status).toBe("idle");
    expect(await w.store.listTimeEvents({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z", connectorAccountId: b.id })).toHaveLength(1);
    expect((await w.store.getConnectorAccount(a.id))?.status).toBe("active");

    // Failures accumulate on a forced retry (an unforced one is held back by the
    // backoff, which has its own tests); a later success resets the counter.
    await engine.runAll({ force: true });
    expect((await w.store.getSyncState(a.id, "calendar"))?.consecutiveFailures).toBe(2);
    const ok = await w.engine.runAll({ force: true });
    expect(ok.errors).toBe(0);
    expect((await w.store.getSyncState(a.id, "calendar"))?.consecutiveFailures).toBe(0);
  });

  it("runAll never throws, even when the connector is missing from the registry", async () => {
    const w = world();
    await seedMockAccount(w.store, w.credentials, { provider: "google", externalAccountId: "google-sub", capabilities: ["mail"] });
    const report = await w.engine.runAll();
    expect(report.errors).toBe(1);
    expect(report.outcomes[0]?.reason).toContain("No connector registered");
  });

  it("skips paused / disconnected accounts and disabled capabilities", async () => {
    const w = world();
    const paused = await seedMockAccount(w.store, w.credentials, { externalAccountId: "p", status: "paused" });
    const active = await seedMockAccount(w.store, w.credentials, { externalAccountId: "a" });
    await w.store.upsertSyncState(active.id, "bank", { enabled: false });
    const report = await w.engine.runAll();
    expect(report.skipped).toBe(4);
    expect(report.ok).toBe(2);
    expect(w.connector.calls.every((c) => c.connectorAccountId === active.id)).toBe(true);
    expect(await w.store.listSyncStates(paused.id)).toHaveLength(0);
    expect((await w.store.getSyncState(active.id, "bank"))?.lastAttemptAt).toBeNull();
  });

  it("skips the document capability instead of recording a failure every cycle", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail", "document"] });
    const report = await w.engine.runAll();
    expect(report.errors).toBe(0);
    expect(report.ok).toBe(1);
    expect(report.outcomes.map((o) => [o.capability, o.status])).toEqual([
      ["mail", "ok"],
      ["document", "skipped"],
    ]);
    expect(await w.store.getSyncState(account.id, "document")).toBeNull();
    expect((await w.store.getConnectorAccount(account.id))?.status).toBe("active");
  });
});

describe("SyncEngine credentials", () => {
  it("refreshes an expired credential once and persists it under the same ref", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { credential: expiredCredential() });
    const report = await w.engine.runAll();
    expect(report.errors).toBe(0);
    expect(w.connector.refreshCount).toBe(1);
    const stored = await w.credentials.get(account.credentialRef!);
    expect(stored?.kind).toBe("oauth2");
    expect(stored && stored.kind === "oauth2" ? stored.accessToken : null).toBe("fake-refreshed-token-1");
    expect(w.connector.calls.every((c) => c.accessToken === "fake-refreshed-token-1")).toBe(true);
    // Second run: the persisted credential is fresh, no refresh.
    await w.engine.runAll();
    expect(w.connector.refreshCount).toBe(1);
  });

  it("redacts the credential from a failed refresh before persisting lastError", async () => {
    const w = world();
    const failingRefresh: Connector = {
      provider: "mock",
      capabilities: ["mail"],
      discoverAccount: () => w.connector.discoverAccount(),
      refreshCredential: async (ctx) => {
        const token = ctx.credential.kind === "api_key" ? ctx.credential.apiKey : ctx.credential.accessToken;
        throw new ConnectorError("provider_unavailable", `refresh rejected for ${token}`);
      },
      syncMail: (ctx, cp) => w.connector.syncMail(ctx, cp),
    };
    const engine = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(failingRefresh), credentials: w.credentials, linker: w.linker, now: tickingClock() });
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"], credential: expiredCredential() });
    const report = await engine.runAll();
    expect(report.errors).toBe(1);
    expect(report.outcomes[0]?.errorCode).toBe("provider_unavailable");
    expect(report.outcomes[0]?.reason).not.toContain("fake-expired-token");
    const state = (await w.store.getSyncState(account.id, "mail"))!;
    expect(state.status).toBe("error");
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastError).not.toContain("fake-expired-token");
    expect(state.lastError).toContain("***");
    expect(w.connector.calls).toHaveLength(0);
  });

  it("persists a credential the connector refreshed on its own via ctx.onCredentialRefreshed", async () => {
    const w = world();
    const selfRefreshing: Connector = {
      provider: "mock",
      capabilities: ["mail"],
      discoverAccount: () => w.connector.discoverAccount(),
      async *syncMail(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<MailSyncBatch>> {
        await ctx.onCredentialRefreshed?.(fakeCredential({ accessToken: "fake-rotated-token" }));
        yield* w.connector.syncMail(ctx, checkpoint);
      },
    };
    const engine = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(selfRefreshing), credentials: w.credentials, linker: w.linker });
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    await engine.runAll();
    const stored = await w.credentials.get(account.credentialRef!);
    expect(stored && stored.kind === "oauth2" ? stored.accessToken : null).toBe("fake-rotated-token");
  });

  it("marks the account needs_reauth on unauthorized and skips the remaining capabilities", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials);
    w.connector.failOn("mail", new ConnectorError("unauthorized", "token revoked"));
    const report = await w.engine.runAll();
    expect(report.errors).toBe(1);
    expect(report.skipped).toBe(2);
    const row = (await w.store.getConnectorAccount(account.id))!;
    expect(row.status).toBe("needs_reauth");
    expect((await w.store.getSyncState(account.id, "mail"))?.status).toBe("error");
    expect(report.outcomes.find((o) => o.capability === "mail")?.errorCode).toBe("unauthorized");
    // Once reauthorized nothing else needs to change.
    w.connector.clearFailures();
    await w.store.updateConnectorAccount(account.id, { status: "active" });
    // Re-linking resets the sync state as connector-link does, or the backoff
    // from the unauthorized failure would hold mail for another cycle.
    await w.store.upsertSyncState(account.id, "mail", { status: "idle", consecutiveFailures: 0, lastError: null });
    expect((await w.engine.runAll()).ok).toBe(3);
  });

  it("marks the account needs_reauth when the credential is missing", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { credential: null });
    const report = await w.engine.runAll();
    expect(report.outcomes.map((o) => o.status)).toEqual(["error", "skipped", "skipped"]);
    expect(report.outcomes[0]?.errorCode).toBe("credential_missing");
    expect((await w.store.getConnectorAccount(account.id))?.status).toBe("needs_reauth");
    expect((await w.store.getSyncState(account.id, "mail"))?.consecutiveFailures).toBe(1);
  });

  it("clears an invalid checkpoint and retries once from scratch", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    await w.engine.runAll();
    w.connector.invalidateNextCheckpoint("mail");
    const outcome = await w.engine.runCapability((await w.store.getConnectorAccount(account.id))!, "mail");
    expect(outcome.status).toBe("ok");
    expect(w.connector.calls.map((c) => c.checkpoint)).toEqual([null, { version: 1, page: 1 }, null]);
    expect((await w.store.getSyncState(account.id, "mail"))?.checkpoint).toEqual({ version: 1, page: 1 });
    expect(await w.store.listMailMessages()).toHaveLength(2);
  });
});

describe("redactCredential", () => {
  it("removes every secret of a credential from a message", () => {
    const cred = fakeCredential({ accessToken: "fake-access-xyz", refreshToken: "fake-refresh-abc" });
    expect(redactCredential("401 for fake-access-xyz / fake-refresh-abc", cred)).toBe("401 for *** / ***");
    expect(redactCredential("plain", { kind: "api_key", apiKey: "fake-key-123" })).toBe("plain");
    expect(redactCredential("key fake-key-123 rejected", { kind: "api_key", apiKey: "fake-key-123" })).toBe("key *** rejected");
  });
});

describe("SyncEngine report shape", () => {
  it("lists one outcome per (account, capability) with durations and counts", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials);
    const report = await w.engine.runAll();
    expect(report.outcomes.map((o) => [o.connectorAccountId, o.capability])).toEqual([
      [account.id, "mail"],
      [account.id, "calendar"],
      [account.id, "bank"],
    ]);
    for (const o of report.outcomes) {
      expect(o.durationMs).toBeGreaterThanOrEqual(0);
      expect(o.pages).toBe(1);
      expect(o.checkpointAdvanced).toBe(true);
      expect(o.label).toBe("Mock account");
    }
    expect(report.outcomes[0]?.counts).toMatchObject({ inserted: 2, peopleCreated: 2, documents: 1, contextEvents: 2 });
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
    const fresh: ConnectorAccount | null = await w.store.getConnectorAccount(account.id);
    expect(fresh?.status).toBe("active");
  });
});

describe("wall-clock budget", () => {
  it("stops at a checkpoint instead of paging on, and resumes from there", async () => {
    const store = new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() });
    const account = await store.createConnectorAccount(mockAccountInput({ capabilities: ["mail"] }));
    const credentials = new InMemoryCredentialStore();
    await credentials.put(account.credentialRef!, fakeCredential());

    // Three pages, each with its own checkpoint. The clock advances one minute
    // per read, so the deadline is already past after the first page.
    let cursor = 0;
    const pages = [
      { batch: { messages: [], deleted: [] }, checkpoint: { page: 1 }, done: false },
      { batch: { messages: [], deleted: [] }, checkpoint: { page: 2 }, done: false },
      { batch: { messages: [], deleted: [] }, checkpoint: { page: 3 }, done: true },
    ];
    const connector = {
      provider: "mock" as const,
      capabilities: ["mail"] as const,
      discoverAccount: () => Promise.resolve({ externalAccountId: "x", label: "x", address: null, capabilities: ["mail"] as const }),
      async *syncMail(_ctx: unknown, checkpoint: { page?: number } | null) {
        const from = checkpoint?.page ?? 0;
        for (let i = from; i < pages.length; i++) {
          cursor = i + 1;
          yield pages[i]!;
        }
      },
    };
    const clock = tickingClock(MOCK_NOW, 60_000);
    const engine = new SyncEngine({
      store,
      registry: new ConnectorRegistry().register(connector as never),
      credentials,
      linker: new ContextLinker(store, { now: clock, selfAddresses: [] }),
      now: clock,
    });

    const first = await engine.runCapability(account, "mail", MOCK_NOW.getTime() + 1);
    expect(first.status).toBe("ok");
    expect(first.reason).toContain("time budget");
    expect(first.pages).toBe(1);
    expect((await store.getSyncState(account.id, "mail"))?.checkpoint).toEqual({ page: 1 });

    // Without a deadline the next run finishes from the stored checkpoint.
    const second = await engine.runCapability(account, "mail");
    expect(second.status).toBe("ok");
    expect(second.reason).toBeNull();
    expect((await store.getSyncState(account.id, "mail"))?.checkpoint).toEqual({ page: 3 });
    expect(cursor).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Resume points must be real progress; the deadline must bound every pass.
// ---------------------------------------------------------------------------
type Page = { checkpoint: Checkpoint | null; done: boolean };

/** A mail connector that yields scripted pages and records the checkpoint each pass started from. */
function scripted(pages: readonly Page[]) {
  const starts: (Checkpoint | null)[] = [];
  let served = 0;
  const connector = {
    provider: "mock" as const,
    capabilities: ["mail"] as const,
    discoverAccount: () => Promise.resolve({ externalAccountId: "x", label: "x", address: null, capabilities: ["mail"] as const }),
    async *syncMail(_ctx: unknown, checkpoint: Checkpoint | null) {
      starts.push(checkpoint);
      for (const page of pages) {
        served++;
        yield { batch: { messages: [], deleted: [] }, checkpoint: page.checkpoint, done: page.done };
      }
    },
  };
  return { connector, starts, served: () => served };
}

async function mailWorld(connector: unknown, stepMs = 60_000) {
  const clock = tickingClock(MOCK_NOW, stepMs);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  const account = await store.createConnectorAccount(mockAccountInput({ capabilities: ["mail"] }));
  const credentials = new InMemoryCredentialStore();
  await credentials.put(account.credentialRef!, fakeCredential());
  const engine = new SyncEngine({
    store,
    registry: new ConnectorRegistry().register(connector as never),
    credentials,
    linker: new ContextLinker(store, { now: clock, selfAddresses: [] }),
    now: clock,
  });
  return { store, account, engine };
}

describe("a checkpoint is a resume point only when it moved", () => {
  it("an echoed cursor under a deadline is an interruption, not progress", async () => {
    // Pages 1 and 2 echo the cursor the pass started from (as Graph delta and
    // the Google calendar window do); only page 3 advances it.
    const s = scripted([
      { checkpoint: { cursor: "A" }, done: false },
      { checkpoint: { cursor: "A" }, done: false },
      { checkpoint: { cursor: "B" }, done: true },
    ]);
    const { store, account, engine } = await mailWorld(s.connector);
    await store.upsertSyncState(account.id, "mail", { checkpoint: { cursor: "A" } });

    const first = await engine.runCapability(account, "mail", MOCK_NOW.getTime() + 1);
    expect(first.status).toBe("ok");
    expect(first.pages).toBe(1);
    expect(first.checkpointAdvanced).toBe(false);
    expect(first.interrupted).toBe(true);
    expect(first.reason).toContain("before a resume point");
    const state = await store.getSyncState(account.id, "mail");
    expect(state?.checkpoint).toEqual({ cursor: "A" });
    expect(state?.status).toBe("idle");
    expect(state?.lastSuccessAt).toBeNull();

    // Without a deadline the pass completes and the real cursor is stored.
    const second = await engine.runCapability(account, "mail");
    expect(second).toMatchObject({ status: "ok", pages: 3, checkpointAdvanced: true, interrupted: false, reason: null });
    expect((await store.getSyncState(account.id, "mail"))?.checkpoint).toEqual({ cursor: "B" });
    expect((await store.getSyncState(account.id, "mail"))?.lastSuccessAt).not.toBeNull();
    expect(s.starts).toEqual([{ cursor: "A" }, { cursor: "A" }]);
  });

  it("key order does not make an unchanged checkpoint look new", async () => {
    const s = scripted([{ checkpoint: { b: 2, a: 1 }, done: false }, { checkpoint: { a: 1, b: 2 }, done: true }]);
    const { store, account, engine } = await mailWorld(s.connector);
    await store.upsertSyncState(account.id, "mail", { checkpoint: { a: 1, b: 2 } });
    const run = await engine.runCapability(account, "mail", MOCK_NOW.getTime() + 1);
    expect(run.checkpointAdvanced).toBe(false);
    expect(run.interrupted).toBe(true);
  });

  it("null-checkpoint pages are bounded by the deadline instead of running to a hard kill", async () => {
    const s = scripted([
      { checkpoint: null, done: false },
      { checkpoint: null, done: false },
      { checkpoint: null, done: false },
      { checkpoint: null, done: false },
      { checkpoint: { delta: "final" }, done: true },
    ]);
    const { store, account, engine } = await mailWorld(s.connector);
    const run = await engine.runCapability(account, "mail", MOCK_NOW.getTime() + 1);
    expect(run.pages).toBe(1);
    expect(run.interrupted).toBe(true);
    expect(s.served()).toBe(1);
    const state = await store.getSyncState(account.id, "mail");
    expect(state?.status).toBe("idle"); // not left `running` for the next cron to skip
    expect(state?.consecutiveFailures).toBe(0); // not a failure either
    // Given the time, the same pass completes and lands the final checkpoint.
    const full = await engine.runCapability(account, "mail");
    expect(full).toMatchObject({ pages: 5, interrupted: false, checkpointAdvanced: true });
    expect((await store.getSyncState(account.id, "mail"))?.checkpoint).toEqual({ delta: "final" });
  });
});

describe("backoff and the running guard", () => {
  it("backoffMs doubles from 10 minutes and caps at 6 hours", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(10 * 60_000);
    expect(backoffMs(2)).toBe(20 * 60_000);
    expect(backoffMs(3)).toBe(40 * 60_000);
    expect(backoffMs(6)).toBe(320 * 60_000);
    expect(backoffMs(7)).toBe(6 * 3600_000);
    expect(backoffMs(50)).toBe(6 * 3600_000);
  });

  it("a failing capability is held back, a forced run is not, and success clears the hold", async () => {
    const connector = new MockConnector().failOn("mail", new ConnectorError("invalid_response", "payload rejected", false));
    const { store, account, engine } = await mailWorld(connector, 1_000);
    const first = await engine.runCapability(account, "mail");
    expect(first.status).toBe("error");
    expect((await store.getSyncState(account.id, "mail"))?.consecutiveFailures).toBe(1);

    // One second later (the clock ticks 1 s per read): inside the 10 min backoff.
    const held = await engine.runCapability(account, "mail");
    expect(held.status).toBe("skipped");
    expect(held.reason).toMatch(/backing off after 1 consecutive failure/);
    expect(connector.calls.filter((c) => c.capability === "mail")).toHaveLength(1);

    // The user's own Sync now goes through.
    const forced = await engine.runCapability(account, "mail", undefined, { force: true });
    expect(forced.status).toBe("error");
    expect((await store.getSyncState(account.id, "mail"))?.consecutiveFailures).toBe(2);
    expect(connector.calls.filter((c) => c.capability === "mail")).toHaveLength(2);
  });

  it("holdReason: recent running → held; stale running → free; errors respect backoff", () => {
    const base = { userId: DEV_USER_ID, connectorAccountId: "c", capability: "mail" as const, enabled: true, checkpoint: null, lastSuccessAt: null, lastError: null, updatedAt: "2026-09-10T09:00:00.000Z" };
    const at = MOCK_NOW.getTime();
    const running = { ...base, status: "running" as const, consecutiveFailures: 0, lastAttemptAt: new Date(at - 5 * 60_000).toISOString() };
    expect(holdReason(running as never, at)).toMatch(/already running/);
    const stale = { ...running, lastAttemptAt: new Date(at - 20 * 60_000).toISOString() };
    expect(holdReason(stale as never, at)).toBeNull();
    const failing = { ...base, status: "error" as const, consecutiveFailures: 3, lastAttemptAt: new Date(at - 30 * 60_000).toISOString() };
    expect(holdReason(failing as never, at)).toMatch(/backing off after 3/); // 40 min backoff, 30 elapsed
    expect(holdReason({ ...failing, lastAttemptAt: new Date(at - 41 * 60_000).toISOString() } as never, at)).toBeNull();
    expect(holdReason(null, at)).toBeNull();
  });

  it("a capability another run marked running just now is skipped, not run twice", async () => {
    const connector = new MockConnector();
    const { store, account, engine } = await mailWorld(connector, 1_000);
    await store.upsertSyncState(account.id, "mail", { status: "running", lastAttemptAt: MOCK_NOW.toISOString() });
    const run = await engine.runCapability(account, "mail");
    expect(run.status).toBe("skipped");
    expect(run.reason).toMatch(/already running/);
    expect(connector.calls).toHaveLength(0);
  });
});
