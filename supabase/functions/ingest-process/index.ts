/**
 * ingest-process — runs THE ingestion pipeline (ingest.ts) for the caller. The
 * handler and its contract live in handler.ts; this file is the production wiring.
 */
import { readEnv } from "../_shared/env.ts";
import { logger, serveWith } from "../_shared/http.ts";
import { userRequest } from "../_shared/request.ts";
import { FN, ingestProcessHandler } from "./handler.ts";

const log = logger(FN);

function production() {
  const env = readEnv();
  return ingestProcessHandler({ userRequest: (req) => userRequest(req, env), log });
}

Deno.serve(serveWith((req) => production()(req), log));
