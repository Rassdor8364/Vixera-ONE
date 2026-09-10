import type { DocumentKind, EventRange, FieldArea, Intent, TransactionRange } from "./intent.ts";

/**
 * The deterministic One Command grammar. Pure and synchronous: it never
 * touches the spine. Where a phrase can only be classified by looking at the
 * user's own names ("find eric" — person, thread or document?) the grammar
 * returns a `Parse` that says so and the router resolves it against the
 * reader. Rules are tried in order; the first match wins.
 */

export type Parse =
  /** Fully determined by the words alone. */
  | { readonly kind: "intent"; readonly rule: string; readonly intent: Intent; readonly confidence: number }
  /** "find <thing>": a person, a thread or a document — the router decides. */
  | { readonly kind: "find"; readonly rule: string; readonly query: string }
  /** "transactions related to <x>": x is a thread or a person — the router decides. */
  | { readonly kind: "transactions_for"; readonly rule: string; readonly target: string; readonly range?: TransactionRange }
  /** A bare noun whose scope comes from `context.focus`. */
  | { readonly kind: "scoped_noun"; readonly rule: string; readonly noun: "documents" | "mail" | "transactions" }
  /** Nothing matched; maybe a bare thread / person name. */
  | { readonly kind: "bare"; readonly text: string };

const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 100;

const AREA_WORDS: Record<string, FieldArea> = {
  now: "now",
  home: "now",
  thread: "threads",
  threads: "threads",
  people: "people",
  person: "people",
  contacts: "people",
  time: "time",
  calendar: "time",
  events: "time",
  money: "money",
  bank: "money",
  finance: "money",
  finances: "money",
  files: "files",
  file: "files",
  documents: "files",
  docs: "files",
  quiet: "quiet",
};

const DOC_KIND_WORDS: Record<string, DocumentKind> = {
  invoice: "invoice",
  invoices: "invoice",
  bill: "invoice",
  contract: "contract",
  contracts: "contract",
  agreement: "agreement",
  agreements: "agreement",
  pdf: "pdf",
  pdfs: "pdf",
  image: "image",
  images: "image",
  photo: "image",
  photos: "image",
  picture: "image",
  pictures: "image",
  document: "any",
  documents: "any",
  file: "any",
  files: "any",
};

const DOC_KIND = "invoices?|bills?|contracts?|agreements?|pdfs?|images?|photos?|pictures?";
const DOC_NOUN = "documents?|files?|docs?|papers?|attachments?";
const MAIL_NOUN = "mails?|e-?mails?|messages?|inbox";
const MONEY_NOUN = "transactions?|payments?|money|spending|expenses|charges";
const EVENT_NOUN = "events?|calendar|meetings?|schedule|agenda|appointments?";
const VERB = "(?:show|find|list|get|open|display|see|view|search(?: for)?|look ?up|pull up)";
const ME = "(?:me\\s+)?(?:my\\s+|the\\s+|all\\s+|all the\\s+)?";

