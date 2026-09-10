import assert from "node:assert/strict";
import { DEV_USER_ID, ref, type IngestItem } from "@vixera/domain";
import { InMemorySpineStore, MOCK_NOW, tickingClock, type DocumentInput } from "@vixera/sync";
import { findMentions, ingestDedupeKey, processIngestItem } from "./ingest.ts";

function world() {
  const clock = tickingClock(MOCK_NOW, 1000);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  return { store, clock };
}

function item(store: InMemorySpineStore, patch: Partial<Omit<IngestItem, "id" | "userId" | "createdAt">>): Promise<IngestItem> {
  return store.createIngestItem({
    deviceId: null,
    kind: "text",
    source: "share",
    title: null,
    textContent: null,
    url: null,
    mimeType: null,
    sizeBytes: null,
    storagePath: null,
    status: "received",
    documentId: null,
    error: null,
    metadata: {},
    processedAt: null,
    ...patch,
  });
}

Deno.test("file item: document in Storage, marked processed, ingest.received emitted", async () => {
  const { store, clock } = world();
  const it = await item(store, { kind: "file", source: "drop", title: "Invoice.pdf", mimeType: "application/pdf", storagePath: `${DEV_USER_ID}/drop/x.pdf`, metadata: { contentHash: "h1", sizeBytes: 42 } });
  const result = await processIngestItem(store, it, { now: clock });
  assert.equal(result.status, "processed");
  const doc = await store.getDocument(result.documentId!);
  assert.equal(doc?.title, "Invoice.pdf");
  assert.equal(doc?.source, "drop");
  assert.equal(doc?.sizeBytes, 42);
  assert.deepEqual(doc?.location, { kind: "storage", bucket: "artifacts", path: `${DEV_USER_ID}/drop/x.pdf` });
  assert.deepEqual(doc?.sourceRef, { ingestItemId: it.id });
  const updated = await store.getIngestItem(it.id);
  assert.equal(updated?.status, "processed");
  assert.equal(updated?.documentId, doc?.id);
  assert.ok(updated?.processedAt);
  const events = await store.listContextEvents({ subject: ref("document", doc!.id) });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "ingest.received");
  assert.equal(events[0]!.dedupeKey, ingestDedupeKey(it.id));
  assert.equal(events[0]!.importance, 40);

  // Re-processing the same item is idempotent.
  const again = await processIngestItem(store, (await store.getIngestItem(it.id))!, { now: clock });
  assert.equal(again.documentId, doc!.id);
  assert.equal(again.documentReused, true);
  assert.equal((await store.listDocuments()).length, 1);
  assert.equal((await store.listContextEvents()).length, 1);
});

Deno.test("url item: document with a url location and host title", async () => {
  const { store, clock } = world();
  const it = await item(store, { kind: "url", source: "share", url: "https://northwind.example/agenda", mimeType: "text/uri-list" });
  const result = await processIngestItem(store, it, { now: clock });
  assert.equal(result.status, "processed");
  const doc = await store.getDocument(result.documentId!);
  assert.equal(doc?.title, "northwind.example");
  assert.deepEqual(doc?.location, { kind: "url", url: "https://northwind.example/agenda" });
  assert.equal((await store.listContextEvents())[0]!.summary, "https://northwind.example/agenda");
});

Deno.test("text item: no document; the ingest item is the event subject", async () => {
  const { store, clock } = world();
  const it = await item(store, { kind: "text", source: "clipboard", textContent: "Remember to pay the invoice" });
  const result = await processIngestItem(store, it, { now: clock });
  assert.equal(result.status, "processed");
  assert.equal(result.documentId, null);
  assert.equal((await store.listDocuments()).length, 0);
  const events = await store.listContextEvents();
  assert.deepEqual(events[0]!.subject, ref("ingest_item", it.id));
  assert.equal(events[0]!.title, "Remember to pay the invoice");
});

