/**
 * The server action seam.
 *
 * Every durable mutation of context state the Field triggers (notification
 * actions, One Command mutations, ingestion, handoff) is an `ActionEnvelope`
 * POSTed to the `action-dispatch` Edge Function with an idempotency key. The
 * function persists an `action_requests` row, executes the handler and
 * returns an `ActionOutcome`; the Field then refreshes. Replaying the same
 * key returns the stored outcome (`replayed: true`) and never re-executes.
 *
 * Keys: notification-style actions (one per subject and type) derive their
 * key with `notificationIdempotencyKey`; user-initiated actions use `newId()`.
 */
import {
  newId,
  notificationIdempotencyKey,
  type ActionEnvelope,
  type ActionOutcome,
  type ActionPayloads,
  type ActionType,
} from "@vixera/domain";
import { FunctionError, type FunctionsClient } from "./functions.ts";

export type ActionDispatcher = (envelope: ActionEnvelope) => Promise<ActionOutcome>;

/**
 * Actions whose key is derived from the subject: repeating them is a replay,
 * not a second execution. Only TERMINAL transitions belong here. `quiet` does
 * not: Quiet can send an item back with `context_event.attend`, so a second
 * "Later" on the same event is a real second execution, and a subject-derived
 * key would silently replay the first outcome and leave the item in NOW.
 */
const SUBJECT_KEYED: Partial<Record<ActionType, (payload: never) => string>> = {
  "context_event.dismiss": (p: ActionPayloads["context_event.dismiss"]) => p.contextEventId,
  "context_event.snooze": (p: ActionPayloads["context_event.snooze"]) => `${p.contextEventId}:${p.until}`,
  "handoff.accept": (p: ActionPayloads["handoff.accept"]) => `${p.handoffId}:${p.deviceId}`,
};

/** Derives the idempotency key for an action: subject-keyed for notification-style actions, fresh otherwise. */
export function idempotencyKeyFor<T extends ActionType>(actionType: T, payload: ActionPayloads[T]): string {
  const derive = SUBJECT_KEYED[actionType] as ((p: ActionPayloads[T]) => string) | undefined;
  return derive ? notificationIdempotencyKey(actionType, derive(payload)) : newId();
}

export function buildEnvelope<T extends ActionType>(
  actionType: T,
  payload: ActionPayloads[T],
  options: { readonly actorDeviceId?: string | null; readonly idempotencyKey?: string } = {},
): ActionEnvelope<T> {
  return {
    actionType,
    idempotencyKey: options.idempotencyKey ?? idempotencyKeyFor(actionType, payload),
    payload,
    actorDeviceId: options.actorDeviceId ?? null,
  };
}

export class ActionFailedError extends Error {
  constructor(
    readonly envelope: ActionEnvelope,
    readonly outcome: ActionOutcome,
  ) {
    super(outcome.error ?? `${envelope.actionType} failed`);
    this.name = "ActionFailedError";
  }
}

export class ActionInProgressError extends Error {
  constructor(readonly envelope: ActionEnvelope) {
    super(`${envelope.actionType} is still running`);
    this.name = "ActionInProgressError";
  }
}

/** Production dispatcher: POST /functions/v1/action-dispatch. */
export function createHttpActionDispatcher(functions: FunctionsClient): ActionDispatcher {
  return async (envelope) => {
    try {
      return await functions.call<ActionOutcome>("action-dispatch", envelope);
    } catch (error) {
      if (error instanceof FunctionError && error.code === "in_progress") throw new ActionInProgressError(envelope);
      throw error;
    }
  };
}

/** Dispatches and throws `ActionFailedError` when the server reports `status: "failed"`. */
export async function dispatchOrThrow(dispatch: ActionDispatcher, envelope: ActionEnvelope): Promise<ActionOutcome> {
  const outcome = await dispatch(envelope);
  if (outcome.status === "failed") throw new ActionFailedError(envelope, outcome);
  return outcome;
}
