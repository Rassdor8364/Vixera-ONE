import assert from "node:assert/strict";
import { HttpError, corsHeaders, errorToResponse, readJsonBody, route, secretsEqual, serveWith, subPath } from "./http.ts";

const post = (url: string, body?: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body } : {}) });

Deno.test("subPath strips the gateway prefix and the function name", () => {
  assert.equal(subPath(new Request("https://x.supabase.co/functions/v1/connector-link"), "connector-link"), "/");
  assert.equal(subPath(new Request("https://x.supabase.co/functions/v1/connector-link/"), "connector-link"), "/");
  assert.equal(subPath(new Request("https://x.supabase.co/functions/v1/connector-link/callback?code=1"), "connector-link"), "/callback");
  assert.equal(subPath(new Request("http://127.0.0.1:54321/connector-link/callback"), "connector-link"), "/callback");
});

Deno.test("route: 404 for unknown paths, 405 for wrong methods, CORS preflight and error envelope via serveWith", async () => {
  const handler = serveWith(route("fn", [{ method: "POST", path: "/", handler: () => Promise.resolve(new Response("ok")) }]), () => {});
  const preflight = await handler(new Request("https://x/functions/v1/fn", { method: "OPTIONS", headers: { origin: "tauri://localhost" } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "tauri://localhost");
  const notFound = await handler(post("https://x/functions/v1/fn/nope", "{}"));
  assert.equal(notFound.status, 404);
  assert.deepEqual((await notFound.json()).error.code, "not_found");
  const wrongMethod = await handler(new Request("https://x/functions/v1/fn", { method: "GET" }));
  assert.equal(wrongMethod.status, 405);
  const ok = await handler(post("https://x/functions/v1/fn", "{}", { origin: "http://evil.example" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("access-control-allow-origin"), null);
});

Deno.test("readJsonBody: objects only, size limited, empty body is {}", async () => {
  assert.deepEqual(await readJsonBody(post("https://x/fn", '{"a":1}')), { a: 1 });
  assert.deepEqual(await readJsonBody(post("https://x/fn")), {});
  await assert.rejects(() => readJsonBody(post("https://x/fn", "[1]")), (e: unknown) => e instanceof HttpError && e.code === "invalid_json");
  await assert.rejects(() => readJsonBody(post("https://x/fn", "{nope")), (e: unknown) => e instanceof HttpError && e.status === 400);
  await assert.rejects(() => readJsonBody(post("https://x/fn", JSON.stringify({ big: "x".repeat(100) })), 50), (e: unknown) => e instanceof HttpError && e.status === 413);
});

Deno.test("errorToResponse hides internals; secretsEqual is strict", async () => {
  const res = await errorToResponse(new Request("https://x/fn"), new Error("contains token abc"), () => {});
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.message, "Internal error");
  assert.equal(secretsEqual("a", "a"), true);
  assert.equal(secretsEqual("a", "b"), false);
  assert.equal(secretsEqual("", ""), false);
  assert.equal(secretsEqual("a", null), false);
  assert.ok(corsHeaders(new Request("https://x/fn", { headers: { origin: "http://localhost:1420" } }))["access-control-allow-origin"]);
});
