/**
 * Gmail API payload shapes as the connector reads them. Provider schema:
 * nothing outside `packages/connectors/google` imports this file.
 */
export interface GmailHeader {
  readonly name: string;
  readonly value: string;
}

export interface GmailBody {
  readonly attachmentId?: string;
  readonly size?: number;
  /** base64url encoded bytes. */
  readonly data?: string;
}

export interface GmailPart {
  readonly partId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: readonly GmailHeader[];
  readonly body?: GmailBody;
  readonly parts?: readonly GmailPart[];
}

export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly historyId?: string;
  /** Epoch milliseconds as a decimal string. */
  readonly internalDate?: string;
  readonly payload?: GmailPart;
  readonly sizeEstimate?: number;
}

export interface GmailProfile {
  readonly emailAddress?: string;
  readonly messagesTotal?: number;
  readonly historyId?: string;
}

export interface GmailMessageRef {
  readonly id: string;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
}

export interface GmailMessageList {
  readonly messages?: readonly GmailMessageRef[];
  readonly nextPageToken?: string;
  readonly resultSizeEstimate?: number;
}

export interface GmailHistoryRecord {
  readonly id: string;
  readonly messages?: readonly GmailMessageRef[];
  readonly messagesAdded?: readonly { readonly message: GmailMessageRef }[];
  readonly messagesDeleted?: readonly { readonly message: GmailMessageRef }[];
  readonly labelsAdded?: readonly { readonly message: GmailMessageRef; readonly labelIds?: readonly string[] }[];
  readonly labelsRemoved?: readonly { readonly message: GmailMessageRef; readonly labelIds?: readonly string[] }[];
}

export interface GmailHistoryList {
  readonly history?: readonly GmailHistoryRecord[];
  readonly nextPageToken?: string;
  readonly historyId?: string;
}
