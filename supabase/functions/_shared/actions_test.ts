import assert from "node:assert/strict";
import { DEV_USER_ID, deriveNow, ref, type ActionEnvelope, type ActionType, type JsonObject } from "@vixera/domain";
import { InMemorySpineStore, MOCK_NOW, emptyCounts, tickingClock } from "@vixera/sync";
import { ACTION_HANDLERS, ActionError, dispatchAction, parseEnvelope, type ActionContext, type ActionHandlers } from "./actions.ts";
import { HttpError } from "./http.ts";
import type { BudgetedSyncReport } from "./sync.ts";

function world() {
  const clock = tickingClock(MOCK_NOW, 1000);
  const store = new InMemorySpineStore(DEV_USER_ID, { now: clock });
  const syncCalls: { accountId: string | null }[] = [];
  const ctx: ActionContext = {
    now: clock,
    actorDeviceId: null,
    runSync: ({ accountId }) => {
      syncCalls.push({ accountId });
      const at = clock().toISOString();
      const report: BudgetedSyncReport = { startedAt: at, finishedAt: at, durationMs: 0, accounts: 0, outcomes: [], ok: 0, errors: 0, skipped: 0, counts: emptyCounts(), skippedForBudget: 0 };
      return Promise.resolve(report);
    },
  };
  return { store, ctx, clock, syncCalls };
}

function envelope<T extends ActionType>(actionType: T, payload: JsonObject, idempotencyKey = `${actionType}:test`): ActionEnvelope {
  return parseEnvelope({ actionType, idempotencyKey, payload });
}

function device(store: InMemorySpineStore, name: string) {
  return store.upsertDevice({ platform: "windows", name, praxionAvailable: false, lastSeenAt: null });
}

Deno.test("dispatch: the same idempotency key replays the stored outcome and runs the handler once", async () => {
  const { store, ctx } = world();
  let runs = 0;
  const handlers: ActionHandlers = {
    ...ACTION_HANDLERS,
    "thread.create": (s, p, c) => {
      runs++;
      return ACTION_HANDLERS["thread.create"](s, p, c);
    },
  };
  const env = envelope("thread.create", { title: "Brand" }, "key-1");
  const first = await dispatchAction(store, env, ctx, { handlers });
  const second = await dispatchAction(store, env, ctx, { handlers });
  assert.equal(first.status, "done");
  assert.equal(first.replayed, false);
  assert.equal(second.status, "done");
  assert.equal(second.replayed, true);
  assert.equal(second.actionRequestId, first.actionRequestId);
  assert.deepEqual(second.result, first.result);
  assert.equal(runs, 1);
  assert.equal((await store.listThreads()).length, 1);
  const request = await store.getActionRequest(first.actionRequestId);
  assert.equal(request?.status, "done");
  assert.equal(request?.attempts, 1);
});

Deno.test("dispatch: a failing handler records failed and the replay returns the failure without re-executing", async () => {
  const { store, ctx } = world();
  let runs = 0;
  const handlers: ActionHandlers = {
    ...ACTION_HANDLERS,
    "context_event.quiet": () => {
      runs++;
      return Promise.reject(new ActionError("boom"));
    },
  };
  const env = envelope("context_event.quiet", { contextEventId: crypto.randomUUID() }, "key-fail");
  const first = await dispatchAction(store, env, ctx, { handlers });
  assert.equal(first.status, "failed");
  assert.equal(first.error, "boom");
  assert.equal(first.result, null);
  const replay = await dispatchAction(store, env, ctx, { handlers });
  assert.equal(replay.status, "failed");
  assert.equal(replay.replayed, true);
  assert.equal(replay.error, "boom");
  assert.equal(runs, 1);
});

