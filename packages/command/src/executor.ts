import { ref, type Document, type EntityRef, type MailMessage, type MoneyTransaction, type Person, type Thread, type TimeEvent } from "@vixera/domain";
import type { CommandContext, DocumentKind, EventRange, FieldArea, Intent, TransactionRange, TransactionScope } from "./intent.ts";
import { resolvePerson, resolveThread, type Resolution } from "./names.ts";
import type { CommandReader } from "./reader.ts";
import { eventRange, transactionRange } from "./time-range.ts";

/**
 * Executes intents against the spine through `CommandReader` only.
 *
 * The reader is bound to the current user at construction; no query built
 * here carries a user id, so a result can never contain another user's
 * rows. Graph questions ("Eric's documents", "transactions related to
 * Brand") are answered with one or two `neighbors()` hops — no graph
 * library, no SQL here.
 */

export type ResultItem =
  | { readonly type: "person"; readonly person: Person }
  | { readonly type: "thread"; readonly thread: Thread }
  | { readonly type: "document"; readonly document: Document }
  | { readonly type: "mail"; readonly message: MailMessage }
  | { readonly type: "time_event"; readonly event: TimeEvent }
  | { readonly type: "transaction"; readonly transaction: MoneyTransaction };

export type CommandResultKind = "navigate" | "results" | "answer" | "unknown";

export interface CommandResult {
  readonly kind: CommandResultKind;
  /** Area the Field should show (navigate) or the area the results belong to. */
  readonly area?: FieldArea;
  /** Entity to put in focus, when the command resolved to exactly one. */
  readonly focus?: EntityRef | null;
  readonly title: string;
  readonly items: readonly ResultItem[];
  /** Human sentence for empty results, ambiguity or unknown commands. */
  readonly message?: string;
}

export class CommandExecutor {
  constructor(private readonly reader: CommandReader) {}

  async execute(intent: Intent, context: CommandContext): Promise<CommandResult> {
    switch (intent.type) {
      case "find_person":
        return this.findPerson(intent.query, context);
      case "show_person_documents":
        return this.showPersonDocuments(intent.personQuery, context);
      case "show_person_mail":
        return this.showPersonMail(intent.personQuery, context);
      case "show_events":
        return this.showEvents(intent.range, context);
      case "find_document":
        return this.findDocument(intent.query, intent.fromPersonQuery, intent.kind ?? "any", context);
      case "show_recent_files":
        return this.showRecentFiles(intent.limit);
      case "show_transactions":
        return this.showTransactions(intent.scope, intent.range, context);
      case "show_thread":
        return this.showThread(intent.query, context);
      case "open_area":
        return { kind: "navigate", area: intent.area, focus: null, title: areaTitle(intent.area), items: [] };
      case "unknown":
        return {
          kind: "unknown",
          title: "Not understood",
          items: [],
          message: intent.text.trim() ? `I don't know how to "${intent.text.trim()}" yet.` : "Type a command, for example: find Eric.",
        };
    }
  }

  // ---------------------------------------------------------------------------
  // People
  // ---------------------------------------------------------------------------
  private async findPerson(query: string, context: CommandContext): Promise<CommandResult> {
    const r = await resolvePerson(this.reader, query, context.focus);
    if (r.status !== "one") return personCandidates(query, r);
    const person = r.match;
    return { kind: "navigate", area: "people", focus: ref("person", person.id), title: person.displayName, items: [{ type: "person", person }] };
  }

  private async showPersonDocuments(personQuery: string, context: CommandContext): Promise<CommandResult> {
    const r = await resolvePerson(this.reader, personQuery, context.focus);
    if (r.status !== "one") return personCandidates(personQuery, r);
    const person = r.match;
    const documents = await this.personDocuments(person);
    return {
      kind: "results",
      area: "files",
      focus: ref("person", person.id),
      title: `${person.displayName}'s documents`,
      items: documents.map((document) => ({ type: "document", document })),
      ...(documents.length ? {} : { message: `No documents related to ${person.displayName} yet.` }),
    };
  }

