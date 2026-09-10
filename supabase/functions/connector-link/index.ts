/**
 * connector-link — finish OAuth / Plaid links on the server, so provider
 * tokens never reach a device (ADR-003).
 *
 *   POST /   { provider: "google" | "microsoft", step: "start" }
 *              → { authorizationUrl, expiresAt }
 *   GET  /callback?code=&state=      (system browser, redirected by the provider)
 *              → HTML "Connected — return to Vixera One"
 *   POST /   { provider: "plaid", step: "start" }
 *              → { linkToken, hostedLinkUrl, expiration }
 *   POST /   { provider: "plaid", step: "complete", publicToken? | linkToken? }
 *              → { account }
 *   POST /   { provider, step: "disconnect", connectorAccountId }
 *              → { ok: true }
 *
 * The callback carries no Vixera session: identity travels in the signed,
 * expiring state token (state.ts). config.toml therefore sets verify_jwt=false
 * for this function and the POST steps verify the JWT themselves.
 */
import { isUuid, type UserId } from "@vixera/domain";
import { buildRegistry } from "../_shared/connectors.ts";
import { VaultCredentialStore } from "../_shared/credentials.ts";
import { readEnv, type FunctionEnv } from "../_shared/env.ts";
import { HttpError, html, json, logger, readJsonBody, route, serveWith } from "../_shared/http.ts";
import { completeOAuthCallback, completePlaidLink, disconnectAccount, linkResultPage, startOAuthLink, startPlaidLink, type LinkDeps } from "../_shared/link.ts";
import { userRequest } from "../_shared/request.ts";
import { serviceClient, spineForUser } from "../_shared/spine.ts";
import { isLinkProvider, linkStateSecret } from "../_shared/state.ts";

const FN = "connector-link";
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

Deno.serve(
  serveWith(
    route(FN, [
      {
        method: "POST",
        path: "/",
        handler: async (req) => {
          const env = readEnv();
          const { userId } = await userRequest(req, env);
          const body = await readJsonBody(req);
          const provider = body.provider;
          const step = body.step;
          if (provider !== "google" && provider !== "microsoft" && provider !== "plaid") throw new HttpError(400, "bad_request", "provider must be google, microsoft or plaid");
          const deps = await linkDeps(env);

          if (step === "disconnect") {
            const accountId = body.connectorAccountId;
            if (typeof accountId !== "string" || !isUuid(accountId)) throw new HttpError(400, "bad_request", "connectorAccountId must be a uuid");
            return json(req, await disconnectAccount(deps, userId, accountId));
          }
          if (isLinkProvider(provider)) {
            if (step !== "start") throw new HttpError(400, "bad_request", `step must be "start" or "disconnect" for ${provider}`);
            return json(req, await startOAuthLink(deps, userId, provider));
          }
          if (step === "start") return json(req, await startPlaidLink(deps, userId));
          if (step === "complete") {
            const publicToken = typeof body.publicToken === "string" && body.publicToken ? body.publicToken : null;
            const linkToken = typeof body.linkToken === "string" && body.linkToken ? body.linkToken : null;
            return json(req, await completePlaidLink(deps, userId, { publicToken, linkToken }));
          }
          throw new HttpError(400, "bad_request", 'step must be "start", "complete" or "disconnect" for plaid');
        },
      },
      {
        method: "GET",
        path: "/callback",
        handler: async (req) => {
          const env = readEnv();
          const url = new URL(req.url);
          try {
            const deps = await linkDeps(env);
            const { provider } = await completeOAuthCallback(deps, {
              code: url.searchParams.get("code"),
              state: url.searchParams.get("state"),
              error: url.searchParams.get("error"),
            });
            log("link: callback completed", { provider });
            return html(req, linkResultPage(true, "Connected"));
          } catch (err) {
            // Rendered for a human in the system browser: a short reason, never provider payloads or secrets.
            const status = err instanceof HttpError ? err.status : 500;
            const message = err instanceof HttpError ? err.message : "The connection could not be completed";
            log("link: callback failed", { status, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
            return html(req, linkResultPage(false, message), status);
          }
        },
      },
    ]),
    log,
  ),
);
