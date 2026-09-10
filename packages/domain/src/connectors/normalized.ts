import type { IsoDate, IsoDateTime, JsonObject } from "../entities/common.ts";
import type { MailAttachmentMeta } from "../entities/mail.ts";
import type { MoneyAccountType } from "../entities/money.ts";
import type { EventParticipant, TimeEventStatus } from "../entities/time.ts";

/**
 * Normalized objects: what every connector produces, regardless of provider.
 * The sync engine and linker only ever see these. Provider schemas stop at
 * the connector boundary.
 */

export interface NormalizedAddress {
  readonly email: string;
  readonly name: string | null;
}

export interface NormalizedMailMessage {
  readonly externalId: string;
  readonly externalThreadId: string | null;
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly bodyText: string | null;
  readonly from: NormalizedAddress | null;
  readonly to: readonly NormalizedAddress[];
  readonly cc: readonly NormalizedAddress[];
  readonly sentAt: IsoDateTime | null;
  readonly receivedAt: IsoDateTime;
  readonly isUnread: boolean;
  readonly attachments: readonly MailAttachmentMeta[];
  readonly labels: readonly string[];
  readonly metadata?: JsonObject;
}

export interface NormalizedTimeEvent {
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
  readonly metadata?: JsonObject;
}

export interface NormalizedMoneyAccount {
  readonly externalId: string;
  readonly name: string;
  readonly officialName: string | null;
  readonly type: MoneyAccountType;
  readonly currency: string;
  readonly balanceCurrent: string | null;
  readonly balanceAvailable: string | null;
  readonly balanceAsOf: IsoDateTime | null;
  readonly mask: string | null;
  readonly metadata?: JsonObject;
}

export interface NormalizedMoneyTransaction {
  readonly externalId: string;
  /** External id of the money account this transaction belongs to. */
  readonly accountExternalId: string;
  /** Signed decimal string; negative = leaving the account. */
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  readonly merchantName: string | null;
  readonly postedOn: IsoDate;
  readonly authorizedAt: IsoDateTime | null;
  readonly pending: boolean;
  readonly category: readonly string[];
  readonly metadata?: JsonObject;
}

/** A provider-side deletion (message trashed, event cancelled/removed, transaction removed). */
export interface NormalizedDeletion {
  readonly externalId: string;
}

export interface MailSyncBatch {
  readonly messages: readonly NormalizedMailMessage[];
  readonly deleted: readonly NormalizedDeletion[];
}

export interface CalendarSyncBatch {
  readonly events: readonly NormalizedTimeEvent[];
  readonly deleted: readonly NormalizedDeletion[];
}

export interface BankSyncBatch {
  readonly accounts: readonly NormalizedMoneyAccount[];
  readonly transactions: readonly NormalizedMoneyTransaction[];
  readonly deleted: readonly NormalizedDeletion[];
}
