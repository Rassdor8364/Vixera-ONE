/**
 * Server actions: the one seam through which notification actions and One
 * Command mutations change context state (ADR-005).
 *
 *   dispatchAction(store, envelope, ctx)
 *     1. validate the envelope + payload (hand-written guards, 400 on failure)
 *     2. createActionRequest — idempotent on (user, idempotencyKey)
 *     3. existing done/failed  → replay the stored outcome, never re-execute
 *        existing running      → 409 in_progress (unless stale: a run older
 *                                than the edge runtime limit can't still be alive;
 *                                a fresh "queued" row belongs to a concurrent
 *                                request and is 409 too, a stale one is retried)
 *     4. mark running (attempts + 1) → run the handler → mark done / failed
 *     5. return the ActionOutcome
 *
 * Every handler is idempotent on its own (set-attention, relate-by-natural-
 * key, state transitions that tolerate repeats), so a retry after a crash
 * between step 4's writes is safe. Handlers receive a store bound to the
 * request's user; they never see a user id.
 */
import {
  ACTION_TYPES,
  isActionType,
  isEntityType,
  isUuid,
  normalizeIngestInput,
  ref,
  type ActionEnvelope,
  type ActionOutcome,
  type ActionPayloads,
  type ActionRequest,
  type ActionType,
  type Attention,
  type EntityRef,
  type EntityType,
  type Handoff,
  type IngestItem,
  type JsonObject,
  type PersonId,
  type PraxionLocation,
  type RelationshipKind,
} from "@vixera/domain";
import { errorMessage, type SpineStore } from "@vixera/sync";
import { HttpError, isJsonObject } from "./http.ts";
import { processIngestItem } from "./ingest.ts";
import { summarizeReport, type BudgetedSyncReport } from "./sync.ts";

export const HANDOFF_TTL_MS = 24 * 3600_000;
export const KIND_HANDOFF_CREATED = "handoff.created";
export const HANDOFF_IMPORTANCE = 60;
/** A "running" request older than this cannot still be executing (edge runtime limit) and may be retried. */
export const STALE_RUNNING_MS = 10 * 60_000;
/** A "queued" request younger than this belongs to a concurrent request that is about to run it. */
export const STALE_QUEUED_MS = 30_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export interface ActionContext {
  readonly now: () => Date;
  readonly actorDeviceId: string | null;
  /** connector.sync_now: runs the sync engine for the request's user. */
  readonly runSync: (options: { readonly accountId: string | null }) => Promise<BudgetedSyncReport>;
  readonly log?: (message: string, data?: JsonObject) => void;
}

export type ActionHandler<T extends ActionType> = (store: SpineStore, payload: ActionPayloads[T], ctx: ActionContext) => Promise<JsonObject>;

export type ActionHandlers = { readonly [T in ActionType]: ActionHandler<T> };

