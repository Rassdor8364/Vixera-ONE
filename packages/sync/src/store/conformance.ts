/**
 * One contract, two implementations. Everything in here must hold for
 * InMemorySpineStore (the fast executable spec) AND for SupabaseSpineStore
 * against a real PostgREST + PostgreSQL (`scripts/live-stack.sh`). Whenever the
 * two drift, this is where it shows.
 *
 * The in-memory suite runs on every `pnpm test`; the live suite runs when
 * VIXERA_LIVE_URL is set (see docs/supabase.md).
 */
import { describe, expect, it } from "vitest";
import { newId, ref, type ConnectorAccount, type UserId } from "@vixera/domain";
import type { SpineStore } from "./spine-store.ts";
import { SpineIntegrityError } from "./spine-store.ts";

export interface ConformanceContext {
  /** A store bound to `userId`, on a database with no rows for it yet. */
  readonly store: SpineStore;
  readonly userId: UserId;
}

export type ConformanceFactory = () => Promise<ConformanceContext> | ConformanceContext;

const MAIL = (externalId: string, overrides: Record<string, unknown> = {}) => ({
  externalId,
  externalThreadId: `thr-${externalId}`,
  subject: `Subject ${externalId}`,
  snippet: null,
  bodyText: "body",
  from: { email: "eric@lindqvist.example", name: "Eric Lindqvist" },
  to: [{ email: "dev@vixera.example", name: null }],
  cc: [],
  sentAt: "2026-09-08T10:00:00Z",
  receivedAt: "2026-09-08T10:00:05Z",
  isUnread: true,
  attachments: [{ attachmentId: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 1200 }],
  labels: ["INBOX"],
  ...overrides,
});

const EVENT = (externalId: string, calendarId: string, overrides: Record<string, unknown> = {}) => ({
  externalCalendarId: calendarId,
  externalId,
  title: `Event ${externalId}`,
  description: null,
  startsAt: "2026-09-10T15:00:00Z",
  endsAt: "2026-09-10T15:45:00Z",
  allDay: false,
  timezone: "UTC",
  location: null,
  status: "confirmed" as const,
  organizer: null,
  participants: [{ email: "priya@northwind.example", name: "Priya", response: "accepted" as const, isOrganizer: true, isSelf: false }],
  externalLink: null,
  ...overrides,
});

