import { describe, expect, it } from "vitest";
import { deriveNow, zonedMidnight } from "./derive-now.ts";
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

  it("honors snooze: quiet while active, back in play once elapsed", () => {
    const active = event({ id: "e7" as ContextEventId, title: "Snoozed", kind: "mail.received", importance: 90, attention: "quiet", metadata: { snoozedUntil: "2026-09-10T09:00:00Z" } });
    const elapsed = event({ id: "e8" as ContextEventId, title: "Back", kind: "mail.received", importance: 90, attention: "quiet", metadata: { snoozedUntil: "2026-09-09T09:00:00Z" } });
    const r = deriveNow({ contextEvents: [active, elapsed], timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: NOW });
    expect(r.quiet.map((i) => i.title)).toEqual(["Snoozed"]);
    expect(r.needsMe.map((i) => i.title)).toEqual(["Back"]);
    expect(r.needsMe[0]?.reasons).toContain("snooze elapsed");
  });

  it("treats time events as appointments: happening now boosts, finished ones fall back", () => {
    const meetingId = "11111111-1111-4111-8111-000000000006" as TimeEventId;
    const meeting: TimeEvent = {
      id: meetingId, userId: DEV_USER_ID, connectorAccountId: "c" as ConnectorAccountId, externalCalendarId: "primary", externalId: "m",
      title: "Kickoff", description: null, startsAt: "2026-09-09T14:30:00Z", endsAt: "2026-09-09T15:15:00Z", allDay: false, timezone: null, location: null,
      status: "confirmed", organizer: null, participants: [], externalLink: null, metadata: {}, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    };
    const ev = event({ id: "e9" as ContextEventId, title: "Kickoff", kind: "time.event.upcoming", importance: 45, dueAt: meeting.startsAt, subject: ref("time_event", meetingId), occurredAt: "2026-09-09T12:00:00Z" });
    const during = deriveNow({ contextEvents: [ev], timeEvents: [meeting], threads: [], relationships: [], now: NOW });
    expect(during.needsMe[0]?.reasons).toContain("happening now");
    const after = deriveNow({ contextEvents: [ev], timeEvents: [meeting], threads: [], relationships: [], now: new Date("2026-09-09T16:00:00Z") });
    expect(after.needsMe).toHaveLength(0);
    expect(after.changed).toHaveLength(0);
    expect(after.canWait).toHaveLength(0);
    expect(after.quiet[0]?.reasons).toContain("already happened");
  });

  it("an appointment that has ended is quiet whatever its importance or thread", () => {
    const meetingId = "11111111-1111-4111-8111-000000000016" as TimeEventId;
    const meeting: TimeEvent = {
      id: meetingId, userId: DEV_USER_ID, connectorAccountId: "c" as ConnectorAccountId, externalCalendarId: "primary", externalId: "b",
      title: "Board", description: null, startsAt: "2026-09-09T12:00:00Z", endsAt: "2026-09-09T13:00:00Z", allDay: false, timezone: null, location: null,
      status: "confirmed", organizer: null, participants: [], externalLink: null, metadata: {}, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    };
    const ev = event({ id: "e20" as ContextEventId, title: "Board", kind: "time.event.changed", importance: 95, dueAt: meeting.startsAt, subject: ref("time_event", meetingId), occurredAt: "2026-09-09T11:00:00Z" });
    const r = deriveNow({ contextEvents: [ev], timeEvents: [meeting], threads, relationships: [{ ...relationships[0]!, from: ref("time_event", meetingId) }], now: NOW });
    expect(r.needsMe).toHaveLength(0);
    expect(r.changed).toHaveLength(0);
    expect(r.quiet.map((i) => i.title)).toEqual(["Board"]);
  });

  it("an overdue item stays in needs_me however old it is — age is not a reason to forget a debt", () => {
    const fresh = event({ id: "e21" as ContextEventId, title: "Invoice due", kind: "money.invoice.due", importance: 50, dueAt: "2026-09-10T11:00:00Z", occurredAt: "2026-09-09T10:00:00Z" });
    const overdueOld = event({ id: "e22" as ContextEventId, title: "Invoice overdue", kind: "money.invoice.due", importance: 50, dueAt: "2026-09-05T11:00:00Z", occurredAt: "2026-09-01T10:00:00Z" });
    const r = deriveNow({ contextEvents: [fresh, overdueOld], timeEvents: [], moneyTransactions: [], threads, relationships, now: NOW });
    expect(r.needsMe.map((i) => i.title)).toEqual(expect.arrayContaining(["Invoice overdue"]));
    expect(r.needsMe.find((i) => i.title === "Invoice overdue")?.reasons).not.toContain("older than window");
    expect(r.needsMe.find((i) => i.title === "Invoice overdue")?.reasons).toContain("overdue");
  });

  it("an explicit Quiet after a snooze elapsed stays quiet once the action cleared the snooze", () => {
    // What the quiet action now persists: attention quiet, snoozedUntil cleared.
    const quieted = event({ id: "e23" as ContextEventId, title: "Quieted after snooze", kind: "mail.received", importance: 60, attention: "quiet", metadata: { snoozedUntil: null } });
    const r = deriveNow({ contextEvents: [quieted], timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: NOW });
    expect(r.needsMe).toHaveLength(0);
    expect(r.quiet.map((i) => i.title)).toEqual(["Quieted after snooze"]);
  });

  it("all-day events use local midnight in the user's zone, not UTC midnight", () => {
    const offsiteId = "11111111-1111-4111-8111-000000000017" as TimeEventId;
    // Stored as the connectors store it: UTC midnight of the civil date, exclusive end.
    const offsite: TimeEvent = {
      id: offsiteId, userId: DEV_USER_ID, connectorAccountId: "c" as ConnectorAccountId, externalCalendarId: "primary", externalId: "o",
      title: "Offsite", description: null, startsAt: "2026-09-10T00:00:00Z", endsAt: "2026-09-11T00:00:00Z", allDay: true, timezone: null, location: null,
      status: "confirmed", organizer: null, participants: [], externalLink: null, metadata: {}, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    };
    const ev = event({ id: "e24" as ContextEventId, title: "Offsite", kind: "time.event.upcoming", importance: 45, dueAt: offsite.startsAt, subject: ref("time_event", offsiteId), occurredAt: "2026-09-09T12:00:00Z" });
    const item = (r: ReturnType<typeof deriveNow>) => [...r.needsMe, ...r.changed, ...r.canWait, ...r.quiet].find((i) => i.title === "Offsite");
    // 2026-09-10T01:00Z is 18:00 on the 9th in Los Angeles: the offsite has NOT started and is not "overdue" either.
    const la = deriveNow({ contextEvents: [ev], timeEvents: [offsite], threads: [], relationships: [], now: new Date("2026-09-10T01:00:00Z"), timeZone: "America/Los_Angeles" });
    expect(item(la)?.reasons).not.toContain("happening now");
    expect(item(la)?.reasons).not.toContain("overdue");
    expect(item(la)?.reasons).toContain("due within 24h");
    // 2026-09-10T20:00Z is 13:00 on the 10th in Los Angeles: it is under way.
    const during = deriveNow({ contextEvents: [ev], timeEvents: [offsite], threads: [], relationships: [], now: new Date("2026-09-10T20:00:00Z"), timeZone: "America/Los_Angeles" });
    expect(item(during)?.reasons).toContain("happening now");
    // 2026-09-11T02:00Z is still 19:00 on the 10th in Los Angeles: not over yet.
    const evening = deriveNow({ contextEvents: [ev], timeEvents: [offsite], threads: [], relationships: [], now: new Date("2026-09-11T02:00:00Z"), timeZone: "America/Los_Angeles" });
    expect(item(evening)?.reasons).toContain("happening now");
    expect(item(evening)?.bucket).not.toBe("quiet");
    // And in Tokyo the same instant (11:00 on the 11th) it is over.
    const tokyo = deriveNow({ contextEvents: [ev], timeEvents: [offsite], threads: [], relationships: [], now: new Date("2026-09-11T02:00:00Z"), timeZone: "Asia/Tokyo" });
    expect(item(tokyo)?.reasons).toContain("already happened");
    expect(item(tokyo)?.bucket).toBe("quiet");
    // Without a zone the old UTC behaviour holds — the caller must pass one.
    const utc = deriveNow({ contextEvents: [ev], timeEvents: [offsite], threads: [], relationships: [], now: new Date("2026-09-10T01:00:00Z") });
    expect(item(utc)?.reasons).toContain("happening now");
    // Upcoming follows the same boundaries.
    expect(la.upcoming.map((t) => t.title)).toEqual(["Offsite"]);
  });

  it("zonedMidnight is DST-safe and falls back to UTC for an unknown zone", () => {
    expect(new Date(zonedMidnight("2026-03-29", "Europe/Stockholm")).toISOString()).toBe("2026-03-28T23:00:00.000Z"); // CET, before the switch
    expect(new Date(zonedMidnight("2026-03-30", "Europe/Stockholm")).toISOString()).toBe("2026-03-29T22:00:00.000Z"); // CEST, after it
    expect(new Date(zonedMidnight("2026-09-10", "Pacific/Kiritimati")).toISOString()).toBe("2026-09-09T10:00:00.000Z"); // UTC+14
    expect(new Date(zonedMidnight("2026-09-10", "Not/AZone")).toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(zonedMidnight("nonsense", "UTC")).toBeNaN();
  });

  it("an unparseable occurredAt is old, not new", () => {
    const bad = event({ id: "e25" as ContextEventId, title: "Bad clock", kind: "mail.received", importance: 60, occurredAt: "not-a-date" });
    const r = deriveNow({ contextEvents: [bad], timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: NOW });
    expect(r.changed).toHaveLength(0);
    const item = [...r.needsMe, ...r.canWait, ...r.quiet][0];
    expect(item?.reasons).toContain("older than window");
    expect(item?.reasons).not.toContain("recent");
  });

  it("changedWindowHours widens or narrows what still counts as changed", () => {
    const threeDaysOld = event({ id: "e26" as ContextEventId, title: "Three days ago", kind: "time.event.changed", importance: 50, occurredAt: "2026-09-06T15:00:00Z" });
    const base = { contextEvents: [threeDaysOld], timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: NOW };
    expect(deriveNow(base).changed).toHaveLength(0);
    expect(deriveNow({ ...base, changedWindowHours: 96 }).changed.map((i) => i.title)).toEqual(["Three days ago"]);
  });

  it("is deterministic for the same input", () => {
    const ev = [event({ id: "e6" as ContextEventId, title: "x", kind: "k", importance: 60 })];
    const a = deriveNow({ contextEvents: ev, timeEvents: [], moneyTransactions: [], threads, relationships, now: NOW });
    const b = deriveNow({ contextEvents: ev, timeEvents: [], moneyTransactions: [], threads, relationships, now: NOW });
    expect(a).toEqual(b);
  });
});
