import { describe, expect, it } from "vitest";
import { DEV_USER_ID, ref } from "@vixera/domain";
import { InMemorySpineStore } from "../store/in-memory-spine-store.ts";
import { ContextLinker, mailDedupeKey, timeDedupeKey, timeEventVersion } from "./context-linker.ts";
import {
  KIND_TIME_EVENT_CANCELLED,
  KIND_TIME_EVENT_CHANGED,
  KIND_TIME_EVENT_CREATED,
  MAIL_QUIET_AFTER_DAYS,
  MAIL_READ,
  MAIL_UNREAD,
  MAIL_UNREAD_KNOWN_WITH_ATTACHMENT,
  MONEY_TRANSACTION_LARGE,
  MONEY_TRANSACTION_SMALL,
  TIME_EVENT_SOON,
} from "./rules.ts";
import { fixedClock, MOCK_NOW, MOCK_SELF_ADDRESS, mockAccountInput, tickingClock } from "../testing/fixtures.ts";
import {
  briefWorldFixtures,
  ERIC_EMAIL,
  ERIC_INVOICE_MESSAGE_ID,
  LINDQVIST_PAYMENT_TX_ID,
  NORTHWIND_KICKOFF_EVENT_ID,
  NORTHWIND_PAYOUT_TX_ID,
  PRIYA_AGENDA_MESSAGE_ID,
  PRIYA_EMAIL,
} from "../testing/mock-connector.ts";

async function setup() {
  const store = new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() });
  const account = await store.createConnectorAccount(mockAccountInput());
  const linker = new ContextLinker(store, { now: fixedClock(), selfAddresses: [MOCK_SELF_ADDRESS] });
  return { store, account, linker, fixtures: briefWorldFixtures() };
}

