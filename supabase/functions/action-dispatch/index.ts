/**
 * POST /functions/v1/action-dispatch — the server action seam (ADR-005). The
 * handler and its contract live in handler.ts; this file is the production wiring.
 */
import { buildRegistry } from "../_shared/connectors.ts";
import { readEnv } from "../_shared/env.ts";
import { logger, serveWith } from "../_shared/http.ts";
import { userRequest } from "../_shared/request.ts";
import { runSyncForUser } from "../_shared/sync.ts";
import { FN, actionDispatchHandler } from "./handler.ts";

const log = logger(FN);

function production() {
  const env = readEnv();
  return actionDispatchHandler({
    userRequest: (req) => userRequest(req, env),
    runSyncForUser: (userId, options) => runSyncForUser(userId, { ...options, env, registry: buildRegistry(env), log }),
    log,
  });
}

Deno.serve(serveWith((req) => production()(req), log));
