import { describe, expect, it } from "vitest";
import eventsFixture from "../__fixtures__/calendar-events.json";
import { normalizeGoogleEvent, toResponse } from "./normalize.ts";
import type { GoogleEvent } from "./types.ts";

const items = (eventsFixture as unknown as { items: GoogleEvent[] }).items;
const byId = (id: string) => items.find((e) => e.id === id)!;

describe("normalizeGoogleEvent", () => {
  it("represents all-day events as UTC midnight with an exclusive end", () => {
    const e = normalizeGoogleEvent("me@example.com", byId("allday001"));
    expect(e).toMatchObject({
      externalCalendarId: "me@example.com",
      externalId: "allday001",
      title: "Brand offsite",
      allDay: true,
      startsAt: "2026-09-14T00:00:00.000Z",
      endsAt: "2026-09-16T00:00:00.000Z",
      timezone: null,
      status: "confirmed",
      organizer: null,
      participants: [],
      externalLink: "https://www.google.com/calendar/event?eid=allday001",
    });
  });

  it("converts timed events to UTC, keeps the zone, maps attendees and drops rooms", () => {
    const e = normalizeGoogleEvent("me@example.com", byId("timed001"));
    expect(e.allDay).toBe(false);
    expect(e.startsAt).toBe("2026-09-11T12:00:00.000Z");
    expect(e.endsAt).toBe("2026-09-11T12:30:00.000Z");
    expect(e.timezone).toBe("Europe/Stockholm");
    expect(e.location).toBe("Studio, Stockholm");
    expect(e.description).toBe("Go through #4800");
    expect(e.organizer).toEqual({ email: "eric.lindqvist@example.com", name: "Eric Lindqvist", response: "accepted", isOrganizer: true, isSelf: false });
    expect(e.participants).toEqual([
      { email: "eric.lindqvist@example.com", name: "Eric Lindqvist", response: "accepted", isOrganizer: true, isSelf: false },
      { email: "me@example.com", name: null, response: "needs_action", isOrganizer: false, isSelf: true },
      { email: "jane.doe@example.com", name: "Jane Doe", response: "tentative", isOrganizer: false, isSelf: false },
    ]);
    expect(e.metadata).toEqual({ recurringEventId: "timed001_parent", hangoutLink: "https://meet.example.com/abc", etag: '"2"', updated: "2026-09-09T08:00:00.000Z" });
  });

  it("falls back to (no title), tentative status and end = start when the end is unspecified", () => {
    const e = normalizeGoogleEvent("me@example.com", byId("untitled001"));
    expect(e.title).toBe("(no title)");
    expect(e.status).toBe("tentative");
    expect(e.endsAt).toBe(e.startsAt);
  });

  it("maps response statuses", () => {
    expect(toResponse("needsAction")).toBe("needs_action");
    expect(toResponse("accepted")).toBe("accepted");
    expect(toResponse("declined")).toBe("declined");
    expect(toResponse("tentative")).toBe("tentative");
    expect(toResponse(undefined)).toBe("unknown");
  });

  it("rejects events without a start", () => {
    expect(() => normalizeGoogleEvent("c", { id: "x", status: "confirmed" })).toThrow(/no start/);
  });
});
