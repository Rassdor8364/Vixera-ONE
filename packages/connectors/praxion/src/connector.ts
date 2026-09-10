/**
 * Praxion client. Everything Vixera does with the document artifact goes
 * through `PraxionConnector`; nothing else in Vixera knows Praxion's wire
 * format. The client is built to be cheap when Praxion is absent: one health
 * probe (750 ms timeout) whose result is cached for `cacheMs`, after which
 * every read returns null and every write throws `PraxionUnavailableError`.
 *
 * Degradation rules:
 *   - connection refused / timeout      → availability "unavailable", reads null
 *   - contract major mismatch (426, or  → availability "incompatible", reads null
 *     health says an incompatible ver.)
 *   - 404 on a document                 → null (document unknown to Praxion)
 *   - open / action while unavailable   → PraxionUnavailableError
 *   - other non-2xx                     → PraxionRequestError (carries the envelope)
 */
import {
  PRAXION_CONTRACT_VERSION,
  PRAXION_ENDPOINTS,
  actionCapability,
  isContractCompatible,
  isPraxionErrorEnvelope,
  isPraxionHealth,
  praxionPath,
  type PraxionActionRequest,
  type PraxionActionResponse,
  type PraxionCapability,
  type PraxionCurrentContext,
  type PraxionDocumentMetadata,
  type PraxionEndpoint,
  type PraxionErrorEnvelope,
  type PraxionHealth,
  type PraxionLocation,
  type PraxionOpenRequest,
  type PraxionOpenResponse,
  type PraxionSelection,
  type PraxionStructuredContent,
} from "./contract.ts";
import type { PraxionResponse, PraxionTransport } from "./transport.ts";

export type PraxionUnavailableReason = "not_running" | "timeout" | "error";

export type PraxionAvailability =
  | {
      readonly state: "available";
      readonly contractVersion: string;
      readonly appVersion: string;
      readonly capabilities: readonly PraxionCapability[];
    }
  | { readonly state: "unavailable"; readonly reason: PraxionUnavailableReason; readonly detail: string }
  | { readonly state: "incompatible"; readonly serverVersion: string; readonly clientVersion: string };

export interface PraxionConnector {
  /** Cached probe of /v1/health. Safe to call on every render. */
  availability(): Promise<PraxionAvailability>;
  /** Uncached health call. Throws `PraxionUnavailableError` when unreachable. */
  health(): Promise<PraxionHealth>;
  /** Null when Praxion is absent, incompatible, or has no focused document. */
  currentContext(): Promise<PraxionCurrentContext | null>;
  getDocument(id: string): Promise<PraxionDocumentMetadata | null>;
  getContent(id: string): Promise<PraxionStructuredContent | null>;
  getLocation(id: string): Promise<PraxionLocation | null>;
  getSelection(id: string): Promise<string | null>;
  /** Throws `PraxionUnavailableError` when Praxion cannot take the request. */
  openDocument(request: PraxionOpenRequest): Promise<PraxionOpenResponse>;
  /** Throws `PraxionUnavailableError` when Praxion cannot take the request. */
  requestAction(request: PraxionActionRequest): Promise<PraxionActionResponse>;
  /** False when Praxion is absent or does not advertise the capability. */
  supports(capability: PraxionCapability): Promise<boolean>;
}

export class PraxionUnavailableError extends Error {
  readonly availability: Exclude<PraxionAvailability, { state: "available" }>;
  constructor(availability: Exclude<PraxionAvailability, { state: "available" }>) {
    super(
      availability.state === "incompatible"
        ? `Praxion contract ${availability.serverVersion} is incompatible with client ${availability.clientVersion}`
        : `Praxion is unavailable (${availability.reason}): ${availability.detail}`,
    );
    this.name = "PraxionUnavailableError";
    this.availability = availability;
  }
}

/** A reachable, compatible Praxion answered with an unexpected status. */
export class PraxionRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly path: string;
  constructor(path: string, status: number, envelope: PraxionErrorEnvelope | null) {
    super(`Praxion ${path} failed with HTTP ${status}${envelope ? `: ${envelope.error.code} — ${envelope.error.message}` : ""}`);
    this.name = "PraxionRequestError";
    this.status = status;
    this.code = envelope?.error.code ?? "http_error";
    this.path = path;
  }
}

