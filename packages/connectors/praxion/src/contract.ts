/**
 * Praxion local connector contract, version 1.0.0.
 *
 * Praxion (`ai.vixera.praxion`) is a separate product that owns the document
 * artifact: rendering, annotation, comparison, signing, page state and the
 * structured content of a document. Vixera One owns context. This file is the
 * ONLY place where Vixera says anything about what Praxion looks like on the
 * wire; it is a contract, not an implementation of document functionality.
 *
 * Transport: loopback HTTP, JSON bodies, `http://127.0.0.1:47815/v1/*`.
 *
 * Versioning:
 *   - `PRAXION_CONTRACT_VERSION` is the contract this client was written for.
 *   - Clients send `X-Praxion-Contract: <major>` on every request.
 *   - `GET /v1/health` reports the server's `contractVersion`.
 *   - Compatible when majors are equal and server minor >= client minor
 *     (`isContractCompatible` in ./version.ts).
 *   - A server that does not support the requested major replies
 *     `426 Upgrade Required` with its health payload as the body so the client
 *     can report both versions without a second round trip.
 *
 * Every other error is `{ error: { code, message } }` with an HTTP status:
 *   400 bad_request · 404 not_found · 409 conflict · 422 unsupported_action ·
 *   426 unsupported_contract · 500 internal.
 *
 * Nothing here carries a Vixera user id. Praxion is login-free and single
 * user; the Vixera user is attached by the store when context is persisted.
 */
import type { JsonObject, PraxionLocation as DomainPraxionLocation, StructuredBlock } from "@vixera/domain";
export { isContractCompatible, parseSemver, contractMajor } from "./version.ts";

export const PRAXION_CONTRACT_VERSION = "1.0.0";
export const PRAXION_CONTRACT_MAJOR = 1;
/** Request header carrying the client's contract major. */
export const PRAXION_CONTRACT_HEADER = "X-Praxion-Contract";

export const PRAXION_DEFAULT_HOST = "127.0.0.1";
export const PRAXION_DEFAULT_PORT = 47815;
export const PRAXION_DEFAULT_BASE_URL = `http://${PRAXION_DEFAULT_HOST}:${PRAXION_DEFAULT_PORT}`;

export type PraxionHttpMethod = "GET" | "POST";

export interface PraxionEndpoint {
  readonly method: PraxionHttpMethod;
  /** Path template; `{id}` is replaced with an URL-encoded document id. */
  readonly path: string;
}

export const PRAXION_ENDPOINTS = {
  health: { method: "GET", path: "/v1/health" },
  currentContext: { method: "GET", path: "/v1/context/current" },
  document: { method: "GET", path: "/v1/documents/{id}" },
  content: { method: "GET", path: "/v1/documents/{id}/content" },
  location: { method: "GET", path: "/v1/documents/{id}/location" },
  selection: { method: "GET", path: "/v1/documents/{id}/selection" },
  open: { method: "POST", path: "/v1/documents/open" },
  action: { method: "POST", path: "/v1/actions" },
} as const satisfies Record<string, PraxionEndpoint>;

export type PraxionEndpointName = keyof typeof PRAXION_ENDPOINTS;

