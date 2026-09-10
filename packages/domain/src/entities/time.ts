import type { ConnectorAccountId, PersonId, TimeEventId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, Timestamped, UserScoped } from "./common.ts";

export type ParticipantResponse = "accepted" | "declined" | "tentative" | "needs_action" | "unknown";

export interface EventParticipant {
  readonly email: string | null;
  readonly name: string | null;
  readonly response: ParticipantResponse;
  readonly isOrganizer: boolean;
  readonly isSelf: boolean;
  readonly personId?: PersonId | null;
}

export const TIME_EVENT_STATUSES = ["confirmed", "tentative", "cancelled"] as const;
export type TimeEventStatus = (typeof TIME_EVENT_STATUSES)[number];

/** A calendar event, normalized. Calendar is INPUT TO CONTEXT. */
export interface TimeEvent extends UserScoped, Timestamped {
  readonly id: TimeEventId;
  readonly userId: UserId;
  readonly connectorAccountId: ConnectorAccountId;
  readonly externalCalendarId: string;
  readonly externalId: string;
  readonly title: string;
  readonly description: string | null;
  readonly startsAt: IsoDateTime;
  readonly endsAt: IsoDateTime;
  readonly allDay: boolean;
  readonly timezone: string | null;
  readonly location: string | null;
  readonly status: TimeEventStatus;
  readonly organizer: EventParticipant | null;
  readonly participants: readonly EventParticipant[];
  readonly externalLink: string | null;
  readonly metadata: JsonObject;
}
