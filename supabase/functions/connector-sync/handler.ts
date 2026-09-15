/**
 * The connector-sync HTTP handler with its side effects injected, so the
 * routing, the two authentication paths and the body rules are tested without
 * a network or a live project (handler_test.ts). index.ts wires production.
 *
 *   POST /  Authorization: Bearer <user>   body { connectorAccountId? }
 *           → { report: SyncReport } for that user (one account or all)
 *   POST /  X-Vixera-Sync-Secret: <VIXERA_SYNC_SECRET>   (pg_cron, every 10 min)
 *           → { users, outcomes, errors, skippedForBudget, usersSkipped, durationMs }
 *             across every user with an active connector account; one engine
 *             per user, shared wall-clock budget so the invocation finishes in time.
 *
 * The secret path never consults a user session, and a wrong secret is refused
 * even when a valid Bearer token comes with it: a request that presents the
 * header is asking for the all-users run, and only pg_cron may have it.
 */
import { isUuid, type UserId } from "@vixera/domain";
import { HttpError, json, readJsonBody, route, secretsEqual, serveWith, type Handler, type Logger } from "../_shared/http.ts";
import { DEFAULT_SYNC_BUDGET_MS, type BudgetedSyncReport, type SyncRunOptions } from "../_shared/sync.ts";

export const FN = "connector-sync";

export interface ConnectorSyncDeps {
  /** VIXERA_SYNC_SECRET; null when unset, which disables the scheduled path. */
  readonly syncSecret: string | null;
  /** Verifies the Bearer token; throws HttpError 401 otherwise (auth.ts). */
  readonly userRequest: (req: Request) => Promise<{ readonly userId: UserId }>;
  readonly listActiveConnectorUserIds: () => Promise<readonly UserId[]>;
  readonly runSyncForUser: (userId: UserId, options: SyncRunOptions) => Promise<BudgetedSyncReport>;
  readonly now?: () => number;
  readonly log: Logger;
}

export function connectorSyncHandler(deps: ConnectorSyncDeps): Handler {
  const now = deps.now ?? (() => Date.now());
  return serveWith(route(FN, [{ method: "POST", path: "/", handler: (req) => post(req, deps, now) }]), deps.log);
}

async function post(req: Request, deps: ConnectorSyncDeps, now: () => number): Promise<Response> {
  const presented = req.headers.get("x-vixera-sync-secret");
  if (presented !== null) {
    if (!secretsEqual(presented, deps.syncSecret)) throw new HttpError(401, "unauthorized", "Invalid sync secret");
    const startedAt = now();
    const deadlineAt = startedAt + DEFAULT_SYNC_BUDGET_MS;
    const userIds = await deps.listActiveConnectorUserIds();
    let outcomes = 0;
    let errors = 0;
    let skippedForBudget = 0;
    let usersSkipped = 0;
    for (const userId of userIds) {
      if (now() >= deadlineAt) {
        usersSkipped++;
        continue;
      }
      try {
        const report = await deps.runSyncForUser(userId, { deadlineAt });
        outcomes += report.outcomes.length;
        errors += report.errors;
        skippedForBudget += report.skippedForBudget;
      } catch (err) {
        errors++;
        deps.log("scheduled sync: user run failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const summary = { users: userIds.length, outcomes, errors, skippedForBudget, usersSkipped, durationMs: now() - startedAt };
    deps.log("scheduled sync: finished", summary);
    return json(req, summary);
  }

  const { userId } = await deps.userRequest(req);
  const body = await readJsonBody(req);
  const accountId = body.connectorAccountId;
  if (accountId !== undefined && accountId !== null && (typeof accountId !== "string" || !isUuid(accountId))) throw new HttpError(400, "bad_request", "connectorAccountId must be a uuid");
  try {
    const report = await deps.runSyncForUser(userId, { accountId: typeof accountId === "string" ? accountId : null });
    return json(req, { report });
  } catch (err) {
    if (err instanceof Error && err.name === "SyncAccountNotFoundError") throw new HttpError(404, "not_found", err.message);
    throw err;
  }
}
