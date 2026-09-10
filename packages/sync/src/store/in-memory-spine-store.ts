import {
  ContextGraph,
  newId,
  refKey,
  type ActionRequest,
  type Attention,
  type Conclusion,
  type ConnectorAccount,
  type ConnectorCapability,
  type ConnectorSyncState,
  type ContextEvent,
  type Device,
  type Document,
  type EntityRef,
  type Handoff,
  type IngestItem,
  type JsonObject,
  type MailAddress,
  type MailMessage,
  type MoneyAccount,
  type MoneyTransaction,
  type NormalizedMoneyAccount,
  type Person,
  type PersonIdentity,
  type PersonId,
  type PersonIdentityKind,
  type Relationship,
  type RelationshipInput,
  type Thread,
  type TimeEvent,
  type UserId,
} from "@vixera/domain";
import {
  SpineIntegrityError,
  SpineNotFoundError,
  type ActionRequestCreateResult,
  type ActionRequestInput,
  type ActionRequestPatch,
  type ConclusionInput,
  type ConnectorAccountInput,
  type ConnectorAccountPatch,
  type ContextEventInput,
  type ContextEventsQuery,
  type DeviceInput,
  type DevicePatch,
  type DocumentInput,
  type DocumentPatch,
  type DocumentsQuery,
  type HandoffInput,
  type HandoffPatch,
  type HandoffsQuery,
  type IngestItemInput,
  type IngestItemPatch,
  type IngestQuery,
  type MailMessageWrite,
  type MailQuery,
  type MoneyTransactionWrite,
  type NeighborRow,
  type NeighborsQuery,
  type Page,
  type PeopleQuery,
  type PersonIdentityInput,
  type PersonInput,
  type PersonPatch,
  type SpineStore,
  type SyncStatePatch,
  type ThreadInput,
  type ThreadPatch,
  type ThreadsQuery,
  type TimeEventWrite,
  type TimeQuery,
  type TransactionsQuery,
  type UpsertResult,
} from "./spine-store.ts";

/**
 * In-memory SpineStore for ONE user. Used by tests, dev fixtures and as the
 * executable specification of the SQL schema's semantics:
 *
 *   - natural-key upserts (mail / money: connectorAccountId+externalId;
 *     time: connectorAccountId+externalCalendarId+externalId; context events:
 *     dedupeKey, existing rows keep their attention; identities: kind+value)
 *   - relate() rejects edges to entities that do not exist for this user and
 *     dedupes by natural key (mirrors trigger `vx_validate_relationship` and
 *     `vx_relate`)
 *   - deleting an entity removes its edges, context events and conclusions
 *     (mirrors trigger `vx_on_entity_deleted`)
 *   - createActionRequest is idempotent by idempotencyKey
 *
 * Ids come from `newId()`; timestamps from the injectable clock so tests can
 * pin time. Nothing here is shared between instances: a second store for a
 * second user cannot see this one's rows, exactly like RLS.
 */
