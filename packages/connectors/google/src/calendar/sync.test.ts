import { describe, expect, it } from "vitest";
import calendarList from "../__fixtures__/calendar-list.json";
import eventsFixture from "../__fixtures__/calendar-events.json";
import { FAKE_OAUTH, collect, makeContext } from "../testing/context.ts";
import { createFakeFetch } from "../testing/fake-fetch.ts";
import { CALENDAR_API, parseCalendarCheckpoint, selectCalendars, syncCalendar } from "./sync.ts";
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

/** The reconciliation scope a listing of one calendar declares (ADR-017): that calendar, inside the window. */
const scopeFor = (calendarId: string, timeMin = "2026-08-11T12:00:00.000Z", timeMax = "2026-12-09T12:00:00.000Z") => ({ kind: "calendar", calendarIds: [calendarId], from: timeMin, to: timeMax });

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
    // primary page 1: no sync token yet (listing incomplete), but a resume point: the next page token with the window it belongs to
    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["p0"]);
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { page: { token: "pg2", timeMin: "2026-08-11T12:00:00.000Z", timeMax: "2026-12-09T12:00:00.000Z" } } } });
    expect(pages[0]?.done).toBe(false);
    // primary page 2: token stored, cancelled -> deleted
    expect(pages[1]?.batch.events.map((e) => e.externalId)).toEqual(["allday001", "timed001", "untitled001"]);
    expect(pages[1]?.batch.deleted).toEqual([{ externalId: "cancelled001", externalCalendarId: PRIMARY }]);
    // the instance of a recurring series is remembered under its master, so deleting the series later can remove it
    const primaryDone = { syncToken: "fake-sync-token-primary-1", series: { timed001_parent: ["timed001"] } };
    expect(pages[1]?.checkpoint).toEqual({ calendars: { [PRIMARY]: primaryDone } });
    expect(pages[1]?.done).toBe(false);
    // team calendar: last page => done
    expect(pages[2]?.checkpoint).toEqual({ calendars: { [PRIMARY]: primaryDone, [TEAM]: { syncToken: "fake-sync-token-team-1" } } });
    expect(pages[2]?.done).toBe(true);
    expect(pages.every((p) => p.fullResync === undefined)).toBe(true);
    // every listing page names the calendar it covers, so a later delete-untouched pass touches only that calendar
    expect(pages.map((p) => p.resyncScope)).toEqual([scopeFor(PRIMARY), scopeFor(PRIMARY), scopeFor(TEAM)]);

    const first = fake.callsTo(eventsUrl(PRIMARY))[0]!;
    expect(first.url.searchParams.get("singleEvents")).toBe("true");
    expect(first.url.searchParams.get("timeMin")).toBe("2026-08-11T12:00:00.000Z");
    expect(first.url.searchParams.get("timeMax")).toBe("2026-12-09T12:00:00.000Z");
    expect(first.url.searchParams.get("syncToken")).toBeNull();
    expect(fake.callsTo("rooms%40example.com")).toHaveLength(0);
    expect(fake.callsTo("holidays%40example.com")).toHaveLength(0);
  });
});

