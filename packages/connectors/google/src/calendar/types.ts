/**
 * Google Calendar API payload shapes as the connector reads them. Provider
 * schema: nothing outside `packages/connectors/google` imports this file.
 */
export interface GoogleCalendarListEntry {
  readonly id: string;
  readonly summary?: string;
  readonly primary?: boolean;
  readonly selected?: boolean;
  readonly accessRole?: "freeBusyReader" | "reader" | "writer" | "owner" | string;
  readonly timeZone?: string;
  readonly deleted?: boolean;
}

export interface GoogleCalendarList {
  readonly items?: readonly GoogleCalendarListEntry[];
  readonly nextPageToken?: string;
  readonly nextSyncToken?: string;
}

export interface GoogleEventDateTime {
  /** All-day: YYYY-MM-DD. */
  readonly date?: string;
  /** Timed: RFC 3339 with offset. */
  readonly dateTime?: string;
  readonly timeZone?: string;
}

export interface GoogleEventPerson {
  readonly email?: string;
  readonly displayName?: string;
  readonly self?: boolean;
  readonly organizer?: boolean;
  readonly optional?: boolean;
  readonly resource?: boolean;
  readonly responseStatus?: "needsAction" | "declined" | "tentative" | "accepted" | string;
}

export interface GoogleEvent {
  readonly id: string;
  readonly status?: "confirmed" | "tentative" | "cancelled" | string;
  readonly htmlLink?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly start?: GoogleEventDateTime;
  readonly end?: GoogleEventDateTime;
  readonly endTimeUnspecified?: boolean;
  readonly organizer?: GoogleEventPerson;
  readonly attendees?: readonly GoogleEventPerson[];
  readonly recurringEventId?: string;
  readonly eventType?: string;
  readonly hangoutLink?: string;
  readonly etag?: string;
  readonly updated?: string;
}

export interface GoogleEventList {
  readonly items?: readonly GoogleEvent[];
  readonly nextPageToken?: string;
  readonly nextSyncToken?: string;
  readonly timeZone?: string;
}
