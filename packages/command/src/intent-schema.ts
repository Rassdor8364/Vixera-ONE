import { isFieldArea, type DocumentKind, type EventRange, type Intent, type TransactionRange } from "./intent.ts";

/**
 * The trust boundary between a model and the executor.
 *
 * A model-backed router hands back JSON. Nothing about that JSON is trusted:
 * `parseIntent` accepts exactly the `Intent` union — known types, known
 * fields, bounded values — and returns null for anything else. There is no
 * "unknown intent with extra fields" path: a field the union does not declare
 * is dropped, an unknown type is rejected. The executor therefore never sees
 * a shape it was not written for, whichever router produced it.
 */

const DOCUMENT_KINDS: readonly DocumentKind[] = ["invoice", "contract", "agreement", "pdf", "image", "any"];
const TRANSACTION_RANGES: readonly TransactionRange[] = ["month", "week", "last_week", "all"];
const NAMED_EVENT_RANGES = ["today", "tomorrow", "week", "next7"] as const;
const MAX_QUERY = 200;
const MAX_LIMIT = 100;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * A real calendar instant, or null. `Date.parse` alone is not enough: V8 rolls
 * "2026-02-30" over to March 2 instead of rejecting it, and comparing two
 * strings lexically ignores offsets. The executor must never see a range it
 * cannot resolve.
 */
export function parseCalendarInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(sec);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function query(x: unknown): string | null {
  return typeof x === "string" && x.trim().length > 0 && x.length <= MAX_QUERY ? x.trim() : null;
}
function optionalQuery(x: unknown): string | null | undefined {
  return x === undefined ? undefined : query(x);
}
function eventRange(x: unknown): EventRange | null {
  if (typeof x === "string") return (NAMED_EVENT_RANGES as readonly string[]).includes(x) ? (x as EventRange) : null;
  if (!isObject(x)) return null;
  const from = parseCalendarInstant(x["from"]);
  const to = parseCalendarInstant(x["to"]);
  if (from === null || to === null || from > to) return null;
  return { from: x["from"] as string, to: x["to"] as string };
}

/** `Intent` or null. Never throws. */
export function parseIntent(value: unknown): Intent | null {
  if (!isObject(value) || typeof value["type"] !== "string") return null;
  switch (value["type"]) {
    case "find_person": {
      const q = query(value["query"]);
      return q ? { type: "find_person", query: q } : null;
    }
    case "show_person_documents": {
      const q = query(value["personQuery"]);
      return q ? { type: "show_person_documents", personQuery: q } : null;
    }
    case "show_person_mail": {
      const q = query(value["personQuery"]);
      return q ? { type: "show_person_mail", personQuery: q } : null;
    }
    case "show_thread": {
      const q = query(value["query"]);
      return q ? { type: "show_thread", query: q } : null;
    }
    case "show_events": {
      const range = eventRange(value["range"]);
      return range ? { type: "show_events", range } : null;
    }
    case "find_document": {
      const q = optionalQuery(value["query"]);
      const from = optionalQuery(value["fromPersonQuery"]);
      if (q === null || from === null) return null;
      const kind = value["kind"];
      if (kind !== undefined && !(DOCUMENT_KINDS as readonly unknown[]).includes(kind)) return null;
      return { type: "find_document", ...(q !== undefined ? { query: q } : {}), ...(from !== undefined ? { fromPersonQuery: from } : {}), ...(kind !== undefined ? { kind: kind as DocumentKind } : {}) };
    }
    case "show_recent_files": {
      const limit = value["limit"];
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return null;
      return { type: "show_recent_files", limit };
    }
    case "show_transactions": {
      const scope = value["scope"];
      let parsedScope: { threadQuery?: string; personQuery?: string } | undefined;
      if (scope !== undefined) {
        if (!isObject(scope)) return null;
        const t = optionalQuery(scope["threadQuery"]);
        const p = optionalQuery(scope["personQuery"]);
        if (t === null || p === null) return null;
        parsedScope = { ...(t !== undefined ? { threadQuery: t } : {}), ...(p !== undefined ? { personQuery: p } : {}) };
      }
      const range = value["range"];
      if (range !== undefined && !(TRANSACTION_RANGES as readonly unknown[]).includes(range)) return null;
      return { type: "show_transactions", ...(parsedScope ? { scope: parsedScope } : {}), ...(range !== undefined ? { range: range as TransactionRange } : {}) };
    }
    case "open_area":
      return typeof value["area"] === "string" && isFieldArea(value["area"]) ? { type: "open_area", area: value["area"] } : null;
    case "unknown":
      return typeof value["text"] === "string" && value["text"].length <= MAX_QUERY ? { type: "unknown", text: value["text"] } : null;
    default:
      return null;
  }
}

/** One line per intent, for a classifier's prompt. Kept next to the parser so they cannot drift. */
export const INTENT_CATALOG: readonly { readonly type: Intent["type"]; readonly description: string; readonly example: string }[] = [
  { type: "find_person", description: "find a person by name", example: '{"type":"find_person","query":"eric"}' },
  { type: "show_person_documents", description: "documents connected to a person", example: '{"type":"show_person_documents","personQuery":"eric"}' },
  { type: "show_person_mail", description: "mail from a person", example: '{"type":"show_person_mail","personQuery":"eric"}' },
  { type: "show_thread", description: "open a thread by title", example: '{"type":"show_thread","query":"brand"}' },
  { type: "show_events", description: "calendar events for today | tomorrow | week | next7 | {from,to}", example: '{"type":"show_events","range":"tomorrow"}' },
  { type: "find_document", description: "documents by kind (invoice|contract|agreement|pdf|image|any), text, or sender", example: '{"type":"find_document","kind":"invoice","fromPersonQuery":"eric"}' },
  { type: "show_recent_files", description: "most recent documents", example: '{"type":"show_recent_files","limit":10}' },
  { type: "show_transactions", description: "money transactions, optionally for a thread or person and a range (month|week|all)", example: '{"type":"show_transactions","scope":{"threadQuery":"brand"},"range":"month"}' },
  { type: "open_area", description: "navigate to an area: now|threads|people|time|money|files|quiet", example: '{"type":"open_area","area":"money"}' },
  { type: "unknown", description: "nothing above fits", example: '{"type":"unknown","text":"..."}' },
];
