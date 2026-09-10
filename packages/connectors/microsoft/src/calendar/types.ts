/**
 * Microsoft Graph calendar resource shapes, limited to what the connector
 * reads. Provider schema: nothing outside `packages/connectors/microsoft`
 * imports this.
 */
import type { GraphEmailAddress } from "../mail/types.ts";

export interface GraphDateTimeTimeZone {
  /** Wall-clock time without offset, e.g. "2026-09-12T10:00:00.0000000". */
  readonly dateTime?: string | null;
  /** "UTC" when requested with `Prefer: outlook.timezone="UTC"`; otherwise a Windows or IANA zone name. */
  readonly timeZone?: string | null;
}

export interface GraphLocation {
  readonly displayName?: string | null;
  readonly locationType?: string | null;
}

export interface GraphResponseStatus {
  readonly response?: "none" | "organizer" | "tentativelyAccepted" | "accepted" | "declined" | "notResponded" | string | null;
  readonly time?: string | null;
}

export interface GraphAttendee {
  readonly type?: "required" | "optional" | "resource" | string | null;
  readonly status?: GraphResponseStatus | null;
  readonly emailAddress?: GraphEmailAddress | null;
}

export interface GraphOrganizer {
  readonly emailAddress?: GraphEmailAddress | null;
}

export interface GraphEvent {
  readonly id: string;
  readonly subject?: string | null;
  readonly bodyPreview?: string | null;
  readonly start?: GraphDateTimeTimeZone | null;
  readonly end?: GraphDateTimeTimeZone | null;
  readonly isAllDay?: boolean | null;
  readonly isCancelled?: boolean | null;
  readonly showAs?: "free" | "tentative" | "busy" | "oof" | "workingElsewhere" | "unknown" | string | null;
  readonly location?: GraphLocation | null;
  readonly organizer?: GraphOrganizer | null;
  readonly attendees?: readonly GraphAttendee[] | null;
  readonly responseStatus?: GraphResponseStatus | null;
  readonly webLink?: string | null;
  readonly lastModifiedDateTime?: string | null;
  readonly type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster" | string | null;
  readonly seriesMasterId?: string | null;
  readonly originalStartTimeZone?: string | null;
  readonly isOnlineMeeting?: boolean | null;
  readonly onlineMeetingUrl?: string | null;
}

/** Entry of a calendarView delta page: either an event or a tombstone. */
export interface GraphEventDeltaEntry extends Partial<GraphEvent> {
  readonly id: string;
  readonly "@removed"?: { readonly reason?: string };
}
