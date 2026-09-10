/**
 * In-process fake of the SERVER side of the Praxion contract.
 *
 * Used by Vixera tests, by the screen-context adapters' tests, and by
 * `scripts/mock-server.ts` for local Field development. It implements the
 * wire contract (paths, statuses, envelopes, version negotiation) over a small
 * document store. It is NOT Praxion and holds no document functionality
 * beyond what the contract exposes; blocks are fixture data.
 *
 * Web-standard only: no Node imports (the mock server wraps it in node:http).
 */
import type { PraxionLocation, StructuredBlock } from "@vixera/domain";
import {
  PRAXION_CAPABILITIES,
  PRAXION_CONTRACT_HEADER,
  PRAXION_CONTRACT_VERSION,
  PRAXION_ENDPOINTS,
  contractMajor,
  isPraxionCapability,
  type PraxionAction,
  type PraxionActionRequest,
  type PraxionActionResponse,
  type PraxionCapability,
  type PraxionCurrentContext,
  type PraxionDocumentMetadata,
  type PraxionDocumentSummary,
  type PraxionErrorCode,
  type PraxionErrorEnvelope,
  type PraxionHealth,
  type PraxionHttpMethod,
  type PraxionOpenRequest,
  type PraxionOpenResponse,
  type PraxionSelection,
  type PraxionStructuredContent,
} from "../contract.ts";
import type { PraxionRequest, PraxionResponse, PraxionTransport } from "../transport.ts";

export interface InMemoryPraxionDocument {
  readonly id: string;
  readonly title: string;
  readonly path: string | null;
  readonly mimeType: string;
  readonly pageCount: number | null;
  readonly sizeBytes?: number | null;
  readonly contentHash?: string | null;
  readonly createdAt?: string | null;
  readonly modifiedAt?: string | null;
  readonly metadata?: PraxionDocumentMetadata["metadata"];
  readonly blocks?: readonly StructuredBlock[];
  /** Last known location inside this document. */
  readonly location?: PraxionLocation | null;
  readonly selection?: string | null;
}

export interface InMemoryPraxionOptions {
  readonly contractVersion?: string;
  readonly appVersion?: string;
  readonly capabilities?: readonly PraxionCapability[];
  readonly documents?: readonly InMemoryPraxionDocument[];
  /** Id of the initially focused document. */
  readonly current?: string | null;
  readonly now?: () => Date;
  /** Blocks per content response before `truncated: true`. Default: unlimited. */
  readonly maxBlocks?: number;
}

export interface HandledResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly contractHeader: string | null;
}

export interface ActionRecord extends PraxionActionRequest {
  readonly response: PraxionActionResponse;
}

interface StoredDocument {
  summary: PraxionDocumentSummary;
  metadata: PraxionDocumentMetadata;
  blocks: readonly StructuredBlock[];
  location: PraxionLocation | null;
  selection: string | null;
}

export class InMemoryPraxion {
  /** When true the fake behaves like a stopped process (transport reports status 0). */
  down = false;
  contractVersion: string;
  appVersion: string;
  capabilities: PraxionCapability[];
  /** Every request that reached `handle`, in order. Tests assert cheapness with it. */
  readonly requests: RecordedRequest[] = [];
  /** Every action Praxion accepted, in order. */
  readonly actions: ActionRecord[] = [];

  private readonly documents = new Map<string, StoredDocument>();
  /** Monotonic: ids minted by open-by-path are never reused, even after removeDocument(). */
  private nextMintedId = 1;
  private currentId: string | null;
  private readonly now: () => Date;
  private readonly maxBlocks: number;

  constructor(options: InMemoryPraxionOptions = {}) {
    this.contractVersion = options.contractVersion ?? PRAXION_CONTRACT_VERSION;
    this.appVersion = options.appVersion ?? "0.0.0-mock";
    this.capabilities = [...(options.capabilities ?? PRAXION_CAPABILITIES)];
    this.now = options.now ?? (() => new Date());
    this.maxBlocks = options.maxBlocks ?? Number.POSITIVE_INFINITY;
    for (const doc of options.documents ?? []) this.addDocument(doc);
    this.currentId = null;
    if (options.current !== undefined && options.current !== null) this.setCurrent(options.current);
  }

  // ---- state manipulation (test / dev API, not part of the wire contract) ----

