/**
 * THE ingestion pipeline. Every explicit share / capture / drop, whatever
 * surface produced it, becomes an `ingest_items` row and passes through
 * `processIngestItem` exactly once (re-processing is idempotent: the document
 * is found by source ref or content hash, edges and the context event dedupe
 * by natural key).
 *
 *   file / image / url  → Document (title, mime, source per surface, location
 *                          storage|url|none, size + sha256 from metadata),
 *                          deduped by contentHash
 *   text                → no document; the ingest item itself is the subject
 *
 *   links:  metadata.threadId → document belongs_to thread
 *           metadata.personId → document has_person person
 *           otherwise exact, case-insensitive mentions of known people
 *           (display names) and thread titles in title + textContent become
 *           `mentions` edges (confidence 0.6, source rule)
 *   event:  context_event `ingest.received`, importance 40, dedupe `ingest:<id>`
 *
 * No OCR, no content extraction: what is not in the item's text is not read.
 */
import { isUuid, ref, type DocumentLocation, type DocumentSource, type EntityRef, type IngestItem, type IngestSource, type JsonObject, type Person, type Thread } from "@vixera/domain";
import { errorMessage, type SpineStore } from "@vixera/sync";

export const KIND_INGEST_RECEIVED = "ingest.received";
export const INGEST_IMPORTANCE = 40;
export const MENTION_CONFIDENCE = 0.6;
export const ARTIFACTS_BUCKET = "artifacts";
const MIN_MENTION_LENGTH = 3;

export interface ProcessIngestOptions {
  readonly now: () => Date;
  readonly log?: (message: string, data?: JsonObject) => void;
}

export interface ProcessIngestResult {
  readonly ingestItemId: string;
  readonly status: "processed" | "failed";
  readonly documentId: string | null;
  /** True when an existing document (same content hash / same item) was reused. */
  readonly documentReused: boolean;
  readonly contextEventId: string | null;
  readonly relationships: number;
  readonly error: string | null;
}

export function ingestDedupeKey(ingestItemId: string): string {
  return `ingest:${ingestItemId}`;
}

export function documentSourceFor(source: IngestSource): DocumentSource {
  return source === "share" ? "share" : source === "drop" ? "drop" : "capture";
}

export async function processIngestItem(store: SpineStore, item: IngestItem, options: ProcessIngestOptions): Promise<ProcessIngestResult> {
  const now = options.now();
  let relationships = 0;
  try {
    // --- document ---------------------------------------------------------
    let documentId: string | null = null;
    let documentReused = false;
    if (item.kind !== "text") {
      const sourceRef: JsonObject = { ingestItemId: item.id };
      const contentHash = stringMeta(item.metadata, "contentHash") ?? stringMeta(item.metadata, "sha256");
      let existing = await store.findDocumentBySourceRef(null, sourceRef);
      if (!existing && contentHash) existing = await store.findDocumentByHash(contentHash);
      if (existing) {
        documentId = existing.id;
        documentReused = true;
      } else {
        const created = await store.upsertDocument({
          title: item.title?.trim() || fallbackTitle(item),
          mimeType: item.mimeType,
          source: documentSourceFor(item.source),
          connectorAccountId: null,
          sourceRef,
          location: locationFor(item),
          praxionDocumentId: null,
          sizeBytes: item.sizeBytes ?? numberMeta(item.metadata, "sizeBytes"),
          contentHash,
          metadata: { ingestItemId: item.id, ingestKind: item.kind, ingestSource: item.source, ...(item.deviceId ? { deviceId: item.deviceId } : {}), ...(item.url ? { url: item.url } : {}) },
        });
        documentId = created.id;
      }
    }
    const subject: EntityRef = documentId ? ref("document", documentId) : ref("ingest_item", item.id);

    // --- explicit links ---------------------------------------------------
    const threadId = stringMeta(item.metadata, "threadId");
    const personId = stringMeta(item.metadata, "personId");
    let explicit = false;
    if (threadId && isUuid(threadId) && (await store.getThread(threadId))) {
      await store.relate({ from: subject, kind: "belongs_to", to: ref("thread", threadId), source: "user" });
      relationships++;
      explicit = true;
    }
    if (personId && isUuid(personId) && (await store.getPerson(personId))) {
      await store.relate({ from: subject, kind: "has_person", to: ref("person", personId), source: "user" });
      relationships++;
      explicit = true;
    }

    // --- mentions ---------------------------------------------------------
    if (!explicit) {
      const haystack = [item.title, item.textContent].filter((s): s is string => !!s).join("\n");
      if (haystack.trim()) {
        const people = await store.listPeople({ includeMerged: false });
        const threads = await store.listThreads();
        for (const target of findMentions(haystack, people, threads)) {
          await store.relate({ from: subject, kind: "mentions", to: target, confidence: MENTION_CONFIDENCE, source: "rule" });
          relationships++;
        }
      }
    }

    // --- context event ----------------------------------------------------
    const events = await store.upsertContextEvents([
      {
        kind: KIND_INGEST_RECEIVED,
        subject,
        title: item.title?.trim() || fallbackTitle(item),
        summary: summaryFor(item),
        occurredAt: item.createdAt,
        importance: INGEST_IMPORTANCE,
        dueAt: null,
        attention: "needs_attention",
        connectorAccountId: null,
        dedupeKey: ingestDedupeKey(item.id),
        metadata: { ingestItemId: item.id, kind: item.kind, source: item.source, documentId, deviceId: item.deviceId },
      },
    ]);
    const contextEventId = events.rows[0]?.id ?? null;

    await store.updateIngestItem(item.id, { status: "processed", documentId: documentId as IngestItem["documentId"], error: null, processedAt: now.toISOString() });
    options.log?.("ingest: item processed", { ingestItemId: item.id, kind: item.kind, documentId, documentReused, relationships });
    return { ingestItemId: item.id, status: "processed", documentId, documentReused, contextEventId, relationships, error: null };
  } catch (err) {
    const error = errorMessage(err).slice(0, 1000);
    options.log?.("ingest: item failed", { ingestItemId: item.id, error });
    try {
      await store.updateIngestItem(item.id, { status: "failed", error, processedAt: now.toISOString() });
    } catch (persistErr) {
      options.log?.("ingest: could not persist failure", { ingestItemId: item.id, error: errorMessage(persistErr) });
    }
    return { ingestItemId: item.id, status: "failed", documentId: null, documentReused: false, contextEventId: null, relationships, error };
  }
}

