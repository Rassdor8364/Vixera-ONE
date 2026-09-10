/**
 * ingest-process — runs THE ingestion pipeline (ingest.ts) for the caller.
 *
 *   POST /  body { ingestItemId? }
 *           → { processed, documentIds, failed, items: [{ ingestItemId, status, documentId, error }] }
 *   One item (any status: re-processing is idempotent; an already processed
 *   item is returned as-is) or every "received" item of the user.
 */
import { isUuid } from "@vixera/domain";
import { readEnv } from "../_shared/env.ts";
import { HttpError, json, logger, readJsonBody, route, serveWith } from "../_shared/http.ts";
import { processIngestItem, type ProcessIngestResult } from "../_shared/ingest.ts";
import { userRequest } from "../_shared/request.ts";

const FN = "ingest-process";
const log = logger(FN);
const MAX_ITEMS_PER_RUN = 200;

Deno.serve(
  serveWith(
    route(FN, [
      {
        method: "POST",
        path: "/",
        handler: async (req) => {
          const env = readEnv();
          const { store } = await userRequest(req, env);
          const body = await readJsonBody(req);
          const id = body.ingestItemId;
          if (id !== undefined && id !== null && (typeof id !== "string" || !isUuid(id))) throw new HttpError(400, "bad_request", "ingestItemId must be a uuid");

          const results: ProcessIngestResult[] = [];
          const now = () => new Date();
          if (typeof id === "string" && id) {
            const item = await store.getIngestItem(id);
            if (!item) throw new HttpError(404, "not_found", `ingest item ${id} not found`);
            if (item.status === "processed") {
              results.push({ ingestItemId: item.id, status: "processed", documentId: item.documentId, documentReused: true, contextEventId: null, relationships: 0, error: null });
            } else {
              results.push(await processIngestItem(store, item, { now, log }));
            }
          } else {
            for (const item of await store.listIngestItems({ status: "received", limit: MAX_ITEMS_PER_RUN })) {
              results.push(await processIngestItem(store, item, { now, log }));
            }
          }
          const processed = results.filter((r) => r.status === "processed");
          return json(req, {
            processed: processed.length,
            documentIds: processed.map((r) => r.documentId).filter((d): d is string => d !== null),
            failed: results.length - processed.length,
            items: results.map((r) => ({ ingestItemId: r.ingestItemId, status: r.status, documentId: r.documentId, error: r.error })),
          });
        },
      },
    ]),
    log,
  ),
);
