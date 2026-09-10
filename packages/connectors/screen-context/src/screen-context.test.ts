import { describe, expect, it } from "vitest";
import { ScreenContextRegistry } from "@vixera/domain";
import { FIXTURE_DOCUMENTS, InMemoryPraxion, InMemoryPraxionTransport, OPERATING_AGREEMENT, PraxionClient } from "@vixera/praxion";
import { ExplicitCaptureAdapter } from "./explicit-capture-adapter.ts";
import { PraxionStructuredContentAdapter } from "./praxion-adapter.ts";
import { createScreenContextRegistry } from "./registry.ts";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function praxionSetup(options: ConstructorParameters<typeof InMemoryPraxion>[0] = {}) {
  const praxion = new InMemoryPraxion({ documents: FIXTURE_DOCUMENTS, current: OPERATING_AGREEMENT.id, now: () => NOW, ...options });
  const connector = new PraxionClient(new InMemoryPraxionTransport(praxion));
  return { praxion, connector };
}

describe("PraxionStructuredContentAdapter", () => {
  it("is unavailable when Praxion is down and never throws", async () => {
    const { praxion, connector } = praxionSetup();
    praxion.down = true;
    const adapter = new PraxionStructuredContentAdapter(connector);
    expect(adapter.source).toBe("praxion");
    expect(await adapter.isAvailable()).toBe(false);
    expect(await adapter.getCurrentContext()).toBeNull();
  });

  it("is unavailable when the contract is incompatible", async () => {
    const { connector } = praxionSetup({ contractVersion: "2.0.0" });
    const adapter = new PraxionStructuredContentAdapter(connector);
    expect(await adapter.isAvailable()).toBe(false);
    expect(await adapter.getCurrentContext()).toBeNull();
  });

  it("builds a ScreenContext from the focused document, its content, location and selection", async () => {
    const { connector } = praxionSetup();
    const ctx = await new PraxionStructuredContentAdapter(connector).getCurrentContext();
    expect(ctx).toEqual({
      source: "praxion",
      capturedAt: NOW.toISOString(),
      document: {
        title: "Operating agreement v3.pdf",
        externalRef: OPERATING_AGREEMENT.path,
        mimeType: "application/pdf",
        praxionDocumentId: OPERATING_AGREEMENT.id,
      },
      location: OPERATING_AGREEMENT.location,
      selection: OPERATING_AGREEMENT.selection,
      structuredContent: OPERATING_AGREEMENT.blocks,
      text: null,
      metadata: { praxionDocumentId: OPERATING_AGREEMENT.id, pageCount: 18, blockCount: 7, contentAvailable: true, truncated: false },
    });
    // No Praxion wire shape leaks through: only domain fields.
    expect(Object.keys(ctx ?? {}).sort()).toEqual(["capturedAt", "document", "location", "metadata", "selection", "source", "structuredContent", "text"]);
  });

  it("returns null when no document is focused", async () => {
    const { praxion, connector } = praxionSetup();
    praxion.setCurrent(null);
    expect(await new PraxionStructuredContentAdapter(connector).isAvailable()).toBe(true);
    expect(await new PraxionStructuredContentAdapter(connector).getCurrentContext()).toBeNull();
  });

  it("truncates blocks to maxBlocks and flags it", async () => {
    const { connector } = praxionSetup();
    const ctx = await new PraxionStructuredContentAdapter(connector, { maxBlocks: 2 }).getCurrentContext();
    expect(ctx?.structuredContent).toHaveLength(2);
    expect(ctx?.metadata["truncated"]).toBe(true);
    expect(ctx?.metadata["blockCount"]).toBe(2);
  });

  it("still yields document + location when Praxion does not offer structured content", async () => {
    const { connector } = praxionSetup({ capabilities: ["current_context", "location", "selection"] });
    const ctx = await new PraxionStructuredContentAdapter(connector).getCurrentContext();
    expect(ctx?.document?.praxionDocumentId).toBe(OPERATING_AGREEMENT.id);
    expect(ctx?.structuredContent).toBeNull();
    expect(ctx?.metadata["contentAvailable"]).toBe(false);
    expect(ctx?.location?.page).toBe(7);
  });

  it("falls back to the location's selectionText when no explicit selection is reported", async () => {
    const { praxion, connector } = praxionSetup();
    praxion.setSelection(OPERATING_AGREEMENT.id, null);
    const ctx = await new PraxionStructuredContentAdapter(connector).getCurrentContext();
    expect(ctx?.selection).toBe("7.1 Distributions shall be made quarterly");
  });
});