/** Fills `{id}` in an endpoint path template. */
export function praxionPath(endpoint: PraxionEndpoint, params: { readonly id?: string } = {}): string {
  return endpoint.path.replace("{id}", () => {
    if (params.id === undefined || params.id === "") throw new TypeError(`Endpoint ${endpoint.path} requires an id`);
    return encodeURIComponent(params.id);
  });
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------
export const PRAXION_CAPABILITIES = [
  "open",
  "current_context",
  "structured_content",
  "selection",
  "location",
  "metadata",
  "action:compare",
  "action:annotate",
  "action:sign",
  "action:goto",
] as const;
export type PraxionCapability = (typeof PRAXION_CAPABILITIES)[number];

export const PRAXION_ACTIONS = ["compare", "annotate", "sign", "goto"] as const;
export type PraxionAction = (typeof PRAXION_ACTIONS)[number];

export function isPraxionCapability(value: unknown): value is PraxionCapability {
  return typeof value === "string" && (PRAXION_CAPABILITIES as readonly string[]).includes(value);
}

export function actionCapability(action: PraxionAction): PraxionCapability {
  return `action:${action}`;
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

/** GET /v1/health → 200 (also the body of a 426). */
export interface PraxionHealth {
  readonly app: "praxion";
  /** Contract version the server implements, e.g. "1.0.0". */
  readonly contractVersion: string;
  /** Praxion application version, informational. */
  readonly appVersion: string;
  readonly capabilities: readonly PraxionCapability[];
}

export interface PraxionDocumentSummary {
  /** Praxion's own document id. Vixera stores it as `Document.praxionDocumentId`. */
  readonly id: string;
  readonly title: string;
  /** Absolute path on this device, or null for documents Praxion holds in memory. */
  readonly path: string | null;
  readonly mimeType: string;
  readonly pageCount: number | null;
}

/** Same shape as `@vixera/domain` `PraxionLocation`; `position` stays opaque to Vixera. */
export type PraxionLocation = DomainPraxionLocation;

/** GET /v1/context/current → 200. `document` is null when nothing is focused. */
export interface PraxionCurrentContext {
  readonly document: PraxionDocumentSummary | null;
  readonly location: PraxionLocation | null;
  readonly selection: string | null;
  readonly capturedAt: string;
}

/** GET /v1/documents/{id} → 200 | 404. */
export interface PraxionDocumentMetadata extends PraxionDocumentSummary {
  readonly sizeBytes: number | null;
  /** sha256 hex of the bytes when Praxion has them; used by Vixera to dedupe. */
  readonly contentHash: string | null;
  readonly createdAt: string | null;
  readonly modifiedAt: string | null;
  /** Praxion-defined extra metadata (author, producer, ...). Opaque to Vixera. */
  readonly metadata: JsonObject;
}

/** GET /v1/documents/{id}/content → 200 | 404. */
export interface PraxionStructuredContent {
  readonly documentId: string;
  readonly blocks: readonly StructuredBlock[];
  /** True when the server cut the block list (very large documents). */
  readonly truncated: boolean;
}

/** GET /v1/documents/{id}/selection → 200 | 404. */
export interface PraxionSelection {
  readonly documentId: string;
  /** Selected text or null when nothing is selected in that document. */
  readonly text: string | null;
}

/** POST /v1/documents/open. Exactly one of `path` / `documentId` is required. */
export interface PraxionOpenRequest {
  readonly path?: string;
  readonly documentId?: string;
  readonly location?: PraxionLocation;
  /** Bring the Praxion window to front (default true). */
  readonly focus?: boolean;
}

/** POST /v1/documents/open → 200 | 400 | 404. */
export interface PraxionOpenResponse {
  readonly document: PraxionDocumentSummary;
}

/** POST /v1/actions. `params` is action-specific and owned by Praxion. */
export interface PraxionActionRequest {
  readonly action: PraxionAction;
  readonly documentId: string;
  readonly params: JsonObject;
}

/**
 * POST /v1/actions → 200 | 404 | 422. `supported: false` means Praxion knows
 * the action but this build cannot perform it; `accepted: false` with
 * `supported: true` means Praxion declined (e.g. document locked).
 */
export interface PraxionActionResponse {
  readonly accepted: boolean;
  readonly supported: boolean;
  readonly message: string | null;
}

export type PraxionErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "unsupported_action"
  | "unsupported_contract"
  | "internal";

export interface PraxionErrorEnvelope {
  readonly error: {
    readonly code: PraxionErrorCode | string;
    readonly message: string;
  };
}

/** Minimal structural checks; Praxion is trusted but the client never assumes. */
export function isPraxionHealth(value: unknown): value is PraxionHealth {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v["app"] === "praxion" && typeof v["contractVersion"] === "string" && typeof v["appVersion"] === "string" && Array.isArray(v["capabilities"]);
}

export function isPraxionErrorEnvelope(value: unknown): value is PraxionErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const err = (value as Record<string, unknown>)["error"];
  return !!err && typeof err === "object" && typeof (err as Record<string, unknown>)["code"] === "string";
}
