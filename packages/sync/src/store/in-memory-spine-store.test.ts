import { describe, expect, it } from "vitest";
import { DEV_USER_ID, ref, type PersonId, type UserId } from "@vixera/domain";
import { InMemorySpineStore } from "./in-memory-spine-store.ts";
import { SpineIntegrityError, SpineNotFoundError } from "./spine-store.ts";
import { mockAccountInput, tickingClock } from "../testing/fixtures.ts";

async function storeWithAccount() {
  const store = new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() });
  const account = await store.createConnectorAccount(mockAccountInput());
  return { store, account };
}

const mail = (externalId: string, subject = "hello") => ({
  externalId,
  externalThreadId: null,
  subject,
  snippet: null,
  bodyText: null,
  from: { email: "a@example.com", name: "A" },
  to: [],
  cc: [],
  sentAt: null,
  receivedAt: "2026-09-09T10:00:00.000Z",
  isUnread: true,
  attachments: [],
  labels: [],
});

describe("InMemorySpineStore natural keys", () => {
  it("upserts mail by (connectorAccountId, externalId) and keeps the row id", async () => {
    const { store, account } = await storeWithAccount();
    const first = await store.upsertMailMessages(account.id, [mail("m1"), mail("m2")]);
    expect(first.inserted).toBe(2);
    const second = await store.upsertMailMessages(account.id, [mail("m1", "changed")]);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.rows[0]?.id).toBe(first.rows[0]?.id);
    expect(second.rows[0]?.subject).toBe("changed");
    expect(second.rows[0]?.createdAt).toBe(first.rows[0]?.createdAt);
    expect(await store.listMailMessages()).toHaveLength(2);
  });

  it("keeps identical external ids of two accounts apart", async () => {
    const { store, account } = await storeWithAccount();
    const other = await store.createConnectorAccount(mockAccountInput({ externalAccountId: "mock-user-2", label: "Other" }));
    await store.upsertMailMessages(account.id, [mail("same")]);
    await store.upsertMailMessages(other.id, [mail("same")]);
    expect(await store.listMailMessages()).toHaveLength(2);
    expect(await store.listMailMessages({ connectorAccountId: other.id })).toHaveLength(1);
  });

  it("resolves transactions to money accounts by external id and rejects unknown accounts", async () => {
    const { store, account } = await storeWithAccount();
    await store.upsertMoneyAccounts(account.id, [
      { externalId: "acct", name: "Checking", officialName: null, type: "checking", currency: "USD", balanceCurrent: "10", balanceAvailable: null, balanceAsOf: null, mask: null },
    ]);
    const tx = {
      externalId: "t1",
      accountExternalId: "acct",
      amount: "-5.50",
      currency: "USD",
      description: "Coffee",
      merchantName: null,
      postedOn: "2026-09-09",
      authorizedAt: null,
      pending: false,
      category: [],
    };
    const r = await store.upsertMoneyTransactions(account.id, [tx]);
    expect(r.rows[0]?.moneyAccountId).toBe((await store.listMoneyAccounts(account.id))[0]?.id);
    await expect(store.upsertMoneyTransactions(account.id, [{ ...tx, accountExternalId: "nope" }])).rejects.toBeInstanceOf(SpineIntegrityError);
  });

  it("upserts time events by (account, calendar, externalId) and filters by overlap", async () => {
    const { store, account } = await storeWithAccount();
    const event = (calendar: string, id: string, startsAt: string, endsAt: string) => ({
      externalCalendarId: calendar,
      externalId: id,
      title: id,
      description: null,
      startsAt,
      endsAt,
      allDay: false,
      timezone: null,
      location: null,
      status: "confirmed" as const,
      organizer: null,
      participants: [],
      externalLink: null,
    });
    await store.upsertTimeEvents(account.id, [
      event("primary", "e1", "2026-09-10T10:00:00.000Z", "2026-09-10T11:00:00.000Z"),
      event("work", "e1", "2026-09-12T10:00:00.000Z", "2026-09-12T11:00:00.000Z"),
    ]);
    const again = await store.upsertTimeEvents(account.id, [event("primary", "e1", "2026-09-10T10:30:00.000Z", "2026-09-10T11:00:00.000Z")]);
    expect(again.updated).toBe(1);
    const all = await store.listTimeEvents({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" });
    expect(all).toHaveLength(2);
    // Overlap: a window ending inside e1 still finds it.
    const partial = await store.listTimeEvents({ from: "2026-09-10T10:45:00.000Z", to: "2026-09-10T10:50:00.000Z" });
    expect(partial.map((e) => e.externalCalendarId)).toEqual(["primary"]);
    expect(await store.listTimeEvents({ from: "2026-09-11T00:00:00.000Z", to: "2026-09-11T23:00:00.000Z" })).toHaveLength(0);
  });

  it("dedupes context events by dedupeKey and never overwrites attention", async () => {
    const { store, account } = await storeWithAccount();
    const { rows } = await store.upsertMailMessages(account.id, [mail("m1")]);
    const subject = ref("mail_message", rows[0]!.id);
    const base = { kind: "mail.received", subject, title: "t", summary: null, occurredAt: "2026-09-09T10:00:00.000Z", importance: 45, dueAt: null, connectorAccountId: account.id, dedupeKey: "k1", metadata: {} };
    const first = await store.upsertContextEvents([{ ...base, attention: "needs_attention" }]);
    expect(first.inserted).toBe(1);
    await store.setContextEventAttention(first.rows[0]!.id, "quiet", { reason: "user" });
    const second = await store.upsertContextEvents([{ ...base, attention: "needs_attention", title: "new title" }]);
    expect(second.inserted).toBe(0);
    expect(second.rows[0]?.id).toBe(first.rows[0]?.id);
    expect(second.rows[0]?.attention).toBe("quiet");
    expect(second.rows[0]?.title).toBe("t");
    expect(await store.listContextEvents({ attention: ["quiet", "dismissed"] })).toHaveLength(1);
    expect(await store.listContextEvents({ attention: "needs_attention" })).toHaveLength(0);
  });

  it("is idempotent on person identities by (kind, value)", async () => {
    const { store } = await storeWithAccount();
    const eric = await store.upsertPerson({ displayName: "Eric", primaryEmail: "eric@example.com", organization: null, notes: null, metadata: {} });
    const other = await store.upsertPerson({ displayName: "Other", primaryEmail: null, organization: null, notes: null, metadata: {} });
    const id1 = await store.upsertPersonIdentity({ personId: eric.id, kind: "email", value: "eric@example.com", rawValue: "Eric@Example.com", provider: null, connectorAccountId: null });
    const id2 = await store.upsertPersonIdentity({ personId: other.id, kind: "email", value: "eric@example.com", rawValue: "eric@example.com", provider: null, connectorAccountId: null });
    expect(id2.id).toBe(id1.id);
    expect(id2.personId).toBe(eric.id);
    expect((await store.findPersonByIdentity("email", "eric@example.com"))?.id).toBe(eric.id);
    await expect(
      store.upsertPersonIdentity({ personId: "00000000-0000-4000-8000-00000000dead" as PersonId, kind: "phone", value: "+15550001111", rawValue: "+1 555 000 1111", provider: null, connectorAccountId: null }),
    ).rejects.toBeInstanceOf(SpineIntegrityError);
  });

  it("searches people over display name, organization and identities, case-insensitively", async () => {
    const { store } = await storeWithAccount();
    const eric = await store.upsertPerson({ displayName: "Eric Lindqvist", primaryEmail: null, organization: "Lindqvist Studio", notes: null, metadata: {} });
    await store.upsertPersonIdentity({ personId: eric.id, kind: "email", value: "eric@lindqvist.example", rawValue: "eric@lindqvist.example", provider: null, connectorAccountId: null });
    await store.upsertPerson({ displayName: "Priya", primaryEmail: null, organization: "Northwind", notes: null, metadata: {} });
    const merged = await store.upsertPerson({ displayName: "Eric Duplicate", primaryEmail: null, organization: null, notes: null, metadata: {}, mergedIntoId: eric.id });
    expect((await store.listPeople({ search: "ERIC" })).map((p) => p.id)).toEqual([eric.id]);
    expect((await store.listPeople({ search: "studio" })).map((p) => p.id)).toEqual([eric.id]);
    expect((await store.listPeople({ search: "lindqvist.example" })).map((p) => p.id)).toEqual([eric.id]);
    expect((await store.listPeople({ search: "eric", includeMerged: true })).map((p) => p.id).sort()).toEqual([eric.id, merged.id].sort());
    expect(await store.listPeople({ search: "nobody" })).toEqual([]);
  });
});

describe("InMemorySpineStore graph integrity", () => {
  it("relate() throws SpineIntegrityError when either entity is missing and dedupes by natural key", async () => {
    const { store, account } = await storeWithAccount();
    const eric = await store.upsertPerson({ displayName: "Eric", primaryEmail: null, organization: null, notes: null, metadata: {} });
    const { rows } = await store.upsertMailMessages(account.id, [mail("m1")]);
    const mailRef = ref("mail_message", rows[0]!.id);
    const personRef = ref("person", eric.id);
    const ghost = ref("person", "00000000-0000-4000-8000-00000000dead");
    await expect(store.relate({ from: mailRef, kind: "has_person", to: ghost })).rejects.toBeInstanceOf(SpineIntegrityError);
    await expect(store.relate({ from: ghost, kind: "has_person", to: personRef })).rejects.toBeInstanceOf(SpineIntegrityError);
    const a = await store.relate({ from: mailRef, kind: "has_person", to: personRef, source: "connector", confidence: 0.5 });
    const b = await store.relate({ from: mailRef, kind: "has_person", to: personRef, confidence: 0.9 });
    expect(b.id).toBe(a.id);
    expect(b.confidence).toBe(0.9);
    expect(await store.listRelationships()).toHaveLength(1);
    const neighbors = await store.neighbors(personRef, { direction: "in", type: "mail_message" });
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]?.ref).toEqual(mailRef);
  });

  it("removes edges, events and conclusions when an entity is deleted", async () => {
    const { store, account } = await storeWithAccount();
    const eric = await store.upsertPerson({ displayName: "Eric", primaryEmail: null, organization: null, notes: null, metadata: {} });
    const { rows } = await store.upsertMailMessages(account.id, [mail("m1")]);
    const mailRef = ref("mail_message", rows[0]!.id);
    await store.relate({ from: mailRef, kind: "has_person", to: ref("person", eric.id) });
    await store.upsertContextEvents([
      { kind: "mail.received", subject: mailRef, title: "t", summary: null, occurredAt: "2026-09-09T10:00:00.000Z", importance: 1, dueAt: null, attention: "needs_attention", connectorAccountId: account.id, dedupeKey: "k", metadata: {} },
    ]);
    await store.insertConclusion({ subject: mailRef, text: "invoice", producedBy: "rule:test", confidence: 1, metadata: {} });
    expect(await store.deleteMailMessages(account.id, ["m1", "missing"])).toBe(1);
    expect(await store.listRelationships()).toHaveLength(0);
    expect(await store.listContextEvents()).toHaveLength(0);
    expect(await store.listConclusions(mailRef)).toHaveLength(0);
    expect(await store.neighbors(ref("person", eric.id))).toHaveLength(0);
  });
});

