import type { DeviceId, UserId } from "../ids.ts";
import type { IsoDateTime, Platform, UserScoped } from "./common.ts";

/** A device where Vixera One is installed. Used for handoff and ingestion provenance. */
export interface Device extends UserScoped {
  readonly id: DeviceId;
  readonly userId: UserId;
  readonly platform: Platform;
  readonly name: string;
  /** Whether Praxion was detected on this device at last check. */
  readonly praxionAvailable: boolean;
  readonly lastSeenAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
}
