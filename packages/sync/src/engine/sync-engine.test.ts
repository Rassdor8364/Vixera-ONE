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
  type BankSyncBatch,
  type CalendarSyncBatch,
  type MailSyncBatch,
  type SyncContext,
  type SyncPage,
} from "@vixera/domain";
import { InMemorySpineStore } from "../store/in-memory-spine-store.ts";
import type { SpineStore } from "../store/spine-store.ts";
import { ContextLinker } from "../linker/context-linker.ts";
import { BACKOFF_MAX_MS, SyncEngine, backoffMs, declareResync, holdReason, redactCredential, scheduleCapabilities } from "./sync-engine.ts";
import { ERIC_INVOICE_MESSAGE_ID, MockConnector, PRIYA_AGENDA_MESSAGE_ID, briefWorldFixtures, NORTHWIND_KICKOFF_EVENT_ID } from "../testing/mock-connector.ts";
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
    w.connector.failOn("mail", new ConnectorError("unauthorized", "token revoked", false, { providerCode: "ITEM_LOGIN_REQUIRED" }));
    const report = await w.engine.runAll();
    expect(report.errors).toBe(1);
    expect(report.skipped).toBe(2);
    const row = (await w.store.getConnectorAccount(account.id))!;
    expect(row.status).toBe("needs_reauth");
    // The provider's own code is kept on the row: connector-link decides from it
    // whether Link update mode can repair the Item or a fresh link is needed.
    expect(row.metadata.reauthCode).toBe("ITEM_LOGIN_REQUIRED");
    expect(typeof row.metadata.reauthAt).toBe("string");
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

