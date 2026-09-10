import { describe, expect, it } from "vitest";
import { PRAXION_CONTRACT_VERSION, PRAXION_ENDPOINTS } from "./contract.ts";
import { PraxionClient, PraxionRequestError, PraxionUnavailableError } from "./connector.ts";
import type { PraxionRequest, PraxionResponse, PraxionTransport } from "./transport.ts";
import { InMemoryPraxion, InMemoryPraxionTransport } from "./testing/in-memory-praxion.ts";
import { FIXTURE_DOCUMENTS, INVOICE_0231, OPERATING_AGREEMENT } from "./testing/fixtures.ts";

/** A canned transport whose bodies are untyped (what a stranger on the port would send). */
function stubTransport(reply: (input: PraxionRequest) => PraxionResponse<unknown>): PraxionTransport {
  return { request: async <T>(input: PraxionRequest) => reply(input) as PraxionResponse<T> };
}

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

function setup(options: ConstructorParameters<typeof InMemoryPraxion>[0] = {}, clientOptions: ConstructorParameters<typeof PraxionClient>[1] = {}) {
  const praxion = new InMemoryPraxion({ documents: FIXTURE_DOCUMENTS, current: OPERATING_AGREEMENT.id, now: () => new Date("2026-09-10T12:00:00.000Z"), ...options });
  const clock = fakeClock();
  const client = new PraxionClient(new InMemoryPraxionTransport(praxion), { clock: clock.now, ...clientOptions });
  return { praxion, client, clock };
}

describe("availability when Praxion is not running", () => {
  it("resolves unavailable/not_running on status 0 and never throws", async () => {
    const { praxion, client } = setup({}, {});
    praxion.down = true;
    await expect(client.availability()).resolves.toEqual({ state: "unavailable", reason: "not_running", detail: expect.stringContaining("refused") });
  });

  it("caches the probe for cacheMs, then re-probes", async () => {
    const { praxion, clock } = setup({}, { cacheMs: 5000 });
    praxion.down = true;
    // Down: the transport never reaches the fake, so count through a spying transport.
    let calls = 0;
    const counting = new PraxionClient(
      {
        request: async (input) => {
          calls += 1;
          return new InMemoryPraxionTransport(praxion).request(input);
        },
      },
      { clock: clock.now, cacheMs: 5000 },
    );
    expect((await counting.availability()).state).toBe("unavailable");
    expect(await counting.currentContext()).toBeNull();
    expect(await counting.getContent(OPERATING_AGREEMENT.id)).toBeNull();
    expect(await counting.getLocation(OPERATING_AGREEMENT.id)).toBeNull();
    expect(await counting.getSelection(OPERATING_AGREEMENT.id)).toBeNull();
    expect(await counting.getDocument(OPERATING_AGREEMENT.id)).toBeNull();
    expect(await counting.supports("open")).toBe(false);
    expect(calls).toBe(1);
    expect(praxion.requests).toHaveLength(0);

    clock.advance(4999);
    await counting.availability();
    expect(calls).toBe(1);

    clock.advance(2);
    praxion.down = false;
    expect((await counting.availability()).state).toBe("available");
    expect(calls).toBe(2);
  });

  it("deduplicates concurrent probes", async () => {
    const { praxion, clock } = setup();
    let calls = 0;
    const counting = new PraxionClient(
      {
        request: async (input) => {
          calls += 1;
          return new InMemoryPraxionTransport(praxion).request(input);
        },
      },
      { clock: clock.now },
    );
    await Promise.all([counting.availability(), counting.availability(), counting.currentContext()]);
    expect(calls).toBe(2); // one probe + one current-context read
  });

  it("reports timeout as its own reason", async () => {
    const praxion = new InMemoryPraxion();
    const client = new PraxionClient(new InMemoryPraxionTransport(praxion, { latencyMs: 10_000 }));
    await expect(client.availability()).resolves.toMatchObject({ state: "unavailable", reason: "timeout" });
  });

  it("openDocument and requestAction throw PraxionUnavailableError while down", async () => {
    const { praxion, client } = setup();
    praxion.down = true;
    await expect(client.openDocument({ documentId: INVOICE_0231.id })).rejects.toBeInstanceOf(PraxionUnavailableError);
    await expect(client.requestAction({ action: "goto", documentId: INVOICE_0231.id, params: { page: 2 } })).rejects.toBeInstanceOf(PraxionUnavailableError);
    await expect(client.health()).rejects.toBeInstanceOf(PraxionUnavailableError);
  });

  it("invalidate() forces the next call to re-probe", async () => {
    const { praxion, client } = setup();
    praxion.down = true;
    expect((await client.availability()).state).toBe("unavailable");
    praxion.down = false;
    expect((await client.availability()).state).toBe("unavailable");
    client.invalidate();
    expect((await client.availability()).state).toBe("available");
  });
});