Deno.test("dispatch: a request still running answers 409 in_progress; a stale one is retried", async () => {
  const { store, ctx, clock } = world();
  const env = envelope("thread.create", { title: "Later" }, "key-running");
  const { request } = await store.createActionRequest({ actionType: env.actionType, idempotencyKey: env.idempotencyKey, payload: env.payload as JsonObject });
  await store.updateActionRequest(request.id, { status: "running", attempts: 1 });
  await assert.rejects(() => dispatchAction(store, env, ctx), (err: unknown) => err instanceof HttpError && err.status === 409 && err.code === "in_progress");
  // Same key, but the run is older than the edge runtime limit: retry-safe.
  const stale: ActionContext = { ...ctx, now: () => new Date(clock().getTime() + 11 * 60_000) };
  const outcome = await dispatchAction(store, env, stale);
  assert.equal(outcome.status, "done");
  assert.equal((await store.getActionRequest(request.id))?.attempts, 2);

  // A freshly queued row belongs to a concurrent request: 409; a stale queued row is picked up.
  const queued = envelope("thread.create", { title: "Queued" }, "key-queued");
  await store.createActionRequest({ actionType: queued.actionType, idempotencyKey: queued.idempotencyKey, payload: queued.payload as JsonObject });
  await assert.rejects(() => dispatchAction(store, queued, ctx), (err: unknown) => err instanceof HttpError && err.code === "in_progress");
  const later: ActionContext = { ...ctx, now: () => new Date(clock().getTime() + 60_000) };
  assert.equal((await dispatchAction(store, queued, later)).status, "done");
});

Deno.test("dispatch: reusing a key for a different action type is a conflict", async () => {
  const { store, ctx } = world();
  await dispatchAction(store, envelope("thread.create", { title: "A" }, "shared"), ctx);
  const sameType = await dispatchAction(store, envelope("thread.create", { title: "B", kind: "x" }, "shared"), ctx);
  assert.equal(sameType.replayed, true);
  assert.equal((await store.listThreads()).length, 1);
  await assert.rejects(
    () => dispatchAction(store, envelope("context_event.dismiss", { contextEventId: crypto.randomUUID() }, "shared"), ctx),
    (err: unknown) => err instanceof HttpError && err.status === 409 && err.code === "conflict",
  );
});