/** Thrown by handlers for a business rule violation; recorded as `failed` with this message. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

// ---------------------------------------------------------------------------
// Envelope + payload validation
// ---------------------------------------------------------------------------
export function parseEnvelope(raw: unknown): ActionEnvelope {
  if (!isJsonObject(raw)) throw new HttpError(400, "invalid_envelope", "Body must be an ActionEnvelope object");
  const { actionType, idempotencyKey, payload, actorDeviceId } = raw;
  if (typeof actionType !== "string" || !isActionType(actionType)) {
    throw new HttpError(400, "invalid_envelope", `actionType must be one of ${ACTION_TYPES.join(", ")}`);
  }
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new HttpError(400, "invalid_envelope", `idempotencyKey must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (!isJsonObject(payload)) throw new HttpError(400, "invalid_envelope", "payload must be an object");
  if (actorDeviceId !== undefined && actorDeviceId !== null && (typeof actorDeviceId !== "string" || !isUuid(actorDeviceId))) {
    throw new HttpError(400, "invalid_envelope", "actorDeviceId must be a uuid or null");
  }
  const validated = validatePayload(actionType, payload);
  return { actionType, idempotencyKey: idempotencyKey.trim(), payload: validated, actorDeviceId: typeof actorDeviceId === "string" ? actorDeviceId : null } as ActionEnvelope;
}

type Raw = JsonObject;

function invalid(field: string, expectation: string): never {
  throw new HttpError(400, "invalid_payload", `payload.${field} ${expectation}`);
}

function uuidField(p: Raw, field: string, label = field): string {
  const v = p[field];
  if (typeof v !== "string" || !isUuid(v)) invalid(label, "must be a uuid");
  return v;
}

function optionalUuid(p: Raw, field: string): string | null {
  const v = p[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !isUuid(v)) invalid(field, "must be a uuid or null");
  return v;
}

function optionalString(p: Raw, field: string, max = 10_000): string | null {
  const v = p[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") invalid(field, "must be a string or null");
  if (v.length > max) invalid(field, `must be at most ${max} characters`);
  return v;
}

function requiredString(p: Raw, field: string, max = 10_000): string {
  const v = p[field];
  if (typeof v !== "string" || !v.trim()) invalid(field, "must be a non-empty string");
  if (v.length > max) invalid(field, `must be at most ${max} characters`);
  return v;
}

function optionalNumber(p: Raw, field: string): number | null {
  const v = p[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) invalid(field, "must be a non-negative number or null");
  return v;
}

function optionalStringArray(p: Raw, field: string): string[] {
  const v = p[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) invalid(field, "must be an array of strings");
  return v as string[];
}

function isoField(p: Raw, field: string): string {
  const v = p[field];
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) invalid(field, "must be an ISO-8601 timestamp");
  return new Date(v).toISOString();
}

function entityTypeField(p: Raw, field: string, label = field): EntityType {
  const v = p[field];
  if (typeof v !== "string" || !isEntityType(v)) invalid(label, "must be an entity type");
  return v;
}

function attachList(p: Raw, field: string): { entityType: EntityType; entityId: string }[] {
  const v = p[field];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) invalid(field, "must be an array");
  return v.map((item, i) => {
    if (!isJsonObject(item)) invalid(`${field}[${i}]`, "must be an object");
    return { entityType: entityTypeField(item, "entityType", `${field}[${i}].entityType`), entityId: uuidField(item, "entityId", `${field}[${i}].entityId`) };
  });
}

export function validatePayload<T extends ActionType>(actionType: T, p: Raw): ActionPayloads[T] {
  switch (actionType) {
    case "context_event.dismiss":
    case "context_event.quiet":
    case "context_event.attend":
      return { contextEventId: uuidField(p, "contextEventId") } as ActionPayloads[T];
    case "context_event.snooze":
      return { contextEventId: uuidField(p, "contextEventId"), until: isoField(p, "until") } as ActionPayloads[T];
    case "thread.attach":
      return { threadId: uuidField(p, "threadId"), entityType: entityTypeField(p, "entityType"), entityId: uuidField(p, "entityId") } as ActionPayloads[T];
    case "thread.create": {
      const kind = optionalString(p, "kind", 100);
      return { title: requiredString(p, "title", 500).trim(), ...(kind ? { kind } : {}), attach: attachList(p, "attach") } as ActionPayloads[T];
    }
    case "handoff.create": {
      const focusRaw = p.focus;
      let focus: EntityRef | null = null;
      if (focusRaw !== undefined && focusRaw !== null) {
        if (!isJsonObject(focusRaw)) invalid("focus", "must be an object or null");
        focus = { type: entityTypeField(focusRaw, "type", "focus.type"), id: uuidField(focusRaw, "id", "focus.id") };
      }
      const locRaw = p.praxionLocation;
      let praxionLocation: PraxionLocation | null = null;
      if (locRaw !== undefined && locRaw !== null) {
        if (!isJsonObject(locRaw)) invalid("praxionLocation", "must be an object or null");
        const page = locRaw.page;
        if (page !== undefined && page !== null && typeof page !== "number") invalid("praxionLocation.page", "must be a number or null");
        const position = locRaw.position;
        if (position !== undefined && position !== null && !isJsonObject(position)) invalid("praxionLocation.position", "must be an object or null");
        praxionLocation = { page: typeof page === "number" ? page : null, position: isJsonObject(position) ? position : null, selectionText: optionalString(locRaw, "selectionText") };
      }
      return {
        sourceDeviceId: uuidField(p, "sourceDeviceId"),
        targetDeviceId: optionalUuid(p, "targetDeviceId"),
        focus,
        threadId: optionalUuid(p, "threadId"),
        documentId: optionalUuid(p, "documentId"),
        artifactStoragePath: optionalString(p, "artifactStoragePath", 1000),
        praxionLocation,
        conclusions: optionalStringArray(p, "conclusions"),
        commandHistory: optionalStringArray(p, "commandHistory"),
      } as ActionPayloads[T];
    }
    case "handoff.accept":
      return { handoffId: uuidField(p, "handoffId"), deviceId: uuidField(p, "deviceId") } as ActionPayloads[T];
    case "ingest.submit": {
      const kind = p.kind;
      if (kind !== "file" && kind !== "image" && kind !== "url" && kind !== "text") invalid("kind", "must be file | image | url | text");
      const source = p.source;
      if (source !== "share" && source !== "capture" && source !== "drop" && source !== "clipboard" && source !== "command") invalid("source", "must be share | capture | drop | clipboard | command");
      const metadata = p.metadata;
      if (metadata !== undefined && metadata !== null && !isJsonObject(metadata)) invalid("metadata", "must be an object");
      const textContent = optionalString(p, "textContent", 200_000);
      const url = optionalString(p, "url", 4000);
      const storagePath = optionalString(p, "storagePath", 1000);
      if (kind === "text" && !textContent?.trim()) invalid("textContent", "is required for text items");
      if (kind === "url" && !url?.trim()) invalid("url", "is required for url items");
      if ((kind === "file" || kind === "image") && !storagePath?.trim() && !url?.trim()) invalid("storagePath", "or url is required for file / image items");
      return {
        deviceId: optionalUuid(p, "deviceId"),
        kind,
        source,
        title: optionalString(p, "title", 500),
        textContent,
        url,
        mimeType: optionalString(p, "mimeType", 200),
        sizeBytes: optionalNumber(p, "sizeBytes"),
        storagePath,
        metadata: isJsonObject(metadata) ? metadata : {},
      } as ActionPayloads[T];
    }
    case "connector.sync_now":
      return { connectorAccountId: optionalUuid(p, "connectorAccountId") } as ActionPayloads[T];
    case "person.merge": {
      const survivorId = uuidField(p, "survivorId");
      const mergedId = uuidField(p, "mergedId");
      if (survivorId === mergedId) invalid("mergedId", "must differ from survivorId");
      return { survivorId, mergedId } as ActionPayloads[T];
    }
  }
  throw new HttpError(400, "invalid_envelope", `Unsupported action ${String(actionType)}`);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
async function setAttention(store: SpineStore, contextEventId: string, attention: Attention, metadata?: JsonObject): Promise<JsonObject> {
  const existing = await store.getContextEvent(contextEventId);
  if (!existing) throw new ActionError(`context event ${contextEventId} not found`);
  const updated = await store.setContextEventAttention(contextEventId, attention, metadata);
  return { contextEventId: updated.id, attention: updated.attention };
}

/** The thread-side edge for an attached entity; null when only `belongs_to` applies. */
export function threadEdgeKind(entityType: EntityType): RelationshipKind | null {
  switch (entityType) {
    case "person":
      return "has_person";
    case "document":
      return "has_document";
    case "time_event":
      return "has_time";
    case "money_transaction":
    case "money_account":
      return "has_money";
    case "mail_message":
      return "has_mail";
    default:
      return null;
  }
}

