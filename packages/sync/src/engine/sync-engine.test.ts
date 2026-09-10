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
import { SyncEngine, redactCredential } from "./sync-engine.ts";
import { MockConnector, briefWorldFixtures, NORTHWIND_KICKOFF_EVENT_ID } from "../testing/mock-connector.ts";
import { expiredCredential, fakeCredential, fixedClock, MOCK_SELF_ADDRESS, seedMockAccount, tickingClock } from "../testing/fixtures.ts";

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

    // Failures accumulate; a later success resets the counter.
    await engine.runAll();
    expect((await w.store.getSyncState(a.id, "calendar"))?.consecutiveFailures).toBe(2);
    const ok = await w.engine.runAll();
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