Deno.test("parseEnvelope rejects bad envelopes and payloads with 400", () => {
  const bad = (raw: unknown, code: string) => assert.throws(() => parseEnvelope(raw), (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === code);
  bad(null, "invalid_envelope");
  bad({ actionType: "nope", idempotencyKey: "k", payload: {} }, "invalid_envelope");
  bad({ actionType: "thread.create", idempotencyKey: "", payload: {} }, "invalid_envelope");
  bad({ actionType: "thread.create", idempotencyKey: "k", payload: "x" }, "invalid_envelope");
  bad({ actionType: "thread.create", idempotencyKey: "k", payload: {} }, "invalid_payload");
  bad({ actionType: "context_event.snooze", idempotencyKey: "k", payload: { contextEventId: crypto.randomUUID(), until: "tomorrow" } }, "invalid_payload");
  bad({ actionType: "thread.attach", idempotencyKey: "k", payload: { threadId: crypto.randomUUID(), entityType: "banana", entityId: crypto.randomUUID() } }, "invalid_payload");
  bad({ actionType: "ingest.submit", idempotencyKey: "k", payload: { kind: "text", source: "share" } }, "invalid_payload");
  bad({ actionType: "person.merge", idempotencyKey: "k", payload: { survivorId: "a", mergedId: "a" } }, "invalid_payload");
  const ok = parseEnvelope({ actionType: "context_event.quiet", idempotencyKey: " k ", payload: { contextEventId: crypto.randomUUID() }, actorDeviceId: null });
  assert.equal(ok.idempotencyKey, "k");
});

Deno.test("context_event.quiet moves the event into NOW's quiet bucket; dismiss removes it", async () => {
  const { store, ctx, clock } = world();
  const subjectItem = await store.createIngestItem({ deviceId: null, kind: "text", source: "share", title: "Invoice", textContent: "x", url: null, mimeType: null, sizeBytes: null, storagePath: null, status: "received", documentId: null, error: null, metadata: {}, processedAt: null });
  const events = await store.upsertContextEvents([
    { kind: "mail.received", subject: ref("ingest_item", subjectItem.id), title: "Invoice", summary: null, occurredAt: clock().toISOString(), importance: 90, dueAt: null, attention: "needs_attention", connectorAccountId: null, dedupeKey: "t:1", metadata: {} },
  ]);
  const ev = events.rows[0]!;
  const before = deriveNow({ contextEvents: [ev], timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: clock() });
  assert.equal(before.needsMe.length, 1);

  const quiet = await dispatchAction(store, envelope("context_event.quiet", { contextEventId: ev.id }), ctx);
  assert.equal(quiet.status, "done");
  const after = deriveNow({ contextEvents: await store.listContextEvents(), timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: clock() });
  assert.equal(after.needsMe.length, 0);
  assert.equal(after.quiet.length, 1);
  assert.ok(after.quiet[0]!.reasons.includes("user marked quiet"));

  const until = new Date(clock().getTime() + 3600_000).toISOString();
  const snooze = await dispatchAction(store, envelope("context_event.snooze", { contextEventId: ev.id, until }), ctx);
  assert.equal(snooze.status, "done");
  assert.equal((await store.getContextEvent(ev.id))?.metadata.snoozedUntil, until);

  await dispatchAction(store, envelope("context_event.dismiss", { contextEventId: ev.id }), ctx);
  const dismissed = deriveNow({ contextEvents: await store.listContextEvents(), timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: clock() });
  assert.equal(dismissed.quiet.length + dismissed.needsMe.length + dismissed.changed.length + dismissed.canWait.length, 0);

  const missing = await dispatchAction(store, envelope("context_event.quiet", { contextEventId: crypto.randomUUID() }, "missing"), ctx);
  assert.equal(missing.status, "failed");
});

Deno.test("handoff.create / handoff.accept lifecycle", async () => {
  const { store, ctx, clock } = world();
  const laptop = await device(store, "Laptop");
  const phone = await device(store, "Phone");
  const doc = await store.upsertDocument({ title: "Lindqvist-Invoice-0231.pdf", mimeType: "application/pdf", source: "share", connectorAccountId: null, sourceRef: {}, location: { kind: "none" }, praxionDocumentId: null, sizeBytes: null, contentHash: null, metadata: {} });

  const created = await dispatchAction(
    store,
    envelope("handoff.create", { sourceDeviceId: laptop.id, documentId: doc.id, praxionLocation: { page: 3, position: null, selectionText: "7.1" }, conclusions: ["Due tomorrow"] }, "h-create"),
    ctx,
  );
  assert.equal(created.status, "done", created.error ?? "");
  const handoffId = created.result!.handoffId as string;
  const handoff = await store.getHandoff(handoffId);
  assert.equal(handoff?.state, "pending");
  assert.equal(handoff?.praxionLocation?.page, 3);
  assert.equal(Date.parse(handoff!.expiresAt!) - Date.parse(handoff!.createdAt) >= 24 * 3600_000 - 5000, true);
  const events = await store.listContextEvents({ subject: ref("handoff", handoffId) });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "handoff.created");
  assert.equal(events[0]!.dedupeKey, `handoff:${handoffId}`);
  assert.ok(events[0]!.title.includes("Laptop"));

  const accepted = await dispatchAction(store, envelope("handoff.accept", { handoffId, deviceId: phone.id }, "h-accept"), ctx);
  assert.equal(accepted.status, "done", accepted.error ?? "");
  const after = await store.getHandoff(handoffId);
  assert.equal(after?.state, "accepted");
  assert.equal(after?.targetDeviceId, phone.id);
  assert.ok(after?.acceptedAt);
  assert.equal((await store.listContextEvents({ subject: ref("handoff", handoffId) }))[0]!.attention, "dismissed");

  // Accepting again from the same device is a no-op; from another device a failure.
  const again = await dispatchAction(store, envelope("handoff.accept", { handoffId, deviceId: phone.id }, "h-accept-2"), ctx);
  assert.equal(again.status, "done");
  assert.equal(again.result!.alreadyAccepted, true);
  const other = await dispatchAction(store, envelope("handoff.accept", { handoffId, deviceId: laptop.id }, "h-accept-3"), ctx);
  assert.equal(other.status, "failed");

  // Expired handoffs cannot be accepted.
  const second = await dispatchAction(store, envelope("handoff.create", { sourceDeviceId: laptop.id }, "h-create-2"), ctx);
  const secondId = second.result!.handoffId as string;
  const late: ActionContext = { ...ctx, now: () => new Date(clock().getTime() + 25 * 3600_000) };
  const expired = await dispatchAction(store, envelope("handoff.accept", { handoffId: secondId, deviceId: phone.id }, "h-accept-4"), late);
  assert.equal(expired.status, "failed");
  assert.match(expired.error ?? "", /expired/);
  assert.equal((await store.getHandoff(secondId))?.state, "expired");
});

