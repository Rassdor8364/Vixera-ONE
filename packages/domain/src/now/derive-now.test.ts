import { describe, expect, it } from "vitest";
import { deriveNow } from "./derive-now.ts";
import { DEV_USER_ID } from "../identity/current-user.ts";
import type { ContextEvent } from "../entities/context-event.ts";
import type { Thread } from "../entities/thread.ts";
import type { TimeEvent } from "../entities/time.ts";
import type { Relationship } from "../graph/relationship.ts";
import { ref } from "../graph/relationship.ts";
import type { ContextEventId, RelationshipId, ThreadId, TimeEventId, ConnectorAccountId } from "../ids.ts";

const NOW = new Date("2026-09-09T15:00:00Z");
const invoice = ref("document", "11111111-1111-4111-8111-000000000002");
const brand = "11111111-1111-4111-8111-000000000003" as ThreadId;

function event(partial: Partial<ContextEvent> & Pick<ContextEvent, "id" | "title" | "kind">): ContextEvent {
  return {
    userId: DEV_USER_ID,
    subject: invoice,
    summary: null,
    occurredAt: "2026-09-09T14:00:00Z",
    importance: 50,
    dueAt: null,
    attention: "needs_attention",
    connectorAccountId: null,
    dedupeKey: partial.id,
    metadata: {},
    createdAt: "2026-09-09T14:00:00Z",
    ...partial,
  };
}

const threads: Thread[] = [
  { id: brand, userId: DEV_USER_ID, title: "Brand", kind: "project", status: "active", summary: null, metadata: {}, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
];
const relationships: Relationship[] = [
  { id: "r1" as RelationshipId, userId: DEV_USER_ID, from: invoice, kind: "belongs_to", to: ref("thread", brand), confidence: 1, source: "user", metadata: {}, createdAt: "2026-09-01T00:00:00Z" },
];

describe("deriveNow", () => {
  it("puts an invoice due tomorrow, attached to a thread, into needs_me", () => {
    const r = deriveNow({
      contextEvents: [event({ id: "e1" as ContextEventId, title: "Eric's invoice is due tomorrow", kind: "money.invoice.due", importance: 40, dueAt: "2026-09-10T12:00:00Z" })],
      timeEvents: [], moneyTransactions: [], threads, relationships, now: NOW,
    });
    expect(r.needsMe).toHaveLength(1);
    expect(r.needsMe[0]?.threadIds).toEqual([brand]);
    expect(r.needsMe[0]?.reasons).toContain("due within 24h");
  });

  it("puts a recent moderate change into changed, an old one into quiet", () => {
    const recent = event({ id: "e2" as ContextEventId, title: "Northwind moved the kickoff", kind: "time.event.changed", importance: 35, occurredAt: "2026-09-09T14:30:00Z" });
    const old = event({ id: "e3" as ContextEventId, title: "Old newsletter", kind: "mail.received", importance: 20, occurredAt: "2026-09-01T10:00:00Z", subject: ref("mail_message", "11111111-1111-4111-8111-000000000009") });
    const r = deriveNow({ contextEvents: [recent, old], timeEvents: [], moneyTransactions: [], threads, relationships, now: NOW });
    expect(r.changed.map((i) => i.title)).toEqual(["Northwind moved the kickoff"]);
    expect(r.quiet.map((i) => i.title)).toEqual(["Old newsletter"]);
  });

  it("respects the user's quiet and dismissed decisions", () => {
    const quiet = event({ id: "e4" as ContextEventId, title: "Quieted", kind: "mail.received", importance: 95, attention: "quiet" });
    const dismissed = event({ id: "e5" as ContextEventId, title: "Dismissed", kind: "mail.received", importance: 95, attention: "dismissed" });
    const r = deriveNow({ contextEvents: [quiet, dismissed], timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: NOW });
    expect(r.needsMe).toHaveLength(0);
    expect(r.quiet.map((i) => i.title)).toEqual(["Quieted"]);
  });

  it("lists the next 24h of time events as upcoming, sorted", () => {
    const mk = (id: string, start: string, end: string, status: TimeEvent["status"] = "confirmed"): TimeEvent => ({
      id: id as TimeEventId, userId: DEV_USER_ID, connectorAccountId: "c" as ConnectorAccountId, externalCalendarId: "primary", externalId: id,
      title: id, description: null, startsAt: start, endsAt: end, allDay: false, timezone: null, location: null, status, organizer: null,
      participants: [], externalLink: null, metadata: {}, createdAt: start, updatedAt: start,
    });
    const r = deriveNow({
      contextEvents: [], moneyTransactions: [], threads: [], relationships: [], now: NOW,
      timeEvents: [
        mk("later", "2026-09-09T18:00:00Z", "2026-09-09T19:00:00Z"),
        mk("soon", "2026-09-09T16:30:00Z", "2026-09-09T17:00:00Z"),
        mk("cancelled", "2026-09-09T16:00:00Z", "2026-09-09T17:00:00Z", "cancelled"),
        mk("tomorrow-late", "2026-09-10T16:00:00Z", "2026-09-10T17:00:00Z"),
      ],
    });
    expect(r.upcoming.map((t) => t.title)).toEqual(["soon", "later"]);
  });

  it("is deterministic for the same input", () => {
    const ev = [event({ id: "e6" as ContextEventId, title: "x", kind: "k", importance: 60 })];
    const a = deriveNow({ contextEvents: ev, timeEvents: [], moneyTransactions: [], threads, relationships, now: NOW });
    const b = deriveNow({ contextEvents: ev, timeEvents: [], moneyTransactions: [], threads, relationships, now: NOW });
    expect(a).toEqual(b);
  });
});