describe("ExplicitCaptureAdapter", () => {
  it("is available only while a capture is held", async () => {
    const adapter = new ExplicitCaptureAdapter({ now: () => NOW });
    expect(adapter.source).toBe("explicit_capture");
    expect(await adapter.isAvailable()).toBe(false);
    expect(await adapter.getCurrentContext()).toBeNull();
    adapter.provide({ text: "  Call Eric about invoice 0231  ", title: "Note" });
    expect(await adapter.isAvailable()).toBe(true);
    expect(await adapter.getCurrentContext()).toEqual({
      source: "explicit_capture",
      capturedAt: NOW.toISOString(),
      document: null,
      location: null,
      selection: null,
      structuredContent: null,
      text: "Call Eric about invoice 0231",
      metadata: { title: "Note" },
    });
    adapter.clear();
    expect(await adapter.isAvailable()).toBe(false);
  });

  it("accepts a shared file as a document reference with blocks, deriving text", async () => {
    const adapter = new ExplicitCaptureAdapter({ now: () => NOW });
    const ctx = adapter.provide({
      title: "Invoice 0231.pdf",
      documentRef: { externalRef: "content://example/invoice-0231.pdf", mimeType: "application/pdf" },
      blocks: [
        { kind: "heading", text: "Invoice 0231", page: 1 },
        { kind: "paragraph", text: "Total due 4,800.00 USD", page: 1 },
      ],
      metadata: { surface: "android_share" },
    });
    expect(ctx.document).toEqual({ title: "Invoice 0231.pdf", externalRef: "content://example/invoice-0231.pdf", mimeType: "application/pdf", praxionDocumentId: null });
    expect(ctx.text).toBe("Invoice 0231\nTotal due 4,800.00 USD");
    expect(ctx.structuredContent).toHaveLength(2);
    expect(ctx.metadata).toEqual({ surface: "android_share", title: "Invoice 0231.pdf" });
  });

  it("rejects an empty capture and replaces the previous one on provide()", async () => {
    const adapter = new ExplicitCaptureAdapter();
    expect(() => adapter.provide({ text: "   " })).toThrow(TypeError);
    adapter.provide({ text: "first" });
    adapter.provide({ text: "second", capturedAt: "2026-09-10T11:00:00.000Z" });
    expect(await adapter.getCurrentContext()).toMatchObject({ text: "second", capturedAt: "2026-09-10T11:00:00.000Z" });
  });
});

describe("createScreenContextRegistry", () => {
  it("registers Praxion first and explicit capture second, nothing else", () => {
    const { connector } = praxionSetup();
    const registry = createScreenContextRegistry({ praxion: connector, explicit: new ExplicitCaptureAdapter() });
    expect(registry).toBeInstanceOf(ScreenContextRegistry);
    expect(registry.list().map((a) => a.source)).toEqual(["praxion", "explicit_capture"]);
  });

  it("prefers Praxion when it is available", async () => {
    const { connector } = praxionSetup();
    const explicit = new ExplicitCaptureAdapter();
    explicit.provide({ text: "shared text" });
    const registry = createScreenContextRegistry({ praxion: connector, explicit });
    expect((await registry.current())?.source).toBe("praxion");
  });

  it("falls through to explicit capture when Praxion is unavailable", async () => {
    const { praxion, connector } = praxionSetup();
    praxion.down = true;
    const explicit = new ExplicitCaptureAdapter();
    explicit.provide({ text: "shared text" });
    const registry = createScreenContextRegistry({ praxion: connector, explicit });
    const ctx = await registry.current();
    expect(ctx?.source).toBe("explicit_capture");
    expect(ctx?.text).toBe("shared text");
    expect((await registry.available()).map((a) => a.source)).toEqual(["explicit_capture"]);
  });

  it("falls through to explicit capture when Praxion is up but has nothing focused", async () => {
    const { praxion, connector } = praxionSetup();
    praxion.setCurrent(null);
    const explicit = new ExplicitCaptureAdapter();
    explicit.provide({ text: "shared text" });
    const registry = createScreenContextRegistry({ praxion: connector, explicit });
    expect((await registry.current())?.source).toBe("explicit_capture");
  });

  it("returns null when both are unavailable, and when nothing is registered", async () => {
    const { praxion, connector } = praxionSetup();
    praxion.down = true;
    const registry = createScreenContextRegistry({ praxion: connector, explicit: new ExplicitCaptureAdapter() });
    expect(await registry.current()).toBeNull();
    expect(await registry.available()).toEqual([]);
    expect(await createScreenContextRegistry().current()).toBeNull();
  });
});
