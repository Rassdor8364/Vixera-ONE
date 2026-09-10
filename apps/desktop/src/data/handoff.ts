/**
 * Vixera-owned cross-device handoff ("Continue on <device>").
 *
 * Creating and accepting a handoff are server actions; after `handoff.accept`
 * the receiving device reconstructs context: Praxion if present, else the OS
 * viewer (see open-document.ts). Praxion never syncs; Vixera carries the
 * artifact reference, location, thread and conclusions.
 */
import { type ActionPayloads, type Device, type Document, type EntityRef, type Handoff, type PraxionLocation } from "@vixera/domain";
import type { SpineReader } from "@vixera/sync";
import { buildEnvelope, dispatchOrThrow, type ActionDispatcher } from "./actions.ts";
import { openDocument, type OpenDocumentDeps, type OpenDocumentResult } from "./open-document.ts";

export interface HandoffDeps extends OpenDocumentDeps {
  readonly reader: SpineReader;
  readonly dispatch: ActionDispatcher;
}

const OPEN_STATES = new Set<Handoff["state"]>(["pending", "delivered"]);

/** Handoffs this device may pick up: open, addressed to it or to any device, and not created by it. */
export function pendingHandoffsFor(handoffs: readonly Handoff[], deviceId: string): Handoff[] {
  return handoffs
    .filter((h) => OPEN_STATES.has(h.state))
    .filter((h) => h.targetDeviceId === null || h.targetDeviceId === deviceId)
    .filter((h) => h.sourceDeviceId !== deviceId)
    .filter((h) => !h.expiresAt || Date.parse(h.expiresAt) > Date.now())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Other devices of the user, most recently seen first — the "Continue on …" targets. */
export function selectHandoffTargets(devices: readonly Device[], thisDeviceId: string): Device[] {
  return devices
    .filter((d) => d.id !== thisDeviceId)
    .sort((a, b) => Date.parse(b.lastSeenAt ?? b.createdAt) - Date.parse(a.lastSeenAt ?? a.createdAt));
}

export function minutesAgo(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

/** "left on Windows 12 min ago" */
export function describeHandoff(handoff: Handoff, devices: readonly Device[], now: number = Date.now()): string {
  const source = devices.find((d) => d.id === handoff.sourceDeviceId);
  const name = source?.name ?? "another device";
  const mins = minutesAgo(handoff.createdAt, now);
  const when = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return `left on ${name} ${when}`;
}

export async function listPendingHandoffs(reader: SpineReader, deviceId: string): Promise<Handoff[]> {
  const rows = await reader.listHandoffs({ state: ["pending", "delivered"], limit: 50 });
  return pendingHandoffsFor(rows, deviceId);
}

export interface AcceptResult {
  readonly handoff: Handoff;
  readonly document: Document | null;
  readonly opened: OpenDocumentResult | null;
}

/** Server action first (durable, idempotent per handoff+device), then reconstruct locally. */
export async function acceptHandoff(deps: HandoffDeps, handoff: Handoff): Promise<AcceptResult> {
  const envelope = buildEnvelope("handoff.accept", { handoffId: handoff.id, deviceId: deps.deviceId }, { actorDeviceId: deps.deviceId });
  await dispatchOrThrow(deps.dispatch, envelope);
  const documentId = handoff.documentId ?? (handoff.focus?.type === "document" ? handoff.focus.id : null);
  const document = documentId ? await deps.reader.getDocument(documentId) : null;
  let opened: OpenDocumentResult | null = null;
  if (document) {
    const withArtifact: Document =
      handoff.artifactStoragePath && document.location.kind !== "storage"
        ? { ...document, location: { kind: "storage", bucket: "artifacts", path: handoff.artifactStoragePath } }
        : document;
    opened = await openDocument(deps, withArtifact, handoff.praxionLocation);
  }
  return { handoff, document, opened };
}

export interface CreateHandoffInput {
  readonly targetDeviceId: string | null;
  readonly focus: EntityRef | null;
  readonly threadId?: string | null;
  readonly documentId?: string | null;
  readonly praxionLocation?: PraxionLocation | null;
  readonly conclusions?: readonly string[];
  readonly commandHistory?: readonly string[];
}

export function handoffPayload(sourceDeviceId: string, input: CreateHandoffInput): ActionPayloads["handoff.create"] {
  const documentId = input.documentId ?? (input.focus?.type === "document" ? input.focus.id : null);
  const threadId = input.threadId ?? (input.focus?.type === "thread" ? input.focus.id : null);
  return {
    sourceDeviceId,
    targetDeviceId: input.targetDeviceId,
    focus: input.focus ? { type: input.focus.type, id: input.focus.id } : null,
    threadId,
    documentId,
    artifactStoragePath: null,
    praxionLocation: input.praxionLocation ?? null,
    conclusions: [...(input.conclusions ?? [])],
    commandHistory: [...(input.commandHistory ?? [])],
  };
}

export async function createHandoff(deps: Pick<HandoffDeps, "deviceId" | "dispatch" | "reader">, input: CreateHandoffInput): Promise<void> {
  const payload = handoffPayload(deps.deviceId, input);
  // When the document only exists in Storage, carry the artifact reference so the receiver can fetch bytes.
  if (payload.documentId) {
    const doc = await deps.reader.getDocument(payload.documentId).catch(() => null);
    if (doc?.location.kind === "storage") {
      await dispatchOrThrow(deps.dispatch, buildEnvelope("handoff.create", { ...payload, artifactStoragePath: doc.location.path }, { actorDeviceId: deps.deviceId }));
      return;
    }
  }
  await dispatchOrThrow(deps.dispatch, buildEnvelope("handoff.create", payload, { actorDeviceId: deps.deviceId }));
}
