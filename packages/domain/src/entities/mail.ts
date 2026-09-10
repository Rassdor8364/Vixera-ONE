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