Deno.test("thread.attach creates belongs_to and the typed thread edge; thread.create attaches too", async () => {
  const { store, ctx } = world();
  const eric = await store.upsertPerson({ displayName: "Eric Lindqvist", primaryEmail: "eric@lindqvist.example", organization: null, notes: null, metadata: {} });
  const doc = await store.upsertDocument({ title: "Invoice", mimeType: null, source: "share", connectorAccountId: null, sourceRef: {}, location: { kind: "none" }, praxionDocumentId: null, sizeBytes: null, contentHash: null, metadata: {} });
  const created = await dispatchAction(store, envelope("thread.create", { title: "Brand", kind: "project", attach: [{ entityType: "person", entityId: eric.id }] }, "t-create"), ctx);
  assert.equal(created.status, "done", created.error ?? "");
  const threadId = created.result!.threadId as string;

  const attach = await dispatchAction(store, envelope("thread.attach", { threadId, entityType: "document", entityId: doc.id }, "t-attach"), ctx);
  assert.equal(attach.status, "done", attach.error ?? "");
  assert.deepEqual(attach.result!.relationships, ["belongs_to", "has_document"]);

  const edges = await store.listRelationships();
  const has = (fromType: string, fromId: string, kind: string, toType: string, toId: string) =>
    edges.some((e) => e.from.type === fromType && e.from.id === fromId && e.kind === kind && e.to.type === toType && e.to.id === toId);
  assert.ok(has("person", eric.id, "belongs_to", "thread", threadId));
  assert.ok(has("thread", threadId, "has_person", "person", eric.id));
  assert.ok(has("document", doc.id, "belongs_to", "thread", threadId));
  assert.ok(has("thread", threadId, "has_document", "document", doc.id));
  assert.equal(edges.length, 4);

  // Re-attaching is idempotent.
  await dispatchAction(store, envelope("thread.attach", { threadId, entityType: "document", entityId: doc.id }, "t-attach-2"), ctx);
  assert.equal((await store.listRelationships()).length, 4);

  const missing = await dispatchAction(store, envelope("thread.attach", { threadId, entityType: "person", entityId: crypto.randomUUID() }, "t-attach-3"), ctx);
  assert.equal(missing.status, "failed");
});

Deno.test("ingest.submit creates the document and the context event, idempotent by key", async () => {
  const { store, ctx } = world();
  const env = envelope("ingest.submit", { kind: "file", source: "share", title: "Lindqvist-Invoice-0231.pdf", mimeType: "application/pdf", sizeBytes: 184233, storagePath: `${DEV_USER_ID}/share/inv.pdf`, metadata: { contentHash: "abc123" } }, "ingest-1");
  const first = await dispatchAction(store, env, ctx);
  assert.equal(first.status, "done", first.error ?? "");
  const documentId = first.result!.documentId as string;
  const doc = await store.getDocument(documentId);
  assert.equal(doc?.source, "share");
  assert.deepEqual(doc?.location, { kind: "storage", bucket: "artifacts", path: `${DEV_USER_ID}/share/inv.pdf` });
  assert.equal(doc?.contentHash, "abc123");
  const item = await store.getIngestItem(first.result!.ingestItemId as string);
  assert.equal(item?.status, "processed");
  assert.equal(item?.documentId, documentId);
  const events = await store.listContextEvents({ kindPrefix: "ingest." });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.importance, 40);

  const replay = await dispatchAction(store, env, ctx);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal((await store.listDocuments()).length, 1);
  assert.equal((await store.listIngestItems()).length, 1);

  const text = await dispatchAction(store, envelope("ingest.submit", { kind: "text", source: "clipboard", textContent: "Call Eric about the invoice" }, "ingest-2"), ctx);
  assert.equal(text.status, "done", text.error ?? "");
  assert.equal(text.result!.documentId, null);
  assert.equal((await store.listContextEvents({ kindPrefix: "ingest." })).length, 2);
});