/** Lower-case, unify apostrophes, drop politeness and trailing punctuation, collapse spaces. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:please|hey|hi|ok|okay|vixera)[,\s]+/g, "")
    .replace(/[\s,]*(?:please)?[.!?]*$/g, "")
    .trim();
}

type Rule = { readonly name: string; readonly re: RegExp; readonly build: (m: RegExpMatchArray) => Parse | null };

function intent(rule: string, value: Intent, confidence = 1): Parse {
  return { kind: "intent", rule, intent: value, confidence };
}

function eventsOf(word: string): EventRange {
  if (word.includes("tomorrow")) return "tomorrow";
  if (word.includes("week")) return "week";
  return "today";
}

function txRange(word: string): TransactionRange {
  if (word.includes("week")) return "week";
  if (word.includes("month")) return "month";
  return "all";
}

function docKind(word: string): DocumentKind {
  return DOC_KIND_WORDS[word] ?? "any";
}

function clampLimit(raw: string | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : DEFAULT_RECENT_LIMIT;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECENT_LIMIT;
  return Math.min(n, MAX_RECENT_LIMIT);
}

const g = (m: RegExpMatchArray, i: number): string => (m[i] ?? "").trim();

export const RULES: readonly Rule[] = [
  // --- Navigation ----------------------------------------------------------
  {
    name: "open_area",
    re: /^(?:open|go to|goto|switch to|take me to|jump to)\s+(?:the\s+)?(now|home|threads?|people|person|contacts|time|calendar|money|bank|finances?|files?|documents|docs|quiet)(?:\s+(?:area|view|screen|page))?$/,
    build: (m) => intent("open_area", { type: "open_area", area: AREA_WORDS[g(m, 1)] ?? "now" }),
  },
  {
    // "show files" / "show documents" are NOT here: with a person in focus they mean that person's files.
    name: "open_area.show",
    re: /^(?:show|display)\s+(?:me\s+)?(?:the\s+)?(now|home|threads|people|contacts|time|calendar|money|quiet)(?:\s+(?:area|view|screen|page))?$/,
    build: (m) => intent("open_area.show", { type: "open_area", area: AREA_WORDS[g(m, 1)] ?? "now" }, 0.9),
  },
  {
    name: "open_area.bare",
    re: /^(now|threads|people|time|money|quiet)$/,
    build: (m) => intent("open_area.bare", { type: "open_area", area: AREA_WORDS[g(m, 1)] ?? "now" }, 0.9),
  },

  // --- Threads -------------------------------------------------------------
  {
    name: "show_thread",
    re: new RegExp(`^${VERB}\\s+(?:me\\s+)?(?:the\\s+)?thread\\s+(?:called\\s+|named\\s+)?["']?(.+?)["']?$`),
    build: (m) => intent("show_thread", { type: "show_thread", query: g(m, 1) }),
  },
  {
    name: "show_thread.suffix",
    re: /^(?:open|show|go to)\s+(?:the\s+)?["']?(.+?)["']?\s+thread$/,
    build: (m) => intent("show_thread.suffix", { type: "show_thread", query: g(m, 1) }),
  },

  // --- Time ----------------------------------------------------------------
  {
    name: "show_events.day",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(today|tomorrow|this week|the week|week)(?:'s)?(?:\\s+(?:${EVENT_NOUN}))?$`),
    build: (m) => intent("show_events.day", { type: "show_events", range: eventsOf(g(m, 1)) }),
  },
  {
    name: "show_events.noun_first",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(?:${EVENT_NOUN})\\s+(?:for\\s+|on\\s+)?(today|tomorrow|this week|the week|next 7 days)$`),
    build: (m) => intent("show_events.noun_first", { type: "show_events", range: eventsOf(g(m, 1)) }),
  },
  {
    name: "show_events.whats",
    re: /^what(?:'s| is| do i have|'s on|'s happening| is happening|'s up)?\s*(?:on|for|up|happening)?\s*(today|tomorrow|this week|the week)$/,
    build: (m) => intent("show_events.whats", { type: "show_events", range: eventsOf(g(m, 1)) }),
  },

  // --- Files ---------------------------------------------------------------
  {
    name: "show_recent_files",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(?:recent|latest|last|newest)\\s+(?:(\\d+)\\s+)?(${DOC_NOUN}|${DOC_KIND})$`),
    build: (m) =>
      new RegExp(`^(?:${DOC_NOUN})$`).test(g(m, 2))
        ? intent("show_recent_files", { type: "show_recent_files", limit: clampLimit(m[1]) })
        : intent("show_recent_files.kind", { type: "find_document", kind: docKind(g(m, 2)) }, 0.9),
  },
  {
    name: "show_recent_files.suffix",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(?:${DOC_NOUN})\\s+(?:recently|from (?:today|this week)|i (?:recently )?(?:worked on|touched|opened))$`),
    build: () => intent("show_recent_files.suffix", { type: "show_recent_files", limit: DEFAULT_RECENT_LIMIT }, 0.9),
  },

  // --- Person-scoped ("eric's documents", "mail from eric", "the invoice from eric") -----
  {
    name: "find_document.kind_from_person",
    re: new RegExp(`^(?:${VERB}\\s+)?(?:me\\s+)?(?:the\\s+|an?\\s+|all\\s+|latest\\s+)?(${DOC_KIND})\\s+(?:from|by|of|sent by)\\s+(.+)$`),
    build: (m) => intent("find_document.kind_from_person", { type: "find_document", kind: docKind(g(m, 1)), fromPersonQuery: g(m, 2) }),
  },
  {
    name: "possessive",
    re: new RegExp(`^(?:${VERB}\\s+)?(?:me\\s+)?(?:all\\s+)?(.+?)'s?\\s+(${DOC_NOUN}|${MAIL_NOUN}|${DOC_KIND}|${MONEY_NOUN})$`),
    build: (m) => {
      const who = g(m, 1);
      const noun = g(m, 2);
      if (new RegExp(`^(?:${DOC_NOUN})$`).test(noun)) return intent("possessive.documents", { type: "show_person_documents", personQuery: who });
      if (new RegExp(`^(?:${MAIL_NOUN})$`).test(noun)) return intent("possessive.mail", { type: "show_person_mail", personQuery: who });
      if (new RegExp(`^(?:${MONEY_NOUN})$`).test(noun)) return { kind: "transactions_for", rule: "possessive.transactions", target: who };
      return intent("possessive.document_kind", { type: "find_document", kind: docKind(noun), fromPersonQuery: who });
    },
  },
  {
    name: "from_person",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(${DOC_NOUN}|${MAIL_NOUN})\\s+(?:from|by|sent by|with)\\s+(.+)$`),
    build: (m) => {
      const noun = g(m, 1);
      const who = g(m, 2);
      if (new RegExp(`^(?:${MAIL_NOUN})$`).test(noun)) return intent("from_person.mail", { type: "show_person_mail", personQuery: who });
      return intent("from_person.documents", { type: "show_person_documents", personQuery: who });
    },
  },

  // --- Money ---------------------------------------------------------------
  {
    name: "show_transactions.for",
    re: new RegExp(
      `^(?:${VERB}\\s+)?${ME}(?:${MONEY_NOUN})\\s+(?:related to|relating to|linked to|for|with|on|about|from|to)\\s+(.+?)(?:\\s+(this month|this week|last week|all time))?$`,
    ),
    build: (m) => {
      const range = m[2];
      return { kind: "transactions_for", rule: "show_transactions.for", target: g(m, 1), ...(range ? { range: txRange(range) } : {}) };
    },
  },
  {
    name: "show_transactions.all",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(?:${MONEY_NOUN})(?:\\s+(this month|this week|all time|all))?$`),
    build: (m) => {
      const range = m[1];
      return range
        ? intent("show_transactions.all", { type: "show_transactions", range: txRange(range) }, 0.9)
        : { kind: "scoped_noun", rule: "scoped_noun.transactions", noun: "transactions" };
    },
  },

  // --- Documents by kind ("find the invoice") -----------------------------------
  {
    name: "find_document.kind",
    re: new RegExp(`^(?:${VERB}\\s+)?(?:me\\s+)?(?:the\\s+|an?\\s+|all\\s+|my\\s+)?(${DOC_KIND})(?:\\s+(?:called|named|about|for)\\s+(.+))?$`),
    build: (m) => intent("find_document.kind", { type: "find_document", kind: docKind(g(m, 1)), ...(m[2] ? { query: g(m, 2) } : {}) }, 0.9),
  },
  {
    name: "find_document.named",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(?:${DOC_NOUN})\\s+(?:called|named|about|matching|containing)\\s+(.+)$`),
    build: (m) => intent("find_document.named", { type: "find_document", query: g(m, 1) }, 0.9),
  },

  // --- Bare nouns whose scope is the focus ---------------------------------------
  {
    name: "scoped_noun",
    re: new RegExp(`^(?:${VERB}\\s+)?${ME}(?:(?:his|her|their|its)\\s+)?(${DOC_NOUN}|${MAIL_NOUN})$`),
    build: (m) => ({
      kind: "scoped_noun",
      rule: "scoped_noun",
      noun: new RegExp(`^(?:${MAIL_NOUN})$`).test(g(m, 1)) ? "mail" : "documents",
    }),
  },

  // --- People --------------------------------------------------------------
  {
    name: "find_person.who",
    re: /^who(?:'s| is| was)\s+(.+)$/,
    build: (m) => intent("find_person.who", { type: "find_person", query: g(m, 1) }),
  },
  {
    name: "find_person.person",
    re: new RegExp(`^${VERB}\\s+(?:me\\s+)?(?:the\\s+)?(?:person|contact)\\s+(?:called\\s+|named\\s+)?(.+)$`),
    build: (m) => intent("find_person.person", { type: "find_person", query: g(m, 1) }),
  },

  // --- Generic find ---------------------------------------------------------
  {
    name: "find",
    re: /^(?:find|search(?: for)?|look ?up|show me|show|open|get|where is|where's)\s+(?:me\s+)?(?:the\s+)?(.+)$/,
    build: (m) => ({ kind: "find", rule: "find", query: g(m, 1) }),
  },
];

/** Parses normalized text. Returns `{ kind: "bare" }` when no rule matches. */
export function parse(text: string): Parse {
  const t = normalizeText(text);
  if (!t) return { kind: "bare", text: "" };
  for (const rule of RULES) {
    const m = t.match(rule.re);
    if (!m) continue;
    const out = rule.build(m);
    if (out) return out;
  }
  return { kind: "bare", text: t };
}
