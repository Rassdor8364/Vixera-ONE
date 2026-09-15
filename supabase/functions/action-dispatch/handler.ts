/**
 * The action-dispatch HTTP handler with its side effects injected (ADR-005):
 * the server action seam, tested in handler_test.ts without a network.
 *
 *   body:     ActionEnvelope  { actionType, idempotencyKey, payload, actorDeviceId? }
 *   response: ActionOutcome   { status, result, error, replayed, actionRequestId }
 *   409 { error: { code: "in_progress" } } while the same key is still running.
 */
import type { UserId } from "@vixera/domain";
import type { SpineStore } from "@vixera/sync";
import { dispatchAction, parseEnvelope } from "../_shared/actions.ts";
import { json, readJsonBody, route, serveWith, type Handler, type Logger } from "../_shared/http.ts";
import type { BudgetedSyncReport, SyncRunOptions } from "../_shared/sync.ts";

export const FN = "action-dispatch";
/** Sync triggered from an action gets a shorter budget than the scheduled run: the client is waiting. */
export const SYNC_NOW_BUDGET_MS = 60_000;

export interface ActionDispatchDeps {
  /** Verifies the Bearer token and binds a store to that user; throws HttpError 401 otherwise. */
  readonly userRequest: (req: Request) => Promise<{ readonly userId: UserId; readonly store: SpineStore }>;
  readonly runSyncForUser: (userId: UserId, options: SyncRunOptions) => Promise<BudgetedSyncReport>;
  readonly now?: () => Date;
  readonly log: Logger;
}

export function actionDispatchHandler(deps: ActionDispatchDeps): Handler {
  const now = deps.now ?? (() => new Date());
  return serveWith(
    route(FN, [
      {
        method: "POST",
        path: "/",
        handler: async (req) => {
          const { userId, store } = await deps.userRequest(req);
          const envelope = parseEnvelope(await readJsonBody(req));
          const outcome = await dispatchAction(store, envelope, {
            now,
            actorDeviceId: envelope.actorDeviceId ?? null,
            // A person's Sync now: their own budget, and `force` (the hold is theirs to override) travels through.
            runSync: ({ accountId, force }) => deps.runSyncForUser(userId, { accountId, budgetMs: SYNC_NOW_BUDGET_MS, ...(force ? { force: true } : {}) }),
            log: deps.log,
          });
          return json(req, outcome);
        },
      },
    ]),
    deps.log,
  );
}
