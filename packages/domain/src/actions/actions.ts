import type { JsonObject } from "../entities/common.ts";

/**
 * Server-side action contract. A notification action (or a One Command
 * mutation) is submitted by a client and executed by the server. The client
 * does not have to stay alive; the action is idempotent by key and audited
 * in `action_requests`.
 */
export const ACTION_TYPES = [
  "context_event.dismiss",
  "context_event.quiet",
  "context_event.snooze",
  "thread.attach",
  "thread.create",
  "handoff.create",
  "handoff.accept",
  "ingest.submit",
  "connector.sync_now",
  "person.merge",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionPayloads {
  "context_event.dismiss": { contextEventId: string };
  "context_event.quiet": { contextEventId: string };
  "context_event.snooze": { contextEventId: string; until: string };
  "thread.attach": { threadId: string; entityType: string; entityId: string };
  "thread.create": { title: string; kind?: string; attach?: { entityType: string; entityId: string }[] };
  "handoff.create": {
    sourceDeviceId: string;
    targetDeviceId?: string | null;
    focus?: { type: string; id: string } | null;
    threadId?: string | null;
    documentId?: string | null;
    artifactStoragePath?: string | null;
    praxionLocation?: { page: number | null; position: JsonObject | null; selectionText: string | null } | null;
    conclusions?: string[];
    commandHistory?: string[];
  };
  "handoff.accept": { handoffId: string; deviceId: string };
  "ingest.submit": {
    deviceId?: string | null;
    kind: "file" | "image" | "url" | "text";
    source: "share" | "capture" | "drop" | "clipboard" | "command";
    title?: string | null;
    textContent?: string | null;
    url?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    storagePath?: string | null;
    metadata?: JsonObject;
  };
  "connector.sync_now": { connectorAccountId?: string | null };
  "person.merge": { survivorId: string; mergedId: string };
}

export interface ActionEnvelope<T extends ActionType = ActionType> {
  readonly actionType: T;
  /** Client-generated; the same key replayed returns the same result. */
  readonly idempotencyKey: string;
  readonly payload: ActionPayloads[T];
  readonly actorDeviceId?: string | null;
}

export interface ActionOutcome {
  readonly status: "done" | "failed";
  readonly result: JsonObject | null;
  readonly error: string | null;
  /** True when this call was a replay of an already-executed request. */
  readonly replayed: boolean;
  readonly actionRequestId: string;
}

export function isActionType(value: string): value is ActionType {
  return (ACTION_TYPES as readonly string[]).includes(value);
}

/** Deterministic idempotency key for a notification action: one action per (event, type). */
export function notificationIdempotencyKey(actionType: ActionType, subjectId: string, salt = ""): string {
  return `${actionType}:${subjectId}${salt ? `:${salt}` : ""}`;
}
