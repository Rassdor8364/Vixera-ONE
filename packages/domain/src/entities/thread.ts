import type { ThreadId, UserId } from "../ids.ts";
import type { JsonObject, Timestamped, UserScoped } from "./common.ts";

export const THREAD_STATUSES = ["active", "quiet", "archived"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

/**
 * A Thread is something happening in the user's life or work: a brand project,
 * a legal matter, a purchase, a trip. It gathers people, documents, mail,
 * calendar events, money events and conclusions through relationships.
 */
export interface Thread extends UserScoped, Timestamped {
  readonly id: ThreadId;
  readonly userId: UserId;
  readonly title: string;
  /** Free-form kind label (project, legal, purchase, trip, ...). Not an enum on purpose. */
  readonly kind: string | null;
  readonly status: ThreadStatus;
  readonly summary: string | null;
  readonly metadata: JsonObject;
}
