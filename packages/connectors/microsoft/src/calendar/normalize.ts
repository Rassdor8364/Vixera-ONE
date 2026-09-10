/**
 * Microsoft Graph event (calendarView) → `NormalizedTimeEvent`. Pure and
 * synchronous.
 *
 *   id                        → externalId; externalCalendarId is "primary"
 *                               (calendarView reads the default calendar)
 *   subject / bodyPreview     → title / description
 *   start / end               → UTC ISO (see "Time zones" below); allDay is the
 *                               civil date as UTC midnight (nearest midnight of the
 *                               zone-converted wall time), end exclusive
 *   showAs / isCancelled      → status (cancelled > tentative > confirmed)
 *   organizer.emailAddress    → organizer (RSVP taken from the attendee list)
 *   attendees[].status        → accepted, declined, tentativelyAccepted → tentative,
 *                               none / notResponded → needs_action, organizer → accepted
 *   isSelf                    → attendee address equals the account address
 *   webLink                   → externalLink
 *
 * Time zones. The sync source asks Graph for UTC (`Prefer: outlook.timezone="UTC"`),
 * so `timeZone` is normally "UTC" and the wall time is simply stamped with `Z`.
 * If Graph answers in another zone anyway, the connector converts only when the
 * name is an IANA zone `Intl.DateTimeFormat` understands (offset computed from
 * `formatToParts`, one DST correction pass). Windows zone names such as
 * "Pacific Standard Time" are NOT mapped to IANA (no table is shipped): the wall
 * time is then taken as UTC and `metadata.timeZoneUnresolved` is set so the
 * limitation is visible in the data instead of silently wrong.
 * `timezone` on the normalized event carries `originalStartTimeZone` (the zone
 * the event was created in, Windows or IANA name, verbatim) when present.
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
import type { GraphAttendee, GraphDateTimeTimeZone, GraphEvent } from "./types.ts";

export const PRIMARY_CALENDAR_ID = "primary";
export const UNTITLED_EVENT = "(no title)";

export interface NormalizeEventOptions {
  /** The linked account's address; attendees with this address are `isSelf`. */
  readonly selfAddress: string | null;
}

export function normalizeGraphEvent(raw: GraphEvent, options: NormalizeEventOptions): NormalizedTimeEvent {
  if (!raw || typeof raw.id !== "string" || !raw.id) {
    throw new ConnectorError("invalid_response", "Microsoft Graph event without id", false);
  }
  const allDay = raw.isAllDay === true;
  const start = toInstant(raw.start, allDay);
  if (!start) throw new ConnectorError("invalid_response", `Microsoft Graph event ${raw.id} has no start`, false);
  const end = toInstant(raw.end, allDay) ?? start;
  const self = options.selfAddress ? normalizeEmail(options.selfAddress) : null;
  const attendees = (raw.attendees ?? []).filter((a) => a && a.type !== "resource");
  const participants = attendees.map((a) => toParticipant(a, self, raw));
  const organizer = toOrganizer(raw, participants, self);

  const metadata: JsonObject = {};
  if (raw.lastModifiedDateTime) metadata.lastModifiedDateTime = raw.lastModifiedDateTime;
  if (raw.type) metadata.type = raw.type;
  if (raw.seriesMasterId) metadata.seriesMasterId = raw.seriesMasterId;
  if (raw.showAs) metadata.showAs = raw.showAs;
  if (raw.onlineMeetingUrl) metadata.onlineMeetingUrl = raw.onlineMeetingUrl;
  if (start.unresolvedZone || end.unresolvedZone) metadata.timeZoneUnresolved = true;

  return {
    externalCalendarId: PRIMARY_CALENDAR_ID,
    externalId: raw.id,
    title: raw.subject?.trim() || UNTITLED_EVENT,
    description: raw.bodyPreview?.trim() || null,
    startsAt: start.iso,
    endsAt: end.iso,
    allDay,
    timezone: raw.originalStartTimeZone?.trim() || raw.start?.timeZone?.trim() || null,
    location: raw.location?.displayName?.trim() || null,
    status: toStatus(raw),
    organizer,
    participants,
    externalLink: raw.webLink?.trim() || null,
    metadata,
  };
}

export function toStatus(raw: Pick<GraphEvent, "isCancelled" | "showAs">): TimeEventStatus {
  if (raw.isCancelled === true) return "cancelled";
  if (raw.showAs === "tentative") return "tentative";
  return "confirmed";
}

export function toResponse(response: string | null | undefined): ParticipantResponse {
  switch (response) {
    case "accepted":
    case "organizer":
      return "accepted";
    case "declined":
      return "declined";
    case "tentativelyAccepted":
      return "tentative";
    case "none":
    case "notResponded":
      return "needs_action";
    default:
      return "unknown";
  }
}

