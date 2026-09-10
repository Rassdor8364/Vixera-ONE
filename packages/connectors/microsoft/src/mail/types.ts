/**
 * Microsoft Graph mail resource shapes, limited to what the connector reads.
 * Provider schema: nothing outside `packages/connectors/microsoft` imports this.
 */

export interface GraphEmailAddress {
  readonly name?: string | null;
  readonly address?: string | null;
}

export interface GraphRecipient {
  readonly emailAddress?: GraphEmailAddress | null;
}

export interface GraphItemBody {
  readonly contentType?: "text" | "html" | string;
  readonly content?: string | null;
}

export interface GraphMessage {
  readonly id: string;
  readonly conversationId?: string | null;
  readonly subject?: string | null;
  readonly bodyPreview?: string | null;
  readonly body?: GraphItemBody | null;
  readonly from?: GraphRecipient | null;
  readonly toRecipients?: readonly GraphRecipient[] | null;
  readonly ccRecipients?: readonly GraphRecipient[] | null;
  readonly sentDateTime?: string | null;
  readonly receivedDateTime?: string | null;
  readonly isRead?: boolean | null;
  readonly hasAttachments?: boolean | null;
  readonly categories?: readonly string[] | null;
  readonly lastModifiedDateTime?: string | null;
  readonly webLink?: string | null;
}

/** Entry of a delta page: either a full message or a tombstone. */
export interface GraphMessageDeltaEntry extends Partial<GraphMessage> {
  readonly id: string;
  readonly "@removed"?: { readonly reason?: string };
}

export interface GraphDeltaPage<T> {
  readonly value?: readonly T[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.deltaLink"?: string;
}

export interface GraphAttachment {
  readonly "@odata.type"?: string;
  readonly id: string;
  readonly name?: string | null;
  readonly contentType?: string | null;
  readonly size?: number | null;
  readonly isInline?: boolean | null;
}

export interface GraphCollection<T> {
  readonly value?: readonly T[];
  readonly "@odata.nextLink"?: string;
}
