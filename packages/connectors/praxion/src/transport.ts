/**
 * Transport seam between the Praxion client and the wire.
 *
 * `PraxionTransport` is deliberately tiny so it can be backed by `fetch`
 * (dev, tests, WebView), the Tauri HTTP plugin, or later a named pipe / Unix
 * socket without touching the client. A transport never throws for a
 * connection that could not be made: it resolves `{ status: 0 }` and the
 * client degrades. Only programmer errors (bad base URL) throw.
 */
import { PRAXION_CONTRACT_HEADER, PRAXION_CONTRACT_MAJOR, PRAXION_DEFAULT_BASE_URL, type PraxionHttpMethod } from "./contract.ts";

export interface PraxionRequest {
  readonly method: PraxionHttpMethod;
  /** Absolute path within the contract, e.g. "/v1/health". */
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export type PraxionTransportFailureKind = "timeout" | "network";

export interface PraxionResponse<T> {
  /** HTTP status; 0 when no HTTP response was obtained (refused, DNS, timeout). */
  readonly status: number;
  /** Parsed JSON body, null when empty or not JSON. */
  readonly body: T | null;
  /** Present only when `status === 0`. */
  readonly failure?: { readonly kind: PraxionTransportFailureKind; readonly message: string };
}

export interface PraxionTransport {
  request<T>(input: PraxionRequest): Promise<PraxionResponse<T>>;
}

export class PraxionTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PraxionTransportError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Only loopback base URLs are acceptable: Praxion is a local product and
 * Vixera must never be talked into sending document context off the machine
 * through a misconfigured base URL. `127.0.0.0/8` addresses count as loopback.
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface FetchPraxionTransportOptions {
  /** Applied when a request does not specify its own timeout. */
  readonly defaultTimeoutMs?: number;
  /** Contract major announced in `X-Praxion-Contract`. Tests use it to provoke 426. */
  readonly contractMajor?: number;
}

export class FetchPraxionTransport implements PraxionTransport {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly contractMajor: number;

  constructor(baseUrl: string = PRAXION_DEFAULT_BASE_URL, fetchImpl?: typeof fetch, options: FetchPraxionTransportOptions = {}) {
    if (!isLoopbackBaseUrl(baseUrl)) {
      throw new PraxionTransportError(`Praxion base URL must be loopback (127.0.0.1, localhost or [::1]); got ${redact(baseUrl)}`);
    }
    const url = new URL(baseUrl);
    url.search = "";
    url.hash = "";
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 3000;
    this.contractMajor = options.contractMajor ?? PRAXION_CONTRACT_MAJOR;
  }

  async request<T>(input: PraxionRequest): Promise<PraxionResponse<T>> {
    const fetchImpl = this.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      return { status: 0, body: null, failure: { kind: "network", message: "fetch is not available in this runtime" } };
    }
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = {
      [PRAXION_CONTRACT_HEADER]: String(this.contractMajor),
      accept: "application/json",
    };
    const init: RequestInit = { method: input.method, headers, signal: controller.signal };
    if (input.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(input.body);
    }
    try {
      const response = await fetchImpl(this.baseUrl + input.path, init);
      return { status: response.status, body: await parseJson<T>(response) };
    } catch (error) {
      const kind: PraxionTransportFailureKind = controller.signal.aborted ? "timeout" : "network";
      return { status: 0, body: null, failure: { kind, message: kind === "timeout" ? `timed out after ${timeoutMs}ms` : describe(error) } };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function parseJson<T>(response: Response): Promise<T | null> {
  if (response.status === 204) return null;
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : "";
    return `${error.message}${causeMsg}`;
  }
  return String(error);
}

function redact(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<invalid url>";
  }
}
