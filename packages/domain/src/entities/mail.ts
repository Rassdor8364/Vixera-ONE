import type { ConnectorAccountId, MailMessageId, PersonId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, Timestamped, UserScoped } from "./common.ts";

export interface MailAddress {
  readonly email: string;
  readonly name: string | null;
  /** Resolved by the ContextLinker; null until linked. */
  readonly personId?: PersonId | null;
}

export interface MailAttachmentMeta {
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
}

/** A mail message as INPUT TO CONTEXT. Not a mail client. */
/**
 * Which way a message went. `received` arrived for the user; `sent` is the
 * user's own writing — context (who they wrote to, about what) that never
 * needs their attention the way received mail can.
 */
export const MAIL_DIRECTIONS = ["received", "sent"] as const;
export type MailDirection = (typeof MAIL_DIRECTIONS)[number];

export interface MailMessage extends UserScoped, Timestamped {
  readonly id: MailMessageId;
  readonly userId: UserId;
  readonly connectorAccountId: ConnectorAccountId;
  readonly externalId: string;
  readonly externalThreadId: string | null;
  readonly subject: string | null;
  readonly snippet: string | null;
  /** Plain-text body, truncated to what context needs. */
  readonly bodyText: string | null;
  readonly direction: MailDirection;
  readonly from: MailAddress | null;
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
  readonly sentAt: IsoDateTime | null;
  readonly receivedAt: IsoDateTime;
  readonly isUnread: boolean;
  readonly attachments: readonly MailAttachmentMeta[];
  readonly labels: readonly string[];
  readonly metadata: JsonObject;
}
