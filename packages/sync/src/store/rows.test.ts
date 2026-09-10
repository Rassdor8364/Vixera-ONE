import { describe, expect, it } from "vitest";
import { DEV_USER_ID } from "@vixera/domain";
import {
  actionRequestFromRow,
  actionRequestToRow,
  connectorAccountFromRow,
  connectorAccountToRow,
  contextEventFromRow,
  contextEventToRow,
  decimalFromDb,
  documentFromRow,
  documentToRow,
  handoffFromRow,
  handoffToRow,
  isoFromDb,
  mailMessageFromRow,
  mailMessageToRow,
  moneyAccountFromRow,
  moneyAccountToRow,
  moneyTransactionFromRow,
  moneyTransactionToRow,
  personFromRow,
  personToRow,
  relationshipFromRow,
  syncStateFromRow,
  syncStatePatchToRow,
  timeEventFromRow,
  timeEventToRow,
  type ContextEventRow,
  type MailMessageRow,
  type MoneyAccountRow,
  type MoneyTransactionRow,
  type TimeEventRow,
} from "./rows.ts";
import { briefWorldFixtures } from "../testing/mock-connector.ts";

const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const ID = "44444444-4444-4444-8444-444444444444";
const TS = { created_at: "2026-09-10T09:00:00+00:00", updated_at: "2026-09-10T09:05:00+00:00" };

describe("scalar mappers", () => {
  it("normalizes PostgREST timestamps and numerics", () => {
    expect(isoFromDb("2026-09-10T09:00:00+00:00")).toBe("2026-09-10T09:00:00.000Z");
    expect(isoFromDb("2026-09-10T11:00:00.5+02:00")).toBe("2026-09-10T09:00:00.500Z");
    expect(isoFromDb(null)).toBeNull();
    expect(decimalFromDb("12400.0000")).toBe("12400");
    expect(decimalFromDb("-2400.5000")).toBe("-2400.5");
    expect(decimalFromDb("0.0000")).toBe("0");
    expect(decimalFromDb("-0.0000")).toBe("0");
    expect(decimalFromDb(18342.17)).toBe("18342.17");
    expect(decimalFromDb(null)).toBeNull();
  });
});

