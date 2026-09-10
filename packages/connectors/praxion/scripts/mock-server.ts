/**
 * Praxion mock server for local Field development.
 *
 *   node --experimental-strip-types packages/connectors/praxion/scripts/mock-server.ts
 *   (or: pnpm praxion:mock)
 *
 * Binds 127.0.0.1:47815 (override the port with PRAXION_MOCK_PORT) and serves
 * the in-memory Praxion fake with two fixture documents. The "Operating
 * agreement v3.pdf" (18 pages) is focused at page 7 with a selection about
 * clause 7.1, so the Field's NOW / Files surfaces have something to show.
 *
 * This script is the only Node-specific code in the package (node:http). It
 * is never exported from src/. The fake has no document functionality; it
 * only speaks the contract. Loopback only: never bind to 0.0.0.0.
 *
 * Try it:
 *   curl -s http://127.0.0.1:47815/v1/health
 *   curl -s http://127.0.0.1:47815/v1/context/current
 *   curl -s http://127.0.0.1:47815/v1/documents/doc-operating-agreement-v3/content
 *   curl -s -X POST -H 'content-type: application/json' \
 *        -d '{"documentId":"doc-invoice-0231"}' http://127.0.0.1:47815/v1/documents/open
 *   curl -s -X POST -H 'content-type: application/json' \
 *        -d '{"action":"goto","documentId":"doc-invoice-0231","params":{"page":2}}' http://127.0.0.1:47815/v1/actions
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PRAXION_DEFAULT_HOST, PRAXION_DEFAULT_PORT } from "../src/contract.ts";
import { InMemoryPraxion } from "../src/testing/in-memory-praxion.ts";
import { FIXTURE_DOCUMENTS, OPERATING_AGREEMENT } from "../src/testing/fixtures.ts";

const host = PRAXION_DEFAULT_HOST;
const port = Number.parseInt(process.env["PRAXION_MOCK_PORT"] ?? "", 10) || PRAXION_DEFAULT_PORT;

const praxion = new InMemoryPraxion({
  appVersion: "0.0.0-mock",
  documents: FIXTURE_DOCUMENTS,
  current: OPERATING_AGREEMENT.id,
});

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  readBody(req)
    .then((raw) => {
      let body: unknown = undefined;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          return send(res, 400, { error: { code: "bad_request", message: "Body is not valid JSON" } });
        }
      }
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value[0] : value;
      const handled = praxion.handle(req.method ?? "GET", url.pathname, body, headers);
      const stamp = new Date().toISOString();
      console.log(`${stamp} ${req.method} ${url.pathname} -> ${handled.status}`);
      return send(res, handled.status, handled.body);
    })
    .catch((error: unknown) => {
      console.error(error);
      send(res, 500, { error: { code: "internal", message: "mock server failure" } });
    });
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Praxion mock: ${host}:${port} is already in use (real Praxion or another mock running?)`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Praxion mock listening on http://${host}:${port} (contract ${praxion.contractVersion})`);
  console.log(`Focused: ${OPERATING_AGREEMENT.title} page ${OPERATING_AGREEMENT.location?.page ?? "-"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}
