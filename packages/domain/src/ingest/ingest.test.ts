import { describe, expect, it } from "vitest";
import { normalizeIngestInput } from "./ingest.ts";

describe("ingest normalization", () => {
  it("classifies a shared PDF as a file that creates a document", () => {
    const n = normalizeIngestInput({ source: "share", filename: "invoice-0231.pdf", mimeType: "application/pdf", sizeBytes: 12000, storagePath: "u/x.pdf" });
    expect(n.kind).toBe("file");
    expect(n.createsDocument).toBe(true);
    expect(n.title).toBe("invoice-0231.pdf");
    expect(n.documentSource).toBe("share");
  });
  it("classifies images separately", () => {
    expect(normalizeIngestInput({ source: "capture", mimeType: "image/png", storagePath: "u/shot.png" }).kind).toBe("image");
  });
  it("detects URLs even when shared as text", () => {
    const n = normalizeIngestInput({ source: "share", text: "https://northwind.com/pricing" });
    expect(n.kind).toBe("url");
    expect(n.url).toBe("https://northwind.com/pricing");
    expect(n.title).toBe("northwind.com");
    expect(n.textContent).toBeNull();
  });
  it("keeps plain text as text without a document", () => {
    const n = normalizeIngestInput({ source: "clipboard", text: "Pilot seats 40 x $38" });
    expect(n.kind).toBe("text");
    expect(n.createsDocument).toBe(false);
    expect(n.mimeType).toBe("text/plain");
    expect(n.sizeBytes).toBe(20);
  });
});
