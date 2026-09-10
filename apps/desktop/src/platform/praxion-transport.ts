/**
 * `PraxionTransport` for the Tauri WebView.
 *
 * WebView `fetch` to `http://127.0.0.1:47815` is subject to CORS and Praxion
 * does not (and should not) send permissive CORS headers. The Tauri HTTP plugin
 * performs the request from Rust, so loopback calls bypass the WebView entirely.
 * Behaviour matches `FetchPraxionTransport` from `@vixera/praxion`: refused
 * connections, DNS failures and timeouts resolve to `status: 0` with a `failure`
 * descriptor; only a non-loopback base URL throws (at construction).
 *
 * The capability `http:default` in `capabilities/*.json` must allow
 * `http://127.0.0.1:*` for this to work (it does on desktop).
 */
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  isLoopbackBaseUrl,
  PRAXION_CONTRACT_HEADER,
  PRAXION_CONTRACT_MAJOR,
  PRAXION_DEFAULT_BASE_URL,
  PraxionTransportError,
  type PraxionRequest,
  type PraxionResponse,
  type PraxionTransport,
  type PraxionTransportFailureKind,
} from "@vixera/praxion";

export interface TauriPraxionTransportOptions {
  readonly defaultTimeoutMs?: number;
  readonly contractMajor?: number;
  /** Test seam; defaults to the Tauri HTTP plugin's fetch. */
  readonly fetchImpl?: typeof fetch;
}

export class TauriPraxionTransport implements PraxionTransport {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;
  private readonly contractMajor: number;

  constructor(baseUrl: string = PRAXION_DEFAULT_BASE_URL, options: TauriPraxionTransportOptions = {}) {
    if (!isLoopbackBaseUrl(baseUrl)) {
      throw new PraxionTransportError("Praxion base URL must be loopback (127.0.0.1, localhost or [::1])");
    }
    const url = new URL(baseUrl);
    url.search = "";
    url.hash = "";
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? (tauriFetch as typeof fetch);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 3000;
    this.contractMajor = options.contractMajor ?? PRAXION_CONTRACT_MAJOR;
  }

  async request<T>(input: PraxionRequest): Promise<PraxionResponse<T>> {
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
      const response = await this.fetchImpl(this.baseUrl + input.path, init);
      return { status: response.status, body: await parseJson<T>(response) };
    } catch (error) {
      const kind: PraxionTransportFailureKind = controller.signal.aborted ? "timeout" : "network";
      const message = kind === "timeout" ? `timed out after ${timeoutMs}ms` : describe(error);
      return { status: 0, body: null, failure: { kind, message } };
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
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "request failed";
}