  addDocument(doc: InMemoryPraxionDocument): this {
    const summary: PraxionDocumentSummary = { id: doc.id, title: doc.title, path: doc.path, mimeType: doc.mimeType, pageCount: doc.pageCount };
    this.documents.set(doc.id, {
      summary,
      metadata: {
        ...summary,
        sizeBytes: doc.sizeBytes ?? null,
        contentHash: doc.contentHash ?? null,
        createdAt: doc.createdAt ?? null,
        modifiedAt: doc.modifiedAt ?? null,
        metadata: doc.metadata ?? {},
      },
      blocks: doc.blocks ?? [],
      location: doc.location ?? null,
      selection: doc.selection ?? null,
    });
    return this;
  }

  removeDocument(id: string): this {
    this.documents.delete(id);
    if (this.currentId === id) this.currentId = null;
    return this;
  }

  /** Focus a document (must exist) or nothing (`null`). */
  setCurrent(id: string | null): this {
    if (id !== null && !this.documents.has(id)) throw new Error(`InMemoryPraxion: unknown document ${id}`);
    this.currentId = id;
    return this;
  }

  setLocation(id: string, location: PraxionLocation | null): this {
    this.stored(id).location = location;
    return this;
  }

  setSelection(id: string, selection: string | null): this {
    this.stored(id).selection = selection;
    return this;
  }

  get current(): string | null {
    return this.currentId;
  }

  health(): PraxionHealth {
    return { app: "praxion", contractVersion: this.contractVersion, appVersion: this.appVersion, capabilities: [...this.capabilities] };
  }

  // ---- wire contract ----------------------------------------------------------

  /**
   * Serves one request. `headers` keys are matched case-insensitively; only
   * `X-Praxion-Contract` is read.
   */
  handle(method: string, path: string, body: unknown = undefined, headers: Record<string, string | undefined> = {}): HandledResponse {
    const upper = method.toUpperCase();
    const contractHeader = headerValue(headers, PRAXION_CONTRACT_HEADER);
    this.requests.push({ method: upper, path, body, contractHeader });

    if (contractHeader !== null) {
      const requested = Number.parseInt(contractHeader, 10);
      if (!Number.isInteger(requested) || requested !== contractMajor(this.contractVersion)) {
        return { status: 426, body: this.health() };
      }
    }

    const pathname = path.split("?")[0] ?? path;
    if (upper === "GET" && pathname === PRAXION_ENDPOINTS.health.path) return ok(this.health());
    if (upper === "GET" && pathname === PRAXION_ENDPOINTS.currentContext.path) return ok(this.currentContext());
    if (upper === "POST" && pathname === PRAXION_ENDPOINTS.open.path) return this.open(body);
    if (upper === "POST" && pathname === PRAXION_ENDPOINTS.action.path) return this.action(body);

    const doc = /^\/v1\/documents\/([^/]+)(?:\/(content|location|selection))?$/.exec(pathname);
    if (doc && upper === "GET") {
      const id = safeDecode(doc[1] ?? "");
      const stored = this.documents.get(id);
      if (!stored) return fail(404, "not_found", `No document ${id}`);
      switch (doc[2]) {
        case undefined:
          return ok(stored.metadata);
        case "content": {
          const truncated = stored.blocks.length > this.maxBlocks;
          const content: PraxionStructuredContent = { documentId: id, blocks: truncated ? stored.blocks.slice(0, this.maxBlocks) : [...stored.blocks], truncated };
          return ok(content);
        }
        case "location":
          return ok(stored.location ?? { page: null, position: null, selectionText: null });
        case "selection": {
          const selection: PraxionSelection = { documentId: id, text: stored.selection };
          return ok(selection);
        }
        default:
          break;
      }
    }
    if (doc) return fail(405, "bad_request", `Method ${upper} not allowed on ${pathname}`);
    return fail(404, "not_found", `No route ${upper} ${pathname}`);
  }

  private currentContext(): PraxionCurrentContext {
    const capturedAt = this.now().toISOString();
    const stored = this.currentId ? this.documents.get(this.currentId) : undefined;
    if (!stored) return { document: null, location: null, selection: null, capturedAt };
    return { document: stored.summary, location: stored.location, selection: stored.selection, capturedAt };
  }

