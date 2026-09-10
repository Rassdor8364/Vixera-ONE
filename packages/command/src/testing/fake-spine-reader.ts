import {
  DEV_USER_ID,
  refKey,
  type Document,
  type EntityRef,
  type MailMessage,
  type MoneyTransaction,
  type Person,
  type RelationshipKind,
  type Thread,
  type TimeEvent,
  type UserId,
} from "@vixera/domain";
import type { DocumentsQuery, MailQuery, NeighborRow, NeighborsQuery, PeopleQuery, ThreadsQuery, TimeQuery, TransactionsQuery } from "@vixera/sync";
import type { CommandReader } from "../reader.ts";

/**
 * A small in-memory `CommandReader` for One Command tests. It implements
 * only the `SpineReader` methods One Command uses, with the same query
 * semantics as the real stores (case-insensitive substring search, overlap
 * for time ranges, neighbors over a typed edge list in both directions).
 * Every row is stamped with the reader's user id; there is no way to load a
 * row for another user.
 */
export interface FakeEdge {
  readonly from: EntityRef;
  readonly kind: RelationshipKind;
  readonly to: EntityRef;
  readonly confidence?: number;
}

export interface FakeWorld {
  readonly people?: readonly Person[];
  readonly threads?: readonly Thread[];
  readonly documents?: readonly Document[];
  readonly mail?: readonly MailMessage[];
  readonly transactions?: readonly MoneyTransaction[];
  readonly events?: readonly TimeEvent[];
  readonly edges?: readonly FakeEdge[];
}

