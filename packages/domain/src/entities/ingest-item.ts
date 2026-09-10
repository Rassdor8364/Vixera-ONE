import type { DeviceId, DocumentId, IngestItemId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, UserScoped } from "./common.ts";

export type IngestKind = "file" | "image" | "url" | "text";
export type IngestSource = "share" | "capture" | "drop" | "clipboard" | "command";
export type IngestStatus = "received" | "processed" | "failed";

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
