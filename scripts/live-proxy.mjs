/**
 * Supabase-shaped front door for the live stack: supabase-js talks to
 * `<url>/rest/v1/...`, PostgREST serves `/...`. This strips the prefix (and
 * answers /health) so the real client library can be exercised end to end.
 *
 *   node scripts/live-proxy.mjs <listenPort> <postgrestUrl>
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 54333);
const target = (process.argv[3] ?? "http://127.0.0.1:54332").replace(/\/$/, "");

const server = createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
    return;
  }
  const path = url.startsWith("/rest/v1") ? url.slice("/rest/v1".length) || "/" : url;
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    try {
      const upstream = await fetch(target + path, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      const out = {};
      upstream.headers.forEach((v, k) => {
        if (k !== "content-encoding" && k !== "transfer-encoding" && k !== "content-length") out[k] = v;
      });
      res.writeHead(upstream.status, out);
      res.end(body);
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(error) }));
    }
  });
});

server.listen(port, "127.0.0.1", () => console.log(`live-proxy on http://127.0.0.1:${port} → ${target}`));
