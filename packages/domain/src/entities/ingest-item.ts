import type { DeviceId, DocumentId, IngestItemId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, UserScoped } from "./common.ts";

export const INGEST_KINDS = ["file", "image", "url", "text"] as const;
export type IngestKind = (typeof INGEST_KINDS)[number];
export const INGEST_SOURCES = ["share", "capture", "drop", "clipboard", "command"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];
export const INGEST_STATUSES = ["received", "processed", "failed"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/**
 * An object the user explicitly handed to Vixera (share sheet, capture, drop).
 * Enters ONE normalized pipeline regardless of which surface produced it.
 */
export interface IngestItem extends UserScoped {
  readonly id: IngestItemId;
  readonly userId: UserId;
  readonly deviceId: DeviceId | null;
  readonly kind: IngestKind;
  readonly source: IngestSource;
  readonly title: string | null;
  readonly textContent: string | null;
  readonly url: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  /** Supabase Storage path when bytes were uploaded. */
  readonly storagePath: string | null;
  readonly status: IngestStatus;
  readonly documentId: DocumentId | null;
  readonly error: string | null;
  readonly metadata: JsonObject;
  readonly createdAt: IsoDateTime;
  readonly processedAt: IsoDateTime | null;
}