describe("ContextLinker people reconciliation", () => {
  it("resolves the same email across mail and calendar to ONE person and never turns self into a person", async () => {
    const { store, account, linker, fixtures } = await setup();
    await linker.applyMailBatch(account, fixtures.mail);
    await linker.applyCalendarBatch(account, fixtures.calendar);

    const people = await store.listPeople();
    expect(people.map((p) => p.displayName).sort()).toEqual(["Eric Lindqvist", "Priya Natarajan"]);
    expect(people.find((p) => p.displayName.includes("Me"))).toBeUndefined();
    expect(await store.findPersonByIdentity("email", MOCK_SELF_ADDRESS)).toBeNull();

    const priya = (await store.findPersonByIdentity("email", PRIYA_EMAIL))!;
    const priyaNeighbors = await store.neighbors(ref("person", priya.id), { kind: "has_person", direction: "in" });
    expect(priyaNeighbors.map((n) => n.ref.type).sort()).toEqual(["mail_message", "time_event"]);

    const event = (await store.listTimeEvents({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" }))[0]!;
    expect(event.participants.find((p) => p.email === PRIYA_EMAIL)?.personId).toBe(priya.id);
    expect(event.participants.find((p) => p.isSelf)?.personId).toBeNull();

    const identities = await store.listPersonIdentities(priya.id);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ kind: "email", value: PRIYA_EMAIL, provider: "mock", connectorAccountId: account.id });
  });

  it("treats the account's own address as self even when selfAddresses is empty, and names people from the email when no name is given", async () => {
    const store = new InMemorySpineStore(DEV_USER_ID, { now: tickingClock() });
    const account = await store.createConnectorAccount(mockAccountInput({ address: "Owner@Example.com" }));
    const linker = new ContextLinker(store, { now: fixedClock() });
    const fixtures = briefWorldFixtures();
    const message = { ...fixtures.mail.messages[0]!, from: { email: "Anna.Berg@partner.example", name: null }, to: [{ email: "owner@example.com", name: "Me" }], attachments: [] };
    await linker.applyMailBatch(account, { messages: [message], deleted: [] });
    const people = await store.listPeople();
    expect(people.map((p) => p.displayName)).toEqual(["Anna Berg"]);
    expect(people[0]?.primaryEmail).toBe("anna.berg@partner.example");
  });

  it("re-applying a batch creates no duplicate people, edges or events", async () => {
    const { store, account, linker, fixtures } = await setup();
    const first = await linker.applyMailBatch(account, fixtures.mail);
    const second = await linker.applyMailBatch(account, fixtures.mail);
    expect(first.peopleCreated).toBe(2);
    expect(second.peopleCreated).toBe(0);
    expect(second.inserted).toBe(0);
    expect(second.contextEvents).toBe(0);
    expect(await store.listPeople()).toHaveLength(2);
    expect(await store.listRelationships()).toHaveLength(first.relationships);
    expect(await store.listContextEvents()).toHaveLength(2);
    expect(await store.listDocuments()).toHaveLength(1);
  });
});

describe("ContextLinker mail", () => {
  it("turns an attachment into a document linked to the message and the sender", async () => {
    const { store, account, linker, fixtures } = await setup();
    await linker.applyMailBatch(account, fixtures.mail);

    const docs = await store.listDocuments();
    expect(docs).toHaveLength(1);
    const doc = docs[0]!;
    expect(doc).toMatchObject({
      title: "Lindqvist-Invoice-0231.pdf",
      mimeType: "application/pdf",
      source: "mail_attachment",
      connectorAccountId: account.id,
      sourceRef: { connectorAccountId: account.id, messageExternalId: ERIC_INVOICE_MESSAGE_ID, attachmentId: "att-0231" },
      location: { kind: "provider", provider: "mock", ref: { messageExternalId: ERIC_INVOICE_MESSAGE_ID, attachmentId: "att-0231" } },
    });

    const message = (await store.findMailMessageByExternalId(account.id, ERIC_INVOICE_MESSAGE_ID))!;
    const eric = (await store.findPersonByIdentity("email", ERIC_EMAIL))!;
    const docNeighbors = await store.neighbors(ref("document", doc.id), { direction: "out" });
    expect(docNeighbors.map((n) => `${n.kind}:${n.ref.type}`).sort()).toEqual(["has_person:person", "originated_from:mail_message"]);
    expect(docNeighbors.find((n) => n.kind === "originated_from")?.ref.id).toBe(message.id);
    expect(docNeighbors.find((n) => n.kind === "has_person")?.ref.id).toBe(eric.id);
    expect(message.from?.personId).toBe(eric.id);
  });

  it("scores mail with the documented rules and files old mail as quiet", async () => {
    const { store, account, linker, fixtures } = await setup();
    // Eric is unknown on first sight, so the invoice is plain unread mail.
    await linker.applyMailBatch(account, fixtures.mail);
    const events = await store.listContextEvents({ kindPrefix: "mail." });
    const byKey = new Map(events.map((e) => [e.dedupeKey, e]));
    const invoice = byKey.get(mailDedupeKey(account.id, ERIC_INVOICE_MESSAGE_ID))!;
    const agenda = byKey.get(mailDedupeKey(account.id, PRIYA_AGENDA_MESSAGE_ID))!;
    expect(invoice.importance).toBe(MAIL_UNREAD);
    expect(invoice.dueAt).toBeNull();
    expect(invoice.attention).toBe("needs_attention");
    expect(invoice.title).toBe("Invoice #0231 — Brand identity work");
    expect(agenda.importance).toBe(MAIL_READ);

    // A second unread mail with an attachment from the now-known Eric scores higher.
    const followUp = { ...fixtures.mail.messages[0]!, externalId: "msg-eric-2", receivedAt: MOCK_NOW.toISOString(), subject: "Revised invoice" };
    await linker.applyMailBatch(account, { messages: [followUp], deleted: [] });
    const revised = (await store.listContextEvents()).find((e) => e.dedupeKey === mailDedupeKey(account.id, "msg-eric-2"))!;
    expect(revised.importance).toBe(MAIL_UNREAD_KNOWN_WITH_ATTACHMENT);

    // Mail older than the quiet threshold at first sight goes to Quiet.
    const old = { ...followUp, externalId: "msg-old", receivedAt: new Date(MOCK_NOW.getTime() - (MAIL_QUIET_AFTER_DAYS + 1) * 86_400_000).toISOString() };
    await linker.applyMailBatch(account, { messages: [old], deleted: [] });
    const oldEvent = (await store.listContextEvents()).find((e) => e.dedupeKey === mailDedupeKey(account.id, "msg-old"))!;
    expect(oldEvent.attention).toBe("quiet");
  });

  it("deletions remove rows (and their edges/events) without emitting events", async () => {
    const { store, account, linker, fixtures } = await setup();
    await linker.applyMailBatch(account, fixtures.mail);
    const before = await store.listContextEvents();
    const counts = await linker.applyMailBatch(account, { messages: [], deleted: [{ externalId: ERIC_INVOICE_MESSAGE_ID }, { externalId: "never-existed" }] });
    expect(counts.deleted).toBe(1);
    expect(counts.contextEvents).toBe(0);
    expect(await store.findMailMessageByExternalId(account.id, ERIC_INVOICE_MESSAGE_ID)).toBeNull();
    expect(await store.listContextEvents()).toHaveLength(before.length - 1);
    // The document survives (it is context), but its edge to the deleted message is gone.
    const doc = (await store.listDocuments())[0]!;
    expect((await store.neighbors(ref("document", doc.id), { kind: "originated_from" })).length).toBe(0);
  });
});

describe("ContextLinker calendar", () => {
  it("emits created once, nothing on an unchanged re-sync, one changed event when the event moves, cancelled when cancelled", async () => {
    const { store, account, linker, fixtures } = await setup();
    const event = fixtures.calendar.events[0]!;

    const first = await linker.applyCalendarBatch(account, fixtures.calendar);
    expect(first.contextEvents).toBe(1);
    const created = (await store.listContextEvents())[0]!;
    expect(created.kind).toBe(KIND_TIME_EVENT_CREATED);
    expect(created.dueAt).toBe(event.startsAt);
    expect(created.importance).toBe(TIME_EVENT_SOON);
    expect(created.dedupeKey).toBe(timeDedupeKey(account.id, event.externalCalendarId, event.externalId, timeEventVersion(event)));

    const again = await linker.applyCalendarBatch(account, fixtures.calendar);
    expect(again.contextEvents).toBe(0);
    expect(again.updated).toBe(1);
    expect(await store.listContextEvents()).toHaveLength(1);

    const moved = { ...event, startsAt: "2026-09-11T15:00:00.000Z", endsAt: "2026-09-11T16:00:00.000Z" };
    const changed = await linker.applyCalendarBatch(account, { events: [moved], deleted: [] });
    expect(changed.contextEvents).toBe(1);
    const events = await store.listContextEvents({ kindPrefix: "time.event." });
    expect(events.map((e) => e.kind).sort()).toEqual([KIND_TIME_EVENT_CHANGED, KIND_TIME_EVENT_CREATED]);
    const changedEvent = events.find((e) => e.kind === KIND_TIME_EVENT_CHANGED)!;
    expect(changedEvent.dueAt).toBe(moved.startsAt);
    // Both events point at the same time_event row (natural key upsert kept the id).
    expect(new Set(events.map((e) => e.subject.id)).size).toBe(1);

    const cancelled = await linker.applyCalendarBatch(account, { events: [{ ...moved, status: "cancelled" }], deleted: [] });
    expect(cancelled.contextEvents).toBe(1);
    expect((await store.listContextEvents()).some((e) => e.kind === KIND_TIME_EVENT_CANCELLED)).toBe(true);
    expect(await store.listTimeEvents({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" })).toHaveLength(1);
  });

  it("deleting an event removes its context events and edges", async () => {
    const { store, account, linker, fixtures } = await setup();
    await linker.applyCalendarBatch(account, fixtures.calendar);
    await linker.applyCalendarBatch(account, { events: [], deleted: [{ externalId: NORTHWIND_KICKOFF_EVENT_ID }] });
    expect(await store.listContextEvents()).toHaveLength(0);
    expect(await store.listRelationships()).toHaveLength(0);
    expect(await store.listPeople()).toHaveLength(1); // Priya stays: people are never deleted by sync
  });
});

describe("ContextLinker bank", () => {
  it("stores accounts and transactions, scores by amount, and links merchants to known people", async () => {
    const { store, account, linker, fixtures } = await setup();
    await linker.applyMailBatch(account, fixtures.mail);
    const eric = (await store.findPersonByIdentity("email", ERIC_EMAIL))!;
    await store.updatePerson(eric.id, { organization: "Lindqvist Studio" });

    const counts = await linker.applyBankBatch(account, fixtures.bank);
    expect(counts.inserted).toBe(3);
    expect(counts.contextEvents).toBe(2);

    const txs = await store.listMoneyTransactions({ connectorAccountId: account.id });
    const payout = txs.find((t) => t.externalId === NORTHWIND_PAYOUT_TX_ID)!;
    const lindqvist = txs.find((t) => t.externalId === LINDQVIST_PAYMENT_TX_ID)!;
    expect(payout.counterpartyPersonId).toBeNull();
    expect(lindqvist.counterpartyPersonId).toBe(eric.id);
    expect(lindqvist.moneyAccountId).toBe((await store.listMoneyAccounts(account.id))[0]!.id);

    const ericTx = await store.neighbors(ref("person", eric.id), { direction: "in", type: "money_transaction" });
    expect(ericTx.map((n) => n.ref.id)).toEqual([lindqvist.id]);
    expect(ericTx[0]?.confidence).toBe(0.8);

    const events = await store.listContextEvents({ kindPrefix: "money." });
    expect(events.find((e) => e.subject.id === payout.id)?.importance).toBe(MONEY_TRANSACTION_LARGE);
    expect(events.find((e) => e.subject.id === payout.id)?.title).toContain("+12,400.00 USD");
    expect(events.find((e) => e.subject.id === lindqvist.id)?.importance).toBe(MONEY_TRANSACTION_LARGE);

    await linker.applyBankBatch(account, { ...fixtures.bank, transactions: [{ ...fixtures.bank.transactions[0]!, externalId: "txn-coffee", amount: "-4.20", merchantName: "Corner Cafe" }] });
    const coffee = (await store.listContextEvents({ kindPrefix: "money." })).find((e) => e.title.startsWith("Corner Cafe"))!;
    expect(coffee.importance).toBe(MONEY_TRANSACTION_SMALL);

    const again = await linker.applyBankBatch(account, fixtures.bank);
    expect(again.inserted).toBe(0);
    expect(again.contextEvents).toBe(0);
    expect(await store.listMoneyTransactions()).toHaveLength(3);
  });
});