Deno.test("connector.sync_now runs the sync for the requested account", async () => {
  const { store, ctx, syncCalls } = world();
  const account = await store.createConnectorAccount({ provider: "mock", externalAccountId: "m1", label: "Mock", address: null, capabilities: ["mail"], status: "active", credentialLocation: "none", credentialRef: null, lastError: null, metadata: {} });
  const outcome = await dispatchAction(store, envelope("connector.sync_now", { connectorAccountId: account.id }, "sync-1"), ctx);
  assert.equal(outcome.status, "done", outcome.error ?? "");
  assert.deepEqual(syncCalls, [{ accountId: account.id }]);
  const unknown = await dispatchAction(store, envelope("connector.sync_now", { connectorAccountId: crypto.randomUUID() }, "sync-2"), ctx);
  assert.equal(unknown.status, "failed");
  assert.equal(syncCalls.length, 1);
});

Deno.test("person.merge moves relationships to the survivor and marks the merged person", async () => {
  const { store, ctx } = world();
  const survivor = await store.upsertPerson({ displayName: "Eric Lindqvist", primaryEmail: null, organization: null, notes: null, metadata: {} });
  const merged = await store.upsertPerson({ displayName: "E. Lindqvist", primaryEmail: "eric@lindqvist.example", organization: "Lindqvist Studio", notes: null, metadata: {} });
  await store.upsertPersonIdentity({ personId: merged.id, kind: "email", value: "eric@lindqvist.example", rawValue: "eric@lindqvist.example", provider: "mock", connectorAccountId: null });
  const thread = await store.createThread({ title: "Brand", kind: null, status: "active", summary: null, metadata: {} });
  await store.relate({ from: ref("thread", thread.id), kind: "has_person", to: ref("person", merged.id) });
  await store.relate({ from: ref("person", merged.id), kind: "belongs_to", to: ref("thread", thread.id) });

  const outcome = await dispatchAction(store, envelope("person.merge", { survivorId: survivor.id, mergedId: merged.id }, "merge-1"), ctx);
  assert.equal(outcome.status, "done", outcome.error ?? "");
  assert.equal(outcome.result!.relationshipsMoved, 2);
  assert.equal((await store.getPerson(merged.id))?.mergedIntoId, survivor.id);
  assert.equal((await store.getPerson(survivor.id))?.primaryEmail, "eric@lindqvist.example");
  const edges = await store.listRelationships();
  assert.equal(edges.length, 2);
  assert.ok(edges.every((e) => (e.from.type === "person" ? e.from.id : e.to.id) === survivor.id));
  assert.equal((await store.listPeople()).length, 1);
  // Identities stay put (store contract); readers follow mergedIntoId.
  assert.equal((await store.findPersonByIdentity("email", "eric@lindqvist.example"))?.id, merged.id);

  const again = await dispatchAction(store, envelope("person.merge", { survivorId: survivor.id, mergedId: merged.id }, "merge-2"), ctx);
  assert.equal(again.result!.alreadyMerged, true);
});

Deno.test("context_event.attend brings a quiet item back and clears its snooze", async () => {
  const { store, ctx, clock } = world();
  const subject = await store.createIngestItem({ deviceId: null, kind: "text", source: "share", title: "Note", textContent: "x", url: null, mimeType: null, sizeBytes: null, storagePath: null, status: "received", documentId: null, error: null, metadata: {}, processedAt: null });
  const events = await store.upsertContextEvents([
    { kind: "ingest.received", subject: ref("ingest_item", subject.id), title: "Note", summary: null, occurredAt: clock().toISOString(), importance: 80, dueAt: null, attention: "needs_attention", connectorAccountId: null, dedupeKey: "t:attend", metadata: {} },
  ]);
  const ev = events.rows[0]!;
  const until = new Date(clock().getTime() + 3600_000).toISOString();
  await dispatchAction(store, envelope("context_event.snooze", { contextEventId: ev.id, until }), ctx);
  assert.equal((await store.getContextEvent(ev.id))?.attention, "quiet");

  const outcome = await dispatchAction(store, envelope("context_event.attend", { contextEventId: ev.id }), ctx);
  assert.equal(outcome.status, "done");
  const attended = await store.getContextEvent(ev.id);
  assert.equal(attended?.attention, "needs_attention");
  assert.equal(attended?.metadata.snoozedUntil, null);
  const now = deriveNow({ contextEvents: await store.listContextEvents(), timeEvents: [], moneyTransactions: [], threads: [], relationships: [], now: clock() });
  assert.equal(now.needsMe.length, 1);
});
