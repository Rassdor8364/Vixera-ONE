import type { DeviceId, DocumentId, HandoffId, ThreadId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, UserScoped } from "./common.ts";
import type { EntityRef } from "../graph/relationship.ts";

export type HandoffState = "pending" | "delivered" | "accepted" | "expired" | "cancelled";

/** Praxion-supplied location inside a document. Opaque to Vixera beyond page. */
export interface PraxionLocation {
  readonly page: number | null;
  readonly position: JsonObject | null;
  readonly selectionText: string | null;
}

/**
 * Vixera-owned cross-device handoff. Carries CONTEXT, not just files:
 * focus object, thread, document reference, artifact payload reference,
 * Praxion location, conclusions.
 */
export interface Handoff extends UserScoped {
  readonly id: HandoffId;
  readonly userId: UserId;
  readonly sourceDeviceId: DeviceId;
  /** null = any of the user's devices may pick it up. */
  readonly targetDeviceId: DeviceId | null;
  readonly state: HandoffState;
  readonly focus: EntityRef | null;
  readonly threadId: ThreadId | null;
  readonly documentId: DocumentId | null;
  /** Supabase Storage path when the artifact bytes had to travel. */
  readonly artifactStoragePath: string | null;
  readonly praxionLocation: PraxionLocation | null;
  readonly conclusions: readonly string[];
  readonly commandHistory: readonly string[];
  readonly createdAt: IsoDateTime;
  readonly deliveredAt: IsoDateTime | null;
  readonly acceptedAt: IsoDateTime | null;
  readonly expiresAt: IsoDateTime | null;
  readonly metadata: JsonObject;
}