export function runSpineStoreConformance(label: string, create: ConformanceFactory): void {
  describe(`SpineStore conformance (${label})`, () => {
    async function withAccount(): Promise<{ store: SpineStore; userId: UserId; account: ConnectorAccount }> {
      const { store, userId } = await create();
      const account = await store.createConnectorAccount({
        provider: "mock",
        externalAccountId: `acct-${newId()}`,
        label: "Conformance account",
        address: "dev@vixera.example",
        capabilities: ["mail", "calendar", "bank"],
        status: "active",
        credentialLocation: "none",
        credentialRef: null,
        lastError: null,
        metadata: {},
      });
      return { store, userId, account };
    }

    it("upserts mail by natural key: re-running a batch changes nothing", async () => {
      const { store, account } = await withAccount();
      const first = await store.upsertMailMessages(account.id, [MAIL("m-1"), MAIL("m-2")]);
      expect(first.inserted).toBe(2);
      const again = await store.upsertMailMessages(account.id, [MAIL("m-1"), MAIL("m-2", { subject: "Changed" })]);
      expect(again.inserted).toBe(0);
      expect(again.updated).toBe(2);
      const rows = await store.listMailMessages({ connectorAccountId: account.id });
      expect(rows).toHaveLength(2);
      expect(rows.find((m) => m.externalId === "m-2")?.subject).toBe("Changed");
      // jsonb round-trips in the documented (camelCase) shape
      const one = rows.find((m) => m.externalId === "m-1");
      expect(one?.to[0]?.email).toBe("dev@vixera.example");
      expect(one?.attachments[0]?.filename).toBe("invoice.pdf");
      expect(one?.attachments[0]?.sizeBytes).toBe(1200);
      expect(one?.isUnread).toBe(true);
      expect(await store.findMailMessageByExternalId(account.id, "m-1")).not.toBeNull();
    });

    it("keeps two accounts of the same provider apart even with identical external ids", async () => {
      const { store, account } = await withAccount();
      const second = await store.createConnectorAccount({
        provider: "mock",
        externalAccountId: `acct-${newId()}`,
        label: "Second account",
        address: "work@vixera.example",
        capabilities: ["mail"],
        status: "active",
        credentialLocation: "none",
        credentialRef: null,
        lastError: null,
        metadata: {},
      });
      await store.upsertMailMessages(account.id, [MAIL("shared-id")]);
      await store.upsertMailMessages(second.id, [MAIL("shared-id", { subject: "Other account" })]);
      const a = await store.listMailMessages({ connectorAccountId: account.id });
      const b = await store.listMailMessages({ connectorAccountId: second.id });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      expect(a[0]?.id).not.toBe(b[0]?.id);
      expect(b[0]?.subject).toBe("Other account");
      // and their sync states are independent
      await store.upsertSyncState(account.id, "mail", { checkpoint: { historyId: "1" }, status: "idle" });
      await store.upsertSyncState(second.id, "mail", { checkpoint: { historyId: "9" }, status: "error", lastError: "nope" });
      expect((await store.getSyncState(account.id, "mail"))?.checkpoint).toEqual({ historyId: "1" });
      expect((await store.getSyncState(second.id, "mail"))?.status).toBe("error");
      expect((await store.getSyncState(account.id, "mail"))?.status).toBe("idle");
    });

    it("scopes calendar rows and deletions by calendar", async () => {
      const { store, account } = await withAccount();
      await store.upsertTimeEvents(account.id, [EVENT("e-1", "primary"), EVENT("e-1", "shared"), EVENT("e-2", "primary")]);
      const all = await store.listTimeEvents({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
      expect(all).toHaveLength(3);
      expect(all[0]?.participants[0]?.isOrganizer).toBe(true);
      expect(all[0]?.participants[0]?.email).toBe("priya@northwind.example");
      expect(await store.deleteTimeEvents(account.id, ["e-1"], "shared")).toBe(1);
      const left = await store.listTimeEvents({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
      expect(left.map((e) => `${e.externalCalendarId}:${e.externalId}`).sort()).toEqual(["primary:e-1", "primary:e-2"]);
      // the window filter is an overlap test
      expect(await store.listTimeEvents({ from: "2026-09-10T15:30:00Z", to: "2026-09-10T16:00:00Z" })).toHaveLength(2);
      expect(await store.listTimeEvents({ from: "2026-09-11T00:00:00Z", to: "2026-09-12T00:00:00Z" })).toHaveLength(0);
    });

    it("stores money as decimal strings with the connector's sign convention", async () => {
      const { store, account } = await withAccount();
      await store.upsertMoneyAccounts(account.id, [
        { externalId: "acc-1", name: "Business checking", officialName: null, type: "checking", currency: "USD", balanceCurrent: "18250.40", balanceAvailable: "17900.40", balanceAsOf: "2026-09-09T00:00:00Z", mask: "4471" },
      ]);
      await store.upsertMoneyTransactions(account.id, [
        { externalId: "tx-in", accountExternalId: "acc-1", amount: "12400.00", currency: "USD", description: "NORTHWIND CO PAYOUT", merchantName: "Northwind Co.", postedOn: "2026-09-08", authorizedAt: null, pending: false, category: ["transfer"] },
        { externalId: "tx-out", accountExternalId: "acc-1", amount: "-2400.00", currency: "USD", description: "LINDQVIST STUDIO", merchantName: "Lindqvist Studio", postedOn: "2026-09-01", authorizedAt: null, pending: false, category: [] },
      ]);
      // Decimals are canonical strings on both sides: what a connector writes
      // ("18250.40") and what numeric(20,4) reads back ("18250.4000") agree,
      // and no value ever passes through a float.
      const [acct] = await store.listMoneyAccounts(account.id);
      expect(acct?.balanceCurrent).toBe("18250.4");
      expect(typeof acct?.balanceCurrent).toBe("string");
      const txs = await store.listMoneyTransactions({ connectorAccountId: account.id });
      expect(txs.map((t) => t.amount).sort()).toEqual(["-2400", "12400"]);
      expect(txs.every((t) => typeof t.amount === "string")).toBe(true);
      // a value beyond double precision survives intact
      await store.upsertMoneyTransactions(account.id, [
        { externalId: "tx-big", accountExternalId: "acc-1", amount: "-90071992547409.9123", currency: "USD", description: "BIG", merchantName: null, postedOn: "2026-09-02", authorizedAt: null, pending: false, category: [] },
      ]);
      const big = (await store.listMoneyTransactions({ connectorAccountId: account.id })).find((t) => t.externalId === "tx-big");
      expect(big?.amount).toBe("-90071992547409.9123");
      expect(await store.deleteMoneyTransactions(account.id, ["tx-out", "tx-big"])).toBe(2);
      expect(await store.listMoneyTransactions({ connectorAccountId: account.id })).toHaveLength(1);
    });

    it("dedupes context events by key and never overwrites an attention decision", async () => {
      const { store, account } = await withAccount();
      await store.upsertMailMessages(account.id, [MAIL("m-ce")]);
      const mail = await store.findMailMessageByExternalId(account.id, "m-ce");
      const event = {
        kind: "mail.received",
        subject: ref("mail_message", mail!.id),
        title: "Eric sent the revised invoice",
        summary: null,
        occurredAt: "2026-09-08T10:00:05Z",
        importance: 60,
        dueAt: null,
        attention: "needs_attention" as const,
        connectorAccountId: account.id,
        dedupeKey: `mail:${account.id}:m-ce`,
        metadata: {},
      };
      const first = await store.upsertContextEvents([event]);
      expect(first.inserted).toBe(1);
      const id = first.rows[0]!.id;
      await store.setContextEventAttention(id, "quiet");
      const second = await store.upsertContextEvents([event]);
      expect(second.inserted).toBe(0);
      expect((await store.getContextEvent(id))?.attention).toBe("quiet");
      expect(await store.listContextEvents({ attention: ["quiet", "dismissed"] })).toHaveLength(1);
      expect(await store.listContextEvents({ attention: "needs_attention" })).toHaveLength(0);
    });

    it("relates entities idempotently, answers neighbors in both directions and rejects dangling edges", async () => {
      const { store, account } = await withAccount();
      const person = await store.upsertPerson({ displayName: "Eric Lindqvist", primaryEmail: "eric@lindqvist.example", organization: "Lindqvist Studio", notes: null, metadata: {} });
      const thread = await store.createThread({ title: "Brand", kind: "project", status: "active", summary: null, metadata: {} });
      const doc = await store.upsertDocument({
        title: "Invoice #0231", mimeType: "application/pdf", source: "mail_attachment", connectorAccountId: account.id,
        sourceRef: { connectorAccountId: account.id, messageExternalId: "m-1", attachmentId: "att-1" },
        location: { kind: "none" }, praxionDocumentId: null, sizeBytes: 1200, contentHash: "abc123", metadata: {},
      });
      const edge = await store.relate({ from: ref("person", person.id), kind: "relates_to", to: ref("document", doc.id), source: "rule", confidence: 0.6 });
      const same = await store.relate({ from: ref("person", person.id), kind: "relates_to", to: ref("document", doc.id), source: "rule", confidence: 0.9 });
      expect(same.id).toBe(edge.id);
      await store.relate({ from: ref("document", doc.id), kind: "belongs_to", to: ref("thread", thread.id) });
      await store.relate({ from: ref("thread", thread.id), kind: "has_person", to: ref("person", person.id) });

      const docNeighbors = await store.neighbors(ref("document", doc.id));
      expect(docNeighbors.map((n) => `${n.direction}:${n.kind}:${n.ref.type}`).sort()).toEqual(["in:relates_to:person", "out:belongs_to:thread"]);
      expect(await store.neighbors(ref("thread", thread.id), { type: "person" })).toHaveLength(1);
      expect(await store.neighbors(ref("thread", thread.id), { direction: "out", kind: "has_person" })).toHaveLength(1);
      expect(await store.neighbors(ref("thread", thread.id), { direction: "in", kind: "has_person" })).toHaveLength(0);

      await expect(store.relate({ from: ref("person", person.id), kind: "relates_to", to: ref("document", newId()) })).rejects.toBeInstanceOf(SpineIntegrityError);
      expect(await store.unrelate({ from: ref("document", doc.id), kind: "belongs_to", to: ref("thread", thread.id) })).toBe(true);
      expect(await store.unrelate({ from: ref("document", doc.id), kind: "belongs_to", to: ref("thread", thread.id) })).toBe(false);
      expect(await store.findDocumentByHash("abc123")).not.toBeNull();
      expect(await store.findDocumentByHash("nothing")).toBeNull();
      // source-ref lookup is exact equality, and scoped to the account
      expect((await store.findDocumentBySourceRef(account.id, { connectorAccountId: account.id, messageExternalId: "m-1", attachmentId: "att-1" }))?.id).toBe(doc.id);
      expect(await store.findDocumentBySourceRef(account.id, { attachmentId: "att-1" })).toBeNull();
      expect(await store.findDocumentBySourceRef(null, doc.sourceRef)).toBeNull();
    });

    it("resolves people by normalized identity and never duplicates one", async () => {
      const { store } = await create();
      const person = await store.upsertPerson({ displayName: "Marta Ruiz", primaryEmail: "marta@ruiz.example", organization: "Ruiz Legal", notes: null, metadata: {} });
      await store.upsertPersonIdentity({ personId: person.id, kind: "email", value: "marta@ruiz.example", rawValue: "Marta@Ruiz.example", provider: "mock", connectorAccountId: null });
      const again = await store.upsertPersonIdentity({ personId: person.id, kind: "email", value: "marta@ruiz.example", rawValue: "marta@ruiz.example", provider: "mock", connectorAccountId: null });
      expect(again.personId).toBe(person.id);
      expect((await store.findPersonByIdentity("email", "marta@ruiz.example"))?.id).toBe(person.id);
      expect(await store.findPersonByIdentity("email", "nobody@example.com")).toBeNull();
      expect((await store.listPeople({ search: "ruiz" })).map((p) => p.id)).toContain(person.id);
      expect(await store.listPersonIdentities(person.id)).toHaveLength(1);
    });

    it("deleting an entity takes its edges and context events with it", async () => {
      const { store, account } = await withAccount();
      await store.upsertMailMessages(account.id, [MAIL("m-del")]);
      const mail = await store.findMailMessageByExternalId(account.id, "m-del");
      const person = await store.upsertPerson({ displayName: "Ghost", primaryEmail: null, organization: null, notes: null, metadata: {} });
      await store.relate({ from: ref("mail_message", mail!.id), kind: "has_person", to: ref("person", person.id) });
      await store.upsertContextEvents([
        { kind: "mail.received", subject: ref("mail_message", mail!.id), title: "x", summary: null, occurredAt: "2026-09-08T10:00:05Z", importance: 40, dueAt: null, attention: "needs_attention", connectorAccountId: account.id, dedupeKey: `mail:${account.id}:m-del`, metadata: {} },
      ]);
      expect(await store.deleteMailMessages(account.id, ["m-del"])).toBe(1);
      expect(await store.neighbors(ref("person", person.id))).toHaveLength(0);
      expect(await store.listContextEvents({ kindPrefix: "mail." })).toHaveLength(0);
    });

    it("returns the whole context graph, past any server row cap", async () => {
      const { store } = await create();
      const thread = await store.createThread({ title: "Big", kind: null, status: "active", summary: null, metadata: {} });
      const people = [];
      for (let i = 0; i < 30; i++) {
        people.push(await store.upsertPerson({ displayName: `Person ${i}`, primaryEmail: null, organization: null, notes: null, metadata: {} }));
      }
      for (const p of people) await store.relate({ from: ref("thread", thread.id), kind: "has_person", to: ref("person", p.id) });
      const all = await store.listRelationships({ limit: 5000 });
      expect(all).toHaveLength(30);
      // People and threads read the same way: the merchant index and One
      // Command both list them unbounded.
      expect(await store.listPeople()).toHaveLength(30);
      expect(await store.listThreads()).toHaveLength(1);
      // the last edge written is present, not just the oldest page
      const last = people[people.length - 1]!;
      expect(all.some((r) => r.to.id === last.id)).toBe(true);
    });

    it("action requests are idempotent by key", async () => {
      const { store } = await create();
      const key = `context_event.dismiss:${newId()}`;
      const first = await store.createActionRequest({ actionType: "context_event.dismiss", idempotencyKey: key, payload: { contextEventId: "x" } });
      expect(first.created).toBe(true);
      const replay = await store.createActionRequest({ actionType: "context_event.dismiss", idempotencyKey: key, payload: { contextEventId: "x" } });
      expect(replay.created).toBe(false);
      expect(replay.request.id).toBe(first.request.id);
      const done = await store.updateActionRequest(first.request.id, { status: "done", result: { ok: true }, attempts: 1 });
      expect(done.status).toBe("done");
      expect((await store.findActionRequestByKey(key))?.result).toEqual({ ok: true });
    });

    it("carries a handoff from one device to another", async () => {
      const { store } = await create();
      const win = await store.upsertDevice({ platform: "windows", name: "Field PC", praxionAvailable: true, lastSeenAt: null });
      const droid = await store.upsertDevice({ platform: "android", name: "Phone", praxionAvailable: false, lastSeenAt: null });
      const doc = await store.upsertDocument({
        title: "Operating agreement v3.pdf", mimeType: "application/pdf", source: "drop", connectorAccountId: null, sourceRef: {},
        location: { kind: "storage", bucket: "artifacts", path: "u/doc.pdf" }, praxionDocumentId: "praxion-1", sizeBytes: 900, contentHash: null, metadata: {},
      });
      const handoff = await store.createHandoff({
        sourceDeviceId: win.id, targetDeviceId: droid.id, state: "pending", focus: ref("document", doc.id), threadId: null, documentId: doc.id,
        artifactStoragePath: "u/doc.pdf", praxionLocation: { page: 7, position: { x: 0.1 }, selectionText: "7.1" },
        conclusions: ["Clause 7.1 now covers contractors"], commandHistory: ["Summarize this"], deliveredAt: null, acceptedAt: null, expiresAt: null, metadata: {},
      });
      const loaded = await store.getHandoff(handoff.id);
      expect(loaded?.praxionLocation?.page).toBe(7);
      expect(loaded?.conclusions).toEqual(["Clause 7.1 now covers contractors"]);
      expect(loaded?.focus).toEqual(ref("document", doc.id));
      const accepted = await store.updateHandoff(handoff.id, { state: "accepted", acceptedAt: "2026-09-09T16:00:00Z" });
      expect(accepted.state).toBe("accepted");
      expect(await store.listHandoffs({ state: "accepted" })).toHaveLength(1);
      expect(await store.listHandoffs({ state: ["pending"] })).toHaveLength(0);
    });

    it("runs an ingest item through to a document", async () => {
      const { store } = await create();
      const item = await store.createIngestItem({
        deviceId: null, kind: "file", source: "share", title: "invoice-0231.pdf", textContent: null, url: null,
        mimeType: "application/pdf", sizeBytes: 118000, storagePath: "u/ingest/invoice.pdf", status: "received", documentId: null, error: null, metadata: { contentHash: "hash-1" }, processedAt: null,
      });
      expect(await store.listIngestItems({ status: "received" })).toHaveLength(1);
      const doc = await store.upsertDocument({
        title: "invoice-0231.pdf", mimeType: "application/pdf", source: "share", connectorAccountId: null, sourceRef: {},
        location: { kind: "storage", bucket: "artifacts", path: "u/ingest/invoice.pdf" }, praxionDocumentId: null, sizeBytes: 118000, contentHash: "hash-1", metadata: {},
      });
      const processed = await store.updateIngestItem(item.id, { status: "processed", documentId: doc.id, processedAt: "2026-09-09T12:00:00Z" });
      expect(processed.status).toBe("processed");
      expect(processed.documentId).toBe(doc.id);
      expect(await store.listIngestItems({ status: "received" })).toHaveLength(0);
      expect((await store.getIngestItem(item.id))?.metadata).toEqual({ contentHash: "hash-1" });
    });
  });
}
