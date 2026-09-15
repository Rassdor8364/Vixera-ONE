/**
 * The connector-link HTTP handler with its dependencies injected: finishes
 * OAuth / Plaid links on the server, so provider tokens never reach a device
 * (ADR-003). Tested in handler_test.ts without a network.
 *
 *   POST /   { provider: "google" | "microsoft", step: "start" }
 *              → { authorizationUrl, expiresAt }
 *   GET  /callback?code=&state=      (system browser, redirected by the provider)
 *              → HTML "Connected — return to Vixera One"
 *   POST /   { provider: "plaid", step: "start", connectorAccountId? }
 *              → { linkToken, hostedLinkUrl, expiration, connectorAccountId }
 *              (with connectorAccountId: Link update mode on that needs_reauth account)
 *   POST /   { provider: "plaid", step: "complete", publicToken? | linkToken?, connectorAccountId? }
 *              → { account }
 *   POST /   { provider, step: "disconnect", connectorAccountId }
 *              → { ok: true }
 *
 * The callback carries no Vixera session: identity travels in the signed,
 * expiring state token (state.ts). config.toml therefore sets verify_jwt=false
 * for this function and the POST steps verify the JWT themselves.
 */
import { isUuid, type UserId } from "@vixera/domain";
import { HttpError, html, json, readJsonBody, route, serveWith, type Handler, type Logger } from "../_shared/http.ts";
import { completeOAuthCallback, completePlaidLink, disconnectAccount, linkResultPage, startOAuthLink, startPlaidLink, type LinkDeps } from "../_shared/link.ts";
import { isLinkProvider } from "../_shared/state.ts";

export const FN = "connector-link";

export interface ConnectorLinkDeps {
  /** Verifies the Bearer token; throws HttpError 401 otherwise. */
  readonly userRequest: (req: Request) => Promise<{ readonly userId: UserId }>;
  /** The link flow's own dependencies (store, vault, registry, state secret), built per request. */
  readonly linkDeps: () => Promise<LinkDeps>;
  readonly log: Logger;
}

export function connectorLinkHandler(deps: ConnectorLinkDeps): Handler {
  return serveWith(
    route(FN, [
      {
        method: "POST",
        path: "/",
        handler: async (req) => {
          const { userId } = await deps.userRequest(req);
          const body = await readJsonBody(req);
          const provider = body.provider;
          const step = body.step;
          if (provider !== "google" && provider !== "microsoft" && provider !== "plaid") throw new HttpError(400, "bad_request", "provider must be google, microsoft or plaid");
          const link = await deps.linkDeps();

          if (step === "disconnect") {
            const accountId = body.connectorAccountId;
            if (typeof accountId !== "string" || !isUuid(accountId)) throw new HttpError(400, "bad_request", "connectorAccountId must be a uuid");
            return json(req, await disconnectAccount(link, userId, accountId));
          }
          if (isLinkProvider(provider)) {
            if (step !== "start") throw new HttpError(400, "bad_request", `step must be "start" or "disconnect" for ${provider}`);
            return json(req, await startOAuthLink(link, userId, provider));
          }
          const relinkId = body.connectorAccountId;
          if (relinkId !== undefined && relinkId !== null && (typeof relinkId !== "string" || !isUuid(relinkId))) throw new HttpError(400, "bad_request", "connectorAccountId must be a uuid");
          const connectorAccountId = typeof relinkId === "string" ? relinkId : null;
          if (step === "start") return json(req, await startPlaidLink(link, userId, { connectorAccountId }));
          if (step === "complete") {
            const publicToken = typeof body.publicToken === "string" && body.publicToken ? body.publicToken : null;
            const linkToken = typeof body.linkToken === "string" && body.linkToken ? body.linkToken : null;
            return json(req, await completePlaidLink(link, userId, { publicToken, linkToken, connectorAccountId }));
          }
          throw new HttpError(400, "bad_request", 'step must be "start", "complete" or "disconnect" for plaid');
        },
      },
      {
        method: "GET",
        path: "/callback",
        handler: async (req) => {
          const url = new URL(req.url);
          try {
            const link = await deps.linkDeps();
            const { provider } = await completeOAuthCallback(link, {
              code: url.searchParams.get("code"),
              state: url.searchParams.get("state"),
              error: url.searchParams.get("error"),
            });
            deps.log("link: callback completed", { provider });
            return html(req, linkResultPage(true, "Connected"));
          } catch (err) {
            // Rendered for a human in the system browser: a short reason, never provider payloads or secrets.
            const status = err instanceof HttpError ? err.status : 500;
            const message = err instanceof HttpError ? err.message : "The connection could not be completed";
            deps.log("link: callback failed", { status, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
            return html(req, linkResultPage(false, message), status);
          }
        },
      },
    ]),
    deps.log,
  );
}