  private open(body: unknown): HandledResponse {
    if (!body || typeof body !== "object") return fail(400, "bad_request", "Body must be a JSON object");
    const req = body as PraxionOpenRequest;
    let stored: StoredDocument | undefined;
    if (typeof req.documentId === "string") stored = this.documents.get(req.documentId);
    else if (typeof req.path === "string") stored = [...this.documents.values()].find((d) => d.summary.path === req.path);
    else return fail(400, "bad_request", "Provide `documentId` or `path`");
    if (!stored) {
      if (typeof req.path === "string") {
        // A real Praxion opens files from disk; the fake registers the path as a fresh document.
        let id = `doc-${this.nextMintedId++}`;
        while (this.documents.has(id)) id = `doc-${this.nextMintedId++}`;
        this.addDocument({ id, title: basename(req.path), path: req.path, mimeType: guessMime(req.path), pageCount: null });
        stored = this.stored(id);
      } else {
        return fail(404, "not_found", `No document ${String(req.documentId)}`);
      }
    }
    if (req.location) stored.location = req.location;
    this.currentId = stored.summary.id;
    const response: PraxionOpenResponse = { document: stored.summary };
    return ok(response);
  }

  private action(body: unknown): HandledResponse {
    if (!body || typeof body !== "object") return fail(400, "bad_request", "Body must be a JSON object");
    const req = body as Partial<PraxionActionRequest>;
    if (typeof req.action !== "string" || typeof req.documentId !== "string") return fail(400, "bad_request", "`action` and `documentId` are required");
    const capability = `action:${req.action}`;
    if (!isPraxionCapability(capability)) return fail(400, "bad_request", `Unknown action ${req.action}`);
    if (!this.capabilities.includes(capability)) return fail(422, "unsupported_action", `This Praxion build does not support ${req.action}`);
    const stored = this.documents.get(req.documentId);
    if (!stored) return fail(404, "not_found", `No document ${req.documentId}`);
    const response: PraxionActionResponse = { accepted: true, supported: true, message: null };
    const record: ActionRecord = { action: req.action as PraxionAction, documentId: req.documentId, params: req.params ?? {}, response };
    this.actions.push(record);
    if (req.action === "goto" && req.params && typeof req.params === "object") {
      const page = (req.params as { page?: unknown }).page;
      if (typeof page === "number") stored.location = { page, position: null, selectionText: null };
    }
    return ok(response);
  }

  private stored(id: string): StoredDocument {
    const stored = this.documents.get(id);
    if (!stored) throw new Error(`InMemoryPraxion: unknown document ${id}`);
    return stored;
  }
}

export interface InMemoryPraxionTransportOptions {
  /** Contract major announced to the fake. Default: the client's own major. */
  readonly contractMajor?: number;
  /** Simulated latency; a request whose timeout is shorter resolves as a timeout (no real waiting). */
  readonly latencyMs?: number;
}

/** Wraps `InMemoryPraxion` as a `PraxionTransport`. A "down" fake yields status 0. */
export class InMemoryPraxionTransport implements PraxionTransport {
  private readonly server: InMemoryPraxion;
  private readonly contractMajor: number;
  private readonly latencyMs: number;

  constructor(server: InMemoryPraxion, options: InMemoryPraxionTransportOptions = {}) {
    this.server = server;
    this.contractMajor = options.contractMajor ?? (contractMajor(PRAXION_CONTRACT_VERSION) ?? 1);
    this.latencyMs = options.latencyMs ?? 0;
  }

  async request<T>(input: PraxionRequest): Promise<PraxionResponse<T>> {
    if (this.server.down) {
      return { status: 0, body: null, failure: { kind: "network", message: "connection refused (fake)" } };
    }
    if (input.timeoutMs !== undefined && this.latencyMs > input.timeoutMs) {
      return { status: 0, body: null, failure: { kind: "timeout", message: `timed out after ${input.timeoutMs}ms (fake latency ${this.latencyMs}ms)` } };
    }
    // Round-trip through JSON so the fake never leaks object identity to the client.
    const body = input.body === undefined ? undefined : JSON.parse(JSON.stringify(input.body));
    const res = this.server.handle(input.method satisfies PraxionHttpMethod, input.path, body, { [PRAXION_CONTRACT_HEADER]: String(this.contractMajor) });
    return { status: res.status, body: res.body === undefined ? null : (JSON.parse(JSON.stringify(res.body)) as T) };
  }
}

// ---------------------------------------------------------------------------

function ok(body: unknown): HandledResponse {
  return { status: 200, body };
}

function fail(status: number, code: PraxionErrorCode, message: string): HandledResponse {
  const envelope: PraxionErrorEnvelope = { error: { code, message } };
  return { status, body: envelope };
}

function headerValue(headers: Record<string, string | undefined>, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) return value;
  }
  return null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function guessMime(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
