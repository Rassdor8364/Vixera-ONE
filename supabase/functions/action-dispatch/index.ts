/**
 * POST /functions/v1/action-dispatch — the server action seam (ADR-005).
 *
 *   body:     ActionEnvelope  { actionType, idempotencyKey, payload, actorDeviceId? }
 *   response: ActionOutcome   { status, result, error, replayed, actionRequestId }
 *   409 { error: { code: "in_progress" } } while the same key is still running.
 */
import { buildRegistry } from "../_shared/connectors.ts";
import { dispatchAction, parseEnvelope } from "../_shared/actions.ts";
import { readEnv } from "../_shared/env.ts";
import { json, logger, readJsonBody, route, serveWith } from "../_shared/http.ts";
import { userRequest } from "../_shared/request.ts";
import { runSyncForUser } from "../_shared/sync.ts";

const FN = "action-dispatch";
const log = logger(FN);
/** Sync triggered from an action gets a shorter budget than the scheduled run: the client is waiting. */
const SYNC_NOW_BUDGET_MS = 60_000;

Deno.serve(
  serveWith(
    route(FN, [
      {
        method: "POST",
        path: "/",
        handler: async (req) => {
          const env = readEnv();
          const { userId, store } = await userRequest(req, env);
          const envelope = parseEnvelope(await readJsonBody(req));
          const outcome = await dispatchAction(store, envelope, {
            now: () => new Date(),
            actorDeviceId: envelope.actorDeviceId ?? null,
            runSync: ({ accountId }) => runSyncForUser(userId, { env, registry: buildRegistry(env), accountId, budgetMs: SYNC_NOW_BUDGET_MS, log }),
            log,
          });
          return json(req, outcome);
        },
      },
    ]),
    log,
  ),
);
