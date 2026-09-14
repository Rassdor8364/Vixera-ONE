import type { EntityRef, EntityType } from "@vixera/domain";
import { ContextSelectionError } from "./errors.ts";

/**
 * Privacy-aware context selection.
 *
 * A model never sees "the user's context"; it sees a `ContextSelection`: an
 * explicit list of entities, each reduced to the fields on an allow-list for
 * its type, the whole thing under a byte budget. Building one is the only way
 * to hand context to a task, so the bound is structural, not a convention.
 *
 * The selection also produces a `ContextManifest` — what was sent, by ref and
 * size, without any content — which is what the audit log records.
 */

export type ContextScalar = string | number | boolean | null;

export interface ContextItem {
  readonly ref: EntityRef;
  /** Field name → value. Only names on the allow-list for `ref.type` survive selection. */
  readonly fields: Readonly<Record<string, ContextScalar>>;
}

/**
 * What a model may be told about each entity type. Deliberately narrow:
 * subjects and titles, dates, amounts and states — never bodies, never raw
 * addresses. Widen a type here only with a documented reason.
 */
export const CONTEXT_FIELD_ALLOWLIST: Readonly<Record<EntityType, readonly string[]>> = {
  person: ["displayName", "organisation", "role"],
  thread: ["title", "summary", "status", "lastActivityAt"],
  document: ["title", "kind", "mimeType", "updatedAt", "pageCount"],
  mail_message: ["subject", "snippet", "receivedAt", "fromDisplayName", "hasAttachments"],
  time_event: ["title", "startsAt", "endsAt", "location", "status"],
  money_transaction: ["description", "amount", "currency", "postedOn", "category", "counterparty"],
  money_account: ["name", "kind", "currency"],
  context_event: ["kind", "title", "attention", "occurredAt"],
  conclusion: ["text", "producedBy", "confidence"],
  handoff: ["status", "createdAt"],
  device: ["name", "platform"],
  ingest_item: ["kind", "status", "createdAt"],
};

export interface ContextBudget {
  /** Serialized size cap for the whole selection. Default 16 KiB. */
  readonly maxBytes?: number;
  /** Item cap. Default 50. */
  readonly maxItems?: number;
  /** Per-string-field cap; longer values are cut with an ellipsis. Default 500. */
  readonly maxFieldChars?: number;
}

export interface ContextManifest {
  readonly itemCount: number;
  readonly bytes: number;
  readonly refs: readonly EntityRef[];
  /** Type → field names that were included (never values). */
  readonly fieldsByType: Readonly<Record<string, readonly string[]>>;
  /** Items dropped for the budget, oldest-listed first. */
  readonly truncatedItems: number;
}

export interface ContextSelection {
  readonly items: readonly ContextItem[];
  readonly manifest: ContextManifest;
  /** The exact text a task puts in the prompt. Stable ordering, one item per line. */
  serialize(): string;
}

const DEFAULT_BUDGET: Required<ContextBudget> = { maxBytes: 16 * 1024, maxItems: 50, maxFieldChars: 500 };

/**
 * Builds a selection from candidate items. Unknown fields are dropped (not an
 * error: callers pass whole entities and the allow-list does the reducing);
 * an unknown entity type is an error, because nothing is on its allow-list
 * and silently sending nothing would hide a bug.
 */
export function selectContext(candidates: readonly ContextItem[], budget: ContextBudget = {}): ContextSelection {
  const b = { ...DEFAULT_BUDGET, ...budget };
  const items: ContextItem[] = [];
  const fieldsByType: Record<string, Set<string>> = {};
  let bytes = 0;
  let truncated = 0;

  for (const candidate of candidates) {
    const allowed = CONTEXT_FIELD_ALLOWLIST[candidate.ref.type];
    if (!allowed) throw new ContextSelectionError(`no context allow-list for entity type "${candidate.ref.type}"`);
    const fields: Record<string, ContextScalar> = {};
    for (const name of allowed) {
      if (!(name in candidate.fields)) continue;
      const value = candidate.fields[name] ?? null;
      fields[name] = typeof value === "string" && value.length > b.maxFieldChars ? `${value.slice(0, b.maxFieldChars - 1)}…` : value;
    }
    const item: ContextItem = { ref: candidate.ref, fields };
    const line = serializeItem(item);
    const cost = line.length + (items.length ? 1 : 0); // newline between items, so bytes === serialize().length
    if (items.length >= b.maxItems || bytes + cost > b.maxBytes) {
      truncated++;
      continue;
    }
    items.push(item);
    bytes += cost;
    const seen = (fieldsByType[candidate.ref.type] ??= new Set());
    for (const name of Object.keys(fields)) seen.add(name);
  }

  const manifest: ContextManifest = {
    itemCount: items.length,
    bytes,
    refs: items.map((i) => i.ref),
    fieldsByType: Object.fromEntries(Object.entries(fieldsByType).map(([t, s]) => [t, [...s].sort()])),
    truncatedItems: truncated,
  };
  return { items, manifest, serialize: () => items.map(serializeItem).join("\n") };
}

/** `type:id {"field":"value",...}` — the id is included so a task can cite what it used. */
function serializeItem(item: ContextItem): string {
  const ordered = Object.fromEntries(Object.entries(item.fields).sort(([a], [b]) => a.localeCompare(b)));
  return `${item.ref.type}:${item.ref.id} ${JSON.stringify(ordered)}`;
}

/** An empty selection, for tasks that need none (intent classification). */
export function noContext(): ContextSelection {
  return selectContext([]);
}