describe("InMemorySpineStore misc semantics", () => {
  it("createActionRequest is idempotent by key", async () => {
    const { store } = await storeWithAccount();
    const a = await store.createActionRequest({ actionType: "context_event.quiet", idempotencyKey: "k1", payload: { contextEventId: "x" } });
    const b = await store.createActionRequest({ actionType: "context_event.quiet", idempotencyKey: "k1", payload: { contextEventId: "y" } });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
    expect(b.request.payload).toEqual({ contextEventId: "x" });
    expect((await store.findActionRequestByKey("k1"))?.status).toBe("queued");
  });

  it("upsertSyncState creates with defaults, patches partially, and requires the account", async () => {
    const { store, account } = await storeWithAccount();
    const s1 = await store.upsertSyncState(account.id, "mail", { status: "running", lastAttemptAt: "2026-09-10T09:00:00.000Z" });
    expect(s1.enabled).toBe(true);
    expect(s1.checkpoint).toBeNull();
    expect(s1.consecutiveFailures).toBe(0);
    const s2 = await store.upsertSyncState(account.id, "mail", { checkpoint: { version: 1 } });
    expect(s2.status).toBe("running");
    expect(s2.checkpoint).toEqual({ version: 1 });
    expect(await store.listSyncStates(account.id)).toHaveLength(1);
    await expect(store.upsertSyncState("00000000-0000-4000-8000-00000000dead", "mail", {})).rejects.toBeInstanceOf(SpineIntegrityError);
  });

  it("rejects duplicate connector accounts per (provider, externalAccountId) and 404s on updates of unknown rows", async () => {
    const { store } = await storeWithAccount();
    await expect(store.createConnectorAccount(mockAccountInput())).rejects.toBeInstanceOf(SpineIntegrityError);
    await expect(store.updatePerson("00000000-0000-4000-8000-00000000dead", { notes: "x" })).rejects.toBeInstanceOf(SpineNotFoundError);
  });

  it("stamps every row with the bound user id and uses the injected clock", async () => {
    const clock = tickingClock(new Date("2030-01-01T00:00:00.000Z"), 60_000);
    const store = new InMemorySpineStore("11111111-1111-4111-8111-111111111111" as UserId, { now: clock });
    const thread = await store.createThread({ title: "Brand", kind: "project", status: "active", summary: null, metadata: {} });
    expect(thread.userId).toBe("11111111-1111-4111-8111-111111111111");
    expect(thread.createdAt).toBe("2030-01-01T00:01:00.000Z");
    const updated = await store.updateThread(thread.id, { summary: "s" });
    expect(updated.updatedAt).toBe("2030-01-01T00:02:00.000Z");
    expect(updated.createdAt).toBe(thread.createdAt);
  });

  it("finds documents by exact source ref regardless of key order", async () => {
    const { store, account } = await storeWithAccount();
    const doc = await store.upsertDocument({
      title: "Invoice.pdf",
      mimeType: "application/pdf",
      source: "mail_attachment",
      connectorAccountId: account.id,
      sourceRef: { messageExternalId: "m1", attachmentId: "a1", connectorAccountId: account.id },
      location: { kind: "none" },
      praxionDocumentId: null,
      sizeBytes: null,
      contentHash: null,
      metadata: {},
    });
    expect((await store.findDocumentBySourceRef(account.id, { attachmentId: "a1", connectorAccountId: account.id, messageExternalId: "m1" }))?.id).toBe(doc.id);
    expect(await store.findDocumentBySourceRef(account.id, { attachmentId: "a1" })).toBeNull();
    expect(await store.findDocumentBySourceRef(null, doc.sourceRef)).toBeNull();
  });
});

