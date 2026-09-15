/**
 * connector-sync — runs the SyncEngine server-side (ADR-003). The handler and
 * its contract live in handler.ts; this file is the production wiring.
 */
import { buildRegistry } from "../_shared/connectors.ts";
import { readEnv } from "../_shared/env.ts";
import { logger, serveWith } from "../_shared/http.ts";
import { userRequest } from "../_shared/request.ts";
import { listActiveConnectorUserIds, serviceClient } from "../_shared/spine.ts";
import { runSyncForUser } from "../_shared/sync.ts";
import { FN, connectorSyncHandler } from "./handler.ts";

const log = logger(FN);

/** Built per request, so a configuration error is that request's 500 (the outer serveWith maps it), never a dead function. */
function production() {
  const env = readEnv();
  const registry = buildRegistry(env);
  return connectorSyncHandler({
    syncSecret: env.syncSecret,
    userRequest: (req) => userRequest(req, env),
    listActiveConnectorUserIds: () => listActiveConnectorUserIds(serviceClient(env)),
    runSyncForUser: (userId, options) => runSyncForUser(userId, { ...options, env, registry, log }),
    log,
  });
}

Deno.serve(serveWith((req) => production()(req), log));
