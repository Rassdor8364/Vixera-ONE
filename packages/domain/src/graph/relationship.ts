import type { RelationshipId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, UserScoped } from "../entities/common.ts";

/**
 * Every entity type that can take part in a relationship. Mirrors the
 * PostgreSQL enum `entity_type`. Keep the two in sync (schema test covers it).
 */
export const ENTITY_TYPES = [
  "person",
  "thread",
  "document",
  "mail_message",
  "money_account",
  "money_transaction",
  "time_event",
  "context_event",
  "conclusion",
  "ingest_item",
  "handoff",
  "device",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Typed relationship kinds. Mirrors PostgreSQL enum `relationship_kind`.
 * Direction matters: `from --kind--> to`.
 *
 *   Eric        RELATES_TO       Invoice #0231
 *   Invoice     BELONGS_TO       Brand thread
 *   Invoice     ORIGINATED_FROM  Mail message
 *   Invoice     RELATES_TO       Bank transaction
 *   Brand       HAS_PERSON       Eric
 *   Brand       HAS_TIME         Client meeting
 */
export const RELATIONSHIP_KINDS = [
  "relates_to",
  "belongs_to",
  "originated_from",
  "has_person",
  "has_time",
  "has_document",
  "has_money",
  "has_mail",
  "replaces",
  "mentions",
  "attached_to",
  "about",
] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export const RELATIONSHIP_SOURCES = ["user", "connector", "rule", "model"] as const;
export type RelationshipSource = (typeof RELATIONSHIP_SOURCES)[number];

export interface EntityRef {
  readonly type: EntityType;
  readonly id: string;
}

export function ref(type: EntityType, id: string): EntityRef {
  return { type, id };
}

export function sameRef(a: EntityRef, b: EntityRef): boolean {
  return a.type === b.type && a.id === b.id;
}

export function refKey(r: EntityRef): string {
  return `${r.type}:${r.id}`;
}

export interface Relationship extends UserScoped {
  readonly id: RelationshipId;
  readonly userId: UserId;
  readonly from: EntityRef;
  readonly kind: RelationshipKind;
  readonly to: EntityRef;
  /** 0..1. User-created edges are 1. */
  readonly confidence: number;
  readonly source: RelationshipSource;
  readonly metadata: JsonObject;
  readonly createdAt: IsoDateTime;
}

/** Input for creating an edge. Id/timestamps are assigned by the store. */
export interface RelationshipInput {
  readonly from: EntityRef;
  readonly kind: RelationshipKind;
  readonly to: EntityRef;
  readonly confidence?: number;
  readonly source?: RelationshipSource;
  readonly metadata?: JsonObject;
}

/** Natural key of an edge: the same edge asserted twice is one edge. */
export function edgeKey(e: Pick<Relationship, "from" | "kind" | "to">): string {
  return `${refKey(e.from)}|${e.kind}|${refKey(e.to)}`;
}

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

export function isRelationshipKind(value: string): value is RelationshipKind {
  return (RELATIONSHIP_KINDS as readonly string[]).includes(value);
}
