import assert from "node:assert/strict";
import { DEV_USER_ID, type UserId } from "@vixera/domain";
import { emptyCounts } from "@vixera/sync";
import { HttpError } from "../_shared/http.ts";
import type { BudgetedSyncReport } from "../_shared/sync.ts";

const USER = DEV_USER_ID as UserId;
const BASE = "https://x.supabase.co/functions/v1";

/** The production `userRequest`, reduced to its contract: one token is a session, anything else is 401. */
function fakeUserRequest(req: Request): Promise<{ userId: UserId }> {
  if (req.headers.get("authorization") === "Bearer user-token") return Promise.resolve({ userId: USER });
  return Promise.reject(new HttpError(401, "unauthorized", "Invalid or expired session"));
}

function report(overrides: Partial<BudgetedSyncReport> = {}): BudgetedSyncReport {
  return { startedAt: "2026-09-10T12:00:00.000Z", finishedAt: "2026-09-10T12:00:01.000Z", durationMs: 1000, accounts: 1, outcomes: [], ok: 0, errors: 0, skipped: 0, interrupted: 0, counts: emptyCounts(), skippedForBudget: 0, ...overrides };
}
import { InMemorySpineStore, MOCK_NOW, tickingClock, type SpineStore } from "@vixera/sync";
import { ingestProcessHandler, type IngestProcessDeps } from "./handler.ts";

function world() {
  const clock = tickingClock(MOCK_NOW, 1000);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  const deps: IngestProcessDeps = {
    userRequest: async (req) => ({ ...(await fakeUserRequest(req)), store }),
    now: clock,
    log: () => {},
  };
  return { handler: ingestProcessHandler(deps), store };
}

function item(store: SpineStore, patch: Partial<Parameters<SpineStore["createIngestItem"]>[0]>) {
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

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}/ingest-process/`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
const asUser = { authorization: "Bearer user-token" };

Deno.test("ingest-process: 401 without a session; a bad id is 400; an unknown id is 404", async () => {
  const w = world();
  assert.equal((await w.handler(post({}))).status, 401);
  assert.equal((await w.handler(post({ ingestItemId: "nope" }, asUser))).status, 400);
  const res = await w.handler(post({ ingestItemId: crypto.randomUUID() }, asUser));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, "not_found");
});

Deno.test("ingest-process: a file item becomes a document; asking again returns it as-is; no id processes every received item (text items carry no document)", async () => {
  const w = world();
  const invoice = await item(w.store, { kind: "file", source: "drop", title: "Invoice.pdf", mimeType: "application/pdf", storagePath: `${DEV_USER_ID}/drop/x.pdf`, metadata: { contentHash: "h1", sizeBytes: 42 } });
  const first = await (await w.handler(post({ ingestItemId: invoice.id }, asUser))).json();
  assert.equal(first.processed, 1);
  assert.equal(first.failed, 0);
  assert.equal(first.documentIds.length, 1);
  assert.deepEqual(first.items.map((i: { status: string; documentId: string | null }) => [i.status, i.documentId]), [["processed", first.documentIds[0]]]);
  assert.equal((await w.store.getIngestItem(invoice.id))?.status, "processed");

  // re-processing is idempotent: the same document, nothing new
  const again = await (await w.handler(post({ ingestItemId: invoice.id }, asUser))).json();
  assert.equal(again.processed, 1);
  assert.deepEqual(again.documentIds, first.documentIds);

  await item(w.store, { title: "A", textContent: "Call Eric about the invoice." });
  await item(w.store, { title: "B", textContent: "Book the room." });
  const all = await (await w.handler(post({}, asUser))).json();
  assert.equal(all.processed, 2);
  assert.deepEqual(all.documentIds, []); // a text item is its own subject: no document
  assert.equal((await w.store.listIngestItems({ status: "received", limit: 10 })).length, 0);
  assert.equal((await w.handler(post({}, asUser)).then((r) => r.json())).processed, 0);
});
