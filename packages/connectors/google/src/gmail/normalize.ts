/**
 * Gmail message → `NormalizedMailMessage`.
 *
 * This is the only place that understands Gmail's MIME tree encoding. Output
 * is the provider-neutral domain shape; addresses go through the domain's
 * `parseAddress`/`parseAddressList` so people resolve the same way for every
 * connector. Pure and synchronous: no I/O, no clock.
 */
import { ConnectorError, parseAddressList, type JsonObject, type MailAttachmentMeta, type NormalizedMailMessage } from "@vixera/domain";
import type { GmailHeader, GmailMessage, GmailPart } from "./types.ts";

export const GMAIL_UNREAD_LABEL = "UNREAD";
export const MAX_BODY_CHARS = 20_000;

export function normalizeGmailMessage(raw: GmailMessage): NormalizedMailMessage {
  if (!raw || typeof raw.id !== "string" || !raw.id) {
    throw new ConnectorError("invalid_response", "Gmail message without id", false);
  }
  const headers = raw.payload?.headers ?? [];
  const from = parseAddressList(header(headers, "From"))[0] ?? null;
  const to = parseAddressList(header(headers, "To"));
  const cc = parseAddressList(header(headers, "Cc"));
  const subject = header(headers, "Subject")?.trim() || null;
  const sentAt = parseRfc2822Date(header(headers, "Date"));
  const receivedAt = parseInternalDate(raw.internalDate) ?? sentAt;
  if (!receivedAt) {
    throw new ConnectorError("invalid_response", `Gmail message ${raw.id} has no usable date`, false);
  }
  const labels = raw.labelIds ?? [];
  const body = extractBody(raw.payload);
  const attachments = collectAttachments(raw.payload);

  const metadata: JsonObject = {};
  if (raw.historyId) metadata.gmailHistoryId = raw.historyId;
  if (typeof raw.sizeEstimate === "number") metadata.sizeEstimate = raw.sizeEstimate;
  const messageId = header(headers, "Message-ID")?.trim();
  if (messageId) metadata.rfcMessageId = messageId;

  return {
    externalId: raw.id,
    externalThreadId: raw.threadId ?? null,
    subject,
    snippet: raw.snippet ? decodeEntities(raw.snippet).trim() || null : null,
    bodyText: body,
    from,
    to,
    cc,
    sentAt,
    receivedAt,
    isUnread: labels.includes(GMAIL_UNREAD_LABEL),
    attachments,
    labels: [...labels],
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Headers and dates
// ---------------------------------------------------------------------------
function header(headers: readonly GmailHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

function parseInternalDate(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

/** RFC 2822 `Date:` header → ISO, or null when unparsable. Trailing "(CEST)" comments are dropped. */
export function parseRfc2822Date(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// ---------------------------------------------------------------------------
// MIME tree
// ---------------------------------------------------------------------------
function walk(part: GmailPart | undefined, visit: (p: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit);
}

function isAttachment(part: GmailPart): boolean {
  return typeof part.filename === "string" && part.filename.length > 0;
}

function extractBody(payload: GmailPart | undefined): string | null {
  const found: { plain: string | null; html: string | null } = { plain: null, html: null };
  walk(payload, (part) => {
    if (isAttachment(part) || !part.body?.data) return;
    const mime = (part.mimeType ?? "").toLowerCase();
    if (mime === "text/plain" && found.plain === null) found.plain = decodeText(part);
    else if (mime === "text/html" && found.html === null) found.html = decodeText(part);
  });
  const text = found.plain?.trim() ? found.plain : found.html !== null ? htmlToText(found.html) : found.plain;
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_BODY_CHARS ? trimmed.slice(0, MAX_BODY_CHARS) : trimmed;
}

function collectAttachments(payload: GmailPart | undefined): MailAttachmentMeta[] {
  const out: MailAttachmentMeta[] = [];
  walk(payload, (part) => {
    if (!isAttachment(part) || !part.body?.attachmentId) return;
    out.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename as string,
      mimeType: part.mimeType ?? null,
      sizeBytes: typeof part.body.size === "number" ? part.body.size : null,
    });
  });
  return out;
}

function decodeText(part: GmailPart): string {
  const charset = charsetOf(part);
  return decodeBase64Url(part.body?.data ?? "", charset);
}

function charsetOf(part: GmailPart): string {
  const ct = header(part.headers ?? [], "Content-Type") ?? "";
  const m = ct.match(/charset\s*=\s*"?([A-Za-z0-9._-]+)"?/i);
  return m?.[1]?.toLowerCase() ?? "utf-8";
}

/** base64url (RFC 4648 §5, unpadded) → text. Falls back to UTF-8 for unknown charsets. */
export function decodeBase64Url(data: string, charset = "utf-8"): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return "";
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// HTML → text (good enough for context; not a renderer)
// ---------------------------------------------------------------------------
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  euro: "€",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre|table|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/\r/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