describe("contract version handling", () => {
  it("server with a newer major answers 426 -> incompatible, reads return null, one probe only", async () => {
    const { praxion, client } = setup({ contractVersion: "2.0.0" });
    await expect(client.availability()).resolves.toEqual({ state: "incompatible", serverVersion: "2.0.0", clientVersion: PRAXION_CONTRACT_VERSION });
    expect(await client.getContent(OPERATING_AGREEMENT.id)).toBeNull();
    expect(await client.currentContext()).toBeNull();
    expect(await client.supports("structured_content")).toBe(false);
    expect(praxion.requests.map((r) => r.path)).toEqual([PRAXION_ENDPOINTS.health.path]);
    await expect(client.openDocument({ documentId: INVOICE_0231.id })).rejects.toMatchObject({ name: "PraxionUnavailableError", availability: { state: "incompatible" } });
  });

  it("server with the same major but older minor -> incompatible (client-side rule)", async () => {
    const { client } = setup({ contractVersion: "1.0.0" }, { clientVersion: "1.3.0" });
    await expect(client.availability()).resolves.toEqual({ state: "incompatible", serverVersion: "1.0.0", clientVersion: "1.3.0" });
    expect(await client.getLocation(OPERATING_AGREEMENT.id)).toBeNull();
  });

  it("server with the same major and newer minor -> available", async () => {
    const { client } = setup({ contractVersion: "1.4.2" });
    await expect(client.availability()).resolves.toMatchObject({ state: "available", contractVersion: "1.4.2" });
  });

  it("health() still returns the payload of an incompatible server so the UI can explain", async () => {
    const { client } = setup({ contractVersion: "2.1.0", appVersion: "9.9.9" });
    await expect(client.health()).resolves.toMatchObject({ app: "praxion", contractVersion: "2.1.0", appVersion: "9.9.9" });
  });

  it("a 426 that arrives mid-session (Praxion upgraded) turns the cached availability incompatible", async () => {
    const { praxion, client } = setup();
    expect((await client.availability()).state).toBe("available");
    praxion.contractVersion = "3.0.0";
    expect(await client.getContent(OPERATING_AGREEMENT.id)).toBeNull();
    await expect(client.availability()).resolves.toMatchObject({ state: "incompatible", serverVersion: "3.0.0" });
  });

  it("a non-Praxion service on the port is 'unavailable/error', not 'available'", async () => {
    const client = new PraxionClient(stubTransport(() => ({ status: 200, body: { hello: "world" } })));
    await expect(client.availability()).resolves.toMatchObject({ state: "unavailable", reason: "error" });
  });
});

