/**
 * connector-link — finish OAuth / Plaid links on the server, so provider
 * tokens never reach a device (ADR-003). The handler and its contract live in
 * handler.ts; this file is the production wiring.
 */
import type { UserId } from "@vixera/domain";
import { buildRegistry } from "../_shared/connectors.ts";
import { VaultCredentialStore } from "../_shared/credentials.ts";
import { readEnv, type FunctionEnv } from "../_shared/env.ts";
import { logger, serveWith } from "../_shared/http.ts";
import type { LinkDeps } from "../_shared/link.ts";
import { userRequest } from "../_shared/request.ts";
import { serviceClient, spineForUser } from "../_shared/spine.ts";
import { linkStateSecret } from "../_shared/state.ts";
import { FN, connectorLinkHandler } from "./handler.ts";

const log = logger(FN);

async function linkDeps(env: FunctionEnv): Promise<LinkDeps> {
  const client = serviceClient(env);
  return {
    env,
    registry: buildRegistry(env),
    stateSecret: await linkStateSecret(env),
    storeFor: (userId: UserId) => spineForUser(client, userId),
    credentialsFor: (userId: UserId) => new VaultCredentialStore(client, userId),
    disconnect: async (_userId, accountId) => {
      const { error } = await client.rpc("vx_connector_account_disconnect", { p_account_id: accountId });
      if (error) throw new Error(`vx_connector_account_disconnect failed: ${error.message}`);
    },
    fetch: globalThis.fetch,
    now: () => new Date(),
    log,
  };
}

function production() {
  const env = readEnv();
  return connectorLinkHandler({ userRequest: (req) => userRequest(req, env), linkDeps: () => linkDeps(env), log });
}

Deno.serve(serveWith((req) => production()(req), log));