function toParticipant(attendee: GraphAttendee, self: string | null, raw: GraphEvent): EventParticipant {
  const email = attendee.emailAddress?.address ? normalizeEmail(attendee.emailAddress.address) : null;
  const isSelf = email !== null && self !== null && email === self;
  // The event-level responseStatus is the account's own RSVP and is the fresher source for self.
  const response = isSelf && raw.responseStatus?.response ? toResponse(raw.responseStatus.response) : toResponse(attendee.status?.response);
  const organizerEmail = raw.organizer?.emailAddress?.address ? normalizeEmail(raw.organizer.emailAddress.address) : null;
  return {
    email,
    name: cleanName(attendee.emailAddress?.name, email),
    response,
    isOrganizer: attendee.status?.response === "organizer" || (email !== null && email === organizerEmail),
    isSelf,
  };
}

function toOrganizer(raw: GraphEvent, participants: readonly EventParticipant[], self: string | null): EventParticipant | null {
  const address = raw.organizer?.emailAddress?.address;
  if (!address) return null;
  const email = normalizeEmail(address);
  const asAttendee = participants.find((p) => p.isOrganizer && (email === null || p.email === email)) ?? participants.find((p) => email !== null && p.email === email);
  return {
    email,
    name: cleanName(raw.organizer?.emailAddress?.name, email) ?? asAttendee?.name ?? null,
    response: asAttendee?.response ?? "accepted",
    isOrganizer: true,
    isSelf: (email !== null && self !== null && email === self) || asAttendee?.isSelf === true,
  };
}

function cleanName(name: string | null | undefined, email: string | null): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return email && trimmed.toLowerCase() === email ? null : trimmed;
}

interface Instant {
  readonly iso: string;
  readonly unresolvedZone: boolean;
}

/** Graph wall time + zone → UTC instant. See the file comment for the zone policy. */
export function toInstant(value: GraphDateTimeTimeZone | null | undefined, allDay: boolean): Instant | null {
  const wall = parseWallTime(value?.dateTime);
  if (!wall) return null;
  if (allDay) {
    // Graph stores all-day events as midnight in their original zone and converts
    // them like any other time when a zone is preferred, so a Stockholm all-day
    // event arrives as 22:00 UTC the day before. Offsets are within ±14h, so the
    // nearest UTC midnight is the intended civil date; a true midnight is unchanged.
    const instant = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
    return { iso: new Date(Math.round(instant / 86_400_000) * 86_400_000).toISOString(), unresolvedZone: false };
  }
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second, wall.millisecond);
  const zone = value?.timeZone?.trim();
  if (!zone || /^(utc|z|gmt)$/i.test(zone) || wall.explicitUtc) return { iso: new Date(asUtc).toISOString(), unresolvedZone: false };
  const offsetMinutes = zoneOffsetMinutes(zone, asUtc);
  if (offsetMinutes === null) return { iso: new Date(asUtc).toISOString(), unresolvedZone: true };
  return { iso: new Date(asUtc - offsetMinutes * 60_000).toISOString(), unresolvedZone: false };
}

interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  /** The string itself carried "Z" or "+00:00". */
  readonly explicitUtc: boolean;
}

function parseWallTime(text: string | null | undefined): WallTime | null {
  if (!text) return null;
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]00:?00)?$/i);
  if (!m) return null;
  const n = (s: string | undefined, fallback = 0): number => (s === undefined ? fallback : Number.parseInt(s, 10));
  const fraction = m[7] ? Number.parseInt(m[7].slice(0, 3).padEnd(3, "0"), 10) : 0;
  const wall: WallTime = {
    year: n(m[1]),
    month: n(m[2]),
    day: n(m[3]),
    hour: n(m[4]),
    minute: n(m[5]),
    second: n(m[6]),
    millisecond: fraction,
    explicitUtc: m[8] !== undefined,
  };
  return Number.isFinite(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)) ? wall : null;
}

/**
 * Offset (minutes east of UTC) of an IANA zone for a wall time, or null when
 * `Intl` does not know the zone (Windows names land here). One correction pass
 * handles DST transitions well enough for calendar context.
 */
export function zoneOffsetMinutes(zone: string, wallAsUtcMs: number): number | null {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return null;
  }
  const offsetAt = (instantMs: number): number => {
    const parts: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(instantMs))) {
      if (part.type !== "literal") parts[part.type] = Number.parseInt(part.value, 10);
    }
    const local = Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
    return Math.round((local - instantMs) / 60_000);
  };
  const first = offsetAt(wallAsUtcMs);
  const second = offsetAt(wallAsUtcMs - first * 60_000);
  return second;
}