describe("happy paths through the in-memory transport", () => {
  it("availability exposes the server's capabilities", async () => {
    const { client } = setup({ capabilities: ["current_context", "structured_content", "action:goto"] });
    await expect(client.availability()).resolves.toEqual({
      state: "available",
      contractVersion: PRAXION_CONTRACT_VERSION,
      appVersion: "0.0.0-mock",
      capabilities: ["current_context", "structured_content", "action:goto"],
    });
    expect(await client.supports("action:goto")).toBe(true);
    expect(await client.supports("action:sign")).toBe(false);
  });

  it("currentContext returns the focused document with location and selection", async () => {
    const { client } = setup();
    const ctx = await client.currentContext();
    expect(ctx).toEqual({
      document: { id: OPERATING_AGREEMENT.id, title: "Operating agreement v3.pdf", path: OPERATING_AGREEMENT.path, mimeType: "application/pdf", pageCount: 18 },
      location: OPERATING_AGREEMENT.location,
      selection: OPERATING_AGREEMENT.selection,
      capturedAt: "2026-09-10T12:00:00.000Z",
    });
  });

  it("currentContext is null when nothing is focused", async () => {
    const { praxion, client } = setup();
    praxion.setCurrent(null);
    expect(await client.currentContext()).toBeNull();
  });

  it("getContent returns structured blocks and honours server truncation", async () => {
    const { client } = setup({ maxBlocks: 3 });
    const content = await client.getContent(OPERATING_AGREEMENT.id);
    expect(content?.documentId).toBe(OPERATING_AGREEMENT.id);
    expect(content?.blocks).toHaveLength(3);
    expect(content?.blocks[0]).toEqual({ kind: "heading", text: "Article 7 — Distributions", page: 7 });
    expect(content?.truncated).toBe(true);
  });

  it("getLocation / getSelection / getDocument read the document's state", async () => {
    const { praxion, client } = setup();
    expect(await client.getLocation(OPERATING_AGREEMENT.id)).toEqual(OPERATING_AGREEMENT.location);
    expect(await client.getSelection(OPERATING_AGREEMENT.id)).toBe(OPERATING_AGREEMENT.selection);
    expect(await client.getSelection(INVOICE_0231.id)).toBeNull();
    praxion.setSelection(INVOICE_0231.id, "4,800.00 USD");
    expect(await client.getSelection(INVOICE_0231.id)).toBe("4,800.00 USD");
    expect(await client.getDocument(INVOICE_0231.id)).toMatchObject({ id: INVOICE_0231.id, sizeBytes: 88_120, contentHash: INVOICE_0231.contentHash, metadata: { producer: "Praxion mock" } });
  });

  it("maps 404 to null for unknown documents", async () => {
    const { client } = setup();
    expect(await client.getDocument("nope")).toBeNull();
    expect(await client.getContent("nope")).toBeNull();
    expect(await client.getLocation("nope")).toBeNull();
    expect(await client.getSelection("nope")).toBeNull();
  });

  it("returns null for reads the server does not advertise, without a request", async () => {
    const { praxion, client } = setup({ capabilities: ["current_context"] });
    expect(await client.getContent(OPERATING_AGREEMENT.id)).toBeNull();
    expect(praxion.requests.map((r) => r.path)).toEqual([PRAXION_ENDPOINTS.health.path]);
  });

  it("openDocument focuses the document and applies the requested location", async () => {
    const { praxion, client } = setup();
    const opened = await client.openDocument({ documentId: INVOICE_0231.id, location: { page: 2, position: null, selectionText: null } });
    expect(opened.document.id).toBe(INVOICE_0231.id);
    expect(praxion.current).toBe(INVOICE_0231.id);
    expect((await client.currentContext())?.location).toEqual({ page: 2, position: null, selectionText: null });
    await expect(client.openDocument({})).rejects.toBeInstanceOf(TypeError);
    await expect(client.openDocument({ documentId: "nope" })).rejects.toBeInstanceOf(PraxionRequestError);
  });

  it("requestAction is accepted when advertised, supported:false when not (no request made)", async () => {
    const { praxion, client } = setup({ capabilities: ["current_context", "action:goto"] });
    await expect(client.requestAction({ action: "goto", documentId: INVOICE_0231.id, params: { page: 2 } })).resolves.toEqual({ accepted: true, supported: true, message: null });
    expect(praxion.actions).toHaveLength(1);
    const before = praxion.requests.length;
    await expect(client.requestAction({ action: "sign", documentId: INVOICE_0231.id, params: {} })).resolves.toMatchObject({ accepted: false, supported: false });
    expect(praxion.requests.length).toBe(before);
  });

  it("requestAction maps a server-side 422 to supported:false", async () => {
    const { praxion, client } = setup();
    await client.availability(); // cache advertises everything
    praxion.capabilities = ["current_context"]; // server drops support without restarting
    await expect(client.requestAction({ action: "compare", documentId: INVOICE_0231.id, params: {} })).resolves.toMatchObject({ accepted: false, supported: false, message: expect.stringContaining("compare") });
  });

  it("wraps unexpected statuses in PraxionRequestError with the envelope code", async () => {
    const client = new PraxionClient(
      stubTransport((input) =>
        input.path === PRAXION_ENDPOINTS.health.path
          ? { status: 200, body: { app: "praxion", contractVersion: PRAXION_CONTRACT_VERSION, appVersion: "x", capabilities: ["structured_content"] } }
          : { status: 500, body: { error: { code: "internal", message: "boom" } } },
      ),
    );
    await expect(client.getContent("d")).rejects.toMatchObject({ name: "PraxionRequestError", status: 500, code: "internal" });
  });
});
