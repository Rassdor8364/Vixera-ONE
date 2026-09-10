import type { ActionRequestId, DeviceId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, UserScoped } from "./common.ts";

export type ActionRequestStatus = "queued" | "running" | "done" | "failed";

/**
 * Audit + idempotency record for a server-side action (notification actions,
 * One Command mutations). The client submits; the server executes durably.
 */
export interface ActionRequest extends UserScoped {
  readonly id: ActionRequestId;
  readonly userId: UserId;
  readonly actionType: string;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
  readonly status: ActionRequestStatus;
  readonly result: JsonObject | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly actorDeviceId: DeviceId | null;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}
