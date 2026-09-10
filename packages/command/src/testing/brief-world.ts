import {
  DEV_USER_ID,
  ref,
  type ConnectorAccountId,
  type Document,
  type DocumentId,
  type MailMessage,
  type MailMessageId,
  type MoneyAccountId,
  type MoneyTransaction,
  type MoneyTransactionId,
  type Person,
  type PersonId,
  type Thread,
  type ThreadId,
  type TimeEvent,
  type TimeEventId,
  type UserId,
} from "@vixera/domain";
import { FakeSpineReader, type FakeEdge, type FakeWorld } from "./fake-spine-reader.ts";

/**
 * The world of the Phase 1 brief, as fixtures: Eric's $4,800 invoice attached
 * to the Brand thread, the Northwind pilot kicking off tomorrow, Marta on the
 * Company thread. Every value is obviously fake (example domains). The clock
 * is fixed at `BRIEF_NOW`; "today" and "tomorrow" are relative to it (UTC).
 */
export const BRIEF_NOW = new Date("2026-09-10T09:00:00.000Z");

const ACCOUNT_MAIL = "00000000-0000-4000-8000-0000000000a1" as ConnectorAccountId;
const ACCOUNT_CAL = "00000000-0000-4000-8000-0000000000a2" as ConnectorAccountId;
const ACCOUNT_BANK = "00000000-0000-4000-8000-0000000000a3" as ConnectorAccountId;
const MONEY_ACCOUNT = "00000000-0000-4000-8000-0000000000b1" as MoneyAccountId;

function id<T extends string>(prefix: string, n: number): T {
  return `00000000-0000-4000-8000-${prefix}${String(n).padStart(12 - prefix.length, "0")}` as unknown as T;
}

const at = (hoursFromNow: number): string => new Date(BRIEF_NOW.getTime() + hoursFromNow * 3600_000).toISOString();

export function person(n: number, displayName: string, primaryEmail: string | null, overrides: Partial<Person> = {}, userId: UserId = DEV_USER_ID): Person {
  return {
    id: id<PersonId>("01", n),
    userId,
    displayName,
    primaryEmail,
    organization: null,
    notes: null,
    mergedIntoId: null,
    metadata: {},
    createdAt: at(-24 * 30),
    updatedAt: at(-24 * 30),
    ...overrides,
  };
}

export function thread(n: number, title: string, overrides: Partial<Thread> = {}, userId: UserId = DEV_USER_ID): Thread {
  return { id: id<ThreadId>("02", n), userId, title, kind: "project", status: "active", summary: null, metadata: {}, createdAt: at(-24 * 20), updatedAt: at(-24), ...overrides };
}

