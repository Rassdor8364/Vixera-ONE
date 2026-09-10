/**
 * Microsoft Graph message → `NormalizedMailMessage`. Pure and synchronous.
 *
 *   emailAddress {name,address} → NormalizedAddress with a normalized email
 *   body.content                → plain text (HTML stripped when contentType is html)
 *   isRead                      → isUnread
 *   categories                  → labels
 *   receivedDateTime            → receivedAt (sentDateTime is the fallback)
 *   conversationId              → externalThreadId
 *   lastModifiedDateTime        → metadata.lastModifiedDateTime
 *
 * Attachment metadata is fetched separately by the sync source and passed in;
 * only non-inline file attachments are kept.
 */
import {
  ConnectorError,
  normalizeEmail,
  type JsonObject,
  type MailAttachmentMeta,
  type NormalizedAddress,
  type NormalizedMailMessage,
} from "@vixera/domain";
import { htmlToText } from "../html.ts";
import type { GraphAttachment, GraphMessage, GraphRecipient } from "./types.ts";

/** Body text kept for context; long newsletters and quoted threads are cut here. */
export const MAX_BODY_CHARS = 20_000;
const FILE_ATTACHMENT_TYPE = "#microsoft.graph.fileAttachment";

export function normalizeGraphMessage(raw: GraphMessage, attachments: readonly GraphAttachment[] = []): NormalizedMailMessage {
  if (!raw || typeof raw.id !== "string" || !raw.id) {
    throw new ConnectorError("invalid_response", "Microsoft Graph message without id", false);
  }
  const receivedAt = toIsoOrNull(raw.receivedDateTime) ?? toIsoOrNull(raw.sentDateTime);
  if (!receivedAt) throw new ConnectorError("invalid_response", `Microsoft Graph message ${raw.id} has no receivedDateTime`, false);

  const metadata: JsonObject = {};
  if (raw.lastModifiedDateTime) metadata.lastModifiedDateTime = raw.lastModifiedDateTime;
  if (raw.webLink) metadata.webLink = raw.webLink;
  if (raw.hasAttachments === true) metadata.hasAttachments = true;

  return {
    externalId: raw.id,
    externalThreadId: raw.conversationId ?? null,
    subject: raw.subject?.trim() || null,
    snippet: raw.bodyPreview?.trim() || null,
    bodyText: extractBody(raw),
    from: toAddress(raw.from),
    to: toAddresses(raw.toRecipients),
    cc: toAddresses(raw.ccRecipients),
    sentAt: toIsoOrNull(raw.sentDateTime),
    receivedAt,
    isUnread: raw.isRead !== true,
    attachments: normalizeAttachments(attachments),
    labels: (raw.categories ?? []).map((c) => c.trim()).filter(Boolean),
    metadata,
  };
}

/** Keeps non-inline file attachments; item/reference attachments are not documents Vixera can locate. */
export function normalizeAttachments(attachments: readonly GraphAttachment[]): MailAttachmentMeta[] {
  return attachments
    .filter((a) => a && typeof a.id === "string" && a.id && a.isInline !== true)
    .filter((a) => !a["@odata.type"] || a["@odata.type"] === FILE_ATTACHMENT_TYPE)
    .map((a) => ({
      attachmentId: a.id,
      filename: a.name?.trim() || "attachment",
      mimeType: a.contentType?.trim() || null,
      sizeBytes: typeof a.size === "number" && Number.isFinite(a.size) ? a.size : null,
    }));
}

export function toAddress(recipient: GraphRecipient | null | undefined): NormalizedAddress | null {
  const raw = recipient?.emailAddress?.address;
  if (!raw) return null;
  const email = normalizeEmail(raw);
  if (!email) return null;
  const name = recipient?.emailAddress?.name?.trim();
  // Outlook often repeats the address as the display name; that is not a name.
  return { email, name: name && name.toLowerCase() !== email ? name : null };
}

function toAddresses(recipients: readonly GraphRecipient[] | null | undefined): NormalizedAddress[] {
  return (recipients ?? []).map(toAddress).filter((a): a is NormalizedAddress => a !== null);
}

function extractBody(raw: GraphMessage): string | null {
  const content = raw.body?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  const text = raw.body?.contentType?.toLowerCase() === "html" ? htmlToText(content) : content.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