describe("calendar-scoped deletions", () => {
  it("deletes only the event in the named calendar when the same id lives in two calendars", async () => {
    const { InMemorySpineStore } = await import("./in-memory-spine-store.ts");
    const { DEV_USER_ID } = await import("@vixera/domain");
    const store = new InMemorySpineStore(DEV_USER_ID);
    const account = await store.createConnectorAccount({
      provider: "mock", externalAccountId: "acc", label: "Mock", address: null, capabilities: ["calendar"], status: "active",
      credentialLocation: "none", credentialRef: null, lastError: null, metadata: {},
    });
    const base = {
      externalId: "evt-1", title: "Shared", description: null, startsAt: "2026-09-10T10:00:00Z", endsAt: "2026-09-10T11:00:00Z", allDay: false,
      timezone: null, location: null, status: "confirmed" as const, organizer: null, participants: [], externalLink: null,
    };
    await store.upsertTimeEvents(account.id, [{ ...base, externalCalendarId: "primary" }, { ...base, externalCalendarId: "shared" }]);
    expect(await store.deleteTimeEvents(account.id, ["evt-1"], "shared")).toBe(1);
    const left = await store.listTimeEvents({ from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" });
    expect(left.map((e) => e.externalCalendarId)).toEqual(["primary"]);
    expect(await store.deleteTimeEvents(account.id, ["evt-1"])).toBe(1);
  });
});
