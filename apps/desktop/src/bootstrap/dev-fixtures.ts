/**
 * DEV ONLY — in-memory world for `VITE_VIXERA_DEV_FIXTURES=true`.
 *
 * Builds `InMemorySpineStore(DEV_USER_ID)` + `ContextLinker` + `SyncEngine`
 * with the `MockConnector` from @vixera/sync/testing (the brief's world:
 * Eric's invoice, Priya's kickoff, the Northwind payout), runs one sync at
 * startup, and provides an in-memory action dispatcher that mimics the
 * `action-dispatch` Edge Function over the same `ActionEnvelope` shapes
 * (idempotent by key through `store.createActionRequest`).
 *
 * Nothing in this file is reachable from the production path; the
 * production Field always talks to the Edge Functions.
 */
import {
  ConnectorRegistry,
  InMemoryCredentialStore,
  isActionType,
  normalizeIngestInput,
  ref,
  type ActionEnvelope,
  type ActionOutcome,
  type ActionPayloads,
  type ActionType,
  type Document,
  type EntityType,
  type JsonObject,
  type RelationshipKind,
  type UserId,
} from "@vixera/domain";
import { ContextLinker, InMemorySpineStore, SyncEngine, type SpineStore, type SyncReport } from "@vixera/sync";
import { ERIC_EMAIL, MOCK_SELF_ADDRESS, MockConnector, seedMockAccount } from "@vixera/sync/testing";
import type { ActionDispatcher } from "../data/actions.ts";
import type { FieldServices } from "../data/services.ts";
import { createMemoryArtifactStorage, type ArtifactStorage } from "../data/storage.ts";

export interface DevWorld {
  readonly store: SpineStore;
  readonly dispatch: ActionDispatcher;
  readonly services: FieldServices;
  readonly storage: ArtifactStorage;
  readonly connector: MockConnector;
  /** Runs the mock sync (again). */
  readonly sync: () => Promise<SyncReport>;
}

export interface DevWorldOptions {
  readonly now?: () => Date;
  /** Seed the "Brand" thread around Eric's invoice. Default true. */
  readonly seedThreads?: boolean;
}

export async function createDevWorld(userId: UserId, options: DevWorldOptions = {}): Promise<DevWorld> {
  const now = options.now ?? (() => new Date());
  const store = new InMemorySpineStore(userId, { now });
  const credentials = new InMemoryCredentialStore();
  const connector = new MockConnector();
  const registry = new ConnectorRegistry().register(connector);
  const linker = new ContextLinker(store, { now, selfAddresses: [MOCK_SELF_ADDRESS] });
  const engine = new SyncEngine({ store, registry, credentials, linker, now });
  await seedMockAccount(store, credentials, { label: "Mock mail · calendar · bank" });

  const sync = () => engine.runAll();
  await sync();
  if (options.seedThreads !== false) await seedBrandThread(store, now);

  const storage = createMemoryArtifactStorage();
  const dispatch = createDevActionDispatcher(store, { now, sync });
  const services: FieldServices = {
    syncNow: () => sync(),
    async processIngest() {
      return { processed: 0, documentIds: [] };
    },
  };
  return { store, dispatch, services, storage, connector, sync };
}

/** The brief's "Brand" thread: Eric, his invoice mail and the invoice PDF attached. */
async function seedBrandThread(store: SpineStore, now: () => Date): Promise<void> {
  const eric = await store.findPersonByIdentity("email", ERIC_EMAIL);
  const brand = await store.createThread({ title: "Brand", kind: "project", status: "active", summary: "Brand identity work with Eric Lindqvist", metadata: {} });
  const threadRef = ref("thread", brand.id);
  if (eric) {
    await store.relate({ from: threadRef, kind: "has_person", to: ref("person", eric.id), source: "user" });
    for (const m of await store.listMailMessages({ fromPersonId: eric.id })) {
      await store.relate({ from: threadRef, kind: "has_mail", to: ref("mail_message", m.id), source: "user" });
      for (const n of await store.neighbors(ref("mail_message", m.id), { type: "document" })) {
        await store.relate({ from: threadRef, kind: "has_document", to: n.ref, source: "user" });
        await store.insertConclusion({
          subject: n.ref,
          text: "Invoice #0231 from Eric — $4,800, due tomorrow, no matching payment yet.",
          producedBy: "rule:dev-fixture",
          confidence: 0.6,
          metadata: {},
        });
      }
    }
    for (const tx of await store.listMoneyTransactions({ counterpartyPersonId: eric.id })) {
      await store.relate({ from: threadRef, kind: "has_money", to: ref("money_transaction", tx.id), source: "rule", confidence: 0.7 });
    }
  }
  void now;
}