export function document(n: number, title: string, mimeType: string | null, updatedAt: string, overrides: Partial<Document> = {}, userId: UserId = DEV_USER_ID): Document {
  return {
    id: id<DocumentId>("03", n),
    userId,
    title,
    mimeType,
    source: "mail_attachment",
    connectorAccountId: ACCOUNT_MAIL,
    sourceRef: {},
    location: { kind: "none" },
    praxionDocumentId: null,
    sizeBytes: null,
    contentHash: null,
    metadata: {},
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

export function mail(n: number, from: Person, subject: string, receivedAt: string, overrides: Partial<MailMessage> = {}, userId: UserId = DEV_USER_ID): MailMessage {
  return {
    id: id<MailMessageId>("04", n),
    userId,
    connectorAccountId: ACCOUNT_MAIL,
    externalId: `msg-${n}`,
    externalThreadId: null,
    subject,
    snippet: null,
    bodyText: null,
    from: { email: from.primaryEmail ?? "unknown@example.com", name: from.displayName, personId: from.id },
    to: [{ email: "me@example.com", name: null }],
    cc: [],
    sentAt: receivedAt,
    receivedAt,
    isUnread: true,
    attachments: [],
    labels: [],
    metadata: {},
    createdAt: receivedAt,
    updatedAt: receivedAt,
    ...overrides,
  };
}

export function event(n: number, title: string, startsAt: string, endsAt: string, overrides: Partial<TimeEvent> = {}, userId: UserId = DEV_USER_ID): TimeEvent {
  return {
    id: id<TimeEventId>("05", n),
    userId,
    connectorAccountId: ACCOUNT_CAL,
    externalCalendarId: "primary",
    externalId: `evt-${n}`,
    title,
    description: null,
    startsAt,
    endsAt,
    allDay: false,
    timezone: "UTC",
    location: null,
    status: "confirmed",
    organizer: null,
    participants: [],
    externalLink: null,
    metadata: {},
    createdAt: at(-48),
    updatedAt: at(-48),
    ...overrides,
  };
}

export function transaction(n: number, description: string, amount: string, postedOn: string, overrides: Partial<MoneyTransaction> = {}, userId: UserId = DEV_USER_ID): MoneyTransaction {
  return {
    id: id<MoneyTransactionId>("06", n),
    userId,
    connectorAccountId: ACCOUNT_BANK,
    moneyAccountId: MONEY_ACCOUNT,
    externalId: `tx-${n}`,
    amount,
    currency: "USD",
    description,
    merchantName: null,
    postedOn,
    authorizedAt: null,
    pending: false,
    category: [],
    counterpartyPersonId: null,
    metadata: {},
    createdAt: at(-1),
    updatedAt: at(-1),
    ...overrides,
  };
}

export interface BriefWorld extends FakeWorld {
  readonly eric: Person;
  readonly marta: Person;
  readonly priya: Person;
  readonly brand: Thread;
  readonly northwind: Thread;
  readonly company: Thread;
  readonly invoice: Document;
  readonly agreement: Document;
  readonly brief: Document;
  readonly ericInvoiceMail: MailMessage;
  readonly martaMail: MailMessage;
  readonly brandReview: TimeEvent;
  readonly northwindKickoff: TimeEvent;
  readonly lastWeekSync: TimeEvent;
  readonly nextMondayPlanning: TimeEvent;
  readonly ericPayment: MoneyTransaction;
  readonly northwindDeposit: MoneyTransaction;
  readonly brandPrinting: MoneyTransaction;
  readonly coffee: MoneyTransaction;
}

export function briefWorld(): BriefWorld {
  const eric = person(1, "Eric Lindqvist", "eric@lindqvist.example", { organization: "Lindqvist Studio" });
  const marta = person(2, "Marta Ruiz", "marta@ruiz.example");
  const priya = person(3, "Priya Natarajan", "priya@northwind.example", { organization: "Northwind" });

  const brand = thread(1, "Brand", { summary: "Brand refresh with Eric" });
  const northwind = thread(2, "Northwind pilot", { summary: "Pilot with Priya's team" });
  const company = thread(3, "Company", { kind: "legal" });

  const invoice = document(1, "Invoice #0231", "application/pdf", at(-20), { metadata: { kind: "invoice", amount: "4800", currency: "USD" } });
  const agreement = document(2, "Operating agreement v3.pdf", "application/pdf", at(-24 * 5), { source: "share" });
  const brief = document(3, "Northwind pilot brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", at(-24 * 2), { source: "drop" });

  const ericInvoiceMail = mail(1, eric, "Invoice #0231 for the brand work", at(-20), {
    attachments: [{ attachmentId: "att-1", filename: "Invoice #0231.pdf", mimeType: "application/pdf", sizeBytes: 12345 }],
  });
  const martaMail = mail(2, marta, "Operating agreement — v3 comments", at(-24 * 5), { isUnread: false });

  // Today is 2026-09-10 (UTC). 09:00Z now.
  const brandReview = event(1, "Brand review with Eric", at(5), at(6));
  const northwindKickoff = event(2, "Northwind pilot kickoff", at(25), at(26));
  const lastWeekSync = event(3, "Company sync", at(-24 * 6), at(-24 * 6 + 1));
  const nextMondayPlanning = event(4, "Planning", at(24 * 4 + 1), at(24 * 4 + 2));

  const ericPayment = transaction(1, "Payment to Lindqvist Studio", "-4800.00", "2026-09-09", { counterpartyPersonId: eric.id });
  const northwindDeposit = transaction(2, "Northwind pilot deposit", "12000.00", "2026-09-01");
  const brandPrinting = transaction(3, "Print shop — brand collateral", "-320.50", "2026-08-28");
  const coffee = transaction(4, "Coffee", "-4.50", "2026-09-10");

  const edges: FakeEdge[] = [
    // Brand thread
    { from: ref("thread", brand.id), kind: "has_person", to: ref("person", eric.id) },
    { from: ref("document", invoice.id), kind: "belongs_to", to: ref("thread", brand.id) },
    { from: ref("thread", brand.id), kind: "has_time", to: ref("time_event", brandReview.id) },
    { from: ref("thread", brand.id), kind: "has_money", to: ref("money_transaction", brandPrinting.id) },
    // Eric's invoice: person ↔ document, document ← mail, document ↔ transaction (two hops from Brand)
    { from: ref("person", eric.id), kind: "relates_to", to: ref("document", invoice.id) },
    { from: ref("document", invoice.id), kind: "originated_from", to: ref("mail_message", ericInvoiceMail.id) },
    { from: ref("mail_message", ericInvoiceMail.id), kind: "has_person", to: ref("person", eric.id) },
    { from: ref("document", invoice.id), kind: "relates_to", to: ref("money_transaction", ericPayment.id) },
    { from: ref("money_transaction", ericPayment.id), kind: "has_person", to: ref("person", eric.id), confidence: 0.8 },
    // Northwind pilot
    { from: ref("thread", northwind.id), kind: "has_person", to: ref("person", priya.id) },
    { from: ref("thread", northwind.id), kind: "has_time", to: ref("time_event", northwindKickoff.id) },
    { from: ref("thread", northwind.id), kind: "has_money", to: ref("money_transaction", northwindDeposit.id) },
    { from: ref("thread", northwind.id), kind: "has_document", to: ref("document", brief.id) },
    // Company
    { from: ref("thread", company.id), kind: "has_person", to: ref("person", marta.id) },
    { from: ref("document", agreement.id), kind: "belongs_to", to: ref("thread", company.id) },
    { from: ref("mail_message", martaMail.id), kind: "has_person", to: ref("person", marta.id) },
    { from: ref("thread", company.id), kind: "has_time", to: ref("time_event", lastWeekSync.id) },
  ];

  return {
    eric, marta, priya,
    brand, northwind, company,
    invoice, agreement, brief,
    ericInvoiceMail, martaMail,
    brandReview, northwindKickoff, lastWeekSync, nextMondayPlanning,
    ericPayment, northwindDeposit, brandPrinting, coffee,
    people: [eric, marta, priya],
    threads: [brand, northwind, company],
    documents: [agreement, brief, invoice],
    mail: [ericInvoiceMail, martaMail],
    events: [lastWeekSync, brandReview, northwindKickoff, nextMondayPlanning],
    transactions: [coffee, ericPayment, northwindDeposit, brandPrinting],
    edges,
  };
}

/** A reader over the brief world, optionally extended (extra people for ambiguity tests, ...). */
export function briefReader(extend: (world: BriefWorld) => FakeWorld = (w) => w): FakeSpineReader {
  return new FakeSpineReader(extend(briefWorld()));
}
