import type { ConnectorAccountId, ContextEventId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, UserScoped } from "./common.ts";
import type { EntityRef } from "../graph/relationship.ts";

export const ATTENTIONS = ["needs_attention", "quiet", "dismissed"] as const;
export type Attention = (typeof ATTENTIONS)[number];

/**
 * Something that happened in the user's context: a message arrived, an event
 * moved, a transaction posted, a document was ingested, a handoff was created.
 * Context events are what NOW and Quiet are derived from.
 */
export interface ContextEvent extends UserScoped {
  readonly id: ContextEventId;
  readonly userId: UserId;
  /** Dotted kind: `mail.received`, `time.event.changed`, `money.transaction.posted`, ... */
  readonly kind: string;
  /** The entity this event is about. */
  readonly subject: EntityRef;
  readonly title: string;
  readonly summary: string | null;
  readonly occurredAt: IsoDateTime;
  /** 0–100, deterministic rules in Phase 1. */
  readonly importance: number;
  /** When the thing this event refers to becomes due / starts / expires. */
  readonly dueAt: IsoDateTime | null;
  readonly attention: Attention;
  readonly connectorAccountId: ConnectorAccountId | null;
  /** Stable key so re-running a sync does not duplicate the event. */
  readonly dedupeKey: string;
  readonly metadata: JsonObject;
  readonly createdAt: IsoDateTime;
}
