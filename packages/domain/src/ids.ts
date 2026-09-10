/**
 * Branded identifiers. Every persisted row in Vixera is keyed by a UUID and
 * scoped by a UserId. The brand prevents accidentally passing a ThreadId
 * where a PersonId is expected.
 */

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type UserId = Brand<string, "UserId">;
export type DeviceId = Brand<string, "DeviceId">;
export type ConnectorAccountId = Brand<string, "ConnectorAccountId">;
export type PersonId = Brand<string, "PersonId">;
export type ThreadId = Brand<string, "ThreadId">;
export type DocumentId = Brand<string, "DocumentId">;
export type MailMessageId = Brand<string, "MailMessageId">;
export type MoneyAccountId = Brand<string, "MoneyAccountId">;
export type MoneyTransactionId = Brand<string, "MoneyTransactionId">;
export type TimeEventId = Brand<string, "TimeEventId">;
export type ContextEventId = Brand<string, "ContextEventId">;
export type ConclusionId = Brand<string, "ConclusionId">;
export type HandoffId = Brand<string, "HandoffId">;
export type IngestItemId = Brand<string, "IngestItemId">;
export type ActionRequestId = Brand<string, "ActionRequestId">;
export type RelationshipId = Brand<string, "RelationshipId">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Generates a v4 UUID using the platform's crypto (Node 19+, browsers, Deno). */
export function newId<T extends string = string>(): T {
  return globalThis.crypto.randomUUID() as unknown as T;
}

export function asId<T extends string>(value: string): T {
  if (!isUuid(value)) throw new Error(`Invalid id: ${value}`);
  return value as unknown as T;
}