describe("full resync reconciliation (ADR-017)", () => {
  /** A connector that rejects the stored checkpoint once, then re-lists from scratch with a declared scope. */
  function relisting(w: World, pages: (checkpoint: Checkpoint | null) => SyncPage<MailSyncBatch>[], rejects: (checkpoint: Checkpoint) => boolean) {
    return {
      provider: "mock" as const,
      capabilities: ["mail"] as const,
      discoverAccount: () => w.connector.discoverAccount(),
      async *syncMail(_ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<MailSyncBatch>> {
        if (checkpoint && rejects(checkpoint)) throw new ConnectorError("checkpoint_invalid", "history too old");
        for (const page of pages(checkpoint)) yield page;
      },
    };
  }
  const SCOPE = { kind: "mail" as const, receivedSince: "2000-01-01T00:00:00.000Z" };

  it("deletes what a from-scratch pass never mentioned inside its scope, with its context events, and nothing outside it", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    await w.engine.runAll(); // the brief world: Eric's invoice mail and Priya's agenda, both with context events
    expect(await w.store.findMailMessageByExternalId(account.id, PRIYA_AGENDA_MESSAGE_ID)).not.toBeNull();
    const eventsBefore = (await w.store.listContextEvents()).filter((e) => e.subject.type === "mail_message").length;
    expect(eventsBefore).toBe(2);
    // Priya's message was deleted at the provider while the history id went stale: the
    // re-list mentions Eric's only. A message received before the scope is outside it.
    const eric = briefWorldFixtures().mail.messages.find((m) => m.externalId === ERIC_INVOICE_MESSAGE_ID)!;
    const ancient = { ...eric, externalId: "msg-ancient", externalThreadId: "thr-ancient", receivedAt: "1999-06-01T00:00:00.000Z", sentAt: "1999-06-01T00:00:00.000Z" };
    await w.store.upsertMailMessages(account.id, [{ ...ancient, toPersonIds: [], ccPersonIds: [], fromPersonId: null }]);
    const connector = relisting(w, () => [{ batch: { messages: [eric], deleted: [] }, checkpoint: { historyId: "fresh" }, done: true, resyncScope: SCOPE }], () => true);
    const engine = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(connector as never), credentials: w.credentials, linker: w.linker, now: tickingClock(), log: (m, d) => w.logs.push(d ? { message: m, data: d } : { message: m }) });

    const outcome = await engine.runCapability((await w.store.getConnectorAccount(account.id))!, "mail");
    expect(outcome.status).toBe("ok");
    expect(outcome.counts.deleted).toBe(1);
    expect(await w.store.findMailMessageByExternalId(account.id, PRIYA_AGENDA_MESSAGE_ID)).toBeNull();
    expect(await w.store.findMailMessageByExternalId(account.id, ERIC_INVOICE_MESSAGE_ID)).not.toBeNull();
    expect(await w.store.findMailMessageByExternalId(account.id, "msg-ancient")).not.toBeNull();
    expect((await w.store.listContextEvents()).filter((e) => e.subject.type === "mail_message")).toHaveLength(1);
    expect((await w.store.getSyncState(account.id, "mail"))?.reconcile).toEqual([]);
    expect(w.logs.find((l) => l.message === "sync: full resync reconciled")?.data).toMatchObject({ removed: 1, units: 1, scope: "mail" });
  });

  it("a pass the budget splits across runs still reconciles once, when it completes", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    await w.engine.runAll();
    const eric = briefWorldFixtures().mail.messages.find((m) => m.externalId === ERIC_INVOICE_MESSAGE_ID)!;
    const pages = (checkpoint: Checkpoint | null): SyncPage<MailSyncBatch>[] => {
      const all: SyncPage<MailSyncBatch>[] = [
        { batch: { messages: [eric], deleted: [] }, checkpoint: { historyId: "p1" }, done: false, fullResync: true, resyncScope: SCOPE },
        { batch: { messages: [], deleted: [] }, checkpoint: { historyId: "p2" }, done: true, fullResync: true, resyncScope: SCOPE },
      ];
      return checkpoint?.historyId === "p1" ? all.slice(1) : all;
    };
    const connector = relisting(w, pages, (cp) => cp.historyId !== "p1");
    const clock = tickingClock(MOCK_NOW, 60_000);
    const engine = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(connector as never), credentials: w.credentials, linker: w.linker, now: clock });
    const acct = (await w.store.getConnectorAccount(account.id))!;

    // Run 1: the deadline is past after page 1 — a resume point, so the pass is parked, not undone.
    const first = await engine.runCapability(acct, "mail", MOCK_NOW.getTime() + 1);
    expect(first.status).toBe("ok");
    expect(first.pages).toBe(1);
    expect(first.counts.deleted).toBe(0);
    expect(await w.store.findMailMessageByExternalId(account.id, PRIYA_AGENDA_MESSAGE_ID)).not.toBeNull();
    const parked = (await w.store.getSyncState(account.id, "mail"))!;
    expect(parked.checkpoint).toEqual({ historyId: "p1" });
    expect(parked.reconcile).toMatchObject([{ scope: SCOPE }]);

    // Run 2: the pass completes and Priya's message, untouched since before run 1, goes.
    const second = await engine.runCapability(acct, "mail");
    expect(second.counts.deleted).toBe(1);
    expect(await w.store.findMailMessageByExternalId(account.id, PRIYA_AGENDA_MESSAGE_ID)).toBeNull();
    expect(await w.store.findMailMessageByExternalId(account.id, ERIC_INVOICE_MESSAGE_ID)).not.toBeNull();
    expect((await w.store.getSyncState(account.id, "mail"))?.reconcile).toEqual([]);
  });

  it("a first-ever sync from scratch reconciles nothing, and the store ignores a scope that does not fit the capability", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    await w.engine.runAll();
    expect((await w.store.getSyncState(account.id, "mail"))?.reconcile).toEqual([]);
    expect(w.logs.find((l) => l.message === "sync: full resync reconciled")).toBeUndefined();
    expect(await w.store.deleteUntouched(account.id, "mail", { since: "2999-01-01T00:00:00.000Z", scope: { kind: "calendar", calendarIds: ["primary"], from: "2000-01-01T00:00:00.000Z", to: "2999-01-01T00:00:00.000Z" } })).toBe(0);
  });

  it("declareResync: the same declaration continues a listing; a different window starts its unit over; calendars are units of their own", () => {
    const S1 = "2026-09-01T00:00:00.000Z";
    const S2 = "2026-09-02T00:00:00.000Z";
    const mail1 = { kind: "mail" as const, receivedSince: "2026-08-01T00:00:00.000Z" };
    const mail2 = { kind: "mail" as const, receivedSince: "2026-08-02T00:00:00.000Z" };
    expect(declareResync([], mail1, S1)).toEqual([{ since: S1, scope: mail1 }]);
    // a resumed page declares the very same scope: the watermark stays where the listing began
    expect(declareResync([{ since: S1, scope: mail1 }], mail1, S2)).toEqual([{ since: S1, scope: mail1 }]);
    // a fresh window is a listing starting over: replaced, never widened to what the partial listing did not cover
    expect(declareResync([{ since: S1, scope: mail1 }], mail2, S2)).toEqual([{ since: S2, scope: mail2 }]);
    // each calendar is a unit: one starting over leaves the other's watermark alone
    const cal = (id: string, from = "2026-08-01T00:00:00.000Z") => ({ kind: "calendar" as const, calendarIds: [id], from, to: "2026-12-01T00:00:00.000Z" });
    const both = declareResync([], { ...cal("a"), calendarIds: ["a", "b"] }, S1);
    expect(both).toEqual([{ since: S1, scope: cal("a") }, { since: S1, scope: cal("b") }]);
    expect(declareResync(both, cal("b", "2026-08-02T00:00:00.000Z"), S2)).toEqual([{ since: S1, scope: cal("a") }, { since: S2, scope: cal("b", "2026-08-02T00:00:00.000Z") }]);
    expect(declareResync(both, cal("a"), S2)).toEqual(both);
    expect(declareResync([], { kind: "all" }, S1)).toEqual([{ since: S1, scope: { kind: "all" } }]);
    expect(declareResync([{ since: S1, scope: { kind: "all" } }], { kind: "all" }, S2)).toEqual([{ since: S1, scope: { kind: "all" } }]);
  });

  it("a pass that starts over with a narrower window never deletes what the first, partial pass did not reach outside it", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    await w.engine.runAll(); // Eric's invoice and Priya's agenda, both older than any pass below
    const fixtures = briefWorldFixtures().mail.messages;
    const eric = fixtures.find((m) => m.externalId === ERIC_INVOICE_MESSAGE_ID)!;
    const priya = fixtures.find((m) => m.externalId === PRIYA_AGENDA_MESSAGE_ID)!;
    const latest = Math.max(Date.parse(eric.receivedAt), Date.parse(priya.receivedAt));
    const narrowSince = new Date(latest + 1).toISOString();
    const NARROW = { kind: "mail" as const, receivedSince: narrowSince };
    // inside the narrow window and never listed by the pass that completes: gone at the provider
    const recent = { ...eric, externalId: "msg-recent", externalThreadId: "thr-recent", receivedAt: new Date(latest + 3_600_000).toISOString(), sentAt: new Date(latest + 3_600_000).toISOString() };
    await w.store.upsertMailMessages(account.id, [{ ...recent, toPersonIds: [], ccPersonIds: [], fromPersonId: null }]);

    let passes = 0;
    const pages = (): SyncPage<MailSyncBatch>[] =>
      ++passes === 1
        ? [
            // pass 1 (wide window): lists Eric only, then the budget parks it
            { batch: { messages: [eric], deleted: [] }, checkpoint: { historyId: "p1" }, done: false, fullResync: true, resyncScope: SCOPE },
            { batch: { messages: [priya], deleted: [] }, checkpoint: { historyId: "p2" }, done: true, fullResync: true, resyncScope: SCOPE },
          ]
        : // pass 2: the parked resume point is rejected, the listing starts over with a window that covers neither message
          [{ batch: { messages: [], deleted: [] }, checkpoint: { historyId: "fresh" }, done: true, fullResync: true, resyncScope: NARROW }];
    const connector = relisting(w, pages, () => true);
    const clock = tickingClock(MOCK_NOW, 60_000);
    const engine = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(connector as never), credentials: w.credentials, linker: w.linker, now: clock, log: (m, d) => w.logs.push(d ? { message: m, data: d } : { message: m }) });
    const acct = (await w.store.getConnectorAccount(account.id))!;

    const first = await engine.runCapability(acct, "mail", MOCK_NOW.getTime() + 1);
    expect(first.pages).toBe(1);
    const parked = (await w.store.getSyncState(account.id, "mail"))!;
    expect(parked.reconcile).toMatchObject([{ scope: SCOPE }]);

    const second = await engine.runCapability(acct, "mail");
    expect(second.status).toBe("ok");
    // Priya's message is outside the window that completed and was never listed by the pass that did not: it stays.
    // With a union of the two windows it would have gone — the wide pass never reached it.
    expect(await w.store.findMailMessageByExternalId(account.id, PRIYA_AGENDA_MESSAGE_ID)).not.toBeNull();
    expect(await w.store.findMailMessageByExternalId(account.id, ERIC_INVOICE_MESSAGE_ID)).not.toBeNull();
    // Inside the completed window, what the listing did not mention is gone.
    expect(await w.store.findMailMessageByExternalId(account.id, "msg-recent")).toBeNull();
    expect(second.counts.deleted).toBe(1);
    expect((await w.store.getSyncState(account.id, "mail"))?.reconcile).toEqual([]);
  });

  it("each calendar keeps its own watermark: one listed in run 1 is reconciled against run 1, one listed in run 2 against run 2", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["calendar"] });
    await w.engine.runAll(); // the Northwind kickoff, on the mock calendar
    const kickoff = briefWorldFixtures().calendar.events.find((e) => e.externalId === NORTHWIND_KICKOFF_EVENT_ID)!;
    const primary = kickoff.externalCalendarId;
    const window = { from: "2000-01-01T00:00:00.000Z", to: "2999-01-01T00:00:00.000Z" };
    const scope = (id: string) => ({ kind: "calendar" as const, calendarIds: [id], ...window });
    // two events the provider no longer has: one on each calendar, both older than any pass
    await w.store.upsertTimeEvents(account.id, [
      { ...kickoff, externalId: "evt-gone-primary", title: "Gone (primary)" },
      { ...kickoff, externalId: "evt-gone-team", externalCalendarId: "team", title: "Gone (team)" },
    ]);
    const pages = (checkpoint: Checkpoint | null): SyncPage<CalendarSyncBatch>[] => {
      const all: SyncPage<CalendarSyncBatch>[] = [
        { batch: { events: [kickoff], deleted: [] }, checkpoint: { stage: "primary-done" }, done: false, fullResync: true, resyncScope: scope(primary) },
        { batch: { events: [], deleted: [] }, checkpoint: { stage: "all-done" }, done: true, fullResync: true, resyncScope: scope("team") },
      ];
      return checkpoint?.stage === "primary-done" ? all.slice(1) : all;
    };
    const connector = {
      provider: "mock" as const,
      capabilities: ["calendar"] as const,
      discoverAccount: () => w.connector.discoverAccount(),
      async *syncCalendar(_ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<CalendarSyncBatch>> {
        if (checkpoint && checkpoint.stage !== "primary-done") throw new ConnectorError("checkpoint_invalid", "token gone");
        for (const page of pages(checkpoint)) yield page;
      },
    };
    const clock = tickingClock(MOCK_NOW, 60_000);
    const engine = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(connector as never), credentials: w.credentials, linker: w.linker, now: clock });
    const acct = (await w.store.getConnectorAccount(account.id))!;
    const listed = async () => (await w.store.listTimeEvents({ ...window })).map((e) => e.externalId).sort();

    // Run 1 lists the primary calendar completely (the kickoff is touched now) and is parked before the team calendar.
    const first = await engine.runCapability(acct, "calendar", MOCK_NOW.getTime() + 1);
    expect(first.pages).toBe(1);
    expect((await w.store.getSyncState(account.id, "calendar"))?.reconcile).toMatchObject([{ scope: scope(primary) }]);
    expect(await listed()).toEqual(["evt-gone-primary", "evt-gone-team", NORTHWIND_KICKOFF_EVENT_ID].sort());

    // Run 2 lists the team calendar; its watermark is run 2, the primary calendar's stays run 1.
    const second = await engine.runCapability(acct, "calendar");
    expect(second.status).toBe("ok");
    expect(second.counts.deleted).toBe(2);
    // The kickoff was touched in run 1 — after the primary calendar's watermark — so it stays even though it is older than run 2.
    expect(await listed()).toEqual([NORTHWIND_KICKOFF_EVENT_ID]);
    expect((await w.store.getSyncState(account.id, "calendar"))?.reconcile).toEqual([]);
  });
});

