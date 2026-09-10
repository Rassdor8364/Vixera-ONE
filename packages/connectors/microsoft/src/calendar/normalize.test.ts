import { describe, expect, it } from "vitest";
import calendarDelta from "../__fixtures__/calendar-delta.json";
import { normalizeGraphEvent, toInstant, toResponse, toStatus, zoneOffsetMinutes } from "./normalize.ts";
import type { GraphEvent } from "./types.ts";

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

  it("does not pretend to know Windows zone names: wall time is kept and flagged", () => {
    const instant = toInstant({ dateTime: "2026-07-01T09:00:00.0000000", timeZone: "Pacific Standard Time" }, false);
    expect(instant).toEqual({ iso: "2026-07-01T09:00:00.000Z", unresolvedZone: true });
    const event = normalizeGraphEvent({ ...timed, start: { dateTime: "2026-07-01T09:00:00", timeZone: "Pacific Standard Time" } }, SELF);
    expect(event.metadata?.timeZoneUnresolved).toBe(true);
  });

  it("returns null for missing or malformed values", () => {
    expect(toInstant(null, false)).toBeNull();
    expect(toInstant({ dateTime: "yesterday", timeZone: "UTC" }, false)).toBeNull();
  });
});