export interface InMemorySpineStoreOptions {
  /** Wall clock. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export class InMemorySpineStore implements SpineStore {
  private readonly now: () => Date;
  private readonly people = new Map<string, Person>();
  private readonly identities = new Map<string, PersonIdentity>();
  private readonly threads = new Map<string, Thread>();
  private readonly documents = new Map<string, Document>();
  private readonly mail = new Map<string, MailMessage>();
  private readonly moneyAccounts = new Map<string, MoneyAccount>();
  private readonly moneyTransactions = new Map<string, MoneyTransaction>();
  private readonly timeEvents = new Map<string, TimeEvent>();
  private readonly contextEvents = new Map<string, ContextEvent>();
  private readonly conclusions = new Map<string, Conclusion>();
  private readonly connectorAccounts = new Map<string, ConnectorAccount>();
  private readonly syncStates = new Map<string, ConnectorSyncState>();
  private readonly devices = new Map<string, Device>();
  private readonly handoffs = new Map<string, Handoff>();
  private readonly ingestItems = new Map<string, IngestItem>();
  private readonly actionRequests = new Map<string, ActionRequest>();
  private graph: ContextGraph;

  constructor(
    readonly userId: UserId,
    options: InMemorySpineStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.graph = new ContextGraph(userId, [], () => this.iso());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------
  async listPeople(query: PeopleQuery = {}): Promise<Person[]> {
    const search = query.search?.trim().toLowerCase();
    const identityMatches = new Set<string>();
    if (search) {
      for (const id of this.identities.values()) {
        if (id.value.toLowerCase().includes(search) || id.rawValue.toLowerCase().includes(search)) {
          identityMatches.add(id.personId);
        }
      }
    }
    let rows = [...this.people.values()];
    if (!query.includeMerged) rows = rows.filter((p) => p.mergedIntoId === null);
    if (search) {
      rows = rows.filter(
        (p) =>
          p.displayName.toLowerCase().includes(search) ||
          (p.organization?.toLowerCase().includes(search) ?? false) ||
          (p.primaryEmail?.toLowerCase().includes(search) ?? false) ||
          identityMatches.has(p.id),
      );
    }
    rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return page(rows, query);
  }

  async getPerson(id: string): Promise<Person | null> {
    return this.people.get(id) ?? null;
  }

  async findPersonByIdentity(kind: PersonIdentityKind, value: string): Promise<Person | null> {
    const identity = this.identities.get(identityKey(kind, value));
    if (!identity) return null;
    return this.people.get(identity.personId) ?? null;
  }

  async listPersonIdentities(personId: string): Promise<PersonIdentity[]> {
    return [...this.identities.values()].filter((i) => i.personId === personId);
  }

  async upsertPerson(input: PersonInput): Promise<Person> {
    const existing = input.id ? this.people.get(input.id) : undefined;
    const now = this.iso();
    const person: Person = {
      id: (existing?.id ?? input.id ?? newId()) as Person["id"],
      userId: this.userId,
      displayName: input.displayName,
      primaryEmail: input.primaryEmail,
      organization: input.organization,
      notes: input.notes,
      mergedIntoId: input.mergedIntoId ?? null,
      metadata: input.metadata,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.people.set(person.id, person);
    return person;
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<Person> {
    const existing = this.people.get(id);
    if (!existing) throw new SpineNotFoundError("person", id);
    const next: Person = { ...existing, ...definedOnly(patch), updatedAt: this.iso() };
    this.people.set(id, next);
    return next;
  }

  async upsertPersonIdentity(input: PersonIdentityInput): Promise<PersonIdentity> {
    const key = identityKey(input.kind, input.value);
    const existing = this.identities.get(key);
    if (existing) return existing;
    if (!this.people.has(input.personId)) {
      throw new SpineIntegrityError(`person ${input.personId} does not exist for user`);
    }
    const identity: PersonIdentity = { id: newId(), userId: this.userId, ...input, createdAt: this.iso() };
    this.identities.set(key, identity);
    return identity;
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------
  async listThreads(query: ThreadsQuery = {}): Promise<Thread[]> {
    const search = query.search?.trim().toLowerCase();
    let rows = [...this.threads.values()];
    if (query.status) rows = rows.filter((t) => t.status === query.status);
    if (search) {
      rows = rows.filter((t) => t.title.toLowerCase().includes(search) || (t.summary?.toLowerCase().includes(search) ?? false));
    }
    rows.sort(byDesc((t) => t.updatedAt));
    return page(rows, query);
  }

  async getThread(id: string): Promise<Thread | null> {
    return this.threads.get(id) ?? null;
  }

  async createThread(input: ThreadInput): Promise<Thread> {
    const now = this.iso();
    const thread: Thread = { ...input, id: (input.id ?? newId()) as Thread["id"], userId: this.userId, createdAt: now, updatedAt: now };
    this.threads.set(thread.id, thread);
    return thread;
  }

  async updateThread(id: string, patch: ThreadPatch): Promise<Thread> {
    const existing = this.threads.get(id);
    if (!existing) throw new SpineNotFoundError("thread", id);
    const next: Thread = { ...existing, ...definedOnly(patch), updatedAt: this.iso() };
    this.threads.set(id, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------
  async listDocuments(query: DocumentsQuery = {}): Promise<Document[]> {
    const search = query.search?.trim().toLowerCase();
    let rows = [...this.documents.values()];
    if (search) rows = rows.filter((d) => d.title.toLowerCase().includes(search));
    if (query.connectorAccountId) rows = rows.filter((d) => d.connectorAccountId === query.connectorAccountId);
    if (query.mimeTypePrefix) rows = rows.filter((d) => d.mimeType?.startsWith(query.mimeTypePrefix ?? "") ?? false);
    if (query.updatedSince) rows = rows.filter((d) => d.updatedAt >= (query.updatedSince ?? ""));
    rows.sort(byDesc((d) => d.updatedAt));
    return page(rows, query);
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.documents.get(id) ?? null;
  }

  async findDocumentByHash(contentHash: string): Promise<Document | null> {
    for (const d of this.documents.values()) if (d.contentHash === contentHash) return d;
    return null;
  }

  async findDocumentBySourceRef(connectorAccountId: string | null, sourceRef: JsonObject): Promise<Document | null> {
    const wanted = stableStringify(sourceRef);
    for (const d of this.documents.values()) {
      if (d.connectorAccountId === connectorAccountId && stableStringify(d.sourceRef) === wanted) return d;
    }
    return null;
  }

  async upsertDocument(input: DocumentInput): Promise<Document> {
    const existing = input.id ? this.documents.get(input.id) : undefined;
    const now = this.iso();
    const doc: Document = {
      ...input,
      id: (existing?.id ?? input.id ?? newId()) as Document["id"],
      userId: this.userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.documents.set(doc.id, doc);
    return doc;
  }

  async updateDocument(id: string, patch: DocumentPatch): Promise<Document> {
    const existing = this.documents.get(id);
    if (!existing) throw new SpineNotFoundError("document", id);
    const next: Document = { ...existing, ...definedOnly(patch), updatedAt: this.iso() };
    this.documents.set(id, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Mail
  // -------------------------------------------------------------------------
  async listMailMessages(query: MailQuery = {}): Promise<MailMessage[]> {
    const search = query.search?.trim().toLowerCase();
    let rows = [...this.mail.values()];
    if (query.connectorAccountId) rows = rows.filter((m) => m.connectorAccountId === query.connectorAccountId);
    if (query.fromPersonId) rows = rows.filter((m) => m.from?.personId === query.fromPersonId);
    if (query.receivedSince) rows = rows.filter((m) => m.receivedAt >= (query.receivedSince ?? ""));
    if (search) {
      rows = rows.filter(
        (m) =>
          (m.subject?.toLowerCase().includes(search) ?? false) ||
          (m.snippet?.toLowerCase().includes(search) ?? false) ||
          (m.from?.email.toLowerCase().includes(search) ?? false) ||
          (m.from?.name?.toLowerCase().includes(search) ?? false),
      );
    }
    rows.sort(byDesc((m) => m.receivedAt));
    return page(rows, query);
  }

  async getMailMessage(id: string): Promise<MailMessage | null> {
    return this.mail.get(id) ?? null;
  }

  async findMailMessageByExternalId(connectorAccountId: string, externalId: string): Promise<MailMessage | null> {
    for (const m of this.mail.values()) {
      if (m.connectorAccountId === connectorAccountId && m.externalId === externalId) return m;
    }
    return null;
  }

  async upsertMailMessages(connectorAccountId: string, messages: readonly MailMessageWrite[]): Promise<UpsertResult<MailMessage>> {
    this.requireConnectorAccount(connectorAccountId);
    const rows: MailMessage[] = [];
    let inserted = 0;
    let updated = 0;
    for (const w of messages) {
      const existing = await this.findMailMessageByExternalId(connectorAccountId, w.externalId);
      const now = this.iso();
      const toAddresses = (addresses: readonly { email: string; name: string | null }[], ids?: readonly (string | null)[]): MailAddress[] =>
        addresses.map((a, i) => ({ email: a.email, name: a.name, personId: (ids?.[i] ?? null) as PersonId | null }));
      const row: MailMessage = {
        id: (existing?.id ?? newId()) as MailMessage["id"],
        userId: this.userId,
        connectorAccountId: connectorAccountId as MailMessage["connectorAccountId"],
        externalId: w.externalId,
        externalThreadId: w.externalThreadId,
        subject: w.subject,
        snippet: w.snippet,
        bodyText: w.bodyText,
        from: w.from ? { email: w.from.email, name: w.from.name, personId: (w.fromPersonId ?? null) as PersonId | null } : null,
        to: toAddresses(w.to, w.toPersonIds),
        cc: toAddresses(w.cc, w.ccPersonIds),
        sentAt: w.sentAt,
        receivedAt: w.receivedAt,
        isUnread: w.isUnread,
        attachments: [...w.attachments],
        labels: [...w.labels],
        metadata: w.metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.mail.set(row.id, row);
      rows.push(row);
      if (existing) updated++;
      else inserted++;
    }
    return { rows, inserted, updated };
  }

  async deleteMailMessages(connectorAccountId: string, externalIds: readonly string[]): Promise<number> {
    const ids = new Set(externalIds);
    let count = 0;
    for (const m of [...this.mail.values()]) {
      if (m.connectorAccountId === connectorAccountId && ids.has(m.externalId)) {
        this.mail.delete(m.id);
        this.onEntityDeleted({ type: "mail_message", id: m.id });
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Money
  // -------------------------------------------------------------------------
  async listMoneyAccounts(connectorAccountId?: string): Promise<MoneyAccount[]> {
    let rows = [...this.moneyAccounts.values()];
    if (connectorAccountId) rows = rows.filter((a) => a.connectorAccountId === connectorAccountId);
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }

  async listMoneyTransactions(query: TransactionsQuery = {}): Promise<MoneyTransaction[]> {
    const search = query.search?.trim().toLowerCase();
    let rows = [...this.moneyTransactions.values()];
    if (query.connectorAccountId) rows = rows.filter((t) => t.connectorAccountId === query.connectorAccountId);
    if (query.moneyAccountId) rows = rows.filter((t) => t.moneyAccountId === query.moneyAccountId);
    if (query.postedFrom) rows = rows.filter((t) => t.postedOn >= (query.postedFrom ?? ""));
    if (query.postedTo) rows = rows.filter((t) => t.postedOn <= (query.postedTo ?? ""));
    if (query.counterpartyPersonId) rows = rows.filter((t) => t.counterpartyPersonId === query.counterpartyPersonId);
    if (search) {
      rows = rows.filter((t) => t.description.toLowerCase().includes(search) || (t.merchantName?.toLowerCase().includes(search) ?? false));
    }
    rows.sort(byDesc((t) => t.postedOn));
    return page(rows, query);
  }

  async getMoneyTransaction(id: string): Promise<MoneyTransaction | null> {
    return this.moneyTransactions.get(id) ?? null;
  }

  async upsertMoneyAccounts(connectorAccountId: string, accounts: readonly NormalizedMoneyAccount[]): Promise<UpsertResult<MoneyAccount>> {
    this.requireConnectorAccount(connectorAccountId);
    const rows: MoneyAccount[] = [];
    let inserted = 0;
    let updated = 0;
    for (const a of accounts) {
      const existing = this.findMoneyAccount(connectorAccountId, a.externalId);
      const now = this.iso();
      const row: MoneyAccount = {
        id: (existing?.id ?? newId()) as MoneyAccount["id"],
        userId: this.userId,
        connectorAccountId: connectorAccountId as MoneyAccount["connectorAccountId"],
        externalId: a.externalId,
        name: a.name,
        officialName: a.officialName,
        type: a.type,
        currency: a.currency,
        balanceCurrent: a.balanceCurrent,
        balanceAvailable: a.balanceAvailable,
        balanceAsOf: a.balanceAsOf,
        mask: a.mask,
        metadata: a.metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.moneyAccounts.set(row.id, row);
      rows.push(row);
      if (existing) updated++;
      else inserted++;
    }
    return { rows, inserted, updated };
  }

  async upsertMoneyTransactions(
    connectorAccountId: string,
    transactions: readonly MoneyTransactionWrite[],
  ): Promise<UpsertResult<MoneyTransaction>> {
    this.requireConnectorAccount(connectorAccountId);
    const rows: MoneyTransaction[] = [];
    let inserted = 0;
    let updated = 0;
    for (const t of transactions) {
      const account = this.findMoneyAccount(connectorAccountId, t.accountExternalId);
      if (!account) {
        throw new SpineIntegrityError(`money account ${t.accountExternalId} does not exist for connector account ${connectorAccountId}`);
      }
      if (t.counterpartyPersonId && !this.people.has(t.counterpartyPersonId)) {
        throw new SpineIntegrityError(`person ${t.counterpartyPersonId} does not exist for user`);
      }
      const existing = this.findMoneyTransaction(connectorAccountId, t.externalId);
      const now = this.iso();
      const row: MoneyTransaction = {
        id: (existing?.id ?? newId()) as MoneyTransaction["id"],
        userId: this.userId,
        connectorAccountId: connectorAccountId as MoneyTransaction["connectorAccountId"],
        moneyAccountId: account.id,
        externalId: t.externalId,
        amount: t.amount,
        currency: t.currency,
        description: t.description,
        merchantName: t.merchantName,
        postedOn: t.postedOn,
        authorizedAt: t.authorizedAt,
        pending: t.pending,
        category: [...t.category],
        counterpartyPersonId: (t.counterpartyPersonId ?? null) as MoneyTransaction["counterpartyPersonId"],
        metadata: t.metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.moneyTransactions.set(row.id, row);
      rows.push(row);
      if (existing) updated++;
      else inserted++;
    }
    return { rows, inserted, updated };
  }

  async deleteMoneyTransactions(connectorAccountId: string, externalIds: readonly string[]): Promise<number> {
    const ids = new Set(externalIds);
    let count = 0;
    for (const t of [...this.moneyTransactions.values()]) {
      if (t.connectorAccountId === connectorAccountId && ids.has(t.externalId)) {
        this.moneyTransactions.delete(t.id);
        this.onEntityDeleted({ type: "money_transaction", id: t.id });
        count++;
      }
    }
    return count;
  }

  private findMoneyAccount(connectorAccountId: string, externalId: string): MoneyAccount | undefined {
    for (const a of this.moneyAccounts.values()) {
      if (a.connectorAccountId === connectorAccountId && a.externalId === externalId) return a;
    }
    return undefined;
  }

  private findMoneyTransaction(connectorAccountId: string, externalId: string): MoneyTransaction | undefined {
    for (const t of this.moneyTransactions.values()) {
      if (t.connectorAccountId === connectorAccountId && t.externalId === externalId) return t;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------
  async listTimeEvents(query: TimeQuery): Promise<TimeEvent[]> {
    let rows = [...this.timeEvents.values()].filter((e) => e.startsAt <= query.to && e.endsAt >= query.from);
    if (query.connectorAccountId) rows = rows.filter((e) => e.connectorAccountId === query.connectorAccountId);
    rows.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return page(rows, query);
  }

  async getTimeEvent(id: string): Promise<TimeEvent | null> {
    return this.timeEvents.get(id) ?? null;
  }

  async upsertTimeEvents(connectorAccountId: string, events: readonly TimeEventWrite[]): Promise<UpsertResult<TimeEvent>> {
    this.requireConnectorAccount(connectorAccountId);
    const rows: TimeEvent[] = [];
    let inserted = 0;
    let updated = 0;
    for (const e of events) {
      if (e.endsAt < e.startsAt) throw new SpineIntegrityError(`time event ${e.externalId} ends before it starts`);
      const existing = this.findTimeEvent(connectorAccountId, e.externalCalendarId, e.externalId);
      const now = this.iso();
      const participants = e.participants.map((p, i) => ({ ...p, personId: (e.participantPersonIds?.[i] ?? p.personId ?? null) as PersonId | null }));
      const row: TimeEvent = {
        id: (existing?.id ?? newId()) as TimeEvent["id"],
        userId: this.userId,
        connectorAccountId: connectorAccountId as TimeEvent["connectorAccountId"],
        externalCalendarId: e.externalCalendarId,
        externalId: e.externalId,
        title: e.title,
        description: e.description,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allDay: e.allDay,
        timezone: e.timezone,
        location: e.location,
        status: e.status,
        organizer: e.organizer ? { ...e.organizer, personId: participants.find((p) => p.email && p.email === e.organizer?.email)?.personId ?? e.organizer.personId ?? null } : null,
        participants,
        externalLink: e.externalLink,
        metadata: e.metadata ?? {},
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      this.timeEvents.set(row.id, row);
      rows.push(row);
      if (existing) updated++;
      else inserted++;
    }
    return { rows, inserted, updated };
  }

  async deleteTimeEvents(connectorAccountId: string, externalIds: readonly string[], externalCalendarId?: string): Promise<number> {
    const ids = new Set(externalIds);
    let count = 0;
    for (const e of [...this.timeEvents.values()]) {
      if (e.connectorAccountId === connectorAccountId && ids.has(e.externalId) && (externalCalendarId === undefined || e.externalCalendarId === externalCalendarId)) {
        this.timeEvents.delete(e.id);
        this.onEntityDeleted({ type: "time_event", id: e.id });
        count++;
      }
    }
    return count;
  }

  private findTimeEvent(connectorAccountId: string, externalCalendarId: string, externalId: string): TimeEvent | undefined {
    for (const e of this.timeEvents.values()) {
      if (e.connectorAccountId === connectorAccountId && e.externalCalendarId === externalCalendarId && e.externalId === externalId) return e;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Context events + conclusions
  // -------------------------------------------------------------------------
  async listContextEvents(query: ContextEventsQuery = {}): Promise<ContextEvent[]> {
    let rows = [...this.contextEvents.values()];
    if (query.attention) {
      const wanted = new Set<Attention>(Array.isArray(query.attention) ? query.attention : [query.attention as Attention]);
      rows = rows.filter((e) => wanted.has(e.attention));
    }
    if (query.occurredSince) rows = rows.filter((e) => e.occurredAt >= (query.occurredSince ?? ""));
    if (query.kindPrefix) rows = rows.filter((e) => e.kind.startsWith(query.kindPrefix ?? ""));
    if (query.subject) rows = rows.filter((e) => refKey(e.subject) === refKey(query.subject as EntityRef));
    rows.sort(byDesc((e) => e.occurredAt));
    return page(rows, query);
  }

  async getContextEvent(id: string): Promise<ContextEvent | null> {
    return this.contextEvents.get(id) ?? null;
  }

  async listConclusions(subject: EntityRef): Promise<Conclusion[]> {
    return [...this.conclusions.values()].filter((c) => refKey(c.subject) === refKey(subject)).sort(byDesc((c) => c.createdAt));
  }

  async upsertContextEvents(events: readonly ContextEventInput[]): Promise<UpsertResult<ContextEvent>> {
    const rows: ContextEvent[] = [];
    let inserted = 0;
    let updated = 0;
    for (const input of events) {
      const existing = this.findContextEventByKey(input.dedupeKey);
      if (existing) {
        rows.push(existing);
        updated++;
        continue;
      }
      if (input.importance < 0 || input.importance > 100) {
        throw new SpineIntegrityError(`importance ${input.importance} out of range for ${input.dedupeKey}`);
      }
      if (!this.entityExists(input.subject)) {
        throw new SpineIntegrityError(`${input.subject.type} ${input.subject.id} does not exist for user`);
      }
      const row: ContextEvent = { ...input, id: (input.id ?? newId()) as ContextEvent["id"], userId: this.userId, createdAt: this.iso() };
      this.contextEvents.set(row.id, row);
      rows.push(row);
      inserted++;
    }
    return { rows, inserted, updated };
  }

  async setContextEventAttention(id: string, attention: Attention, metadata?: JsonObject): Promise<ContextEvent> {
    const existing = this.contextEvents.get(id);
    if (!existing) throw new SpineNotFoundError("context_event", id);
    const next: ContextEvent = { ...existing, attention, metadata: metadata ? { ...existing.metadata, ...metadata } : existing.metadata };
    this.contextEvents.set(id, next);
    return next;
  }

  async insertConclusion(input: ConclusionInput): Promise<Conclusion> {
    if (!this.entityExists(input.subject)) {
      throw new SpineIntegrityError(`${input.subject.type} ${input.subject.id} does not exist for user`);
    }
    const row: Conclusion = { ...input, id: (input.id ?? newId()) as Conclusion["id"], userId: this.userId, createdAt: this.iso() };
    this.conclusions.set(row.id, row);
    return row;
  }

  private findContextEventByKey(dedupeKey: string): ContextEvent | undefined {
    for (const e of this.contextEvents.values()) if (e.dedupeKey === dedupeKey) return e;
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------------
  async listRelationships(query: Page = {}): Promise<Relationship[]> {
    return page(this.graph.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt)), query);
  }

  async neighbors(node: EntityRef, query: NeighborsQuery = {}): Promise<NeighborRow[]> {
    return this.graph.neighbors(node, query).map((n) => ({
      relationshipId: n.edge.id,
      kind: n.edge.kind,
      direction: n.direction,
      ref: n.ref,
      confidence: n.edge.confidence,
    }));
  }

  async relate(input: RelationshipInput): Promise<Relationship> {
    if (!this.entityExists(input.from)) {
      throw new SpineIntegrityError(`relationship source ${input.from.type} ${input.from.id} does not exist for user`);
    }
    if (!this.entityExists(input.to)) {
      throw new SpineIntegrityError(`relationship target ${input.to.type} ${input.to.id} does not exist for user`);
    }
    if (input.from.type === input.to.type && input.from.id === input.to.id) {
      throw new SpineIntegrityError("an entity cannot relate to itself");
    }
    const existing = this.graph.neighbors(input.from, { kind: input.kind, direction: "out" }).find((n) => refKey(n.ref) === refKey(input.to));
    if (existing) {
      // vx_relate keeps the greatest confidence on conflict.
      const confidence = Math.max(existing.edge.confidence, input.confidence ?? 1);
      if (confidence !== existing.edge.confidence) {
        const upgraded: Relationship = { ...existing.edge, confidence };
        this.graph = new ContextGraph(this.userId, this.graph.all().map((e) => (e.id === upgraded.id ? upgraded : e)), () => this.iso());
        return upgraded;
      }
      return existing.edge;
    }
    return this.graph.relate({ ...input, source: input.source ?? "user" });
  }

  async unrelate(input: Pick<RelationshipInput, "from" | "kind" | "to">): Promise<boolean> {
    return this.graph.unrelate(input);
  }

  // -------------------------------------------------------------------------
  // Connector accounts + sync states
  // -------------------------------------------------------------------------
  async listConnectorAccounts(): Promise<ConnectorAccount[]> {
    return [...this.connectorAccounts.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getConnectorAccount(id: string): Promise<ConnectorAccount | null> {
    return this.connectorAccounts.get(id) ?? null;
  }

  async findConnectorAccount(provider: ConnectorAccount["provider"], externalAccountId: string): Promise<ConnectorAccount | null> {
    for (const a of this.connectorAccounts.values()) {
      if (a.provider === provider && a.externalAccountId === externalAccountId) return a;
    }
    return null;
  }

  async listSyncStates(connectorAccountId?: string): Promise<ConnectorSyncState[]> {
    let rows = [...this.syncStates.values()];
    if (connectorAccountId) rows = rows.filter((s) => s.connectorAccountId === connectorAccountId);
    return rows;
  }

  async getSyncState(connectorAccountId: string, capability: ConnectorCapability): Promise<ConnectorSyncState | null> {
    return this.syncStates.get(`${connectorAccountId}:${capability}`) ?? null;
  }

  async createConnectorAccount(input: ConnectorAccountInput): Promise<ConnectorAccount> {
    if (await this.findConnectorAccount(input.provider, input.externalAccountId)) {
      throw new SpineIntegrityError(`connector account ${input.provider}/${input.externalAccountId} already exists for user`);
    }
    const now = this.iso();
    const row: ConnectorAccount = {
      ...input,
      id: (input.id ?? newId()) as ConnectorAccount["id"],
      userId: this.userId,
      capabilities: [...input.capabilities],
      createdAt: now,
      updatedAt: now,
    };
    this.connectorAccounts.set(row.id, row);
    return row;
  }

  async updateConnectorAccount(id: string, patch: ConnectorAccountPatch): Promise<ConnectorAccount> {
    const existing = this.connectorAccounts.get(id);
    if (!existing) throw new SpineNotFoundError("connector_account", id);
    const next: ConnectorAccount = { ...existing, ...definedOnly(patch), updatedAt: this.iso() };
    this.connectorAccounts.set(id, next);
    return next;
  }

  async upsertSyncState(connectorAccountId: string, capability: ConnectorCapability, patch: SyncStatePatch): Promise<ConnectorSyncState> {
    this.requireConnectorAccount(connectorAccountId);
    const key = `${connectorAccountId}:${capability}`;
    const existing = this.syncStates.get(key);
    const base: ConnectorSyncState = existing ?? {
      userId: this.userId,
      connectorAccountId: connectorAccountId as ConnectorSyncState["connectorAccountId"],
      capability,
      enabled: true,
      status: "idle",
      checkpoint: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      updatedAt: this.iso(),
    };
    const next: ConnectorSyncState = { ...base, ...definedOnly(patch), updatedAt: this.iso() };
    this.syncStates.set(key, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Devices, handoffs, ingest, actions
  // -------------------------------------------------------------------------
  async listDevices(): Promise<Device[]> {
    return [...this.devices.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getDevice(id: string): Promise<Device | null> {
    return this.devices.get(id) ?? null;
  }

  async upsertDevice(input: DeviceInput): Promise<Device> {
    const existing = input.id ? this.devices.get(input.id) : undefined;
    const row: Device = { ...input, id: (existing?.id ?? input.id ?? newId()) as Device["id"], userId: this.userId, createdAt: existing?.createdAt ?? this.iso() };
    this.devices.set(row.id, row);
    return row;
  }

  async updateDevice(id: string, patch: DevicePatch): Promise<Device> {
    const existing = this.devices.get(id);
    if (!existing) throw new SpineNotFoundError("device", id);
    const next: Device = { ...existing, ...definedOnly(patch) };
    this.devices.set(id, next);
    return next;
  }

  async listHandoffs(query: HandoffsQuery = {}): Promise<Handoff[]> {
    let rows = [...this.handoffs.values()];
    if (query.state) {
      const wanted = new Set(Array.isArray(query.state) ? query.state : [query.state]);
      rows = rows.filter((h) => wanted.has(h.state));
    }
    if (query.targetDeviceId !== undefined) rows = rows.filter((h) => h.targetDeviceId === query.targetDeviceId);
    rows.sort(byDesc((h) => h.createdAt));
    return page(rows, query);
  }

  async getHandoff(id: string): Promise<Handoff | null> {
    return this.handoffs.get(id) ?? null;
  }

  async createHandoff(input: HandoffInput): Promise<Handoff> {
    if (!this.devices.has(input.sourceDeviceId)) throw new SpineIntegrityError(`device ${input.sourceDeviceId} does not exist for user`);
    const row: Handoff = { ...input, id: (input.id ?? newId()) as Handoff["id"], userId: this.userId, createdAt: this.iso() };
    this.handoffs.set(row.id, row);
    return row;
  }

  async updateHandoff(id: string, patch: HandoffPatch): Promise<Handoff> {
    const existing = this.handoffs.get(id);
    if (!existing) throw new SpineNotFoundError("handoff", id);
    const next: Handoff = { ...existing, ...definedOnly(patch) };
    this.handoffs.set(id, next);
    return next;
  }

  async listIngestItems(query: IngestQuery = {}): Promise<IngestItem[]> {
    let rows = [...this.ingestItems.values()];
    if (query.status) rows = rows.filter((i) => i.status === query.status);
    rows.sort(byDesc((i) => i.createdAt));
    return page(rows, query);
  }

  async getIngestItem(id: string): Promise<IngestItem | null> {
    return this.ingestItems.get(id) ?? null;
  }

  async createIngestItem(input: IngestItemInput): Promise<IngestItem> {
    const row: IngestItem = { ...input, id: (input.id ?? newId()) as IngestItem["id"], userId: this.userId, createdAt: this.iso() };
    this.ingestItems.set(row.id, row);
    return row;
  }

  async updateIngestItem(id: string, patch: IngestItemPatch): Promise<IngestItem> {
    const existing = this.ingestItems.get(id);
    if (!existing) throw new SpineNotFoundError("ingest_item", id);
    const next: IngestItem = { ...existing, ...definedOnly(patch) };
    this.ingestItems.set(id, next);
    return next;
  }

  async getActionRequest(id: string): Promise<ActionRequest | null> {
    return this.actionRequests.get(id) ?? null;
  }

  async findActionRequestByKey(idempotencyKey: string): Promise<ActionRequest | null> {
    for (const r of this.actionRequests.values()) if (r.idempotencyKey === idempotencyKey) return r;
    return null;
  }

  async createActionRequest(input: ActionRequestInput): Promise<ActionRequestCreateResult> {
    const existing = await this.findActionRequestByKey(input.idempotencyKey);
    if (existing) return { request: existing, created: false };
    const now = this.iso();
    const row: ActionRequest = {
      id: newId(),
      userId: this.userId,
      actionType: input.actionType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      status: "queued",
      result: null,
      error: null,
      attempts: 0,
      actorDeviceId: (input.actorDeviceId ?? null) as ActionRequest["actorDeviceId"],
      createdAt: now,
      updatedAt: now,
    };
    this.actionRequests.set(row.id, row);
    return { request: row, created: true };
  }

  async updateActionRequest(id: string, patch: ActionRequestPatch): Promise<ActionRequest> {
    const existing = this.actionRequests.get(id);
    if (!existing) throw new SpineNotFoundError("action_request", id);
    const next: ActionRequest = { ...existing, ...definedOnly(patch), updatedAt: this.iso() };
    this.actionRequests.set(id, next);
    return next;
  }

  // -------------------------------------------------------------------------
  // Internals mirroring the SQL triggers
  // -------------------------------------------------------------------------
  private entityExists(node: EntityRef): boolean {
    switch (node.type) {
      case "person":
        return this.people.has(node.id);
      case "thread":
        return this.threads.has(node.id);
      case "document":
        return this.documents.has(node.id);
      case "mail_message":
        return this.mail.has(node.id);
      case "money_account":
        return this.moneyAccounts.has(node.id);
      case "money_transaction":
        return this.moneyTransactions.has(node.id);
      case "time_event":
        return this.timeEvents.has(node.id);
      case "context_event":
        return this.contextEvents.has(node.id);
      case "conclusion":
        return this.conclusions.has(node.id);
      case "ingest_item":
        return this.ingestItems.has(node.id);
      case "handoff":
        return this.handoffs.has(node.id);
      case "device":
        return this.devices.has(node.id);
    }
  }

  /** Mirrors `vx_on_entity_deleted`: edges, context events and conclusions about the entity go away. */
  private onEntityDeleted(node: EntityRef): void {
    this.graph.removeEntity(node);
    const key = refKey(node);
    for (const e of [...this.contextEvents.values()]) if (refKey(e.subject) === key) this.contextEvents.delete(e.id);
    for (const c of [...this.conclusions.values()]) if (refKey(c.subject) === key) this.conclusions.delete(c.id);
  }

  private requireConnectorAccount(id: string): void {
    if (!this.connectorAccounts.has(id)) throw new SpineIntegrityError(`connector account ${id} does not exist for user`);
  }
}

function identityKey(kind: PersonIdentityKind, value: string): string {
  return `${kind}:${value}`;
}

function page<T>(rows: T[], q: Page): T[] {
  const offset = q.offset ?? 0;
  const limit = q.limit ?? rows.length;
  return rows.slice(offset, offset + limit);
}

function byDesc<T>(key: (row: T) => string): (a: T, b: T) => number {
  return (a, b) => key(b).localeCompare(key(a));
}

/** Drops `undefined` values so a partial patch never erases a column (like PostgREST). */
function definedOnly<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

/** JSON with sorted keys so two equal objects compare equal as strings. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}