describe("a failure the connector marks non-retryable", () => {
  it("is held for the backoff cap at once, while a retryable one backs off from 10 minutes; an older state reads as retryable", () => {
    expect(backoffMs(1, false)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(3, false)).toBe(BACKOFF_MAX_MS);
    expect(backoffMs(1, true)).toBe(10 * 60_000);
    expect(backoffMs(0, false)).toBe(0);
    const at = MOCK_NOW.getTime();
    const base = { userId: DEV_USER_ID, connectorAccountId: "c" as never, capability: "mail" as const, enabled: true, status: "error" as const, checkpoint: null, lastAttemptAt: MOCK_NOW.toISOString(), lastSuccessAt: null, lastError: "the grant does not cover Gmail", consecutiveFailures: 1, reconcile: [], updatedAt: MOCK_NOW.toISOString() };
    const repeating = { ...base, lastErrorCode: "unsupported" as const, lastErrorRetryable: false };
    expect(holdReason(repeating, at + 5 * 3600_000)).toMatch(/held until .*: the last failure \(unsupported\) repeats until something changes/);
    expect(holdReason(repeating, at + 6 * 3600_000)).toBeNull();
    const transient = { ...base, lastErrorCode: "rate_limited" as const, lastErrorRetryable: true };
    expect(holdReason(transient, at + 9 * 60_000)).toMatch(/backing off/);
    expect(holdReason(transient, at + 10 * 60_000)).toBeNull();
    // a state written before the column existed keeps the old behaviour
    expect(holdReason({ ...base, lastErrorCode: null, lastErrorRetryable: null }, at + 10 * 60_000)).toBeNull();
  });

  it("records the failure's code and retryability on the state and the outcome, holds a repeating failure, and still runs when forced", async () => {
    const w = world();
    const account = await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    let t = MOCK_NOW.getTime();
    const engine = new SyncEngine({ store: w.store, registry: w.registry, credentials: w.credentials, linker: w.linker, now: () => new Date((t += 1000)) });

    w.connector.failOn("mail", new ConnectorError("unsupported", "the grant does not cover Gmail", false));
    const [failed] = await engine.runAccount(account.id);
    expect(failed).toMatchObject({ status: "error", errorCode: "unsupported", errorRetryable: false });
    expect(await w.store.getSyncState(account.id, "mail")).toMatchObject({ status: "error", lastErrorCode: "unsupported", lastErrorRetryable: false, consecutiveFailures: 1 });

    // five hours later it is still held: probing would only repeat the failure …
    t = MOCK_NOW.getTime() + 5 * 3600_000;
    const [held] = await engine.runAccount(account.id);
    expect(held?.status).toBe("skipped");
    expect(held?.reason).toMatch(/repeats until something changes/);
    // … but a person's Sync now runs it regardless
    const [forced] = await engine.runAccount(account.id, { force: true });
    expect(forced?.status).toBe("error");
    expect((await w.store.getSyncState(account.id, "mail"))?.consecutiveFailures).toBe(2);

    // past the cap a transient failure is recorded as such and backs off gently
    t = MOCK_NOW.getTime() + 12 * 3600_000;
    w.connector.failOn("mail", new ConnectorError("provider_unavailable", "Gmail is down", true));
    const [transient] = await engine.runAccount(account.id);
    expect(transient).toMatchObject({ status: "error", errorCode: "provider_unavailable", errorRetryable: true });
    expect(await w.store.getSyncState(account.id, "mail")).toMatchObject({ lastErrorCode: "provider_unavailable", lastErrorRetryable: true, consecutiveFailures: 3 });

    // a success clears both
    w.connector.clearFailures();
    t = MOCK_NOW.getTime() + 24 * 3600_000;
    const [ok] = await engine.runAccount(account.id);
    expect(ok).toMatchObject({ status: "ok", errorCode: null, errorRetryable: null });
    expect(await w.store.getSyncState(account.id, "mail")).toMatchObject({ status: "idle", lastErrorCode: null, lastErrorRetryable: null, consecutiveFailures: 0 });
  });
});