export interface PraxionClientOptions {
  /** How long an availability probe result stays valid. Default 5000 ms. */
  readonly cacheMs?: number;
  /** Monotonic-ish clock in milliseconds. Default `Date.now`. */
  readonly clock?: () => number;
  /** Timeout of the health probe. Default 750 ms. */
  readonly probeTimeoutMs?: number;
  /** Timeout of every other request. Default 3000 ms. */
  readonly requestTimeoutMs?: number;
  /** Contract version this client speaks. Default `PRAXION_CONTRACT_VERSION`; tests override. */
  readonly clientVersion?: string;
}

interface CacheEntry {
  readonly value: PraxionAvailability;
  readonly at: number;
}

export class PraxionClient implements PraxionConnector {
  readonly clientVersion: string;
  private readonly transport: PraxionTransport;
  private readonly cacheMs: number;
  private readonly clock: () => number;
  private readonly probeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private cache: CacheEntry | null = null;
  private inFlight: Promise<PraxionAvailability> | null = null;

  constructor(transport: PraxionTransport, options: PraxionClientOptions = {}) {
    this.transport = transport;
    this.cacheMs = options.cacheMs ?? 5000;
    this.clock = options.clock ?? (() => Date.now());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 750;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3000;
    this.clientVersion = options.clientVersion ?? PRAXION_CONTRACT_VERSION;
  }

  /** Drops the cached probe so the next call re-checks (e.g. after the user launched Praxion). */
  invalidate(): void {
    this.cache = null;
  }