describe("syncCalendar resuming an initial listing", () => {
  const storedWindow = { timeMin: "2026-08-01T00:00:00.000Z", timeMax: "2026-11-29T00:00:00.000Z" };

  it("continues from the stored page token with the window it was opened with, and leaves finished calendars incremental", async () => {
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: calendarList } },
      { match: eventsUrl(PRIMARY), reply: { json: { items: [{ id: "p9", status: "confirmed", summary: "Last page", start: { date: "2026-09-20" }, end: { date: "2026-09-21" } }], nextSyncToken: "fake-sync-token-primary-1" } } },
      { match: eventsUrl(TEAM), reply: { json: { items: [], nextSyncToken: "fake-sync-token-team-2" } } },
    ]);
    const checkpoint = { calendars: { [PRIMARY]: { page: { token: "pg2", ...storedWindow } }, [TEAM]: { syncToken: "fake-sync-token-team-1" } } };
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, checkpoint, options));

    const primary = fake.callsTo(eventsUrl(PRIMARY));
    expect(primary).toHaveLength(1);
    expect(primary[0]?.url.searchParams.get("pageToken")).toBe("pg2");
    // Google requires every parameter except pageToken to match the request that issued the token
    expect(primary[0]?.url.searchParams.get("timeMin")).toBe(storedWindow.timeMin);
    expect(primary[0]?.url.searchParams.get("timeMax")).toBe(storedWindow.timeMax);
    expect(primary[0]?.url.searchParams.get("syncToken")).toBeNull();
    expect(fake.callsTo(eventsUrl(TEAM))[0]?.url.searchParams.get("syncToken")).toBe("fake-sync-token-team-1");
    expect(pages).toHaveLength(2);
    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["p9"]);
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-1" }, [TEAM]: { syncToken: "fake-sync-token-team-1" } } });
    expect(pages[0]?.fullResync).toBeUndefined();
    expect(pages[1]?.done).toBe(true);
    // the resumed listing keeps the window it was issued with; the sync-token round declares nothing
    expect(pages[0]?.resyncScope).toEqual(scopeFor(PRIMARY, storedWindow.timeMin, storedWindow.timeMax));
    expect(pages[1]?.resyncScope).toBeUndefined();
  });

  it("a sync-token response that pages checkpoints its page token without a window, and the resume carries both", async () => {
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: { items: [{ id: PRIMARY, primary: true, accessRole: "owner" }] } } },
      {
        match: eventsUrl(PRIMARY),
        reply: ({ call }) =>
          call.url.searchParams.get("pageToken") === "inc2"
            ? { json: { items: [{ id: "i2", status: "confirmed", summary: "Second", start: { date: "2026-09-21" }, end: { date: "2026-09-22" } }], nextSyncToken: "fake-sync-token-primary-3" } }
            : { json: { items: [{ id: "i1", status: "confirmed", summary: "First", start: { date: "2026-09-20" }, end: { date: "2026-09-21" } }], nextPageToken: "inc2" } },
      },
    ]);
    const checkpoint = { calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-2" } } };
    const pages = await collect(syncCalendar(makeContext(fake.fetch), checkpoint, options));
    const calls = fake.callsTo(eventsUrl(PRIMARY));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get("syncToken")).toBe("fake-sync-token-primary-2");
    expect(calls[0]?.url.searchParams.get("timeMin")).toBeNull();
    // The intermediate page keeps the token it was issued under and the page token, no window.
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-2", page: { token: "inc2" } } } });
    expect(calls[1]?.url.searchParams.get("syncToken")).toBe("fake-sync-token-primary-2");
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("inc2");
    expect(pages[1]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-3" } } });

    // A run resumed from that checkpoint sends both parameters.
    const resumed = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: { items: [{ id: PRIMARY, primary: true, accessRole: "owner" }] } } },
      { match: eventsUrl(PRIMARY), reply: { json: { items: [], nextSyncToken: "fake-sync-token-primary-3" } } },
    ]);
    await collect(syncCalendar(makeContext(resumed.fetch), { calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-2", page: { token: "inc2" } } } }, options));
    const call = resumed.callsTo(eventsUrl(PRIMARY))[0];
    expect(call?.url.searchParams.get("syncToken")).toBe("fake-sync-token-primary-2");
    expect(call?.url.searchParams.get("pageToken")).toBe("inc2");
    expect(call?.url.searchParams.get("timeMin")).toBeNull();
  });

  it("keeps the fullResync marker on resumed pages of a re-list", async () => {
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: { items: [{ id: PRIMARY, primary: true, accessRole: "owner" }] } } },
      { match: eventsUrl(PRIMARY), reply: { json: { items: [], nextSyncToken: "fake-sync-token-primary-4" } } },
    ]);
    const checkpoint = { calendars: { [PRIMARY]: { page: { token: "pg3", ...storedWindow, fullResync: true } } } };
    const pages = await collect(syncCalendar(makeContext(fake.fetch), checkpoint, options));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.fullResync).toBe(true);
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-4" } } });
  });

  it("re-lists just that calendar from scratch when Google rejects the stored page token", async () => {
    const fake = createFakeFetch([
      { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: calendarList } },
      {
        match: eventsUrl(PRIMARY),
        reply: ({ call }) =>
          call.url.searchParams.get("pageToken")
            ? { status: 400, json: { error: { code: 400, message: "Invalid page token" } } }
            : { json: { items: [{ id: "r0", status: "confirmed", summary: "From the top", start: { date: "2026-09-10" }, end: { date: "2026-09-11" } }], nextSyncToken: "fake-sync-token-primary-5" } },
      },
      { match: eventsUrl(TEAM), reply: { json: { items: [], nextSyncToken: "fake-sync-token-team-2" } } },
    ]);
    const checkpoint = { calendars: { [PRIMARY]: { page: { token: "stale", ...storedWindow } }, [TEAM]: { syncToken: "fake-sync-token-team-1" } } };
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, checkpoint, options));

    const primary = fake.callsTo(eventsUrl(PRIMARY));
    expect(primary).toHaveLength(2);
    expect(primary[1]?.url.searchParams.get("pageToken")).toBeNull();
    // a fresh listing gets a fresh window
    expect(primary[1]?.url.searchParams.get("timeMin")).toBe("2026-08-11T12:00:00.000Z");
    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["r0"]);
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-5" }, [TEAM]: { syncToken: "fake-sync-token-team-1" } } });
    expect(fake.callsTo(eventsUrl(TEAM))[0]?.url.searchParams.get("syncToken")).toBe("fake-sync-token-team-1");
    expect(ctx.logs.some((l) => l.message === "calendar.pageToken.rejected")).toBe(true);
  });

  it("parses the checkpoint shape it writes and still reads the older token-only shape", () => {
    expect(
      parseCalendarCheckpoint({
        calendars: {
          a: { syncToken: "t", series: { m1: ["m1_20260911T120000Z", 5, "m1_20260918T120000Z"], m2: "junk", m3: [] } },
          b: { page: { token: "p", ...storedWindow, fullResync: true } },
          c: { page: { token: 7 } },
          d: "junk",
        },
      }),
    ).toEqual({
      calendars: { a: { syncToken: "t", series: { m1: ["m1_20260911T120000Z", "m1_20260918T120000Z"] } }, b: { page: { token: "p", ...storedWindow, fullResync: true } } },
    });
    expect(parseCalendarCheckpoint({ deltaLink: "not-google" })).toBeNull();
  });
});

