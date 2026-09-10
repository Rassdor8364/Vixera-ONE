import type { CommandContext, Intent, TransactionScope } from "./intent.ts";
import { parse, type Parse } from "./grammar.ts";
import { searchPeople, searchThreads, type MatchQuality } from "./names.ts";
import type { CommandReader } from "./reader.ts";

/**
 * Intent routing: free text + context → intent.
 *
 * `IntentRouter` is the seam. Phase 1 ships `RuleBasedIntentRouter`, a
 * deterministic grammar (grammar.ts) that consults the spine only to
 * classify names ("find eric": person, thread or document?) and to scope
 * bare nouns to the focused entity. A model-backed router (built on
 * `@vixera/intelligence`'s `ModelProvider`, server-side) can implement the
 * same interface later and be composed in front of or behind this one; it
 * is deliberately not implemented in Phase 1.
 */
export interface RoutedIntent {
  readonly intent: Intent;
  /** 0..1. Rule-based: 1 for an unambiguous phrase, lower when a name had to be guessed, 0 for unknown. */
  readonly confidence: number;
  /** Name of the grammar rule that matched, null for unknown. */
  readonly matchedRule: string | null;
}

export interface IntentRouter {
  route(text: string, context: CommandContext): Promise<RoutedIntent>;
}

export class RuleBasedIntentRouter implements IntentRouter {
  constructor(private readonly reader: CommandReader) {}

  async route(text: string, context: CommandContext): Promise<RoutedIntent> {
    const parsed = parse(text);
    switch (parsed.kind) {
      case "intent":
        return { intent: parsed.intent, confidence: parsed.confidence, matchedRule: parsed.rule };
      case "find":
        return this.routeFind(parsed);
      case "transactions_for":
        return this.routeTransactionsFor(parsed);
      case "scoped_noun":
        return this.routeScopedNoun(parsed, context);
      case "bare":
        return this.routeBare(parsed.text, text);
    }
  }

  /**
   * "find <thing>": the better name match wins — a person ("find eric") or a
   * thread ("find northwind"); ties go to the person. A hit that only came
   * from the reader's substring search (an email domain, a thread summary)
   * never beats a real name match. Nothing named that way → document search.
   */
  private async routeFind(parsed: Extract<Parse, { kind: "find" }>): Promise<RoutedIntent> {
    const q = parsed.query;
    const people = await searchPeople(this.reader, q);
    const threads = await searchThreads(this.reader, q);
    if (people.quality >= 0 && people.quality >= threads.quality) {
      return { intent: { type: "find_person", query: q }, confidence: confidenceOf(people.quality), matchedRule: `${parsed.rule}.person` };
    }
    if (threads.quality >= 0) {
      return { intent: { type: "show_thread", query: q }, confidence: confidenceOf(threads.quality), matchedRule: `${parsed.rule}.thread` };
    }
    return { intent: { type: "find_document", query: q }, confidence: 0.6, matchedRule: `${parsed.rule}.document` };
  }

  /** "transactions related to <x>": thread or person by match quality (ties → thread); unresolved → thread query, the executor reports. */
  private async routeTransactionsFor(parsed: Extract<Parse, { kind: "transactions_for" }>): Promise<RoutedIntent> {
    const q = parsed.target;
    const range = parsed.range;
    const threads = await searchThreads(this.reader, q);
    const people = await searchPeople(this.reader, q);
    let scope: TransactionScope;
    let confidence: number;
    let rule: string;
    if (threads.quality >= 0 && threads.quality >= people.quality) {
      scope = { threadQuery: q };
      confidence = confidenceOf(threads.quality);
      rule = `${parsed.rule}.thread`;
    } else if (people.quality >= 0) {
      scope = { personQuery: q };
      confidence = confidenceOf(people.quality);
      rule = `${parsed.rule}.person`;
    } else {
      scope = { threadQuery: q };
      confidence = 0.4;
      rule = `${parsed.rule}.unresolved`;
    }
    return { intent: { type: "show_transactions", scope, ...(range ? { range } : {}) }, confidence, matchedRule: rule };
  }

  /** Bare "documents" / "mail" / "transactions": scoped to the focused person or thread. */
  private async routeScopedNoun(parsed: Extract<Parse, { kind: "scoped_noun" }>, context: CommandContext): Promise<RoutedIntent> {
    const focus = context.focus ?? null;
    const rule = `${parsed.rule}.${parsed.noun}`;
    if (focus?.type === "person") {
      const person = await this.reader.getPerson(focus.id);
      if (person) {
        const personQuery = person.displayName;
        const intent: Intent =
          parsed.noun === "documents"
            ? { type: "show_person_documents", personQuery }
            : parsed.noun === "mail"
              ? { type: "show_person_mail", personQuery }
              : { type: "show_transactions", scope: { personQuery } };
        return { intent, confidence: 0.95, matchedRule: `${rule}.focus_person` };
      }
    }
    if (focus?.type === "thread") {
      const thread = await this.reader.getThread(focus.id);
      if (thread) {
        const intent: Intent =
          parsed.noun === "transactions"
            ? { type: "show_transactions", scope: { threadQuery: thread.title } }
            : { type: "show_thread", query: thread.title };
        return { intent, confidence: parsed.noun === "transactions" ? 0.95 : 0.7, matchedRule: `${rule}.focus_thread` };
      }
    }
    switch (parsed.noun) {
      case "documents":
        return { intent: { type: "show_recent_files", limit: 10 }, confidence: 0.7, matchedRule: `${rule}.unfocused` };
      case "transactions":
        return { intent: { type: "show_transactions" }, confidence: 0.8, matchedRule: `${rule}.unfocused` };
      case "mail":
        return { intent: { type: "unknown", text: parsed.noun }, confidence: 0, matchedRule: null };
    }
  }

  /**
   * No rule matched: a bare known thread name opens it ("Brand"); a bare
   * known person name finds them ("Eric Lindqvist"); a unique thread title
   * prefix opens that thread ("northwind"); else unknown. Substring-only
   * hits (summary, email) are not names and stay unknown.
   */
  private async routeBare(normalized: string, original: string): Promise<RoutedIntent> {
    if (normalized) {
      const threads = await searchThreads(this.reader, normalized);
      if (threads.quality === 3) return { intent: { type: "show_thread", query: normalized }, confidence: 1, matchedRule: "bare.thread" };
      const people = await searchPeople(this.reader, normalized);
      if (people.quality === 3) return { intent: { type: "find_person", query: normalized }, confidence: 0.9, matchedRule: "bare.person" };
      if (threads.quality >= 1 && threads.rows.length === 1) {
        return { intent: { type: "show_thread", query: normalized }, confidence: 0.7, matchedRule: "bare.thread_partial" };
      }
      if (people.quality >= 2) return { intent: { type: "find_person", query: normalized }, confidence: 0.6, matchedRule: "bare.person_partial" };
    }
    return { intent: { type: "unknown", text: original }, confidence: 0, matchedRule: null };
  }
}

function confidenceOf(quality: MatchQuality): number {
  switch (quality) {
    case 3:
      return 1;
    case 2:
      return 0.9;
    case 1:
      return 0.8;
    default:
      return 0.6;
  }
}
