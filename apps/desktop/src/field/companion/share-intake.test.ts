import { describe, expect, it } from "vitest";
import { DEV_USER_ID } from "@vixera/domain";
import { InMemorySpineStore } from "@vixera/sync";
import { createDevActionDispatcher } from "../../bootstrap/dev-fixtures.ts";
import { createMemoryArtifactStorage } from "../../data/storage.ts";
import type { ShareItem } from "../../platform/share.ts";
import { drainShares, intakeShares, splitShares } from "./share-intake.ts";

function share(over: Partial<ShareItem>): ShareItem {
  return { id: "s1", kind: "text", path: null, text: null, mimeType: null, filename: null, sizeBytes: null, title: null, receivedAt: "2026-09-10T09:00:00Z", ...over };
}

describe("share intake", () => {
  it("splits files from text and drops malformed items", () => {
    const { files, texts } = splitShares([share({ kind: "file", path: "/cache/a.pdf" }), share({ kind: "url", text: "https://x.example" }), share({ kind: "image", path: null })]);
    expect(files).toHaveLength(1);
    expect(texts).toHaveLength(1);
  });

  it("ingests text shares as ingest.submit(source: share) and reports completeness", async () => {
    const store = new InMemorySpineStore(DEV_USER_ID);
    const deps = { userId: DEV_USER_ID, deviceId: "droid", reader: store, storage: createMemoryArtifactStorage(), dispatch: createDevActionDispatcher(store) };
    const result = await intakeShares(deps, [share({ kind: "url", text: "https://x.example/brief", title: "Brief" }), share({ id: "s2", kind: "text", text: "remember this" })]);
    expect(result.complete).toBe(true);
    expect(result.submitted).toHaveLength(2);
    const items = await store.listIngestItems();
    expect(items.every((i) => i.source === "share" && i.deviceId === ("droid" as never))).toBe(true);
    const incomplete = await intakeShares(deps, [share({ id: "s3", kind: "file", path: null })]);
    expect(incomplete.complete).toBe(false);
  });
});

describe("share queue drain", () => {
  const world = () => {
    const store = new InMemorySpineStore(DEV_USER_ID);
    return { store, deps: { userId: DEV_USER_ID, deviceId: "droid", reader: store, storage: createMemoryArtifactStorage(), dispatch: createDevActionDispatcher(store) } };
  };

  it("ingests shares that arrive mid-batch and clears the queue once, after everything was dispatched", async () => {
    const w = world();
    const first = share({ id: "s1", kind: "text", text: "first" });
    const late = share({ id: "s2", kind: "url", text: "https://x.example/late" });
    let queue = [first];
    let reads = 0;
    let cleared = 0;
    const result = await drainShares(
      w.deps,
      {
        getPending: async () => {
          reads += 1;
          if (reads === 1) queue = [first, late];
          return { items: queue };
        },
        clear: async () => {
          cleared += 1;
          queue = [];
        },
      },
      [first],
    );
    expect(result.complete).toBe(true);
    expect(result.submitted.map((s) => s.title)).toEqual(["first", "x.example"]);
    expect(cleared).toBe(1);
    expect((await w.store.listIngestItems()).map((i) => i.kind).sort()).toEqual(["text", "url"]);
  });

  it("leaves the queue alone when a batch is incomplete", async () => {
    const w = world();
    let cleared = 0;
    const result = await drainShares(w.deps, { getPending: async () => ({ items: [] }), clear: async () => void (cleared += 1) }, [share({ id: "s3", kind: "file", path: null })]);
    expect(result.complete).toBe(false);
    expect(cleared).toBe(0);
    expect(await w.store.listIngestItems()).toEqual([]);
  });
});
