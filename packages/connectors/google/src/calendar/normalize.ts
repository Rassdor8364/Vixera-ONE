/**
 * Google Calendar event → `NormalizedTimeEvent`.
 *
 * All-day events are represented as UTC midnight of their civil date with
 * `allDay: true`; `endsAt` keeps Google's exclusive end date. Timed events are
 * converted to UTC ISO. Cancelled events are still normalized (the sync
 * source turns them into deletions). Pure and synchronous.
 */
import {
  ConnectorError,
  normalizeEmail,
  type EventParticipant,
  type JsonObject,
  type NormalizedTimeEvent,
  type ParticipantResponse,
  type TimeEventStatus,
} from "@vixera/domain";
import type { GoogleEvent, GoogleEventDateTime, GoogleEventPerson } from "./types.ts";

export const UNTITLED_EVENT = "(no title)";

export function normalizeGoogleEvent(calendarId: string, raw: GoogleEvent): NormalizedTimeEvent {
  if (!raw || typeof raw.id !== "string" || !raw.id) {
    throw new ConnectorError("invalid_response", "Google Calendar event without id", false);
  }
  const start = toInstant(raw.start);
  if (!start) throw new ConnectorError("invalid_response", `Google Calendar event ${raw.id} has no start`, false);
  const end = toInstant(raw.end) ?? start;
  const attendees = (raw.attendees ?? []).filter((a) => a.resource !== true);
  const organizer = raw.organizer ? toOrganizer(raw.organizer, attendees) : null;

  const metadata: JsonObject = {};
  if (raw.recurringEventId) metadata.recurringEventId = raw.recurringEventId;
  if (raw.eventType) metadata.eventType = raw.eventType;
  if (raw.hangoutLink) metadata.hangoutLink = raw.hangoutLink;
  if (raw.etag) metadata.etag = raw.etag;
  if (raw.updated) metadata.updated = raw.updated;

  return {
    externalCalendarId: calendarId,
    externalId: raw.id,
    title: raw.summary?.trim() || UNTITLED_EVENT,
    description: raw.description?.trim() || null,
    startsAt: start.iso,
    endsAt: end.iso,
    allDay: start.allDay,
    timezone: raw.start?.timeZone ?? raw.end?.timeZone ?? null,
    location: raw.location?.trim() || null,
    status: toStatus(raw.status),
    organizer,
    participants: attendees.map((a) => toParticipant(a)),
    externalLink: raw.htmlLink ?? null,
    metadata,
  };
}

export function toStatus(status: string | undefined): TimeEventStatus {
  if (status === "cancelled") return "cancelled";
  if (status === "tentative") return "tentative";
  return "confirmed";
}

export function toResponse(status: string | undefined): ParticipantResponse {
  switch (status) {
    case "accepted":
    case "declined":
    case "tentative":
      return status;
    case "needsAction":
      return "needs_action";
    default:
      return "unknown";
  }
}

function toInstant(value: GoogleEventDateTime | undefined): { iso: string; allDay: boolean } | null {
  if (!value) return null;
  if (value.date) {
    const ms = Date.parse(`${value.date}T00:00:00Z`);
    return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), allDay: true } : null;
  }
  if (value.dateTime) {
    const ms = Date.parse(value.dateTime);
    return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), allDay: false } : null;
  }
  return null;
}

function toParticipant(person: GoogleEventPerson): EventParticipant {
  return {
    email: person.email ? normalizeEmail(person.email) : null,
    name: person.displayName?.trim() || null,
    response: toResponse(person.responseStatus),
    isOrganizer: person.organizer === true,
    isSelf: person.self === true,
  };
}

function toOrganizer(organizer: GoogleEventPerson, attendees: readonly GoogleEventPerson[]): EventParticipant {
  const email = organizer.email ? normalizeEmail(organizer.email) : null;
  // Google lists the organizer among attendees when they were invited; that entry carries the RSVP.
  const asAttendee = attendees.find((a) => a.organizer === true || (email !== null && a.email && normalizeEmail(a.email) === email));
  return {
    email,
    name: organizer.displayName?.trim() || asAttendee?.displayName?.trim() || null,
    response: toResponse(asAttendee?.responseStatus),
    isOrganizer: true,
    isSelf: organizer.self === true || asAttendee?.self === true,
  };
}