describe("scheduling passes that cannot resume", () => {
  const bankConnector = (order: string[]) => ({
    provider: "plaid" as const,
    capabilities: ["bank"] as const,
    nonResumable: ["bank"] as const,
    discoverAccount: () => Promise.reject(new Error("unused")),
    async *syncBank(): AsyncIterable<SyncPage<BankSyncBatch>> {
      order.push("bank");
      yield { batch: { accounts: [], transactions: [], deleted: [] }, checkpoint: { cursor: "c1" }, done: true };
    },
  });

  it("scheduleCapabilities puts a connector's non-resumable capabilities first, across accounts, and keeps the rest in store order", () => {
    const registry = new ConnectorRegistry().register(new MockConnector()).register(bankConnector([]) as never);
    const google = { ...mockAccountInput({ capabilities: ["mail", "calendar"] }), id: "g" } as unknown as ConnectorAccount;
    const plaid = { ...mockAccountInput({ provider: "plaid", capabilities: ["bank"] }), id: "p" } as unknown as ConnectorAccount;
    expect(scheduleCapabilities([google, plaid], registry).map((s) => [s.account.id, s.capability, s.resumable])).toEqual([
      ["p", "bank", false],
      ["g", "mail", true],
      ["g", "calendar", true],
    ]);
    // a provider without a connector counts as resumable: runCapability reports it as unsupported anyway
    expect(scheduleCapabilities([{ ...plaid, provider: "microsoft" } as ConnectorAccount], new ConnectorRegistry()).map((s) => s.resumable)).toEqual([true]);
  });

  it("runAll runs the pass that cannot resume before the others, whatever the account order", async () => {
    const w = world();
    const order: string[] = [];
    const registry = new ConnectorRegistry().register(w.connector).register(bankConnector(order) as never);
    await seedMockAccount(w.store, w.credentials, { capabilities: ["mail"] });
    await w.store.createConnectorAccount(mockAccountInput({ provider: "plaid", capabilities: ["bank"], externalAccountId: "item-1", address: null, credentialRef: "plaid-cred" }));
    await w.credentials.put("plaid-cred", fakeCredential());
    const engine = new SyncEngine({ store: w.store, registry, credentials: w.credentials, linker: w.linker, now: tickingClock() });
    const report = await engine.runAll();
    expect(report.outcomes.map((o) => [o.provider, o.capability, o.status])).toEqual([
      ["plaid", "bank", "ok"],
      ["mock", "mail", "ok"],
    ]);
    expect(order).toEqual(["bank"]);
  });
});

