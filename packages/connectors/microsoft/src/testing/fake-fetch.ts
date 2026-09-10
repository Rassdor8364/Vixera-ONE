/**
 * Fake `fetch` for connector tests: routes matched in order against the
 * request URL, every call recorded (method, URL, headers, body) so tests can
 * assert what went over the wire and, just as importantly, what did not.
 * Web-standard only (`Request`/`Response`/`URL`); no Node imports.
 */
export interface RecordedCall {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface FakeReply {
  readonly status?: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

export interface FakeRequest {
  readonly call: RecordedCall;
  /** How many times this route matched before this call (0 on first hit). */
  readonly nth: number;
}

export interface FakeRoute {
  /** String = substring of the URL; RegExp = tested against the full URL. */
  readonly match: string | RegExp | ((url: URL, call: RecordedCall) => boolean);
  readonly method?: string;
  readonly reply: FakeReply | ((req: FakeRequest) => FakeReply | Promise<FakeReply>);
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly calls: RecordedCall[];
  /** Calls whose URL contains `fragment`. */
  callsTo(fragment: string | RegExp): RecordedCall[];
}

export function createFakeFetch(routes: readonly FakeRoute[]): FakeFetch {
  const calls: RecordedCall[] = [];
  const hits = new Map<FakeRoute, number>();

  const fetchImpl: typeof fetch = async (input, init) => {
    const call = record(input, init);
    calls.push(call);
    for (const route of routes) {
      if (route.method && route.method.toUpperCase() !== call.method) continue;
      if (!matches(route.match, call)) continue;
      const nth = hits.get(route) ?? 0;
      hits.set(route, nth + 1);
      const reply = typeof route.reply === "function" ? await route.reply({ call, nth }) : route.reply;
      return toResponse(reply);
    }
    throw new Error(`fake-fetch: no route for ${call.method} ${call.url.toString()}`);
  };

  return {
    fetch: fetchImpl,
    calls,
    callsTo: (fragment) => calls.filter((c) => (typeof fragment === "string" ? c.url.toString().includes(fragment) : fragment.test(c.url.toString()))),
  };
}

/** Returns reply N on the Nth match; the last reply repeats. */
export function sequence(...replies: readonly FakeReply[]): (req: FakeRequest) => FakeReply {
  return ({ nth }) => replies[Math.min(nth, replies.length - 1)] as FakeReply;
}

function matches(match: FakeRoute["match"], call: RecordedCall): boolean {
  if (typeof match === "string") return call.url.toString().includes(match);
  if (match instanceof RegExp) return match.test(call.url.toString());
  return match(call.url, call);
}

function record(input: RequestInfo | URL, init: RequestInit | undefined): RecordedCall {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers: Record<string, string> = {};
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (source) new Headers(source).forEach((value, key) => (headers[key.toLowerCase()] = value));
  const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : null;
  return { method, url, headers, body };
}

function toResponse(reply: FakeReply): Response {
  const status = reply.status ?? 200;
  const headers = new Headers(reply.headers ?? {});
  if (reply.json !== undefined) {
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    return new Response(JSON.stringify(reply.json), { status, headers });
  }
  return new Response(reply.text ?? (status === 204 ? null : ""), { status, headers });
}
