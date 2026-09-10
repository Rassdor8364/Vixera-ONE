import { describe, expect, it } from "vitest";
import { DEV_USER_ID } from "@vixera/domain";
import { InMemorySpineStore } from "@vixera/sync";
import { createDevActionDispatcher } from "../bootstrap/dev-fixtures.ts";
import { detectMimeType, ingestFiles, ingestKindFor, ingestStoragePath, ingestText, isUrlText, sanitizeFilename } from "./ingest.ts";
import { createMemoryArtifactStorage } from "./storage.ts";

describe("ingest naming", () => {
  it("sanitizes filenames for Storage object keys", () => {
    expect(sanitizeFilename("Lindqvist Invoice #0231 (final).pdf")).toBe("Lindqvist-Invoice-0231-final.pdf");
    expect(sanitizeFilename("C:\\Users\\me\\Desktop\\résumé.PDF")).toBe("resume.PDF");
    expect(sanitizeFilename("/tmp/../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("   ")).toBe("file");
    expect(sanitizeFilename("...")).toBe("file");
    const long = sanitizeFilename(`${"a".repeat(200)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(96);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("keys objects under the bound user id", () => {
    const path = ingestStoragePath(DEV_USER_ID, "11111111-1111-4111-8111-111111111111", "Eric invoice.pdf");
    expect(path).toBe(`${DEV_USER_ID}/ingest/11111111-1111-4111-8111-111111111111-Eric-invoice.pdf`);
    expect(path.startsWith(`${DEV_USER_ID}/`)).toBe(true);
  });

  it("detects mime types and kinds", () => {
    expect(detectMimeType("scan.PNG")).toBe("image/png");
    expect(detectMimeType("contract.pdf")).toBe("application/pdf");
    expect(detectMimeType("noext")).toBeNull();
    expect(ingestKindFor("image/jpeg")).toBe("image");
    expect(ingestKindFor("application/pdf")).toBe("file");
    expect(isUrlText(" https://example.com/x ")).toBe(true);
    expect(isUrlText("call Eric")).toBe(false);
  });
});

describe("ingest pipeline (dev dispatcher)", () => {
  const world = () => {
    const store = new InMemorySpineStore(DEV_USER_ID);
    const storage = createMemoryArtifactStorage();
    const dispatch = createDevActionDispatcher(store);
    return { store, storage, deps: { userId: DEV_USER_ID, deviceId: "device-1", reader: store, storage, dispatch } };
  };

  it("uploads bytes under the user prefix then submits ingest.submit with hash metadata", async () => {
    const w = world();
    const file = new File([new TextEncoder().encode("hello invoice")], "Invoice 0231.pdf", { type: "application/pdf" });
    const result = await ingestFiles(w.deps, [file], "drop");
    expect(result.failed).toEqual([]);
    expect(result.submitted).toHaveLength(1);
    const path = result.submitted[0]?.storagePath ?? "";
    expect(path.startsWith(`${DEV_USER_ID}/ingest/`)).toBe(true);
    expect(path.endsWith("-Invoice-0231.pdf")).toBe(true);
    expect(w.storage.objects.has(path)).toBe(true);
    const [item] = await w.store.listIngestItems();
    expect(item?.kind).toBe("file");
    expect(item?.source).toBe("drop");
    expect(item?.status).toBe("processed");
    expect(typeof item?.metadata["contentHash"]).toBe("string");
    const docs = await w.store.listDocuments();
    expect(docs[0]?.location).toEqual({ kind: "storage", bucket: "artifacts", path });
    expect(docs[0]?.contentHash).toBe(item?.metadata["contentHash"]);
  });

  it("does not upload the same bytes twice", async () => {
    const w = world();
    const bytes = new TextEncoder().encode("same bytes");
    await ingestFiles(w.deps, [new File([bytes], "a.pdf", { type: "application/pdf" })], "drop");
    const second = await ingestFiles(w.deps, [new File([bytes], "b.pdf", { type: "application/pdf" })], "drop");
    expect(second.submitted[0]?.deduplicated).toBe(true);
    expect(w.storage.objects.size).toBe(1);
  });

  it("ingests text and urls without touching storage", async () => {
    const w = world();
    const t = await ingestText(w.deps, "Call Eric about the invoice", "capture");
    expect(t.outcome.status).toBe("done");
    const u = await ingestText(w.deps, "https://example.com/brief", "share");
    expect(u.outcome.status).toBe("done");
    const items = await w.store.listIngestItems();
    expect(items.map((i) => i.kind).sort()).toEqual(["text", "url"]);
    expect(w.storage.objects.size).toBe(0);
    await expect(ingestText(w.deps, "   ", "capture")).rejects.toThrow();
  });
});