describe("a capability the grant does not cover", () => {
  it("errors that capability only: the account stays active and the others keep syncing", async () => {
    const store = new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() });
    const account = await store.createConnectorAccount(mockAccountInput({ capabilities: ["mail", "calendar"] }));
    const credentials = new InMemoryCredentialStore();
    await credentials.put(account.credentialRef!, fakeCredential());
    const connector = {
      provider: "mock" as const,
      capabilities: ["mail", "calendar"] as const,
      discoverAccount: () => Promise.resolve({ externalAccountId: "x", label: "x", address: null, capabilities: ["mail", "calendar"] as const }),
      // eslint-disable-next-line require-yield
      async *syncMail() {
        throw new ConnectorError("unsupported", "Google grant does not cover this API", false);
      },
      async *syncCalendar() {
        yield { batch: { events: [], deleted: [] }, checkpoint: { token: "c1" }, done: true };
      },
    };
    const clock = tickingClock(MOCK_NOW, 1000);
    const engine = new SyncEngine({ store, registry: new ConnectorRegistry().register(connector as never), credentials, linker: new ContextLinker(store, { now: clock, selfAddresses: [] }), now: clock });
    const outcomes = await engine.runAccount(account.id);
    expect(outcomes.map((o) => [o.capability, o.status, o.errorCode ?? null])).toEqual([
      ["mail", "error", "unsupported"],
      ["calendar", "ok", null],
    ]);
    expect((await store.getConnectorAccount(account.id))?.status).toBe("active");
    expect((await store.getSyncState(account.id, "calendar"))?.checkpoint).toEqual({ token: "c1" });
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

    // One second later (the clock ticks 1 s per read): held — and, the failure being non-retryable, for the cap, not a 10 min probe.
    const held = await engine.runCapability(account, "mail");
    expect(held.status).toBe("skipped");
    expect(held.reason).toMatch(/held until .*: the last failure \(invalid_response\) repeats until something changes/);
    expect(connector.calls.filter((c) => c.capability === "mail")).toHaveLength(1);

    // The user's own Sync now goes through.
    const forced = await engine.runCapability(account, "mail", undefined, { force: true });
    expect(forced.status).toBe("error");
    expect((await store.getSyncState(account.id, "mail"))?.consecutiveFailures).toBe(2);
    expect(connector.calls.filter((c) => c.capability === "mail")).toHaveLength(2);
  });

  it("holdReason: recent running → held; stale running → free; errors respect backoff", () => {
    const base = { userId: DEV_USER_ID, connectorAccountId: "c", capability: "mail" as const, enabled: true, checkpoint: null, lastSuccessAt: null, lastError: null, lastErrorCode: null, lastErrorRetryable: null, reconcile: [], updatedAt: "2026-09-10T09:00:00.000Z" };
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
