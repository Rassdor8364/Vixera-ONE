import { describe, expect, it } from "vitest";
import { PRAXION_CONTRACT_HEADER, PRAXION_CONTRACT_MAJOR, PRAXION_DEFAULT_BASE_URL } from "./contract.ts";
import { FetchPraxionTransport, PraxionTransportError, isLoopbackBaseUrl } from "./transport.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function fakeFetch(handler: (seen: Seen, init: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const entry: Seen = { url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null };
    seen.push(entry);
    return handler(entry, init ?? {});
  };
  return { fetch: impl, seen };
}

describe("loopback-only base URL", () => {
  it.each(["http://127.0.0.1:47815", "http://localhost:47815", "http://[::1]:47815", "http://127.0.0.2:1", "https://127.0.0.1/", PRAXION_DEFAULT_BASE_URL])(
    "accepts %s",
    (url) => {
      expect(isLoopbackBaseUrl(url)).toBe(true);
      expect(() => new FetchPraxionTransport(url, fakeFetch(() => new Response()).fetch)).not.toThrow();
    },
  );

  it.each([
    "http://praxion.example.com:47815",
    "http://10.0.0.5:47815",
    "http://0.0.0.0:47815",
    "http://192.168.1.10:47815",
    "http://localhost.example.com:47815",
    "ftp://127.0.0.1:47815",
    "file:///tmp/praxion",
    "not a url",
    "",
  ])("rejects %s at construction", (url) => {
    expect(isLoopbackBaseUrl(url)).toBe(false);
    expect(() => new FetchPraxionTransport(url, fakeFetch(() => new Response()).fetch)).toThrow(PraxionTransportError);
  });

  it("does not echo credentials or query strings from a rejected URL in the error", () => {
    let message = "";
    try {
      new FetchPraxionTransport("http://user:secret-pass@evil.example.com/?token=abc", fakeFetch(() => new Response()).fetch);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("secret-pass");
    expect(message).not.toContain("token=abc");
    expect(message).toContain("evil.example.com");
  });
});

describe("FetchPraxionTransport.request", () => {
  it("sends the contract major header, joins the path onto the base URL, and parses JSON", async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ app: "praxion" }), { status: 200, headers: { "content-type": "application/json" } }));
    const transport = new FetchPraxionTransport("http://127.0.0.1:47815/", fake.fetch);
    const res = await transport.request<{ app: string }>({ method: "GET", path: "/v1/health" });
    expect(res).toEqual({ status: 200, body: { app: "praxion" } });
    expect(fake.seen[0]?.url).toBe("http://127.0.0.1:47815/v1/health");
    expect(fake.seen[0]?.headers[PRAXION_CONTRACT_HEADER.toLowerCase()]).toBe(String(PRAXION_CONTRACT_MAJOR));
    expect(fake.seen[0]?.headers["content-type"]).toBeUndefined();
  });

  it("serializes POST bodies as JSON", async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const transport = new FetchPraxionTransport(PRAXION_DEFAULT_BASE_URL, fake.fetch);
    await transport.request({ method: "POST", path: "/v1/documents/open", body: { documentId: "d1", focus: true } });
    expect(fake.seen[0]?.method).toBe("POST");
    expect(fake.seen[0]?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(fake.seen[0]?.body ?? "null")).toEqual({ documentId: "d1", focus: true });
  });

  it("resolves status 0 (never throws) when the connection is refused", async () => {
    const fake = fakeFetch(() => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:47815") });
    });
    const transport = new FetchPraxionTransport(PRAXION_DEFAULT_BASE_URL, fake.fetch);
    const res = await transport.request({ method: "GET", path: "/v1/health" });
    expect(res.status).toBe(0);
    expect(res.body).toBeNull();
    expect(res.failure?.kind).toBe("network");
    expect(res.failure?.message).toContain("ECONNREFUSED");
  });

  it("aborts on timeout and reports failure kind 'timeout'", async () => {
    const fake = fakeFetch(
      (_seen, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }),
    );
    const transport = new FetchPraxionTransport(PRAXION_DEFAULT_BASE_URL, fake.fetch);
    const started = Date.now();
    const res = await transport.request({ method: "GET", path: "/v1/health", timeoutMs: 20 });
    expect(res.status).toBe(0);
    expect(res.failure?.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("returns a null body for empty, 204 and non-JSON responses without throwing", async () => {
    const replies = [new Response(null, { status: 204 }), new Response("", { status: 200 }), new Response("<html>nope</html>", { status: 502 })];
    const fake = fakeFetch(() => replies.shift() as Response);
    const transport = new FetchPraxionTransport(PRAXION_DEFAULT_BASE_URL, fake.fetch);
    expect(await transport.request({ method: "GET", path: "/a" })).toEqual({ status: 204, body: null });
    expect(await transport.request({ method: "GET", path: "/b" })).toEqual({ status: 200, body: null });
    expect(await transport.request({ method: "GET", path: "/c" })).toEqual({ status: 502, body: null });
  });

  it("keeps the 426 body so the client can read the server's version", async () => {
    const fake = fakeFetch(() => new Response(JSON.stringify({ app: "praxion", contractVersion: "2.0.0", appVersion: "x", capabilities: [] }), { status: 426 }));
    const transport = new FetchPraxionTransport(PRAXION_DEFAULT_BASE_URL, fake.fetch);
    const res = await transport.request<{ contractVersion: string }>({ method: "GET", path: "/v1/health" });
    expect(res.status).toBe(426);
    expect(res.body?.contractVersion).toBe("2.0.0");
  });
});
