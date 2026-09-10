import type { UserId } from "../ids.ts";
import type { IsoDateTime } from "./common.ts";

export interface User {
  readonly id: UserId;
  readonly displayName: string | null;
  readonly createdAt: IsoDateTime;
}
