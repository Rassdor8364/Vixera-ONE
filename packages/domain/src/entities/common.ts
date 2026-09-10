import type { UserId } from "../ids.ts";

/** ISO-8601 timestamp string (UTC). Rows store timestamptz; the domain uses strings. */
export type IsoDateTime = string;
/** ISO-8601 date string YYYY-MM-DD. */
export type IsoDate = string;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** Every persisted domain row carries the owning user. No exceptions. */
export interface UserScoped {
  readonly userId: UserId;
}

export interface Timestamped {
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export const PLATFORMS = ["windows", "android", "macos", "ios", "ipados", "web", "server"] as const;
export type Platform = (typeof PLATFORMS)[number];
