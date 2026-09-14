import { describe, expect, it } from "vitest";
import calendarDelta from "../__fixtures__/calendar-delta.json";
import { normalizeGraphEvent, toInstant, toResponse, toStatus, zoneOffsetAt, zoneOffsetMinutes } from "./normalize.ts";
import { windowsZoneNames } from "./windows-zones.ts";
import type { GraphEvent } from "./types.ts";
import { windowsZoneToIana } from "./windows-zones.ts";

const events = calendarDelta.value as GraphEvent[];
const timed = events[0] as GraphEvent;
const allDay = events[1] as GraphEvent;
const cancelled = events[2] as GraphEvent;
const SELF = { selfAddress: "me@example.com" };

describe("normalizeGraphEvent", () => {
  it("normalizes a timed UTC event with organizer, attendees and location", () => {
    const event = normalizeGraphEvent(timed, SELF);
    expect(event.externalCalendarId).toBe("primary");
    expect(event.externalId).toBe("AAMkAGfake-evt-timed");
    expect(event.title).toBe("Brand review");
    expect(event.description).toBe("Walk through the invoice and the next steps.");
    expect(event.startsAt).toBe("2026-09-12T10:00:00.000Z");
    expect(event.endsAt).toBe("2026-09-12T11:00:00.000Z");
    expect(event.allDay).toBe(false);
    expect(event.timezone).toBe("W. Europe Standard Time");
    expect(event.location).toBe("Studio, room 2");
    expect(event.status).toBe("confirmed");
    expect(event.externalLink).toContain("outlook.office365.com");
    expect(event.organizer).toEqual({ email: "eric.lindqvist@studio.example", name: "Eric Lindqvist", response: "accepted", isOrganizer: true, isSelf: false });
    expect(event.metadata).toEqual({ lastModifiedDateTime: "2026-09-08T09:40:00Z", type: "singleInstance", showAs: "busy" });
  });

  it("maps attendee responses, drops resources, and marks the account address as self", () => {
    const event = normalizeGraphEvent(timed, SELF);
    expect(event.participants.map((p) => [p.email, p.response, p.isSelf, p.isOrganizer])).toEqual([
      ["eric.lindqvist@studio.example", "accepted", false, true],
      ["me@example.com", "accepted", true, false],
      ["anna@studio.example", "tentative", false, false],
      ["bo@studio.example", "declined", false, false],
      ["cy@studio.example", "needs_action", false, false],
    ]);
    expect(event.participants.find((p) => p.isSelf)?.name).toBe("Me Example");
  });

  it("prefers the event-level responseStatus for the account's own RSVP", () => {
    const event = normalizeGraphEvent({ ...timed, responseStatus: { response: "tentativelyAccepted" } }, SELF);
    expect(event.participants.find((p) => p.isSelf)?.response).toBe("tentative");
  });

  it("normalizes an all-day occurrence as UTC midnight with an exclusive end", () => {
    const event = normalizeGraphEvent(allDay, SELF);
    expect(event.allDay).toBe(true);
    expect(event.startsAt).toBe("2026-09-14T00:00:00.000Z");
    expect(event.endsAt).toBe("2026-09-15T00:00:00.000Z");
    expect(event.description).toBeNull();
    expect(event.location).toBeNull();
    expect(event.participants).toEqual([]);
    expect(event.organizer).toEqual({ email: "me@example.com", name: "Me Example", response: "accepted", isOrganizer: true, isSelf: true });
    expect(event.metadata).toMatchObject({ type: "occurrence", seriesMasterId: "AAMkAGfake-series-1" });
  });

  it("recovers the civil date of an all-day event that Graph converted into UTC", () => {
    // Created as midnight Sep 14 in W. Europe Standard Time (UTC+2 in September); Graph answers in UTC.
    const shifted = normalizeGraphEvent(
      { ...allDay, start: { dateTime: "2026-09-13T22:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-09-15T22:00:00.0000000", timeZone: "UTC" } },
      SELF,
    );
    expect(shifted.startsAt).toBe("2026-09-14T00:00:00.000Z");
    expect(shifted.endsAt).toBe("2026-09-16T00:00:00.000Z");
    // West of UTC the converted time falls on the same civil day.
    expect(toInstant({ dateTime: "2026-09-14T07:00:00.0000000", timeZone: "UTC" }, true)?.iso).toBe("2026-09-14T00:00:00.000Z");
  });

  it("recovers the civil date of all-day events created east of UTC+12 from originalStartTimeZone", () => {
    // Public holiday on Mon 26 Oct 2026 in Pacific/Auckland (NZDT, UTC+13): Graph, asked for UTC, answers 11:00Z the day before.
    const utc = (start: string, end: string) => ({ start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" } });
    const auckland = normalizeGraphEvent({ ...allDay, ...utc("2026-10-25T11:00:00.0000000", "2026-10-26T11:00:00.0000000"), originalStartTimeZone: "Pacific/Auckland" }, SELF);
    expect(auckland.startsAt).toBe("2026-10-26T00:00:00.000Z");
    expect(auckland.endsAt).toBe("2026-10-27T00:00:00.000Z");
    expect(auckland.metadata?.timeZoneUnresolved).toBeUndefined();
    // Outlook reports the zone under its Windows name.
    const windows = normalizeGraphEvent({ ...allDay, ...utc("2026-10-25T11:00:00.0000000", "2026-10-26T11:00:00.0000000"), originalStartTimeZone: "New Zealand Standard Time" }, SELF);
    expect([windows.startsAt, windows.endsAt]).toEqual(["2026-10-26T00:00:00.000Z", "2026-10-27T00:00:00.000Z"]);
    expect(windows.metadata?.timeZoneUnresolved).toBeUndefined();
    expect(windows.timezone).toBe("New Zealand Standard Time");
    // UTC+14 (Kiritimati) and UTC−12 (Dateline) are the two edges the nearest-midnight rounding gets wrong in both directions.
    expect(toInstant({ dateTime: "2026-09-27T10:00:00.0000000", timeZone: "UTC" }, true, "Pacific/Kiritimati")?.iso).toBe("2026-09-28T00:00:00.000Z");
    expect(toInstant({ dateTime: "2026-09-27T10:00:00.0000000", timeZone: "UTC" }, true, "Line Islands Standard Time")?.iso).toBe("2026-09-28T00:00:00.000Z");
    expect(toInstant({ dateTime: "2026-09-28T12:00:00.0000000", timeZone: "UTC" }, true, "Etc/GMT+12")?.iso).toBe("2026-09-28T00:00:00.000Z");
    expect(toInstant({ dateTime: "2026-09-28T12:00:00.0000000", timeZone: "UTC" }, true, "Dateline Standard Time")?.iso).toBe("2026-09-28T00:00:00.000Z");
    // The zone also settles the west: a Stockholm all-day event still lands on its own date.
    expect(toInstant({ dateTime: "2026-09-13T22:00:00.0000000", timeZone: "UTC" }, true, "W. Europe Standard Time")?.iso).toBe("2026-09-14T00:00:00.000Z");
    // Graph ignoring the UTC preference (wall time in the original zone) yields the same date.
    expect(toInstant({ dateTime: "2026-10-26T00:00:00.0000000", timeZone: "New Zealand Standard Time" }, true, "New Zealand Standard Time")?.iso).toBe("2026-10-26T00:00:00.000Z");
    // An unknown zone falls back to the nearest UTC midnight and says so.
    expect(toInstant({ dateTime: "2026-09-13T22:00:00.0000000", timeZone: "UTC" }, true, "Atlantis Standard Time")).toEqual({ iso: "2026-09-14T00:00:00.000Z", unresolvedZone: true });
    const unknown = normalizeGraphEvent({ ...allDay, ...utc("2026-10-25T11:00:00.0000000", "2026-10-26T11:00:00.0000000"), originalStartTimeZone: "Atlantis Standard Time" }, SELF);
    expect(unknown.metadata?.timeZoneUnresolved).toBe(true);
    // A true midnight without any zone is unchanged and not flagged.
    expect(toInstant({ dateTime: "2026-09-14T00:00:00.0000000", timeZone: "UTC" }, true, null)).toEqual({ iso: "2026-09-14T00:00:00.000Z", unresolvedZone: false });
    // Exchange spells UTC as tzone://Microsoft/Utc on old items: known, not flagged.
    expect(toInstant({ dateTime: "2026-09-14T00:00:00.0000000", timeZone: "UTC" }, true, "tzone://Microsoft/Utc")).toEqual({ iso: "2026-09-14T00:00:00.000Z", unresolvedZone: false });
    // Legacy Windows ids Exchange still emits resolve too.
    expect(toInstant({ dateTime: "2026-09-13T12:00:00.0000000", timeZone: "UTC" }, true, "Kamchatka Standard Time")?.unresolvedZone).toBe(false);
  });

  it("resolves every Windows zone name in the table through Intl (a typo would silently flag that zone)", () => {
    for (const name of windowsZoneNames()) expect(zoneOffsetAt(name, Date.UTC(2026, 0, 1)), name).not.toBeNull();
    expect(windowsZoneNames().length).toBeGreaterThanOrEqual(139);
  });

  it("marks cancelled events as cancelled and tentative showAs as tentative", () => {
    expect(normalizeGraphEvent(cancelled, SELF).status).toBe("cancelled");
    expect(normalizeGraphEvent({ ...timed, showAs: "tentative" }, SELF).status).toBe("tentative");
    expect(toStatus({ isCancelled: true, showAs: "tentative" })).toBe("cancelled");
  });

  it("falls back to a placeholder title and rejects events without id or start", () => {
    expect(normalizeGraphEvent({ ...timed, subject: "  " }, SELF).title).toBe("(no title)");
    expect(() => normalizeGraphEvent({ ...timed, id: "" }, SELF)).toThrow(/without id/);
    expect(() => normalizeGraphEvent({ ...timed, start: null }, SELF)).toThrow(/no start/);
  });

  it("does not leak provider field names", () => {
    const json = JSON.stringify(normalizeGraphEvent(timed, SELF));
    expect(json).not.toContain("emailAddress");
    expect(json).not.toContain("tentativelyAccepted");
    expect(json).not.toContain("webLink");
  });
});

describe("toResponse", () => {
  it("maps every Graph response value", () => {
    expect(toResponse("accepted")).toBe("accepted");
    expect(toResponse("organizer")).toBe("accepted");
    expect(toResponse("declined")).toBe("declined");
    expect(toResponse("tentativelyAccepted")).toBe("tentative");
    expect(toResponse("none")).toBe("needs_action");
    expect(toResponse("notResponded")).toBe("needs_action");
    expect(toResponse(undefined)).toBe("unknown");
    expect(toResponse("something-new")).toBe("unknown");
  });
});

describe("toInstant (time zones)", () => {
  it("stamps UTC wall times with Z and keeps 7-digit fractions", () => {
    expect(toInstant({ dateTime: "2026-09-12T10:00:00.1234567", timeZone: "UTC" }, false)).toEqual({ iso: "2026-09-12T10:00:00.123Z", unresolvedZone: false });
  });

  it("converts IANA zones through Intl", () => {
    expect(toInstant({ dateTime: "2026-07-01T09:00:00.0000000", timeZone: "Europe/Stockholm" }, false)).toEqual({ iso: "2026-07-01T07:00:00.000Z", unresolvedZone: false });
    expect(toInstant({ dateTime: "2026-01-15T09:00:00.0000000", timeZone: "America/Los_Angeles" }, false)).toEqual({ iso: "2026-01-15T17:00:00.000Z", unresolvedZone: false });
    expect(zoneOffsetMinutes("Asia/Kolkata", Date.UTC(2026, 0, 1))).toBe(330);
  });

  it("converts Windows zone names through the CLDR table, with DST", () => {
    expect(toInstant({ dateTime: "2026-07-01T09:00:00.0000000", timeZone: "Pacific Standard Time" }, false)).toEqual({ iso: "2026-07-01T16:00:00.000Z", unresolvedZone: false });
    expect(toInstant({ dateTime: "2026-01-15T09:00:00.0000000", timeZone: "pacific standard time" }, false)).toEqual({ iso: "2026-01-15T17:00:00.000Z", unresolvedZone: false });
    expect(zoneOffsetMinutes("India Standard Time", Date.UTC(2026, 0, 1))).toBe(330);
    expect(windowsZoneToIana("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(windowsZoneToIana("Europe/Stockholm")).toBeNull();
  });

  it("does not pretend to know unknown zone names: wall time is kept and flagged", () => {
    const instant = toInstant({ dateTime: "2026-07-01T09:00:00.0000000", timeZone: "Atlantis Standard Time" }, false);
    expect(instant).toEqual({ iso: "2026-07-01T09:00:00.000Z", unresolvedZone: true });
    const event = normalizeGraphEvent({ ...timed, start: { dateTime: "2026-07-01T09:00:00", timeZone: "Atlantis Standard Time" } }, SELF);
    expect(event.metadata?.timeZoneUnresolved).toBe(true);
  });

  it("returns null for missing or malformed values", () => {
    expect(toInstant(null, false)).toBeNull();
    expect(toInstant({ dateTime: "yesterday", timeZone: "UTC" }, false)).toBeNull();
  });
});