  async availability(): Promise<PraxionAvailability> {
    const now = this.clock();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.value;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe()
      .then((value) => {
        this.cache = { value, at: this.clock() };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async health(): Promise<PraxionHealth> {
    const res = await this.transport.request<unknown>({ method: "GET", path: PRAXION_ENDPOINTS.health.path, timeoutMs: this.probeTimeoutMs });
    const availability = this.interpretHealth(res);
    if (availability.state === "unavailable") throw new PraxionUnavailableError(availability);
    // 426 carries the server's health payload; an incompatible server still answers health().
    if (isPraxionHealth(res.body)) return res.body;
    throw new PraxionUnavailableError({ state: "unavailable", reason: "error", detail: "health payload malformed" });
  }

  async currentContext(): Promise<PraxionCurrentContext | null> {
    const body = await this.read<PraxionCurrentContext>(PRAXION_ENDPOINTS.currentContext, "current_context");
    if (!body || !body.document) return null;
    return body;
  }

  getDocument(id: string): Promise<PraxionDocumentMetadata | null> {
    return this.read<PraxionDocumentMetadata>(PRAXION_ENDPOINTS.document, "metadata", id);
  }

  getContent(id: string): Promise<PraxionStructuredContent | null> {
    return this.read<PraxionStructuredContent>(PRAXION_ENDPOINTS.content, "structured_content", id);
  }

  getLocation(id: string): Promise<PraxionLocation | null> {
    return this.read<PraxionLocation>(PRAXION_ENDPOINTS.location, "location", id);
  }

  async getSelection(id: string): Promise<string | null> {
    const body = await this.read<PraxionSelection>(PRAXION_ENDPOINTS.selection, "selection", id);
    return body?.text ?? null;
  }

  async openDocument(request: PraxionOpenRequest): Promise<PraxionOpenResponse> {
    if (!request.path && !request.documentId) throw new TypeError("openDocument requires `path` or `documentId`");
    return this.write<PraxionOpenResponse>(PRAXION_ENDPOINTS.open, request);
  }

  async requestAction(request: PraxionActionRequest): Promise<PraxionActionResponse> {
    const availability = await this.requireAvailable();
    if (!availability.capabilities.includes(actionCapability(request.action))) {
      return { accepted: false, supported: false, message: `Praxion does not advertise ${actionCapability(request.action)}` };
    }
    const res = await this.transport.request<PraxionActionResponse | PraxionErrorEnvelope>({
      method: PRAXION_ENDPOINTS.action.method,
      path: PRAXION_ENDPOINTS.action.path,
      body: request,
      timeoutMs: this.requestTimeoutMs,
    });
    if (res.status === 422) {
      const envelope = isPraxionErrorEnvelope(res.body) ? res.body : null;
      return { accepted: false, supported: false, message: envelope?.error.message ?? `Praxion cannot perform ${request.action}` };
    }
    return this.settle<PraxionActionResponse>(PRAXION_ENDPOINTS.action.path, res);
  }

  async supports(capability: PraxionCapability): Promise<boolean> {
    const availability = await this.availability();
    return availability.state === "available" && availability.capabilities.includes(capability);
  }

  // -------------------------------------------------------------------------

  private async probe(): Promise<PraxionAvailability> {
    const res = await this.transport.request<unknown>({ method: "GET", path: PRAXION_ENDPOINTS.health.path, timeoutMs: this.probeTimeoutMs });
    return this.interpretHealth(res);
  }

  private interpretHealth(res: PraxionResponse<unknown>): PraxionAvailability {
    if (res.status === 0) {
      const kind = res.failure?.kind ?? "network";
      return { state: "unavailable", reason: kind === "timeout" ? "timeout" : "not_running", detail: res.failure?.message ?? "no response" };
    }
    if (res.status === 426) {
      const serverVersion = isPraxionHealth(res.body) ? res.body.contractVersion : "unknown";
      return { state: "incompatible", serverVersion, clientVersion: this.clientVersion };
    }
    if (res.status < 200 || res.status >= 300) {
      return { state: "unavailable", reason: "error", detail: `HTTP ${res.status} from health` };
    }
    if (!isPraxionHealth(res.body)) {
      return { state: "unavailable", reason: "error", detail: "health payload is not a Praxion health response" };
    }
    if (!isContractCompatible(res.body.contractVersion, this.clientVersion)) {
      return { state: "incompatible", serverVersion: res.body.contractVersion, clientVersion: this.clientVersion };
    }
    return {
      state: "available",
      contractVersion: res.body.contractVersion,
      appVersion: res.body.appVersion,
      capabilities: res.body.capabilities,
    };
  }

  private async requireAvailable(): Promise<Extract<PraxionAvailability, { state: "available" }>> {
    const availability = await this.availability();
    if (availability.state !== "available") throw new PraxionUnavailableError(availability);
    return availability;
  }

  /** GET helper: null when absent / incompatible / capability missing / 404 / connection lost. */
  private async read<T>(endpoint: PraxionEndpoint, capability: PraxionCapability, id?: string): Promise<T | null> {
    const availability = await this.availability();
    if (availability.state !== "available") return null;
    if (!availability.capabilities.includes(capability)) return null;
    const path = praxionPath(endpoint, id === undefined ? {} : { id });
    const res = await this.transport.request<T | PraxionErrorEnvelope>({ method: endpoint.method, path, timeoutMs: this.requestTimeoutMs });
    if (res.status === 0 || res.status === 426) {
      this.noteLost(res);
      return null;
    }
    if (res.status === 404) return null;
    return this.settle<T>(path, res);
  }

  /** POST helper: throws PraxionUnavailableError when Praxion cannot take the request. */
  private async write<T>(endpoint: PraxionEndpoint, body: unknown): Promise<T> {
    await this.requireAvailable();
    const res = await this.transport.request<T | PraxionErrorEnvelope>({ method: endpoint.method, path: endpoint.path, body, timeoutMs: this.requestTimeoutMs });
    if (res.status === 0 || res.status === 426) {
      const availability = this.noteLost(res);
      throw new PraxionUnavailableError(availability);
    }
    return this.settle<T>(endpoint.path, res);
  }

  private settle<T>(path: string, res: PraxionResponse<T | PraxionErrorEnvelope>): T {
    if (res.status >= 200 && res.status < 300) {
      if (isPraxionErrorEnvelope(res.body)) throw new PraxionRequestError(path, res.status, res.body);
      return res.body as T;
    }
    throw new PraxionRequestError(path, res.status, isPraxionErrorEnvelope(res.body) ? res.body : null);
  }

  /** Praxion went away (or changed) between the probe and this call: refresh the cache. */
  private noteLost(res: PraxionResponse<unknown>): Exclude<PraxionAvailability, { state: "available" }> {
    const availability = this.interpretHealth(res);
    this.cache = { value: availability, at: this.clock() };
    return availability.state === "available" ? { state: "unavailable", reason: "error", detail: "inconsistent response" } : availability;
  }
}
