/**
 * Edge Function client. All calls are
 *   POST <supabaseUrl>/functions/v1/<name>
 *   Authorization: Bearer <session access token>, apikey: <anon key>, Content-Type: application/json
 * Errors arrive as `{ error: { code, message } }` and become `FunctionError`.
 */
export interface FunctionsClient {
  call<T>(name: string, body: unknown): Promise<T>;
}

export class FunctionError extends Error {
  constructor(
    readonly fn: string,
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FunctionError";
  }
}

export interface HttpFunctionsClientOptions {
  readonly baseUrl: string;
  readonly anonKey: string;
  /** Resolves the current access token; null ⇒ 401 before the request is made. */
  readonly accessToken: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
}

export function parseFunctionError(status: number, body: unknown): { code: string; message: string } {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === "string" ? err.code : status === 401 ? "unauthorized" : status === 409 ? "conflict" : "error";
  const message = typeof err?.message === "string" ? err.message : `request failed with status ${status}`;
  return { code, message };
}

export function createHttpFunctionsClient(options: HttpFunctionsClientOptions): FunctionsClient {
  const fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    async call<T>(name: string, body: unknown): Promise<T> {
      const token = await options.accessToken();
      if (!token) throw new FunctionError(name, 401, "unauthorized", "Not signed in");
      let response: Response;
      try {
        response = await fetchImpl(`${base}/${name}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            apikey: options.anonKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body ?? {}),
        });
      } catch (error) {
        throw new FunctionError(name, 0, "network", error instanceof Error ? error.message : "network error");
      }
      const text = await response.text();
      let parsed: unknown = null;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (!response.ok) {
        const { code, message } = parseFunctionError(response.status, parsed);
        throw new FunctionError(name, response.status, code, message);
      }
      return parsed as T;
    },
  };
}