async function attachToThread(store: SpineStore, threadId: string, entity: EntityRef): Promise<RelationshipKind[]> {
  const threadRef = ref("thread", threadId);
  if (entity.type === "thread" && entity.id === threadId) throw new ActionError("a thread cannot be attached to itself");
  const kinds: RelationshipKind[] = [];
  await store.relate({ from: entity, kind: "belongs_to", to: threadRef, source: "user" });
  kinds.push("belongs_to");
  const kind = threadEdgeKind(entity.type);
  if (kind) {
    await store.relate({ from: threadRef, kind, to: entity, source: "user" });
    kinds.push(kind);
  }
  return kinds;
}

export const ACTION_HANDLERS: ActionHandlers = {
  "context_event.dismiss": (store, { contextEventId }) => setAttention(store, contextEventId, "dismissed"),

  "context_event.quiet": (store, { contextEventId }) => setAttention(store, contextEventId, "quiet"),

  "context_event.snooze": async (store, { contextEventId, until }) => {
    const result = await setAttention(store, contextEventId, "quiet", { snoozedUntil: until });
    return { ...result, snoozedUntil: until };
  },

  // Back into the attention stream; any snooze is cleared so NOW scores it again.
  "context_event.attend": (store, { contextEventId }) => setAttention(store, contextEventId, "needs_attention", { snoozedUntil: null }),

  "thread.attach": async (store, { threadId, entityType, entityId }) => {
    if (!isEntityType(entityType)) throw new ActionError(`unknown entity type ${entityType}`);
    if (!(await store.getThread(threadId))) throw new ActionError(`thread ${threadId} not found`);
    const kinds = await attachToThread(store, threadId, ref(entityType, entityId));
    return { threadId, entityType, entityId, relationships: kinds };
  },

  "thread.create": async (store, { title, kind, attach }) => {
    const thread = await store.createThread({ title, kind: kind ?? null, status: "active", summary: null, metadata: {} });
    const attached: JsonObject[] = [];
    for (const a of attach ?? []) {
      if (!isEntityType(a.entityType)) throw new ActionError(`unknown entity type ${a.entityType}`);
      const kinds = await attachToThread(store, thread.id, ref(a.entityType, a.entityId));
      attached.push({ entityType: a.entityType, entityId: a.entityId, relationships: kinds });
    }
    return { threadId: thread.id, title: thread.title, attached };
  },

  "handoff.create": async (store, payload, ctx) => {
    const now = ctx.now();
    const source = await store.getDevice(payload.sourceDeviceId);
    if (!source) throw new ActionError(`device ${payload.sourceDeviceId} not found`);
    if (payload.targetDeviceId && !(await store.getDevice(payload.targetDeviceId))) throw new ActionError(`device ${payload.targetDeviceId} not found`);
    if (payload.threadId && !(await store.getThread(payload.threadId))) throw new ActionError(`thread ${payload.threadId} not found`);
    if (payload.documentId && !(await store.getDocument(payload.documentId))) throw new ActionError(`document ${payload.documentId} not found`);
    const focus = payload.focus && isEntityType(payload.focus.type) ? ref(payload.focus.type, payload.focus.id) : null;
    const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS).toISOString();
    const handoff = await store.createHandoff({
      sourceDeviceId: payload.sourceDeviceId as Handoff["sourceDeviceId"],
      targetDeviceId: (payload.targetDeviceId ?? null) as Handoff["targetDeviceId"],
      state: "pending",
      focus,
      threadId: (payload.threadId ?? null) as Handoff["threadId"],
      documentId: (payload.documentId ?? null) as Handoff["documentId"],
      artifactStoragePath: payload.artifactStoragePath ?? null,
      praxionLocation: payload.praxionLocation ?? null,
      conclusions: payload.conclusions ?? [],
      commandHistory: payload.commandHistory ?? [],
      deliveredAt: null,
      acceptedAt: null,
      expiresAt,
      metadata: {},
    });
    const document = payload.documentId ? await store.getDocument(payload.documentId) : null;
    const thread = payload.threadId ? await store.getThread(payload.threadId) : null;
    const title = document ? `Continue "${document.title}" from ${source.name}` : thread ? `Continue "${thread.title}" from ${source.name}` : `Handoff from ${source.name}`;
    const events = await store.upsertContextEvents([
      {
        kind: KIND_HANDOFF_CREATED,
        subject: ref("handoff", handoff.id),
        title,
        summary: payload.conclusions?.[0] ?? null,
        occurredAt: now.toISOString(),
        importance: HANDOFF_IMPORTANCE,
        dueAt: expiresAt,
        attention: "needs_attention",
        connectorAccountId: null,
        dedupeKey: `handoff:${handoff.id}`,
        metadata: { handoffId: handoff.id, sourceDeviceId: payload.sourceDeviceId, targetDeviceId: payload.targetDeviceId ?? null, threadId: payload.threadId ?? null, documentId: payload.documentId ?? null },
      },
    ]);
    return { handoffId: handoff.id, state: handoff.state, expiresAt, contextEventId: events.rows[0]?.id ?? null };
  },

  "handoff.accept": async (store, { handoffId, deviceId }, ctx) => {
    const now = ctx.now();
    const handoff = await store.getHandoff(handoffId);
    if (!handoff) throw new ActionError(`handoff ${handoffId} not found`);
    if (!(await store.getDevice(deviceId))) throw new ActionError(`device ${deviceId} not found`);
    if (handoff.state === "accepted") {
      if (handoff.targetDeviceId === deviceId) return { handoffId, state: "accepted", acceptedAt: handoff.acceptedAt, targetDeviceId: deviceId, alreadyAccepted: true };
      throw new ActionError(`handoff ${handoffId} was already accepted by another device`);
    }
    if (handoff.state === "cancelled") throw new ActionError(`handoff ${handoffId} was cancelled`);
    const expired = handoff.state === "expired" || (handoff.expiresAt !== null && Date.parse(handoff.expiresAt) <= now.getTime());
    if (expired) {
      if (handoff.state !== "expired") await store.updateHandoff(handoffId, { state: "expired" });
      throw new ActionError(`handoff ${handoffId} has expired`);
    }
    if (handoff.targetDeviceId && handoff.targetDeviceId !== deviceId) throw new ActionError(`handoff ${handoffId} targets another device`);
    const acceptedAt = now.toISOString();
    const updated = await store.updateHandoff(handoffId, { state: "accepted", acceptedAt, targetDeviceId: deviceId as Handoff["targetDeviceId"], deliveredAt: handoff.deliveredAt ?? acceptedAt });
    // The "handoff.created" prompt is resolved; take it out of NOW.
    for (const ev of await store.listContextEvents({ subject: ref("handoff", handoffId), kindPrefix: "handoff." })) {
      if (ev.attention !== "dismissed") await store.setContextEventAttention(ev.id, "dismissed");
    }
    return { handoffId, state: updated.state, acceptedAt, targetDeviceId: deviceId, alreadyAccepted: false };
  },

  "ingest.submit": async (store, payload, ctx) => {
    if (payload.deviceId && !(await store.getDevice(payload.deviceId))) throw new ActionError(`device ${payload.deviceId} not found`);
    const normalized = normalizeIngestInput({
      source: payload.source,
      deviceId: payload.deviceId ?? null,
      title: payload.title ?? null,
      text: payload.textContent ?? null,
      url: payload.url ?? null,
      mimeType: payload.mimeType ?? null,
      sizeBytes: payload.sizeBytes ?? null,
      storagePath: payload.storagePath ?? null,
      metadata: payload.metadata ?? {},
      ...(payload.kind === "file" || payload.kind === "image" ? { filename: payload.title ?? payload.storagePath?.split("/").pop() ?? "file" } : {}),
    });
    // The client's declared kind wins over detection (it saw the bytes / the share intent).
    const kind = payload.kind;
    const item = await store.createIngestItem({
      deviceId: (payload.deviceId ?? null) as IngestItem["deviceId"],
      kind,
      source: payload.source,
      title: normalized.title,
      textContent: kind === "url" ? null : normalized.textContent,
      url: kind === "url" ? (normalized.url ?? payload.url ?? null) : (payload.url ?? null),
      mimeType: payload.mimeType ?? (kind === "text" ? "text/plain" : kind === "url" ? "text/uri-list" : normalized.mimeType),
      sizeBytes: normalized.sizeBytes,
      storagePath: normalized.storagePath,
      status: "received",
      documentId: null,
      error: null,
      metadata: normalized.metadata,
      processedAt: null,
    });
    const result = await processIngestItem(store, item, { now: ctx.now, ...(ctx.log ? { log: ctx.log } : {}) });
    if (result.status === "failed") throw new ActionError(result.error ?? "ingest failed");
    return { ingestItemId: item.id, documentId: result.documentId, contextEventId: result.contextEventId, documentReused: result.documentReused, relationships: result.relationships };
  },

  "connector.sync_now": async (store, { connectorAccountId }, ctx) => {
    if (connectorAccountId && !(await store.getConnectorAccount(connectorAccountId))) throw new ActionError(`connector account ${connectorAccountId} not found`);
    const report = await ctx.runSync({ accountId: connectorAccountId ?? null });
    return summarizeReport(report);
  },

  /**
   * Person merge. The store contract has no "re-point identity" operation
   * (`upsertPersonIdentity` is idempotent on (kind, value) and returns the
   * existing row, still owned by the merged person), so identities stay on
   * the merged person; readers follow `mergedIntoId` (the ContextLinker does)
   * and `listPeople` hides merged people. Relationships ARE moved: every edge
   * touching the merged person is re-asserted on the survivor and removed.
   */
  "person.merge": async (store, { survivorId, mergedId }) => {
    const survivor = await store.getPerson(survivorId);
    if (!survivor) throw new ActionError(`person ${survivorId} not found`);
    if (survivor.mergedIntoId) throw new ActionError(`person ${survivorId} was itself merged into ${survivor.mergedIntoId}`);
    const merged = await store.getPerson(mergedId);
    if (!merged) throw new ActionError(`person ${mergedId} not found`);
    if (merged.mergedIntoId === survivorId) return { survivorId, mergedId, alreadyMerged: true, relationshipsMoved: 0, identitiesKept: 0 };
    if (merged.mergedIntoId) throw new ActionError(`person ${mergedId} was already merged into ${merged.mergedIntoId}`);

    const mergedRef = ref("person", mergedId);
    const survivorRef = ref("person", survivorId);
    let relationshipsMoved = 0;
    for (const n of await store.neighbors(mergedRef)) {
      if (n.ref.type === "person" && n.ref.id === survivorId) {
        await store.unrelate(n.direction === "out" ? { from: mergedRef, kind: n.kind, to: n.ref } : { from: n.ref, kind: n.kind, to: mergedRef });
        continue;
      }
      const edge = n.direction === "out" ? { from: survivorRef, kind: n.kind, to: n.ref } : { from: n.ref, kind: n.kind, to: survivorRef };
      await store.relate({ ...edge, confidence: n.confidence, source: "user" });
      await store.unrelate(n.direction === "out" ? { from: mergedRef, kind: n.kind, to: n.ref } : { from: n.ref, kind: n.kind, to: mergedRef });
      relationshipsMoved++;
    }
    const identities = await store.listPersonIdentities(mergedId);
    let identitiesKept = 0;
    for (const identity of identities) {
      const result = await store.upsertPersonIdentity({ personId: survivor.id, kind: identity.kind, value: identity.value, rawValue: identity.rawValue, provider: identity.provider, connectorAccountId: identity.connectorAccountId });
      if (result.personId !== survivor.id) identitiesKept++;
    }
    const patch: { primaryEmail?: string | null; organization?: string | null; notes?: string | null } = {};
    if (!survivor.primaryEmail && merged.primaryEmail) patch.primaryEmail = merged.primaryEmail;
    if (!survivor.organization && merged.organization) patch.organization = merged.organization;
    if (!survivor.notes && merged.notes) patch.notes = merged.notes;
    if (Object.keys(patch).length) await store.updatePerson(survivorId, patch);
    await store.updatePerson(mergedId, { mergedIntoId: survivorId as PersonId });
    return { survivorId, mergedId, alreadyMerged: false, relationshipsMoved, identitiesKept };
  },
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
export interface DispatchOptions {
  readonly handlers?: ActionHandlers;
}