export const ATTACH_KIND: Readonly<Record<string, RelationshipKind>> = {
  person: "has_person",
  document: "has_document",
  mail_message: "has_mail",
  time_event: "has_time",
  money_transaction: "has_money",
  money_account: "has_money",
};

export function attachKindFor(entityType: string): RelationshipKind {
  return ATTACH_KIND[entityType] ?? "relates_to";
}

export interface DevDispatcherOptions {
  readonly now?: () => Date;
  readonly sync?: () => Promise<SyncReport>;
}

/**
 * Mimics `action-dispatch`: record the request (idempotent by key), execute,
 * persist the outcome, return it; a replay returns the stored outcome with
 * `replayed: true` and never re-executes.
 */
export function createDevActionDispatcher(store: SpineStore, options: DevDispatcherOptions = {}): ActionDispatcher {
  const now = options.now ?? (() => new Date());
  return async (envelope) => {
    const { request, created } = await store.createActionRequest({
      actionType: envelope.actionType,
      idempotencyKey: envelope.idempotencyKey,
      payload: envelope.payload as unknown as JsonObject,
      actorDeviceId: envelope.actorDeviceId ?? null,
    });
    if (!created) {
      return { status: request.status === "failed" ? "failed" : "done", result: request.result, error: request.error, replayed: true, actionRequestId: request.id };
    }
    await store.updateActionRequest(request.id, { status: "running", attempts: request.attempts + 1 });
    try {
      const result = await executeDev(store, envelope, now, options.sync);
      await store.updateActionRequest(request.id, { status: "done", result, error: null });
      return { status: "done", result, error: null, replayed: false, actionRequestId: request.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.updateActionRequest(request.id, { status: "failed", result: null, error: message });
      return { status: "failed", result: null, error: message, replayed: false, actionRequestId: request.id };
    }
  };
}

async function executeDev(store: SpineStore, envelope: ActionEnvelope, now: () => Date, sync?: () => Promise<SyncReport>): Promise<JsonObject> {
  if (!isActionType(envelope.actionType)) throw new Error(`unknown action type ${String(envelope.actionType)}`);
  const type: ActionType = envelope.actionType;
  switch (type) {
    case "context_event.dismiss": {
      const p = envelope.payload as ActionPayloads["context_event.dismiss"];
      const ev = await store.setContextEventAttention(p.contextEventId, "dismissed");
      return { contextEventId: ev.id, attention: ev.attention };
    }
    case "context_event.quiet": {
      const p = envelope.payload as ActionPayloads["context_event.quiet"];
      const ev = await store.setContextEventAttention(p.contextEventId, "quiet");
      return { contextEventId: ev.id, attention: ev.attention };
    }
    case "context_event.snooze": {
      const p = envelope.payload as ActionPayloads["context_event.snooze"];
      const ev = await store.setContextEventAttention(p.contextEventId, "quiet", { snoozedUntil: p.until });
      return { contextEventId: ev.id, attention: ev.attention, until: p.until };
    }
    case "context_event.attend": {
      const p = envelope.payload as ActionPayloads["context_event.attend"];
      const ev = await store.setContextEventAttention(p.contextEventId, "needs_attention", { snoozedUntil: null });
      return { contextEventId: ev.id, attention: ev.attention };
    }
    case "thread.attach": {
      const p = envelope.payload as ActionPayloads["thread.attach"];
      const edge = await store.relate({ from: ref("thread", p.threadId), kind: attachKindFor(p.entityType), to: ref(p.entityType as EntityType, p.entityId), source: "user" });
      return { relationshipId: edge.id };
    }
    case "thread.create": {
      const p = envelope.payload as ActionPayloads["thread.create"];
      const thread = await store.createThread({ title: p.title, kind: p.kind ?? null, status: "active", summary: null, metadata: {} });
      for (const a of p.attach ?? []) {
        await store.relate({ from: ref("thread", thread.id), kind: attachKindFor(a.entityType), to: ref(a.entityType as EntityType, a.entityId), source: "user" });
      }
      return { threadId: thread.id };
    }
    case "handoff.create": {
      const p = envelope.payload as ActionPayloads["handoff.create"];
      const handoff = await store.createHandoff({
        sourceDeviceId: p.sourceDeviceId as never,
        targetDeviceId: (p.targetDeviceId ?? null) as never,
        state: "pending",
        focus: p.focus ? ref(p.focus.type as EntityType, p.focus.id) : null,
        threadId: (p.threadId ?? null) as never,
        documentId: (p.documentId ?? null) as never,
        artifactStoragePath: p.artifactStoragePath ?? null,
        praxionLocation: p.praxionLocation ?? null,
        conclusions: p.conclusions ?? [],
        commandHistory: p.commandHistory ?? [],
        deliveredAt: null,
        acceptedAt: null,
        expiresAt: new Date(now().getTime() + 24 * 3600_000).toISOString(),
        metadata: {},
      });
      return { handoffId: handoff.id };
    }
    case "handoff.accept": {
      const p = envelope.payload as ActionPayloads["handoff.accept"];
      const h = await store.updateHandoff(p.handoffId, { state: "accepted", acceptedAt: now().toISOString(), metadata: { acceptedBy: p.deviceId } });
      return { handoffId: h.id, state: h.state };
    }
    case "ingest.submit":
      return processIngestLocally(store, envelope.payload as ActionPayloads["ingest.submit"], now);
    case "connector.sync_now": {
      const report = sync ? await sync() : null;
      return { ok: report?.ok ?? 0, errors: report?.errors ?? 0 };
    }
    case "person.merge": {
      const p = envelope.payload as ActionPayloads["person.merge"];
      await store.updatePerson(p.mergedId, { mergedIntoId: p.survivorId as never });
      return { survivorId: p.survivorId };
    }
  }
}

/** Local equivalent of `ingest-process`: item → document (+ edge) → context event. */
async function processIngestLocally(store: SpineStore, p: ActionPayloads["ingest.submit"], now: () => Date): Promise<JsonObject> {
  const normalized = normalizeIngestInput({
    source: p.source,
    deviceId: p.deviceId ?? null,
    title: p.title ?? null,
    text: p.textContent ?? null,
    url: p.url ?? null,
    mimeType: p.mimeType ?? null,
    sizeBytes: p.sizeBytes ?? null,
    storagePath: p.storagePath ?? null,
    metadata: p.metadata ?? {},
  });
  const item = await store.createIngestItem({
    deviceId: normalized.deviceId as never,
    kind: normalized.kind,
    source: normalized.source,
    title: normalized.title,
    textContent: normalized.textContent,
    url: normalized.url,
    mimeType: normalized.mimeType,
    sizeBytes: normalized.sizeBytes,
    storagePath: normalized.storagePath,
    status: "received",
    documentId: null,
    error: null,
    metadata: normalized.metadata,
    processedAt: null,
  });
  let document: Document | null = null;
  if (normalized.createsDocument) {
    const contentHash = typeof normalized.metadata["contentHash"] === "string" ? normalized.metadata["contentHash"] : null;
    document = await store.upsertDocument({
      title: normalized.title ?? "Untitled",
      mimeType: normalized.mimeType,
      source: normalized.documentSource,
      connectorAccountId: null,
      sourceRef: { ingestItemId: item.id },
      location: normalized.storagePath
        ? { kind: "storage", bucket: "artifacts", path: normalized.storagePath }
        : normalized.url
          ? { kind: "url", url: normalized.url }
          : { kind: "none" },
      praxionDocumentId: null,
      sizeBytes: normalized.sizeBytes,
      contentHash,
      metadata: { ingestSource: normalized.source },
    });
    await store.relate({ from: ref("document", document.id), kind: "originated_from", to: ref("ingest_item", item.id), source: "rule" });
  }
  const subject = document ? ref("document", document.id) : ref("ingest_item", item.id);
  await store.upsertContextEvents([
    {
      // Same kind and importance as the server pipeline (supabase/functions/_shared/ingest.ts),
      // so dev mode and production produce comparable NOW items.
      kind: "ingest.received",
      subject,
      title: normalized.title ?? "Shared to Vixera",
      summary: normalized.textContent ? normalized.textContent.slice(0, 140) : normalized.url,
      occurredAt: now().toISOString(),
      importance: 40,
      dueAt: null,
      attention: "needs_attention",
      connectorAccountId: null,
      dedupeKey: `ingest:${item.id}`,
      metadata: { source: normalized.source, kind: normalized.kind },
    },
  ]);
  await store.updateIngestItem(item.id, { status: "processed", documentId: (document?.id ?? null) as never, processedAt: now().toISOString() });
  return { ingestItemId: item.id, documentId: document?.id ?? null };
}
