/**
 * HTTP plumbing shared by every Edge Function: JSON responses, the error
 * envelope `{ error: { code, message } }`, CORS for the Field origins, body
 * parsing with a size limit, and a tiny router. No secrets ever reach a
 * response or a log line; `HttpError` messages are written for the client.
 */
import type { Json, JsonObject } from "@vixera/domain";

export const ALLOWED_ORIGINS: readonly string[] = [
  "http://localhost:1420",
  "http://127.0.0.1:1420",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

export const MAX_BODY_BYTES = 1_000_000;

export type ErrorCode =
  | "bad_request"
  | "invalid_json"
  | "invalid_envelope"
  | "invalid_payload"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "in_progress"
  | "conflict"
  | "provider_not_configured"
  | "provider_error"
  | "invalid_state"
  | "payload_too_large"
  | "method_not_allowed"
  | "internal";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, apikey, content-type, x-vixera-sync-secret, x-client-info",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
}

export function json(req: Request, body: Json | object, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(req), ...extraHeaders },
  });
}

export function html(req: Request, body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...corsHeaders(req) },
  });
}

export function errorResponse(req: Request, status: number, code: ErrorCode, message: string): Response {
  return json(req, { error: { code, message } }, status);
}

/** Maps any thrown value to the error envelope. Unknown errors become an opaque 500. */
export function errorToResponse(req: Request, err: unknown, log: (message: string, data?: JsonObject) => void = console.error): Response {
  if (err instanceof HttpError) return errorResponse(req, err.status, err.code, err.message);
  const name = err instanceof Error ? err.name : "Error";
  if (name === "EnvError") {
    log("edge: configuration error", { error: err instanceof Error ? err.message : String(err) });
    return errorResponse(req, 500, "internal", "Server configuration is incomplete");
  }
  if (name === "SpineNotFoundError") return errorResponse(req, 404, "not_found", err instanceof Error ? err.message : "not found");
  log("edge: unhandled error", { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  return errorResponse(req, 500, "internal", "Internal error");
}

/** Reads a JSON object body, enforcing `MAX_BODY_BYTES`. Empty bodies become `{}`. */
export async function readJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<JsonObject> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "payload_too_large", `Body exceeds ${maxBytes} bytes`);
  const text = await readTextLimited(req, maxBytes);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
  if (!isJsonObject(parsed)) throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  return parsed;
}

async function readTextLimited(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "payload_too_large", `Body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Path of the request relative to the function: `/functions/v1/<fn>/callback`
 * (deployed) and `/<fn>/callback` (local `supabase functions serve`) both
 * become `/callback`; the bare function URL becomes `/`.
 */
export function subPath(req: Request, functionName: string): string {
  let path = new URL(req.url).pathname;
  if (path.startsWith("/functions/v1/")) path = path.slice("/functions/v1".length);
  const prefix = `/${functionName}`;
  if (path === prefix || path === `${prefix}/`) return "/";
  if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
  return path.replace(/\/+$/, "") || "/";
}

export type Handler = (req: Request) => Promise<Response>;

export interface Route {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly handler: Handler;
}

/** Dispatches by method + sub-path; unknown paths are 404, known paths with the wrong method 405. */
export function route(functionName: string, routes: readonly Route[]): Handler {
  return (req) => {
    const path = subPath(req, functionName);
    const matching = routes.filter((r) => r.path === path);
    if (matching.length === 0) throw new HttpError(404, "not_found", `No route for ${path}`);
    const hit = matching.find((r) => r.method === req.method);
    if (!hit) throw new HttpError(405, "method_not_allowed", `${req.method} not allowed for ${path}`);
    return hit.handler(req);
  };
}

/**
 * Wraps a handler with CORS preflight and the error envelope. Every function's
 * `Deno.serve` receives the result of this.
 */
export function serveWith(handler: Handler, log?: (message: string, data?: JsonObject) => void): Handler {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    try {
      return await handler(req);
    } catch (err) {
      return errorToResponse(req, err, log);
    }
  };
}

/** Constant-time string comparison for shared secrets. */
export function secretsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ea.byteLength; i++) diff |= (ea[i] as number) ^ (eb[i] as number);
  return diff === 0;
}

export type Logger = (message: string, data?: JsonObject) => void;

/** Structured single-line JSON logs. Callers must never pass secrets in `data`. */
export function logger(functionName: string): Logger {
  return (message, data) => {
    console.log(JSON.stringify({ fn: functionName, at: new Date().toISOString(), message, ...(data ?? {}) }));
  };
}
