import type {
  Conclusion,
  ContextEvent,
  Device,
  Document,
  EntityRef,
  EntityType,
  Handoff,
  IngestItem,
  MailMessage,
  MoneyAccount,
  MoneyTransaction,
  Person,
  Thread,
  TimeEvent,
} from "@vixera/domain";
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
 * subjects and titles, dates, amounts and states — never bodies (a mail
 * snippet is a body excerpt and is excluded), never raw addresses. Every
 * name is checked against the entity's own type at compile time, so a field
 * that does not exist on the entity cannot be listed and silently select
 * nothing.
 */
type FieldsOf<T> = readonly (keyof T & string)[];

export const CONTEXT_FIELD_ALLOWLIST = {
  person: ["displayName", "organization"] satisfies FieldsOf<Person>,
  thread: ["title", "kind", "summary", "status", "updatedAt"] satisfies FieldsOf<Thread>,
  document: ["title", "mimeType", "source", "sizeBytes", "updatedAt"] satisfies FieldsOf<Document>,
  mail_message: ["subject", "sentAt", "receivedAt", "isUnread"] satisfies FieldsOf<MailMessage>,
  time_event: ["title", "startsAt", "endsAt", "allDay", "location", "status"] satisfies FieldsOf<TimeEvent>,
  money_transaction: ["description", "merchantName", "amount", "currency", "postedOn", "pending"] satisfies FieldsOf<MoneyTransaction>,
  money_account: ["name", "type", "currency"] satisfies FieldsOf<MoneyAccount>,
  context_event: ["kind", "title", "attention", "importance", "occurredAt", "dueAt"] satisfies FieldsOf<ContextEvent>,
  conclusion: ["text", "producedBy", "confidence"] satisfies FieldsOf<Conclusion>,
  handoff: ["state", "createdAt", "expiresAt"] satisfies FieldsOf<Handoff>,
  device: ["name", "platform"] satisfies FieldsOf<Device>,
  ingest_item: ["kind", "source", "status", "createdAt"] satisfies FieldsOf<IngestItem>,
} as const satisfies Record<EntityType, readonly string[]>;

export interface ContextBudget {
  /** Serialized size cap for the whole selection, in UTF-8 bytes. Default 16 KiB; ceiling 64 KiB. */
  readonly maxBytes?: number;
  /** Item cap. Default 50; ceiling 200. */
  readonly maxItems?: number;
  /** Per-string-field cap in characters; longer values are cut with an ellipsis. Default 500; range 8..2000. */
  readonly maxFieldChars?: number;
}

/** Hard ceilings a caller cannot raise: the point of a budget is that no call site can send the mailbox. */
export const CONTEXT_BUDGET_CEILING = { maxBytes: 64 * 1024, maxItems: 200, maxFieldChars: 2000 } as const;
const CONTEXT_BUDGET_FLOOR = { maxBytes: 256, maxItems: 1, maxFieldChars: 8 } as const;

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
const clampBudget = (budget: ContextBudget): Required<ContextBudget> => {
  const pick = (key: keyof ContextBudget) => {
    const raw = budget[key];
    const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BUDGET[key];
    return Math.min(CONTEXT_BUDGET_CEILING[key], Math.max(CONTEXT_BUDGET_FLOOR[key], value));
  };
  return { maxBytes: pick("maxBytes"), maxItems: pick("maxItems"), maxFieldChars: pick("maxFieldChars") };
};
const utf8 = new TextEncoder();
/** Bytes on the wire, not UTF-16 code units. */
export function byteLength(text: string): number {
  return utf8.encode(text).byteLength;
}

/**
 * Builds a selection from candidate items. Unknown fields are dropped (not an
 * error: callers pass whole entities and the allow-list does the reducing);
 * an unknown entity type is an error, because nothing is on its allow-list
 * and silently sending nothing would hide a bug.
 */
export function selectContext(candidates: readonly ContextItem[], budget: ContextBudget = {}): ContextSelection {
  const b = clampBudget(budget);
  const items: ContextItem[] = [];
  const fieldsByType: Record<string, Set<string>> = {};
  let bytes = 0;
  let truncated = 0;

  for (const candidate of candidates) {
    const allowed: readonly string[] | undefined = CONTEXT_FIELD_ALLOWLIST[candidate.ref.type];
    if (!allowed) throw new ContextSelectionError(`no context allow-list for entity type "${candidate.ref.type}"`);
    const fields: Record<string, ContextScalar> = {};
    for (const name of allowed) {
      if (!(name in candidate.fields)) continue;
      const value = candidate.fields[name] ?? null;
      fields[name] = typeof value === "string" && value.length > b.maxFieldChars ? `${value.slice(0, b.maxFieldChars - 1)}…` : value;
    }
    const item: ContextItem = { ref: candidate.ref, fields };
    const line = serializeItem(item);
    const cost = byteLength(line) + (items.length ? 1 : 0); // newline between items, so bytes === byteLength(serialize())
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
