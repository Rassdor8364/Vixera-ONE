import type { ConnectorAccountId, DeviceId, DocumentId, UserId } from "../ids.ts";
import type { JsonObject, Timestamped, UserScoped } from "./common.ts";

export const DOCUMENT_SOURCES = ["mail_attachment", "share", "capture", "drop", "praxion", "filesystem", "handoff", "connector"] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

/** Where the bytes of a document can be found. Vixera stores context, not rendering state. */
export type DocumentLocation =
  | { readonly kind: "device_path"; readonly deviceId: DeviceId; readonly path: string }
  | { readonly kind: "storage"; readonly bucket: string; readonly path: string }
  | { readonly kind: "provider"; readonly provider: string; readonly ref: JsonObject }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "none" };

/**
 * Document CONTEXT. Identity, name, source, location, Praxion reference and
 * semantic metadata. Rendering / annotation / page state belongs to Praxion.
 */
export interface Document extends UserScoped, Timestamped {
  readonly id: DocumentId;
  readonly userId: UserId;
  readonly title: string;
  readonly mimeType: string | null;
  readonly source: DocumentSource;
  readonly connectorAccountId: ConnectorAccountId | null;
  /** Provider-side identifiers (message id + attachment id, drive id, ...). */
  readonly sourceRef: JsonObject;
  readonly location: DocumentLocation;
  /** Praxion's own document identifier when Praxion has seen this artifact. */
  readonly praxionDocumentId: string | null;
  readonly sizeBytes: number | null;
  /** Content hash (sha256 hex) when the bytes were available. Used to dedupe. */
  readonly contentHash: string | null;
  readonly metadata: JsonObject;
}