export async function dispatchAction(store: SpineStore, envelope: ActionEnvelope, ctx: ActionContext, options: DispatchOptions = {}): Promise<ActionOutcome> {
  const handlers = options.handlers ?? ACTION_HANDLERS;
  const { request, created } = await store.createActionRequest({
    actionType: envelope.actionType,
    idempotencyKey: envelope.idempotencyKey,
    payload: envelope.payload as JsonObject,
    actorDeviceId: envelope.actorDeviceId ?? null,
  });

  if (!created) {
    if (request.actionType !== envelope.actionType) {
      throw new HttpError(409, "conflict", `idempotencyKey ${envelope.idempotencyKey} was used for ${request.actionType}`);
    }
    if (request.status === "done" || request.status === "failed") return outcome(request, true);
    const age = ctx.now().getTime() - Date.parse(request.updatedAt);
    if (request.status === "running" && age < STALE_RUNNING_MS) throw new HttpError(409, "in_progress", "This action is still running");
    if (request.status === "queued" && age < STALE_QUEUED_MS) throw new HttpError(409, "in_progress", "This action is about to run");
    // stale queued (a previous attempt died before running) or stale running: retry.
    ctx.log?.("action: retrying stale request", { actionRequestId: request.id, status: request.status, attempts: request.attempts });
  }

  const running = await store.updateActionRequest(request.id, { status: "running", attempts: request.attempts + 1, error: null });
  const handler = handlers[envelope.actionType] as ActionHandler<ActionType>;
  try {
    const result = await handler(store, request.payload as ActionPayloads[ActionType], ctx);
    const done = await store.updateActionRequest(running.id, { status: "done", result, error: null });
    ctx.log?.("action: done", { actionRequestId: done.id, actionType: envelope.actionType, attempts: done.attempts });
    return outcome(done, false);
  } catch (err) {
    const error = errorMessage(err).slice(0, 1000);
    const failed = await store.updateActionRequest(running.id, { status: "failed", result: null, error });
    ctx.log?.("action: failed", { actionRequestId: failed.id, actionType: envelope.actionType, error });
    return outcome(failed, false);
  }
}

function outcome(request: ActionRequest, replayed: boolean): ActionOutcome {
  return {
    status: request.status === "done" ? "done" : "failed",
    result: request.result,
    error: request.error,
    replayed,
    actionRequestId: request.id,
  };
}
