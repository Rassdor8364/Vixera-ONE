import { describe, expect, it } from "vitest";
import calendarDelta from "../__fixtures__/calendar-delta.json";
import { collect, FAKE_OAUTH, makeContext } from "../testing/context.ts";
import { createFakeFetch } from "../testing/fake-fetch.ts";
import { isWindowStale, parseCalendarCheckpoint, syncCalendar, type CalendarSyncOptions } from "./sync.ts";

const OPTIONS: CalendarSyncOptions = { oauth: FAKE_OAUTH, window: { pastDays: 30, futureDays: 90 }, pageSize: 50 };
const WINDOW = { start: "2026-08-11T12:00:00.000Z", end: "2026-12-09T12:00:00.000Z" };
const DELTA_0 = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=fake-cal-delta-0";
const DELTA_1 = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=fake-cal-delta-1";
const NEXT = "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=fake-cal-skip";

describe("syncCalendar (Microsoft Graph calendarView delta)", () => {
  it("opens a window around now in UTC and stores it with the deltaLink", async () => {
    const fake = createFakeFetch([{ match: "/me/calendarView/delta", reply: { json: calendarDelta } }]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, null, OPTIONS));
    expect(pages).toHaveLength(1);

    const call = fake.calls[0];
    expect(call?.url.searchParams.get("startDateTime")).toBe(WINDOW.start);
    expect(call?.url.searchParams.get("endDateTime")).toBe(WINDOW.end);
    expect(call?.url.searchParams.get("$select")).toContain("attendees");
    expect(call?.headers.prefer).toBe('odata.maxpagesize=50, outlook.timezone="UTC"');

    const page = pages[0];
    expect(page?.done).toBe(true);
    expect(page?.fullResync).toBeUndefined();
    expect(page?.checkpoint).toEqual({ deltaLink: DELTA_1, window: WINDOW });
    expect(page?.batch.events.map((e) => e.externalId)).toEqual(["AAMkAGfake-evt-timed", "AAMkAGfake-evt-allday"]);
    expect(page?.batch.deleted).toEqual([{ externalId: "AAMkAGfake-evt-cancelled", externalCalendarId: "primary" }, { externalId: "AAMkAGfake-evt-removed", externalCalendarId: "primary" }]);
    // isSelf comes from the account address on the context, never from provider data.
    expect(page?.batch.events[0]?.participants.filter((p) => p.isSelf).map((p) => p.email)).toEqual(["me@example.com"]);
  });

  it("pages through nextLink keeping the previous checkpoint until the deltaLink arrives", async () => {
    const fake = createFakeFetch([
      { match: "$skiptoken=fake-cal-skip", reply: { json: { value: [calendarDelta.value[1]], "@odata.deltaLink": DELTA_1 } } },
      { match: "$deltatoken=fake-cal-delta-0", reply: { json: { value: [calendarDelta.value[0]], "@odata.nextLink": NEXT } } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, { deltaLink: DELTA_0, window: WINDOW }, OPTIONS));
    expect(fake.calls[0]?.url.toString()).toBe(DELTA_0);
    expect(fake.calls[0]?.url.searchParams.has("startDateTime")).toBe(false);
    expect(pages.map((p) => p.done)).toEqual([false, true]);
    expect(pages[0]?.checkpoint).toEqual({ deltaLink: DELTA_0, window: WINDOW });
    expect(pages[1]?.checkpoint).toEqual({ deltaLink: DELTA_1, window: WINDOW });
  });

  it("re-opens a fresh window with fullResync when the stored window is older than 7 days", async () => {
    const fake = createFakeFetch([{ match: "/me/calendarView/delta", reply: { json: calendarDelta } }]);
    const ctx = makeContext(fake.fetch);
    const stale = { start: "2026-08-01T12:00:00.000Z", end: "2026-11-29T12:00:00.000Z" };
    const pages = await collect(syncCalendar(ctx, { deltaLink: DELTA_0, window: stale }, OPTIONS));
    expect(fake.calls[0]?.url.searchParams.get("startDateTime")).toBe(WINDOW.start);
    expect(pages[0]?.fullResync).toBe(true);
    expect(pages[0]?.checkpoint).toEqual({ deltaLink: DELTA_1, window: WINDOW });
    expect(ctx.logs.map((l) => l.message)).toContain("microsoft.calendar.window.stale");
  });

  it("keeps a window that is less than 7 days old", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    expect(isWindowStale({ start: "2026-08-05T12:00:00.000Z" }, now, OPTIONS.window)).toBe(false);
    expect(isWindowStale({ start: "2026-08-04T11:59:59.000Z" }, now, OPTIONS.window)).toBe(true);
  });

  it("restarts with a fresh window and fullResync on 410", async () => {
    const fake = createFakeFetch([
      { match: "$deltatoken=fake-cal-delta-0", reply: { status: 410, json: { error: { code: "SyncStateNotFound", message: "Resync required." } } } },
      { match: "startDateTime=", reply: { json: { value: [], "@odata.deltaLink": DELTA_1 } } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, { deltaLink: DELTA_0, window: WINDOW }, OPTIONS));
    expect(pages).toEqual([{ batch: { events: [], deleted: [] }, checkpoint: { deltaLink: DELTA_1, window: WINDOW }, done: true, fullResync: true }]);
  });

  it("skips a malformed event and keeps the page", async () => {
    const fake = createFakeFetch([
      { match: "/me/calendarView/delta", reply: { json: { value: [{ id: "no-start", subject: "?" }, calendarDelta.value[0]], "@odata.deltaLink": DELTA_1 } } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncCalendar(ctx, null, OPTIONS));
    expect(pages[0]?.batch.events.map((e) => e.externalId)).toEqual(["AAMkAGfake-evt-timed"]);
    expect(ctx.logs.find((l) => l.message === "microsoft.calendar.event.skipped")?.data).toMatchObject({ id: "no-start" });
  });
});

describe("parseCalendarCheckpoint", () => {
  it("requires a Graph deltaLink and a parseable window", () => {
    expect(parseCalendarCheckpoint(null)).toBeNull();
    expect(parseCalendarCheckpoint({ deltaLink: DELTA_0 })).toBeNull();
    expect(parseCalendarCheckpoint({ deltaLink: DELTA_0, window: { start: "nope", end: WINDOW.end } })).toBeNull();
    expect(parseCalendarCheckpoint({ deltaLink: "https://evil.example/", window: WINDOW })).toBeNull();
    expect(parseCalendarCheckpoint({ deltaLink: DELTA_0, window: WINDOW })).toEqual({ deltaLink: DELTA_0, window: WINDOW });
  });
});