  private async showPersonMail(personQuery: string, context: CommandContext): Promise<CommandResult> {
    const r = await resolvePerson(this.reader, personQuery, context.focus);
    if (r.status !== "one") return personCandidates(personQuery, r);
    const person = r.match;
    const messages = await this.personMail(person);
    return {
      kind: "results",
      area: "people",
      focus: ref("person", person.id),
      title: `Mail from ${person.displayName}`,
      items: messages.map((message) => ({ type: "mail", message })),
      ...(messages.length ? {} : { message: `No mail from ${person.displayName} yet.` }),
    };
  }

  /**
   * Documents a person is connected to: direct document neighbors (either
   * direction: `person relates_to doc`, `doc has_person person`, ...) plus
   * attachments that originated from that person's mail.
   */
  private async personDocuments(person: Person): Promise<Document[]> {
    const personRef = ref("person", person.id);
    const ids = new Set<string>();
    for (const n of await this.reader.neighbors(personRef, { type: "document" })) ids.add(n.ref.id);
    for (const message of await this.personMail(person)) {
      for (const n of await this.reader.neighbors(ref("mail_message", message.id), { type: "document" })) ids.add(n.ref.id);
    }
    const docs = await this.loadDocuments(ids);
    return sortRecentFirst(docs, (d) => d.updatedAt);
  }

  /** Mail from a person: the reader's own index plus `mail has_person person` edges. */
  private async personMail(person: Person): Promise<MailMessage[]> {
    const byId = new Map<string, MailMessage>();
    for (const m of await this.reader.listMailMessages({ fromPersonId: person.id })) byId.set(m.id, m);
    for (const n of await this.reader.neighbors(ref("person", person.id), { type: "mail_message" })) {
      if (byId.has(n.ref.id)) continue;
      const m = await this.reader.getMailMessage(n.ref.id);
      if (m) byId.set(m.id, m);
    }
    return sortRecentFirst([...byId.values()], (m) => m.receivedAt);
  }