export class FakeSpineReader implements CommandReader {
  readonly userId: UserId;
  readonly people = new Map<string, Person>();
  readonly threads = new Map<string, Thread>();
  readonly documents = new Map<string, Document>();
  readonly mail = new Map<string, MailMessage>();
  readonly transactions = new Map<string, MoneyTransaction>();
  readonly events = new Map<string, TimeEvent>();
  readonly edges: FakeEdge[] = [];
  /** Every call made, for tests that assert no query ever carries a user id. */
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];

  constructor(world: FakeWorld = {}, userId: UserId = DEV_USER_ID) {
    this.userId = userId;
    for (const p of world.people ?? []) this.people.set(p.id, this.own(p));
    for (const t of world.threads ?? []) this.threads.set(t.id, this.own(t));
    for (const d of world.documents ?? []) this.documents.set(d.id, this.own(d));
    for (const m of world.mail ?? []) this.mail.set(m.id, this.own(m));
    for (const t of world.transactions ?? []) this.transactions.set(t.id, this.own(t));
    for (const e of world.events ?? []) this.events.set(e.id, this.own(e));
    this.edges.push(...(world.edges ?? []));
  }

  private own<T extends { readonly userId: UserId }>(row: T): T {
    if (row.userId !== this.userId) throw new Error(`Fixture row belongs to another user (${row.userId})`);
    return row;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async listPeople(query: PeopleQuery = {}): Promise<Person[]> {
    this.record("listPeople", query);
    const search = query.search?.trim().toLowerCase();
    let rows = [...this.people.values()];
    if (!query.includeMerged) rows = rows.filter((p) => p.mergedIntoId === null);
    if (search) {
      rows = rows.filter(
        (p) =>
          p.displayName.toLowerCase().includes(search) ||
          (p.organization?.toLowerCase().includes(search) ?? false) ||
          (p.primaryEmail?.toLowerCase().includes(search) ?? false),
      );
    }
    return page(rows, query);
  }

  async getPerson(id: string): Promise<Person | null> {
    this.record("getPerson", id);
    return this.people.get(id) ?? null;
  }

  async listThreads(query: ThreadsQuery = {}): Promise<Thread[]> {
    this.record("listThreads", query);
    const search = query.search?.trim().toLowerCase();
    let rows = [...this.threads.values()];
    if (query.status) rows = rows.filter((t) => t.status === query.status);
    if (search) rows = rows.filter((t) => t.title.toLowerCase().includes(search) || (t.summary?.toLowerCase().includes(search) ?? false));
    return page(rows, query);
  }

  async getThread(id: string): Promise<Thread | null> {
    this.record("getThread", id);
    return this.threads.get(id) ?? null;
  }

  async listDocuments(query: DocumentsQuery = {}): Promise<Document[]> {
    this.record("listDocuments", query);
    const search = query.search?.trim().toLowerCase();
    let rows = [...this.documents.values()];
    if (search) rows = rows.filter((d) => d.title.toLowerCase().includes(search));
    if (query.mimeTypePrefix) rows = rows.filter((d) => d.mimeType?.startsWith(query.mimeTypePrefix ?? "") ?? false);
    if (query.updatedSince) rows = rows.filter((d) => d.updatedAt >= (query.updatedSince ?? ""));
    // Deliberately NOT sorted: the executor must not rely on store order.
    return page(rows, query);
  }

  async getDocument(id: string): Promise<Document | null> {
    this.record("getDocument", id);
    return this.documents.get(id) ?? null;
  }

  async listMailMessages(query: MailQuery = {}): Promise<MailMessage[]> {
    this.record("listMailMessages", query);
    let rows = [...this.mail.values()];
    if (query.fromPersonId) rows = rows.filter((m) => m.from?.personId === query.fromPersonId);
    if (query.receivedSince) rows = rows.filter((m) => m.receivedAt >= (query.receivedSince ?? ""));
    const search = query.search?.trim().toLowerCase();
    if (search) rows = rows.filter((m) => (m.subject?.toLowerCase().includes(search) ?? false) || (m.snippet?.toLowerCase().includes(search) ?? false));
    return page(rows, query);
  }

  async getMailMessage(id: string): Promise<MailMessage | null> {
    this.record("getMailMessage", id);
    return this.mail.get(id) ?? null;
  }

  async listMoneyTransactions(query: TransactionsQuery = {}): Promise<MoneyTransaction[]> {
    this.record("listMoneyTransactions", query);
    let rows = [...this.transactions.values()];
    if (query.counterpartyPersonId) rows = rows.filter((t) => t.counterpartyPersonId === query.counterpartyPersonId);
    if (query.postedFrom) rows = rows.filter((t) => t.postedOn >= (query.postedFrom ?? ""));
    if (query.postedTo) rows = rows.filter((t) => t.postedOn <= (query.postedTo ?? ""));
    const search = query.search?.trim().toLowerCase();
    if (search) rows = rows.filter((t) => t.description.toLowerCase().includes(search) || (t.merchantName?.toLowerCase().includes(search) ?? false));
    return page(rows, query);
  }

  async getMoneyTransaction(id: string): Promise<MoneyTransaction | null> {
    this.record("getMoneyTransaction", id);
    return this.transactions.get(id) ?? null;
  }

  async listTimeEvents(query: TimeQuery): Promise<TimeEvent[]> {
    this.record("listTimeEvents", query);
    const rows = [...this.events.values()].filter((e) => e.startsAt <= query.to && e.endsAt >= query.from);
    rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return page(rows, query);
  }

  async getTimeEvent(id: string): Promise<TimeEvent | null> {
    this.record("getTimeEvent", id);
    return this.events.get(id) ?? null;
  }

  async neighbors(node: EntityRef, query: NeighborsQuery = {}): Promise<NeighborRow[]> {
    this.record("neighbors", node, query);
    const direction = query.direction ?? "both";
    const key = refKey(node);
    const out: NeighborRow[] = [];
    this.edges.forEach((edge, i) => {
      const isOut = refKey(edge.from) === key;
      const isIn = refKey(edge.to) === key;
      if (!isOut && !isIn) return;
      if (direction === "out" && !isOut) return;
      if (direction === "in" && !isIn) return;
      const other = isOut ? edge.to : edge.from;
      if (query.type && other.type !== query.type) return;
      if (query.kind && edge.kind !== query.kind) return;
      out.push({ relationshipId: `edge-${i}`, kind: edge.kind, direction: isOut ? "out" : "in", ref: other, confidence: edge.confidence ?? 1 });
    });
    return out;
  }
}

function page<T>(rows: T[], q: { readonly limit?: number; readonly offset?: number }): T[] {
  const start = q.offset ?? 0;
  return rows.slice(start, q.limit === undefined ? undefined : start + q.limit);
}
