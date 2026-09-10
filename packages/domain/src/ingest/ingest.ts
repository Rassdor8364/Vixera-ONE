import type { JsonObject } from "../entities/common.ts";
import type { IngestKind, IngestSource } from "../entities/ingest-item.ts";
import type { DocumentSource } from "../entities/document.ts";

/**
 * Raw input from any surface (Android share sheet, Windows drop, capture).
 * `normalizeIngestInput` turns it into one shape before it enters the spine.
 */
export interface RawIngestInput {
  readonly source: IngestSource;
  readonly deviceId?: string | null;
  readonly title?: string | null;
  readonly text?: string | null;
  readonly url?: string | null;
  readonly mimeType?: string | null;
  readonly filename?: string | null;
  readonly sizeBytes?: number | null;
  readonly storagePath?: string | null;
  readonly metadata?: JsonObject;
}

export interface NormalizedIngestInput {
  readonly kind: IngestKind;
  readonly source: IngestSource;
  readonly deviceId: string | null;
  readonly title: string | null;
  readonly textContent: string | null;
  readonly url: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly storagePath: string | null;
  /** Whether a Document row should be created (files, images, URLs). */
  readonly createsDocument: boolean;
  readonly documentSource: DocumentSource;
  readonly metadata: JsonObject;
}

const URL_RE = /^(https?:\/\/)[^\s]+$/i;

export function detectIngestKind(input: RawIngestInput): IngestKind {
  if (input.storagePath || input.filename || (input.mimeType && !input.mimeType.startsWith("text/"))) {
    return input.mimeType?.startsWith("image/") ? "image" : "file";
  }
  if (input.url && URL_RE.test(input.url.trim())) return "url";
  const text = input.text?.trim() ?? "";
  if (text && URL_RE.test(text)) return "url";
  return "text";
}

export function normalizeIngestInput(input: RawIngestInput): NormalizedIngestInput {
  const kind = detectIngestKind(input);
  const text = input.text?.trim() || null;
  const url = kind === "url" ? (input.url?.trim() || text) : (input.url?.trim() || null);
  const title =
    input.title?.trim() ||
    input.filename?.trim() ||
    (kind === "url" && url ? safeHost(url) : null) ||
    (text ? text.slice(0, 80) : null);
  const documentSource: DocumentSource = input.source === "share" ? "share" : input.source === "drop" ? "drop" : "capture";
  return {
    kind,
    source: input.source,
    deviceId: input.deviceId ?? null,
    title,
    textContent: kind === "url" ? null : text,
    url: kind === "url" ? url : null,
    mimeType: input.mimeType ?? (kind === "text" ? "text/plain" : kind === "url" ? "text/uri-list" : null),
    sizeBytes: input.sizeBytes ?? (text ? new TextEncoder().encode(text).length : null),
    storagePath: input.storagePath ?? null,
    createsDocument: kind !== "text",
    documentSource,
    metadata: input.metadata ?? {},
  };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