Deno.test("contentHash dedupe: a second item with the same hash reuses the document", async () => {
  const { store, clock } = world();
  const a = await item(store, { kind: "file", title: "a.pdf", storagePath: "u/a.pdf", metadata: { contentHash: "same" } });
  const b = await item(store, { kind: "image", source: "capture", title: "b.png", storagePath: "u/b.png", metadata: { contentHash: "same" } });
  const ra = await processIngestItem(store, a, { now: clock });
  const rb = await processIngestItem(store, b, { now: clock });
  assert.equal(rb.documentId, ra.documentId);
  assert.equal(rb.documentReused, true);
  assert.equal((await store.listDocuments()).length, 1);
  assert.equal((await store.getIngestItem(b.id))?.documentId, ra.documentId);
  // Both items still get their own context event (dedupe key is per item).
  assert.equal((await store.listContextEvents()).length, 2);
});

Deno.test("mentions: known people and thread titles in title + text become `mentions` edges", async () => {
  const { store, clock } = world();
  const eric = await store.upsertPerson({ displayName: "Eric Lindqvist", primaryEmail: null, organization: null, notes: null, metadata: {} });
  await store.upsertPerson({ displayName: "Priya Natarajan", primaryEmail: null, organization: null, notes: null, metadata: {} });
  const brand = await store.createThread({ title: "Brand", kind: null, status: "active", summary: null, metadata: {} });
  await store.createThread({ title: "Branding", kind: null, status: "active", summary: null, metadata: {} });
  const it = await item(store, { kind: "text", textContent: "Notes from ERIC LINDQVIST on the brand refresh. Rebranding later." });
  const result = await processIngestItem(store, it, { now: clock });
  assert.equal(result.relationships, 2);
  const edges = await store.listRelationships();
  assert.equal(edges.length, 2);
  for (const e of edges) {
    assert.equal(e.kind, "mentions");
    assert.equal(e.confidence, 0.6);
    assert.equal(e.source, "rule");
    assert.deepEqual(e.from, ref("ingest_item", it.id));
  }
  assert.ok(edges.some((e) => e.to.id === eric.id));
  assert.ok(edges.some((e) => e.to.id === brand.id));
  assert.deepEqual(findMentions("no one here", await store.listPeople(), await store.listThreads()), []);
});

Deno.test("explicit metadata.threadId / personId link the document instead of scanning", async () => {
  const { store, clock } = world();
  const eric = await store.upsertPerson({ displayName: "Eric Lindqvist", primaryEmail: null, organization: null, notes: null, metadata: {} });
  const brand = await store.createThread({ title: "Brand", kind: null, status: "active", summary: null, metadata: {} });
  const it = await item(store, { kind: "file", title: "Brand deck Eric Lindqvist.pdf", storagePath: "u/deck.pdf", metadata: { threadId: brand.id, personId: eric.id } });
  const result = await processIngestItem(store, it, { now: clock });
  assert.equal(result.status, "processed");
  const edges = await store.listRelationships();
  assert.deepEqual(edges.map((e) => e.kind).sort(), ["belongs_to", "has_person"]);
  assert.ok(edges.every((e) => e.from.type === "document" && e.from.id === result.documentId));
});

Deno.test("a failing store call marks the item failed with the error text", async () => {
  const { store, clock } = world();
  const it = await item(store, { kind: "file", title: "x", storagePath: "u/x" });
  const broken = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "upsertDocument") return (_input: DocumentInput) => Promise.reject(new Error("disk full"));
      return Reflect.get(target, prop, receiver);
    },
  });
  const result = await processIngestItem(broken, it, { now: clock });
  assert.equal(result.status, "failed");
  assert.equal(result.error, "disk full");
  const updated = await store.getIngestItem(it.id);
  assert.equal(updated?.status, "failed");
  assert.equal(updated?.error, "disk full");
  assert.equal((await store.listContextEvents()).length, 0);
});
