/**
 * connector-sync — runs the SyncEngine server-side (ADR-003).
 *
 *   POST /  Authorization: Bearer <user>   body { connectorAccountId? }
 *           → { report: SyncReport } for that user (one account or all)
 *   POST /  X-Vixera-Sync-Secret: <VIXERA_SYNC_SECRET>   (pg_cron, every 10 min)
 *           → { users, outcomes, errors, skippedForBudget } across every user
 *             with an active connector account; one engine per user, service
 *             role, shared wall-clock budget so the invocation finishes in time.
 */
import { isUuid } from "@vixera/domain";
import { readEnv } from "../_shared/env.ts";
import { HttpError, json, logger, readJsonBody, route, secretsEqual, serveWith } from "../_shared/http.ts";
import { buildRegistry } from "../_shared/connectors.ts";
import { userRequest } from "../_shared/request.ts";
import { listActiveConnectorUserIds, serviceClient } from "../_shared/spine.ts";
import { DEFAULT_SYNC_BUDGET_MS, runSyncForUser } from "../_shared/sync.ts";

const FN = "connector-sync";
const log = logger(FN);

Deno.serve(
  serveWith(
    route(FN, [
      {
        method: "POST",
        path: "/",
        handler: async (req) => {
          const env = readEnv();
          const registry = buildRegistry(env);
          const presented = req.headers.get("x-vixera-sync-secret");

          if (presented !== null) {
            if (!secretsEqual(presented, env.syncSecret)) throw new HttpError(401, "unauthorized", "Invalid sync secret");
            const startedAt = Date.now();
            const deadlineAt = startedAt + DEFAULT_SYNC_BUDGET_MS;
            const userIds = await listActiveConnectorUserIds(serviceClient(env));
            let outcomes = 0;
            let errors = 0;
            let skippedForBudget = 0;
            let usersSkipped = 0;
            for (const userId of userIds) {
              if (Date.now() >= deadlineAt) {
                usersSkipped++;
                continue;
              }
              try {
                const report = await runSyncForUser(userId, { env, registry, deadlineAt, log });
                outcomes += report.outcomes.length;
                errors += report.errors;
                skippedForBudget += report.skippedForBudget;
              } catch (err) {
                errors++;
                log("scheduled sync: user run failed", { error: err instanceof Error ? err.message : String(err) });
              }
            }
            const summary = { users: userIds.length, outcomes, errors, skippedForBudget, usersSkipped, durationMs: Date.now() - startedAt };
            log("scheduled sync: finished", summary);
            return json(req, summary);
          }

          const { userId } = await userRequest(req, env);
          const body = await readJsonBody(req);
          const accountId = body.connectorAccountId;
          if (accountId !== undefined && accountId !== null && (typeof accountId !== "string" || !isUuid(accountId))) throw new HttpError(400, "bad_request", "connectorAccountId must be a uuid");
          let report;
          try {
            report = await runSyncForUser(userId, { env, registry, accountId: typeof accountId === "string" ? accountId : null, log });
          } catch (err) {
            if (err instanceof Error && err.name === "SyncAccountNotFoundError") throw new HttpError(404, "not_found", err.message);
            throw err;
          }
          return json(req, { report });
        },
      },
    ]),
    log,
  ),
);
