import { describe, expect, it } from "vitest";
import calendarList from "../__fixtures__/calendar-list.json";
import eventsFixture from "../__fixtures__/calendar-events.json";
import { FAKE_OAUTH, collect, makeContext } from "../testing/context.ts";
import { createFakeFetch } from "../testing/fake-fetch.ts";
import { CALENDAR_API, selectCalendars, syncCalendar } from "./sync.ts";
import type { GoogleCalendarListEntry } from "./types.ts";

const options = { oauth: FAKE_OAUTH, window: { pastDays: 30, futureDays: 90 } };
const PRIMARY = "me@example.com";
const TEAM = "brand-team@group.calendar.google.com";
const eventsUrl = (id: string) => `${CALENDAR_API}/calendars/${encodeURIComponent(id)}/events`;

describe("selectCalendars", () => {
  it("keeps primary and selected readable calendars, drops free/busy and deselected", () => {
    const ids = selectCalendars((calendarList as { items: GoogleCalendarListEntry[] }).items).map((c) => c.id);
    expect(ids).toEqual([PRIMARY, TEAM]);
    expect(selectCalendars([{ id: "p", primary: true, selected: false, accessRole: "freeBusyReader" }]).map((c) => c.id)).toEqual(["p"]);
  });
});

describe("syncCalendar initial", () => {
  it("lists each calendar inside the window, turns cancelled into deletions and stores sync tokens", async () => {
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: calendarList } },
      {
        match: eventsUrl(PRIMARY),
        reply: ({ call }) =>
          call.url.searchParams.get("pageToken")
            ? { json: eventsFixture }
            : { json: { items: [{ id: "p0", status: "confirmed", summary: "Page one", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }], nextPageToken: "pg2" } },
      },
      { match: eventsUrl(TEAM), reply: { json: { items: [], nextSyncToken: "fake-sync-token-team-1" } } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, null, options));

    expect(pages).toHaveLength(3);
    // primary page 1: no token yet for primary (listing incomplete)
    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["p0"]);
    expect(pages[0]?.checkpoint).toEqual({ calendars: {} });
    expect(pages[0]?.done).toBe(false);
    // primary page 2: token stored, cancelled -> deleted
    expect(pages[1]?.batch.events.map((e) => e.externalId)).toEqual(["allday001", "timed001", "untitled001"]);
    expect(pages[1]?.batch.deleted).toEqual([{ externalId: "cancelled001" }]);
    expect(pages[1]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-1" } } });
    expect(pages[1]?.done).toBe(false);
    // team calendar: last page => done
    expect(pages[2]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-1" }, [TEAM]: { syncToken: "fake-sync-token-team-1" } } });
    expect(pages[2]?.done).toBe(true);
    expect(pages.every((p) => p.fullResync === undefined)).toBe(true);

    const first = fake.callsTo(eventsUrl(PRIMARY))[0]!;
    expect(first.url.searchParams.get("singleEvents")).toBe("true");
    expect(first.url.searchParams.get("timeMin")).toBe("2026-08-11T12:00:00.000Z");
    expect(first.url.searchParams.get("timeMax")).toBe("2026-12-09T12:00:00.000Z");
    expect(first.url.searchParams.get("syncToken")).toBeNull();
    expect(fake.callsTo("rooms%40example.com")).toHaveLength(0);
    expect(fake.callsTo("holidays%40example.com")).toHaveLength(0);
  });
});

describe("syncCalendar incremental", () => {
  it("uses the stored syncToken per calendar and prunes calendars that disappeared", async () => {
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: { items: [{ id: PRIMARY, primary: true, accessRole: "owner" }] } } },
      {
        match: eventsUrl(PRIMARY),
        reply: { json: { items: [{ id: "cancelled001", status: "cancelled" }, { id: "n1", status: "confirmed", summary: "New", start: { dateTime: "2026-09-12T10:00:00Z" }, end: { dateTime: "2026-09-12T11:00:00Z" } }], nextSyncToken: "fake-sync-token-primary-2" } },
      },
    ]);
    const checkpoint = { calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-1" }, "old@example.com": { syncToken: "stale" } } };
    const pages = await collect(syncCalendar(makeContext(fake.fetch), checkpoint, options));

    expect(pages).toHaveLength(1);
    const call = fake.callsTo(eventsUrl(PRIMARY))[0]!;
    expect(call.url.searchParams.get("syncToken")).toBe("fake-sync-token-primary-1");
    expect(call.url.searchParams.get("timeMin")).toBeNull();
    expect(pages[0]?.batch.deleted).toEqual([{ externalId: "cancelled001" }]);
    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["n1"]);
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-2" } } });
    expect(pages[0]?.done).toBe(true);
  });

  it("re-lists one calendar with fullResync on 410 without touching the others", async () => {
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: calendarList } },
      {
        match: eventsUrl(PRIMARY),
        reply: ({ call }) =>
          call.url.searchParams.get("syncToken")
            ? { status: 410, json: { error: { code: 410, message: "Sync token is no longer valid, a full sync is required." } } }
            : { json: { items: [{ id: "r1", status: "confirmed", summary: "Resynced", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }], nextSyncToken: "fake-sync-token-primary-3" } },
      },
      { match: eventsUrl(TEAM), reply: { json: { items: [], nextSyncToken: "fake-sync-token-team-2" } } },
    ]);
    const checkpoint = { calendars: { [PRIMARY]: { syncToken: "expired" }, [TEAM]: { syncToken: "fake-sync-token-team-1" } } };
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, checkpoint, options));

    expect(pages).toHaveLength(2);
    expect(pages[0]?.fullResync).toBe(true);
    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["r1"]);
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-3" }, [TEAM]: { syncToken: "fake-sync-token-team-1" } } });
    expect(pages[1]?.fullResync).toBeUndefined();
    expect(fake.callsTo(eventsUrl(TEAM))[0]?.url.searchParams.get("syncToken")).toBe("fake-sync-token-team-1");
    const primaryCalls = fake.callsTo(eventsUrl(PRIMARY));
    expect(primaryCalls).toHaveLength(2);
    expect(primaryCalls[1]?.url.searchParams.get("timeMin")).toBe("2026-08-11T12:00:00.000Z");
    expect(ctx.logs.some((l) => l.message === "calendar.syncToken.expired")).toBe(true);
  });

  it("does not loop on a 410 that arrives without a sync token: it is surfaced as an error", async () => {
    const gone = { status: 410, json: { error: { code: 410, message: "Gone" } } };
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: { items: [{ id: PRIMARY, primary: true, accessRole: "owner" }] } } },
      { match: eventsUrl(PRIMARY), reply: gone },
    ]);
    await expect(collect(syncCalendar(makeContext(fake.fetch), null, options))).rejects.toMatchObject({ name: "ConnectorError" });
    expect(fake.callsTo(eventsUrl(PRIMARY))).toHaveLength(1);
  });

  it("yields one empty done page when the account has no calendars", async () => {
    const fake = createFakeFetch([{ match: "/users/me/calendarList", reply: { json: { items: [] } } }]);
    const pages = await collect(syncCalendar(makeContext(fake.fetch), null, options));
    expect(pages).toEqual([{ batch: { events: [], deleted: [] }, checkpoint: { calendars: {} }, done: true }]);
  });
});