describe("row mappers round-trip the brief world", () => {
  const fx = briefWorldFixtures();

  it("mail: snake_case row with jsonb addresses ⇄ MailMessage with person ids", () => {
    const write = { ...fx.mail.messages[0]!, fromPersonId: PERSON, toPersonIds: [null] };
    const insert = mailMessageToRow(DEV_USER_ID, ACCOUNT, write);
    expect(insert).toMatchObject({
      user_id: DEV_USER_ID,
      connector_account_id: ACCOUNT,
      external_id: "msg-eric-invoice-0231",
      from_address: "eric@lindqvist.example",
      from_name: "Eric Lindqvist",
      from_person_id: PERSON,
      to_addresses: [{ email: "me@example.com", name: null, personId: null }],
      is_unread: true,
      labels: ["INBOX"],
    });
    expect(insert.attachments[0]).toEqual({ attachmentId: "att-0231", filename: "Lindqvist-Invoice-0231.pdf", mimeType: "application/pdf", sizeBytes: 184233 });
    const row: MailMessageRow = { ...insert, id: ID, ...TS, received_at: "2026-09-09T16:00:00+00:00" };
    const domain = mailMessageFromRow(row);
    expect(domain.id).toBe(ID);
    expect(domain.userId).toBe(DEV_USER_ID);
    expect(domain.from).toEqual({ email: "eric@lindqvist.example", name: "Eric Lindqvist", personId: PERSON });
    expect(domain.to).toEqual([{ email: "me@example.com", name: null, personId: null }]);
    expect(domain.receivedAt).toBe("2026-09-09T16:00:00.000Z");
    expect(domain.attachments).toEqual(write.attachments);
    expect(domain.createdAt).toBe("2026-09-10T09:00:00.000Z");
    // Round trip: writing what we read yields the same row (minus db-owned columns).
    const again = mailMessageToRow(DEV_USER_ID, ACCOUNT, { ...domain, fromPersonId: domain.from?.personId ?? null, toPersonIds: domain.to.map((a) => a.personId ?? null), ccPersonIds: [] });
    expect(again).toEqual({ ...insert, received_at: "2026-09-09T16:00:00.000Z", sent_at: domain.sentAt });
  });

  it("money: numeric strings from Postgres become canonical decimal strings", () => {
    const acct = moneyAccountToRow(DEV_USER_ID, ACCOUNT, fx.bank.accounts[0]!);
    expect(acct).toMatchObject({ external_id: "acct-checking-0001", currency: "USD", balance_current: "18342.17", official_name: "Business Checking" });
    const acctRow: MoneyAccountRow = { ...acct, id: ID, ...TS, balance_current: "18342.1700", balance_available: "18342.1700", balance_as_of: "2026-09-10T09:00:00+00:00" };
    const a = moneyAccountFromRow(acctRow);
    expect(a.balanceCurrent).toBe("18342.17");
    expect(a.balanceAsOf).toBe("2026-09-10T09:00:00.000Z");
    expect(moneyAccountToRow(DEV_USER_ID, ACCOUNT, a)).toEqual({ ...acct, balance_as_of: "2026-09-10T09:00:00.000Z" });

    const tx = moneyTransactionToRow(DEV_USER_ID, ACCOUNT, ID, { ...fx.bank.transactions[1]!, counterpartyPersonId: PERSON });
    expect(tx).toMatchObject({ money_account_id: ID, amount: "-2400", merchant_name: "Lindqvist Studio", posted_on: "2026-09-08", counterparty_person_id: PERSON, category: ["services"] });
    const txRow: MoneyTransactionRow = { ...tx, id: "55555555-5555-4555-8555-555555555555", ...TS, amount: "-2400.0000" };
    const t = moneyTransactionFromRow(txRow);
    expect(t.amount).toBe("-2400");
    expect(t.moneyAccountId).toBe(ID);
    expect(t.counterpartyPersonId).toBe(PERSON);
    expect(t.postedOn).toBe("2026-09-08");
  });

  it("time: participants jsonb carries person ids, organizer inherits the matching participant's id", () => {
    const write = { ...fx.calendar.events[0]!, participantPersonIds: [null, PERSON] };
    const insert = timeEventToRow(DEV_USER_ID, ACCOUNT, write);
    expect(insert.participants).toEqual([
      { email: "me@example.com", name: null, response: "accepted", isOrganizer: true, isSelf: true, personId: null },
      { email: "priya@northwind.example", name: "Priya Natarajan", response: "accepted", isOrganizer: false, isSelf: false, personId: PERSON },
    ]);
    expect(insert.organizer?.personId).toBeNull();
    const row: TimeEventRow = { ...insert, id: ID, ...TS, starts_at: "2026-09-11T14:00:00+00:00", ends_at: "2026-09-11T15:00:00+00:00" };
    const e = timeEventFromRow(row);
    expect(e.startsAt).toBe("2026-09-11T14:00:00.000Z");
    expect(e.participants[1]).toEqual({ email: "priya@northwind.example", name: "Priya Natarajan", response: "accepted", isOrganizer: false, isSelf: false, personId: PERSON });
    expect(e.organizer?.isSelf).toBe(true);
    expect(timeEventToRow(DEV_USER_ID, ACCOUNT, e)).toEqual({ ...insert, starts_at: "2026-09-11T14:00:00.000Z", ends_at: "2026-09-11T15:00:00.000Z" });
  });

  it("context events and relationships map subject / from / to pairs and numeric confidence", () => {
    const input = {
      kind: "mail.received",
      subject: { type: "mail_message" as const, id: ID },
      title: "Invoice",
      summary: null,
      occurredAt: "2026-09-09T16:00:00.000Z",
      importance: 45,
      dueAt: null,
      attention: "needs_attention" as const,
      connectorAccountId: ACCOUNT as never,
      dedupeKey: `mail:${ACCOUNT}:m1`,
      metadata: { from: "eric@lindqvist.example" },
    };
    const insert = contextEventToRow(DEV_USER_ID, PERSON, input);
    expect(insert).toMatchObject({ id: PERSON, subject_type: "mail_message", subject_id: ID, dedupe_key: `mail:${ACCOUNT}:m1`, importance: 45 });
    const row: ContextEventRow = { ...insert, created_at: TS.created_at };
    const ev = contextEventFromRow(row);
    expect(ev.subject).toEqual({ type: "mail_message", id: ID });
    expect(ev.connectorAccountId).toBe(ACCOUNT);
    expect(contextEventToRow(DEV_USER_ID, ev.id, ev)).toEqual(insert);

    const rel = relationshipFromRow({
      id: ID,
      user_id: DEV_USER_ID,
      from_type: "document",
      from_id: PERSON,
      kind: "originated_from",
      to_type: "mail_message",
      to_id: ACCOUNT,
      confidence: "0.800",
      source: "connector",
      metadata: {},
      created_at: TS.created_at,
    });
    expect(rel.confidence).toBe(0.8);
    expect(rel.from).toEqual({ type: "document", id: PERSON });
    expect(rel.to).toEqual({ type: "mail_message", id: ACCOUNT });
  });

  it("people, documents, accounts, sync states, handoffs and action requests", () => {
    const person = personFromRow({ ...personToRow(DEV_USER_ID, PERSON, { displayName: "Eric Lindqvist", primaryEmail: "eric@lindqvist.example", organization: "Lindqvist Studio", notes: null, metadata: {} }), ...TS });
    expect(person).toMatchObject({ id: PERSON, displayName: "Eric Lindqvist", organization: "Lindqvist Studio", mergedIntoId: null });

    const docInsert = documentToRow(DEV_USER_ID, ID, {
      title: "Invoice.pdf",
      mimeType: "application/pdf",
      source: "mail_attachment",
      connectorAccountId: ACCOUNT as never,
      sourceRef: { attachmentId: "att-0231" },
      location: { kind: "provider", provider: "mock", ref: { attachmentId: "att-0231" } },
      praxionDocumentId: null,
      sizeBytes: 184233,
      contentHash: null,
      metadata: {},
    });
    const doc = documentFromRow({ ...docInsert, ...TS, size_bytes: "184233" });
    expect(doc.location).toEqual({ kind: "provider", provider: "mock", ref: { attachmentId: "att-0231" } });
    expect(doc.sizeBytes).toBe(184233);
    expect(documentFromRow({ ...docInsert, ...TS, location: { kind: "bogus" } }).location).toEqual({ kind: "none" });

    const accInsert = connectorAccountToRow(DEV_USER_ID, ACCOUNT, {
      provider: "mock",
      externalAccountId: "mock-user-1",
      label: "Mock",
      address: "me@example.com",
      capabilities: ["mail", "calendar"],
      status: "active",
      credentialLocation: "server_vault",
      credentialRef: "fake-ref",
      lastError: null,
      metadata: {},
    });
    expect(accInsert.capabilities).toEqual(["mail", "calendar"]);
    expect(connectorAccountFromRow({ ...accInsert, ...TS }).credentialRef).toBe("fake-ref");

    const statePatch = syncStatePatchToRow(DEV_USER_ID, ACCOUNT, "mail", { status: "error", lastError: "boom", consecutiveFailures: 2 });
    expect(statePatch).toEqual({ user_id: DEV_USER_ID, connector_account_id: ACCOUNT, capability: "mail", status: "error", last_error: "boom", consecutive_failures: 2 });
    expect("checkpoint" in statePatch).toBe(false);
    const state = syncStateFromRow({ ...statePatch, enabled: true, status: "error", checkpoint: { version: 1 }, last_attempt_at: TS.created_at, last_success_at: null, last_error: "boom", consecutive_failures: 2, updated_at: TS.updated_at });
    expect(state).toMatchObject({ capability: "mail", checkpoint: { version: 1 }, lastAttemptAt: "2026-09-10T09:00:00.000Z", lastSuccessAt: null });

    const handoffInsert = handoffToRow(DEV_USER_ID, ID, {
      sourceDeviceId: PERSON as never,
      targetDeviceId: null,
      state: "pending",
      focus: { type: "document", id: ACCOUNT },
      threadId: null,
      documentId: ACCOUNT as never,
      artifactStoragePath: null,
      praxionLocation: { page: 3, position: null, selectionText: "7.1" },
      conclusions: ["covers contractors"],
      commandHistory: [],
      deliveredAt: null,
      acceptedAt: null,
      expiresAt: null,
      metadata: {},
    });
    expect(handoffInsert).toMatchObject({ focus_type: "document", focus_id: ACCOUNT, praxion_location: { page: 3, position: null, selectionText: "7.1" } });
    const handoff = handoffFromRow({ ...handoffInsert, created_at: TS.created_at });
    expect(handoff.focus).toEqual({ type: "document", id: ACCOUNT });
    expect(handoff.praxionLocation).toEqual({ page: 3, position: null, selectionText: "7.1" });

    const ar = actionRequestToRow(DEV_USER_ID, ID, { actionType: "context_event.quiet", idempotencyKey: "k", payload: { contextEventId: "x" } });
    expect(ar).toEqual({ id: ID, user_id: DEV_USER_ID, action_type: "context_event.quiet", idempotency_key: "k", payload: { contextEventId: "x" }, status: "queued", actor_device_id: null });
    expect(actionRequestFromRow({ ...ar, result: null, error: null, attempts: 0, ...TS }).attempts).toBe(0);
  });
});