describe("syncCalendar recurring series", () => {
  const instance = (id: string, master: string, day: string) => ({
    id,
    status: "confirmed",
    summary: "Invoice review",
    recurringEventId: master,
    start: { dateTime: `${day}T12:00:00Z` },
    end: { dateTime: `${day}T12:30:00Z` },
  });
  const primaryOnly = { match: `${CALENDAR_API}/users/me/calendarList`, reply: { json: { items: [{ id: PRIMARY, primary: true, accessRole: "owner" }] } } };

  it("deletes every stored instance when the series master arrives cancelled", async () => {
    const fake = createFakeFetch([
      primaryOnly,
      { match: eventsUrl(PRIMARY), reply: { json: { items: [{ id: "weekly", status: "cancelled" }], nextSyncToken: "fake-sync-token-primary-2" } } },
    ]);
    const checkpoint = {
      calendars: {
        [PRIMARY]: {
          syncToken: "fake-sync-token-primary-1",
          series: { weekly: ["weekly_20260911T120000Z", "weekly_20260918T120000Z", "weekly_20260925T120000Z"], other: ["other_20260912T090000Z"] },
        },
      },
    };
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, checkpoint, options));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.batch.deleted.map((d) => d.externalId)).toEqual(["weekly", "weekly_20260911T120000Z", "weekly_20260918T120000Z", "weekly_20260925T120000Z"]);
    expect(pages[0]?.batch.deleted.every((d) => d.externalCalendarId === PRIMARY)).toBe(true);
    // the series is forgotten; the other one is untouched
    expect(pages[0]?.checkpoint).toEqual({ calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-2", series: { other: ["other_20260912T090000Z"] } } } });
    expect(ctx.logs.some((l) => l.message === "calendar.series.cancelled" && l.data?.instances === 3)).toBe(true);
  });

  it("registers instances under their master as they arrive and forgets an instance cancelled on its own", async () => {
    const fake = createFakeFetch([
      primaryOnly,
      {
        match: eventsUrl(PRIMARY),
        reply: {
          json: {
            items: [
              instance("weekly_20260911T120000Z", "weekly", "2026-09-11"),
              instance("weekly_20260918T120000Z", "weekly", "2026-09-18"),
              { id: "weekly_20260904T120000Z", status: "cancelled", recurringEventId: "weekly" },
            ],
            nextSyncToken: "fake-sync-token-primary-2",
          },
        },
      },
    ]);
    const checkpoint = { calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-1", series: { weekly: ["weekly_20260904T120000Z", "weekly_20260911T120000Z"] } } } };
    const pages = await collect(syncCalendar(makeContext(fake.fetch), checkpoint, options));

    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["weekly_20260911T120000Z", "weekly_20260918T120000Z"]);
    expect(pages[0]?.batch.deleted).toEqual([{ externalId: "weekly_20260904T120000Z", externalCalendarId: PRIMARY }]);
    expect(pages[0]?.checkpoint).toEqual({
      calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-2", series: { weekly: ["weekly_20260911T120000Z", "weekly_20260918T120000Z"] } } },
    });
  });

  it("forgets instances that fell out of the past window so the checkpoint stays bounded, keeping ids it cannot date", async () => {
    const fake = createFakeFetch([primaryOnly, { match: eventsUrl(PRIMARY), reply: { json: { items: [], nextSyncToken: "fake-sync-token-primary-2" } } }]);
    // now is 2026-09-10T12:00Z and pastDays is 30: anything before 2026-08-11T12:00Z is outside the window
    const checkpoint = {
      calendars: {
        [PRIMARY]: {
          syncToken: "fake-sync-token-primary-1",
          // futureDays is 90: 2026-12-09T12:00Z is the far edge, so a 2027 instance is dropped too
          series: { weekly: ["weekly_20260701T120000Z", "weekly_20260811T113000Z", "weekly_20260811T120000Z", "weekly_20260904", "weekly_20270105T120000Z"], odd: ["odd_first", "odd_20260101T000000Z"] },
        },
      },
    };
    const pages = await collect(syncCalendar(makeContext(fake.fetch), checkpoint, options));
    expect(pages[0]?.checkpoint).toEqual({
      calendars: { [PRIMARY]: { syncToken: "fake-sync-token-primary-2", series: { weekly: ["weekly_20260811T120000Z", "weekly_20260904"], odd: ["odd_first"] } } },
    });
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
    expect(pages[0]?.batch.deleted).toEqual([{ externalId: "cancelled001", externalCalendarId: PRIMARY }]);
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