/** Exact, case-insensitive, word-bounded matches of people display names and thread titles. */
export function findMentions(text: string, people: readonly Person[], threads: readonly Thread[]): EntityRef[] {
  const lower = text.toLowerCase();
  const found: EntityRef[] = [];
  const seen = new Set<string>();
  const consider = (name: string, target: EntityRef) => {
    const needle = name.trim().toLowerCase();
    if (needle.length < MIN_MENTION_LENGTH || seen.has(`${target.type}:${target.id}`)) return;
    if (containsWord(lower, needle)) {
      seen.add(`${target.type}:${target.id}`);
      found.push(target);
    }
  };
  for (const p of people) consider(p.displayName, ref("person", p.id));
  for (const t of threads) consider(t.title, ref("thread", t.id));
  return found;
}

function containsWord(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (haystack[at - 1] as string);
    const after = at + needle.length >= haystack.length ? "" : (haystack[at + needle.length] as string);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

function isWordChar(ch: string): boolean {
  return ch !== "" && /[\p{L}\p{N}_]/u.test(ch);
}

function locationFor(item: IngestItem): DocumentLocation {
  if (item.storagePath) return { kind: "storage", bucket: ARTIFACTS_BUCKET, path: item.storagePath };
  if (item.url) return { kind: "url", url: item.url };
  return { kind: "none" };
}

function fallbackTitle(item: IngestItem): string {
  if (item.url) {
    try {
      return new URL(item.url).host || item.url;
    } catch {
      return item.url;
    }
  }
  if (item.textContent) return item.textContent.trim().slice(0, 80) || "Shared text";
  if (item.storagePath) return item.storagePath.split("/").pop() || "Shared file";
  return item.kind === "image" ? "Shared image" : item.kind === "file" ? "Shared file" : "Shared item";
}

function summaryFor(item: IngestItem): string | null {
  if (item.url) return item.url;
  if (item.textContent) {
    const t = item.textContent.trim().replace(/\s+/g, " ");
    return t.length > 200 ? `${t.slice(0, 197)}...` : t;
  }
  return item.mimeType;
}

function stringMeta(metadata: JsonObject, key: string): string | null {
  const v = metadata[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function numberMeta(metadata: JsonObject, key: string): number | null {
  const v = metadata[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