  // ---------------------------------------------------------------------------
  // Time
  // ---------------------------------------------------------------------------
  private async showEvents(range: EventRange, context: CommandContext): Promise<CommandResult> {
    const { from, to } = eventRange(range, context);
    const rows = await this.reader.listTimeEvents({ from, to });
    // Half-open [from, to): an event that starts exactly at midnight belongs to the next day,
    // and one that ended exactly at midnight belongs to the previous day.
    const events = rows.filter((e) => e.startsAt < to && (e.endsAt > from || e.startsAt >= from)).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const title = typeof range === "object" ? `Events ${from.slice(0, 10)} – ${to.slice(0, 10)}` : rangeTitle(range);
    return {
      kind: "results",
      area: "time",
      focus: null,
      title,
      items: events.map((event) => ({ type: "time_event", event })),
      ...(events.length ? {} : { message: `Nothing scheduled ${title.toLowerCase()}.` }),
    };
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------
  private async findDocument(query: string | undefined, fromPersonQuery: string | undefined, kind: DocumentKind, context: CommandContext): Promise<CommandResult> {
    let scopeTitle = "";
    let focus: EntityRef | null = null;
    let docs: Document[];
    if (fromPersonQuery !== undefined) {
      const r = await resolvePerson(this.reader, fromPersonQuery, context.focus);
      if (r.status !== "one") return personCandidates(fromPersonQuery, r);
      docs = await this.personDocuments(r.match);
      scopeTitle = ` from ${r.match.displayName}`;
      focus = ref("person", r.match.id);
    } else {
      docs = await this.reader.listDocuments(query ? { search: query } : {});
    }
    const q = query?.trim().toLowerCase();
    const matches = sortRecentFirst(
      docs.filter((d) => matchesKind(d, kind) && (!q || d.title.toLowerCase().includes(q))),
      (d) => d.updatedAt,
    );
    const what = kind === "any" ? "Documents" : `${capitalize(kind)}s`;
    const title = `${what}${q ? ` matching "${query?.trim()}"` : ""}${scopeTitle}`;
    if (matches.length === 1) focus = ref("document", (matches[0] as Document).id);
    return {
      kind: "results",
      area: "files",
      focus,
      title,
      items: matches.map((document) => ({ type: "document", document })),
      ...(matches.length ? {} : { message: `No ${what.toLowerCase()} found${scopeTitle}${q ? ` for "${query?.trim()}"` : ""}.` }),
    };
  }

  /** Recent first by `updatedAt`. Sorting happens here so the order does not depend on the store. */
  private async showRecentFiles(limit: number): Promise<CommandResult> {
    const docs = sortRecentFirst(await this.reader.listDocuments(), (d) => d.updatedAt).slice(0, Math.max(1, limit));
    return {
      kind: "results",
      area: "files",
      focus: null,
      title: "Recent files",
      items: docs.map((document) => ({ type: "document", document })),
      ...(docs.length ? {} : { message: "No files yet. Connect mail or share a document to Vixera." }),
    };
  }

  // ---------------------------------------------------------------------------
  // Money
  // ---------------------------------------------------------------------------
  private async showTransactions(scope: TransactionScope | undefined, range: TransactionRange | undefined, context: CommandContext): Promise<CommandResult> {
    const posted = transactionRange(range, context);
    let rows: MoneyTransaction[];
    let title = "Transactions";
    let focus: EntityRef | null = null;

    if (scope?.threadQuery !== undefined) {
      const r = await resolveThread(this.reader, scope.threadQuery, context.focus);
      if (r.status !== "one") return threadCandidates(scope.threadQuery, r);
      rows = await this.threadTransactions(r.match);
      title = `Transactions related to ${r.match.title}`;
      focus = ref("thread", r.match.id);
    } else if (scope?.personQuery !== undefined) {
      const r = await resolvePerson(this.reader, scope.personQuery, context.focus);
      if (r.status !== "one") return personCandidates(scope.personQuery, r);
      rows = await this.personTransactions(r.match);
      title = `Transactions with ${r.match.displayName}`;
      focus = ref("person", r.match.id);
    } else {
      rows = await this.reader.listMoneyTransactions(posted ? { postedFrom: posted.from, postedTo: posted.to } : {});
    }

    const filtered = posted ? rows.filter((t) => t.postedOn >= posted.from && t.postedOn <= posted.to) : rows;
    const transactions = sortRecentFirst(filtered, (t) => `${t.postedOn}T${t.authorizedAt ?? ""}`);
    const rangeTitle = range === "month" ? " this month" : range === "week" ? " this week" : "";
    return {
      kind: "results",
      area: "money",
      focus,
      title: `${title}${rangeTitle}`,
      items: transactions.map((transaction) => ({ type: "transaction", transaction })),
      ...(transactions.length ? {} : { message: focus ? `No transactions${rangeTitle} related to ${title.replace(/^Transactions (related to|with) /, "")}.` : `No transactions${rangeTitle} yet.` }),
    };
  }

  /** Direct `thread ↔ transaction` edges plus transactions two hops away through the thread's documents. */
  private async threadTransactions(thread: Thread): Promise<MoneyTransaction[]> {
    // Three hops, because Phase 1 produces thread edges in three ways: the user
    // attaches a transaction; a document of the thread relates to one; or the
    // linker matched a merchant to a person the thread has.
    const threadRef = ref("thread", thread.id);
    const ids = new Set<string>();
    for (const n of await this.reader.neighbors(threadRef, { type: "money_transaction" })) ids.add(n.ref.id);
    for (const doc of await this.reader.neighbors(threadRef, { type: "document" })) {
      for (const n of await this.reader.neighbors(doc.ref, { type: "money_transaction" })) ids.add(n.ref.id);
    }
    for (const person of await this.reader.neighbors(threadRef, { type: "person" })) {
      for (const n of await this.reader.neighbors(person.ref, { type: "money_transaction" })) ids.add(n.ref.id);
    }
    return this.loadTransactions(ids);
  }

  /** Counterparty transactions plus edges to the person and to the person's documents. */
  private async personTransactions(person: Person): Promise<MoneyTransaction[]> {
    const byId = new Map<string, MoneyTransaction>();
    for (const t of await this.reader.listMoneyTransactions({ counterpartyPersonId: person.id })) byId.set(t.id, t);
    const ids = new Set<string>();
    for (const n of await this.reader.neighbors(ref("person", person.id), { type: "money_transaction" })) ids.add(n.ref.id);
    for (const doc of await this.personDocuments(person)) {
      for (const n of await this.reader.neighbors(ref("document", doc.id), { type: "money_transaction" })) ids.add(n.ref.id);
    }
    for (const id of ids) if (!byId.has(id)) {
      const t = await this.reader.getMoneyTransaction(id);
      if (t) byId.set(t.id, t);
    }
    return [...byId.values()];
  }

  // ---------------------------------------------------------------------------
  // Threads
  // ---------------------------------------------------------------------------
  private async showThread(query: string, context: CommandContext): Promise<CommandResult> {
    const r = await resolveThread(this.reader, query, context.focus);
    if (r.status !== "one") return threadCandidates(query, r);
    const thread = r.match;
    return { kind: "navigate", area: "threads", focus: ref("thread", thread.id), title: thread.title, items: [{ type: "thread", thread }] };
  }

  // ---------------------------------------------------------------------------
  // Loading helpers
  // ---------------------------------------------------------------------------
  private async loadDocuments(ids: Iterable<string>): Promise<Document[]> {
    const out: Document[] = [];
    for (const id of ids) {
      const d = await this.reader.getDocument(id);
      if (d) out.push(d);
    }
    return out;
  }

  private async loadTransactions(ids: Iterable<string>): Promise<MoneyTransaction[]> {
    const out: MoneyTransaction[] = [];
    for (const id of ids) {
      const t = await this.reader.getMoneyTransaction(id);
      if (t) out.push(t);
    }
    return out;
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------
function personCandidates(query: string, r: Resolution<Person>): CommandResult {
  if (r.status === "many") {
    return {
      kind: "results",
      area: "people",
      focus: null,
      title: `People matching "${query}"`,
      items: r.candidates.map((person) => ({ type: "person", person })),
      message: `Several people match "${query}". Which one?`,
    };
  }
  return { kind: "results", area: "people", focus: null, title: `People matching "${query}"`, items: [], message: `No one named "${query}" yet.` };
}

function threadCandidates(query: string, r: Resolution<Thread>): CommandResult {
  if (r.status === "many") {
    return {
      kind: "results",
      area: "threads",
      focus: null,
      title: `Threads matching "${query}"`,
      items: r.candidates.map((thread) => ({ type: "thread", thread })),
      message: `Several threads match "${query}". Which one?`,
    };
  }
  return { kind: "results", area: "threads", focus: null, title: `Threads matching "${query}"`, items: [], message: `No thread named "${query}" yet.` };
}

const KIND_TITLE_RE: Record<Exclude<DocumentKind, "any" | "pdf" | "image">, RegExp> = {
  invoice: /\b(invoice|inv\.?|bill|faktura|receipt)\b/i,
  contract: /\b(contract|avtal)\b/i,
  agreement: /\b(agreement|terms)\b/i,
};

/** Kind matching over title, mime type and the linker's `metadata.kind` when present. */
export function matchesKind(doc: Document, kind: DocumentKind): boolean {
  if (kind === "any") return true;
  const metaKind = typeof doc.metadata["kind"] === "string" ? (doc.metadata["kind"] as string).toLowerCase() : null;
  if (metaKind === kind) return true;
  const title = doc.title;
  const mime = doc.mimeType?.toLowerCase() ?? "";
  switch (kind) {
    case "pdf":
      return mime === "application/pdf" || /\.pdf$/i.test(title);
    case "image":
      return mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i.test(title);
    default:
      return KIND_TITLE_RE[kind].test(title);
  }
}

function sortRecentFirst<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((a, b) => key(b).localeCompare(key(a)));
}

function areaTitle(area: FieldArea): string {
  return area === "now" ? "NOW" : capitalize(area);
}

function rangeTitle(range: Exclude<EventRange, object>): string {
  return range === "today" ? "Today" : range === "tomorrow" ? "Tomorrow" : "This week";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
