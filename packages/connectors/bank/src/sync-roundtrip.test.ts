/**
 * The bank connector through the real `SyncEngine`, `ContextLinker` and
 * `InMemorySpineStore` (`@vixera/sync`, dev dependency): what the engine
 * persists is what the store ends up holding. The docs require, for every
 * provider, a second run with the produced checkpoint that changes nothing.
 * Pages are applied through the store, so a pending→posted transition and a
 * mutation-driven replay are checked on rows, not on page shapes.
 */
import { ConnectorRegistry, DEV_USER_ID, InMemoryCredentialStore, type ConnectorAccount, type ConnectorCredential, type JsonObject } from "@vixera/domain";
import { ContextLinker, InMemorySpineStore, SyncEngine, type SpineStore } from "@vixera/sync";
import { describe, expect, it } from "vitest";
import accountsFixture from "./__fixtures__/plaid-accounts.json";
import itemFixture from "./__fixtures__/plaid-item.json";
import page1 from "./__fixtures__/plaid-transactions-sync-page1.json";
import page2 from "./__fixtures__/plaid-transactions-sync-page2.json";
import { BankConnector } from "./connector.ts";
import { completeBankRelink, createPlaidBankConnector } from "./link.ts";
import { MOCK_ITEM_ID, MOCK_TRANSACTIONS, MockBankProvider } from "./mock/provider.ts";
import { BankPaginationMutationError } from "./provider.ts";
import { PlaidClient } from "./plaid/client.ts";
import { FAKE_CREDENTIAL, FAKE_PLAID_CONFIG } from "./testing/context.ts";
import { createFakeFetch, type FakeReply, type FakeRequest } from "./testing/fake-fetch.ts";

const MUTATION: FakeReply = { status: 400, json: { error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", request_id: "req-fake-mut" } };

function clock(start = Date.parse("2026-09-10T12:00:00.000Z"), stepMs = 1000): () => Date {
  let t = start;
  return () => new Date((t += stepMs));
}

interface World {
  readonly store: SpineStore;
  readonly engine: SyncEngine;
  readonly account: ConnectorAccount;
  readonly credentials: InMemoryCredentialStore;
  readonly logs: { message: string; data?: JsonObject }[];
}

/** One engine over one connector and one linked account of it, credential in the (in-memory) vault. */
async function world(connector: BankConnector, options: { fetch?: typeof fetch; credential?: ConnectorCredential; externalAccountId: string }): Promise<World> {
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock() });
  const credentials = new InMemoryCredentialStore();
  const credentialRef = await credentials.put(null, options.credential ?? FAKE_CREDENTIAL);
  const account = await store.createConnectorAccount({
    provider: connector.provider,
    externalAccountId: options.externalAccountId,
    label: "Bank",
    address: null,
    capabilities: ["bank"],
    status: "active",
    credentialLocation: "server_vault",
    credentialRef,
    lastError: null,
    metadata: {},
  });
  const logs: World["logs"] = [];
  const engine = new SyncEngine({
    store,
    registry: new ConnectorRegistry().register(connector),
    credentials,
    linker: new ContextLinker(store, { now: clock() }),
    now: clock(),
    fetch: options.fetch ?? (async () => { throw new Error("no network in tests"); }),
    log: (message, data) => logs.push(data ? { message, data } : { message }),
  });
  return { store, engine, account, credentials, logs };
}

/** Rows the store holds for the world's one account. Amounts come back canonical ("-6.4"). */
async function snapshot(w: World) {
  const transactions = await w.store.listMoneyTransactions({ connectorAccountId: w.account.id });
  return {
    accounts: (await w.store.listMoneyAccounts(w.account.id)).map((a) => [a.externalId, a.balanceCurrent]),
    transactions: transactions.map((t) => [t.externalId, t.amount, t.description, t.pending]).sort(),
    contextEvents: (await w.store.listContextEvents()).length,
    checkpoint: (await w.store.getSyncState(w.account.id, "bank"))?.checkpoint ?? null,
  };
}

/** What "changes nothing" means for a bank run: accounts are re-upserted for their balances by design, nothing else moves. */
const nothingBut = (accounts: number) => ({ inserted: 0, updated: accounts, deleted: 0, contextEvents: 0 });

const plaidRoutes = (syncReply: (req: FakeRequest, cursor: string | null) => FakeReply) =>
  createFakeFetch([
    { match: "/item/get", reply: { json: itemFixture } },
    { match: "/accounts/get", reply: { json: accountsFixture } },
    { match: "/transactions/sync", reply: (req) => syncReply(req, (JSON.parse(req.call.body ?? "{}") as { cursor?: string }).cursor ?? null) },
  ]);

