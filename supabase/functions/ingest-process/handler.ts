/**
 * The ingest-process HTTP handler with its store injected: runs THE ingestion
 * pipeline (ingest.ts) for the caller. Tested in handler_test.ts.
 *
 *   POST /  body { ingestItemId? }
 *           → { processed, deferred, failed, documentIds, items: [{ ingestItemId, status, attempts, documentId, error }] }
 *   One item (any status: re-processing is idempotent; an already processed
 *   item is returned as-is) or every "received" item of the user — which is
 *   also how an item a transient failure left `received` gets its next run.
 */
import { isUuid } from "@vixera/domain";
import type { SpineStore } from "@vixera/sync";
import { HttpError, json, readJsonBody, route, serveWith, type Handler, type Logger } from "../_shared/http.ts";
import { processIngestItem, type ProcessIngestResult } from "../_shared/ingest.ts";

export const FN = "ingest-process";
export const MAX_ITEMS_PER_RUN = 200;

export interface IngestProcessDeps {
  /** Verifies the Bearer token and binds a store to that user; throws HttpError 401 otherwise. */
  readonly userRequest: (req: Request) => Promise<{ readonly store: SpineStore }>;
  readonly now?: () => Date;
  readonly log: Logger;
}

export function ingestProcessHandler(deps: IngestProcessDeps): Handler {
  const now = deps.now ?? (() => new Date());
  return serveWith(
    route(FN, [
      {
        method: "POST",
        path: "/",
        handler: async (req) => {
          const { store } = await deps.userRequest(req);
          const body = await readJsonBody(req);
          const id = body.ingestItemId;
          if (id !== undefined && id !== null && (typeof id !== "string" || !isUuid(id))) throw new HttpError(400, "bad_request", "ingestItemId must be a uuid");

          const results: ProcessIngestResult[] = [];
          if (typeof id === "string" && id) {
            const item = await store.getIngestItem(id);
            if (!item) throw new HttpError(404, "not_found", `ingest item ${id} not found`);
            if (item.status === "processed") {
              results.push({ ingestItemId: item.id, status: "processed", attempts: item.attempts, documentId: item.documentId, documentReused: true, contextEventId: null, relationships: 0, error: null });
            } else {
              results.push(await processIngestItem(store, item, { now, log: deps.log }));
            }
          } else {
            for (const item of await store.listIngestItems({ status: "received", limit: MAX_ITEMS_PER_RUN })) {
              results.push(await processIngestItem(store, item, { now, log: deps.log }));
            }
          }
          const processed = results.filter((r) => r.status === "processed");
          return json(req, {
            processed: processed.length,
            deferred: results.filter((r) => r.status === "deferred").length,
            failed: results.filter((r) => r.status === "failed").length,
            documentIds: processed.map((r) => r.documentId).filter((d): d is string => d !== null),
            items: results.map((r) => ({ ingestItemId: r.ingestItemId, status: r.status, attempts: r.attempts, documentId: r.documentId, error: r.error })),
          });
        },
      },
    ]),
    deps.log,
  );
}