const happyPath = (_req: FakeRequest, cursor: string | null): FakeReply =>
  cursor === null ? { json: page1 } : cursor === "fake-cursor-page-1" ? { json: page2 } : { json: { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false } };

describe("BankConnector through the SyncEngine", () => {
  it("mock provider: one run fills the store, a second run with the produced checkpoint changes nothing", async () => {
    const mock = new MockBankProvider({ pageSize: 2 });
    const w = await world(new BankConnector(mock), { externalAccountId: MOCK_ITEM_ID, credential: { kind: "access_token", accessToken: "fake-token" } });

    const first = await w.engine.runAccount(w.account.id);
    expect(first.map((o) => [o.status, o.pages, o.checkpointAdvanced, o.interrupted])).toEqual([["ok", 2, true, false]]);
    expect(first[0]!.counts).toMatchObject({ inserted: 1 + MOCK_TRANSACTIONS.length, updated: 0, deleted: 0 });
    const after1 = await snapshot(w);
    expect(after1.transactions.map((t) => t[0])).toEqual([...MOCK_TRANSACTIONS.map((t) => t.externalId)].sort());
    expect(after1.checkpoint).toEqual({ cursor: mock.latestCursor });
    expect(after1.contextEvents).toBe(MOCK_TRANSACTIONS.length);

    const second = await w.engine.runAccount(w.account.id, { force: true });
    expect(second.map((o) => [o.status, o.pages, o.checkpointAdvanced])).toEqual([["ok", 1, false]]);
    expect(second[0]!.counts).toMatchObject(nothingBut(1));
    expect(await snapshot(w)).toEqual(after1);

    // A change appended after the cursor arrives as a delta; the pending coffee settles under a new id.
    const coffee = MOCK_TRANSACTIONS.find((t) => t.externalId === "mock-txn-coffee-1")!;
    mock.removeTransaction(coffee.externalId).addTransaction({ ...coffee, externalId: "mock-txn-coffee-2", pending: false });
    const third = await w.engine.runAccount(w.account.id, { force: true });
    expect(third[0]!.counts).toMatchObject({ inserted: 1, deleted: 1 });
    const after3 = await snapshot(w);
    expect(after3.transactions.find((t) => t[0] === "mock-txn-coffee-1")).toBeUndefined();
    expect(after3.transactions.find((t) => t[0] === "mock-txn-coffee-2")).toEqual(["mock-txn-coffee-2", "-6.4", "KAFFE CENTRAL", false]);
    expect(after3.checkpoint).toEqual({ cursor: mock.latestCursor });
    expect((await w.engine.runAccount(w.account.id, { force: true }))[0]!.counts).toMatchObject(nothingBut(1));
  });

  it("Plaid provider: pending→posted leaves one KAFFE CENTRAL row, and the second run is a no-op from the committed cursor", async () => {
    const ff = plaidRoutes(happyPath);
    const w = await world(createPlaidBankConnector(FAKE_PLAID_CONFIG), { fetch: ff.fetch, externalAccountId: "fake-item-id-1" });

    const first = await w.engine.runAccount(w.account.id);
    expect(first.map((o) => [o.status, o.pages, o.checkpointAdvanced, o.interrupted])).toEqual([["ok", 2, true, false]]);
    const after1 = await snapshot(w);
    expect(after1.accounts).toHaveLength(accountsFixture.accounts.length);
    // The pending coffee row is gone, its posted successor is there once, and page 2's modification stuck.
    expect(after1.transactions).toEqual([
      ["fake-txn-coffee-posted", "-6.4", "KAFFE CENTRAL", false],
      ["fake-txn-lindqvist", "-2400", "LINDQVIST STUDIO AB", false],
      ["fake-txn-northwind", "12400", "NORTHWIND CO INVOICE 2026-041", false],
    ]);
    // One event per surviving transaction: the pending coffee's event left with its row.
    expect(after1.contextEvents).toBe(3);
    // The final checkpoint is the has_more:false cursor (that intermediate pages
    // never advanced it is what the dies-mid-update test below asserts).
    expect(after1.checkpoint).toEqual({ cursor: "fake-cursor-page-2" });

    const second = await w.engine.runAccount(w.account.id, { force: true });
    expect(second.map((o) => [o.status, o.pages, o.checkpointAdvanced])).toEqual([["ok", 1, false]]);
    expect(second[0]!.counts).toMatchObject(nothingBut(accountsFixture.accounts.length));
    expect(await snapshot(w)).toEqual(after1);
    const cursors = ff.callsTo("/transactions/sync").map((c) => (JSON.parse(c.body ?? "{}") as { cursor?: string }).cursor ?? null);
    expect(cursors).toEqual([null, "fake-cursor-page-1", "fake-cursor-page-2"]);
  });

  it("Plaid provider: the run's time budget interrupts an update before any resume point, and the next run redoes it whole", async () => {
    const ff = plaidRoutes(happyPath);
    const w = await world(createPlaidBankConnector(FAKE_PLAID_CONFIG), { fetch: ff.fetch, externalAccountId: "fake-item-id-1" });
    // The deadline is already past once the first page has been read: the engine
    // stops there, and a bank update has no cursor to keep before has_more:false.
    const first = await w.engine.runCapability(w.account, "bank", Date.parse("2026-09-10T12:00:00.000Z") + 1);
    expect(first).toMatchObject({ status: "ok", interrupted: true, checkpointAdvanced: false, pages: 1 });
    expect((await snapshot(w)).checkpoint).toBeNull();
    expect(ff.callsTo("/transactions/sync")).toHaveLength(1);

    const second = await w.engine.runCapability(w.account, "bank");
    expect(second).toMatchObject({ status: "ok", interrupted: false, checkpointAdvanced: true, pages: 2 });
    // Restarted from the cursor the interrupted update began with (null), not from page 1's.
    expect(ff.callsTo("/transactions/sync").map((c) => (JSON.parse(c.body ?? "{}") as { cursor?: string }).cursor ?? null)).toEqual([null, null, "fake-cursor-page-1"]);
    expect((await snapshot(w)).checkpoint).toEqual({ cursor: "fake-cursor-page-2" });
  });

  it("Plaid provider: a transaction's context event is dated by authorized_datetime when there is one, else by the posting date at UTC midnight", async () => {
    const ff = plaidRoutes(happyPath);
    const w = await world(createPlaidBankConnector(FAKE_PLAID_CONFIG), { fetch: ff.fetch, externalAccountId: "fake-item-id-1" });
    await w.engine.runAccount(w.account.id);
    const byExternal = new Map((await w.store.listMoneyTransactions({ connectorAccountId: w.account.id })).map((t) => [t.externalId, t.id]));
    const events = await w.store.listContextEvents();
    // Compared as instants: the in-memory store keeps the connector's own ISO form, Postgres canonicalizes it.
    const occurredAt = (externalId: string) => Date.parse(events.find((e) => e.subject.type === "money_transaction" && e.subject.id === byExternal.get(externalId))?.occurredAt ?? "");
    expect(occurredAt("fake-txn-northwind")).toBe(Date.parse("2026-09-08T09:12:00Z")); // authorized_datetime in the fixture
    expect(occurredAt("fake-txn-lindqvist")).toBe(Date.parse("2026-09-09T00:00:00Z")); // authorized_date only: the posting date by convention
  });

  it("Plaid provider: a mutation mid-update replays page 1 through the store without duplicating anything", async () => {
    let mutated = false;
    const ff = plaidRoutes((req, cursor) => {
      if (cursor === "fake-cursor-page-1" && !mutated) {
        mutated = true;
        return MUTATION;
      }
      return happyPath(req, cursor);
    });
    const w = await world(createPlaidBankConnector(FAKE_PLAID_CONFIG), { fetch: ff.fetch, externalAccountId: "fake-item-id-1" });
    const [outcome] = await w.engine.runAccount(w.account.id);
    expect(outcome).toMatchObject({ status: "ok", pages: 3, checkpointAdvanced: true });
    const after = await snapshot(w);
    expect(after.transactions.map((t) => t[0])).toEqual(["fake-txn-coffee-posted", "fake-txn-lindqvist", "fake-txn-northwind"]);
    expect(after.checkpoint).toEqual({ cursor: "fake-cursor-page-2" });
    expect(after.contextEvents).toBe(3);
  });

  it("Plaid provider: a run that dies mid-update never leaves an intermediate cursor behind; the next run redoes the update", async () => {
    let calls = 0;
    const ff = plaidRoutes((req, cursor) => {
      calls += 1;
      // Second page of the first pass: the provider goes away.
      if (calls === 2) return { status: 503, json: { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" } };
      return happyPath(req, cursor);
    });
    const w = await world(createPlaidBankConnector(FAKE_PLAID_CONFIG), { fetch: ff.fetch, externalAccountId: "fake-item-id-1" });
    const [failed] = await w.engine.runAccount(w.account.id);
    expect(failed).toMatchObject({ status: "error", errorCode: "provider_unavailable", pages: 1, checkpointAdvanced: false });
    expect((await snapshot(w)).checkpoint).toBeNull();
    expect((await snapshot(w)).transactions.map((t) => t[0])).toEqual(["fake-txn-coffee-pending", "fake-txn-lindqvist", "fake-txn-northwind"]);

    const [ok] = await w.engine.runAccount(w.account.id, { force: true });
    expect(ok).toMatchObject({ status: "ok", pages: 2, checkpointAdvanced: true });
    const after = await snapshot(w);
    expect(after.transactions.map((t) => [t[0], t[3]])).toEqual([["fake-txn-coffee-posted", false], ["fake-txn-lindqvist", false], ["fake-txn-northwind", false]]);
    expect(after.checkpoint).toEqual({ cursor: "fake-cursor-page-2" });
    const cursors = ff.callsTo("/transactions/sync").map((c) => (JSON.parse(c.body ?? "{}") as { cursor?: string }).cursor ?? null);
    expect(cursors).toEqual([null, "fake-cursor-page-1", null, "fake-cursor-page-1"]);
  });

  it("mock provider: a mutation after page 1 is replayed through the store, and a pass that never settles leaves the old cursor", async () => {
    const mock = new MockBankProvider({ pageSize: 2 });
    mock.failNext({ method: "syncTransactions", error: new BankPaginationMutationError("mutated", null), afterPages: 1 });
    const w = await world(new BankConnector(mock), { externalAccountId: MOCK_ITEM_ID, credential: { kind: "access_token", accessToken: "fake-token" } });
    const [outcome] = await w.engine.runAccount(w.account.id);
    expect(outcome).toMatchObject({ status: "ok", pages: 3, checkpointAdvanced: true });
    expect((await snapshot(w)).transactions).toHaveLength(MOCK_TRANSACTIONS.length);
    expect((await snapshot(w)).checkpoint).toEqual({ cursor: mock.latestCursor });

    // The mock fails once per failNext, so a one-attempt connector over the same store stands in for a pass that never settles.
    mock.addTransaction({ ...MOCK_TRANSACTIONS[0]!, externalId: "mock-txn-new" });
    mock.failNext({ method: "syncTransactions", error: new BankPaginationMutationError("mutated again", null), afterPages: 0 });
    const oneShot = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(new BankConnector(mock, { maxAttempts: 1 })), credentials: w.credentials, linker: new ContextLinker(w.store, { now: clock() }), now: clock() });
    const [failed] = await oneShot.runAccount(w.account.id, { force: true });
    expect(failed).toMatchObject({ status: "error", errorCode: "unknown", checkpointAdvanced: false });
    // The unsettled pass left the previous cursor in place; the next run picks the new transaction up from it.
    expect((await snapshot(w)).checkpoint).toEqual({ cursor: "mock-cursor-4" });
    expect((await w.engine.runAccount(w.account.id, { force: true }))[0]!.counts).toMatchObject({ inserted: 1 });
    expect((await snapshot(w)).checkpoint).toEqual({ cursor: mock.latestCursor });
  });

  it("a needs_reauth Plaid account repaired through Link update mode keeps its row, its checkpoint and its rows", async () => {
    const ff = plaidRoutes(happyPath);
    const connector = createPlaidBankConnector(FAKE_PLAID_CONFIG);
    const w = await world(connector, { fetch: ff.fetch, externalAccountId: "fake-item-id-1" });
    await w.engine.runAccount(w.account.id);
    const before = await snapshot(w);

    // The bank rotated credentials: the next run sees ITEM_LOGIN_REQUIRED and the engine parks the account.
    const broken = plaidRoutes(() => ({ status: 400, json: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" } }));
    const brokenEngine = new SyncEngine({ store: w.store, registry: new ConnectorRegistry().register(connector), credentials: w.credentials, linker: new ContextLinker(w.store, { now: clock() }), now: clock(), fetch: broken.fetch });
    const [parked] = await brokenEngine.runAccount(w.account.id, { force: true });
    expect(parked).toMatchObject({ status: "error", errorCode: "unauthorized" });
    expect((await w.store.getConnectorAccount(w.account.id))?.status).toBe("needs_reauth");
    expect((await snapshot(w)).checkpoint).toEqual(before.checkpoint);

    // Update mode: same credential, no exchange, same item id → the natural key finds the existing row.
    const repaired = await completeBankRelink({ client: new PlaidClient(ff.fetch, FAKE_PLAID_CONFIG), connector, fetch: ff.fetch }, { credential: (await w.credentials.get(w.account.credentialRef!))! });
    expect(ff.callsTo("/item/public_token/exchange")).toHaveLength(0);
    const existing = await w.store.findConnectorAccount("plaid", repaired.discovered.externalAccountId);
    expect(existing?.id).toBe(w.account.id);
    await w.store.updateConnectorAccount(w.account.id, { status: "active", lastError: null });
    expect(await w.store.listConnectorAccounts()).toHaveLength(1);

    const [again] = await w.engine.runAccount(w.account.id, { force: true });
    expect(again).toMatchObject({ status: "ok", checkpointAdvanced: false });
    expect(again!.counts).toMatchObject(nothingBut(accountsFixture.accounts.length));
    expect(await snapshot(w)).toEqual(before);
  });
});
