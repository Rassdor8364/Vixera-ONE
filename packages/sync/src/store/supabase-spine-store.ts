import type { SupabaseClient } from "@supabase/supabase-js";
import {
  newId,
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
  type MailMessage,
  type MoneyAccount,
  type MoneyTransaction,
  type NormalizedMoneyAccount,
  type Person,
  type PersonIdentity,
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
import {
  actionRequestFromRow,
  actionRequestPatchToRow,
  actionRequestToRow,
  conclusionFromRow,
  conclusionToRow,
  connectorAccountFromRow,
  connectorAccountPatchToRow,
  connectorAccountToRow,
  contextEventFromRow,
  contextEventToRow,
  deviceFromRow,
  devicePatchToRow,
  deviceToRow,
  documentFromRow,
  documentPatchToRow,
  documentToRow,
  handoffFromRow,
  handoffPatchToRow,
  handoffToRow,
  ingestItemFromRow,
  ingestItemPatchToRow,
  ingestItemToRow,
  mailMessageFromRow,
  mailMessageToRow,
  moneyAccountFromRow,
  moneyAccountToRow,
  moneyTransactionFromRow,
  moneyTransactionToRow,
  neighborRefFromRpc,
  numberFromDb,
  personFromRow,
  personIdentityFromRow,
  personIdentityToRow,
  personPatchToRow,
  personToRow,
  relationshipFromRow,
  syncStateFromRow,
  syncStatePatchToRow,
  threadFromRow,
  threadPatchToRow,
  threadToRow,
  timeEventFromRow,
  timeEventToRow,
  type ActionRequestRow,
  type ConclusionRow,
  type ConnectorAccountRow,
  type ConnectorSyncStateRow,
  type ContextEventRow,
  type DeviceRow,
  type DocumentRow,
  type HandoffRow,
  type IngestItemRow,
  type MailMessageRow,
  type MoneyAccountRow,
  type MoneyTransactionRow,
  type NeighborRpcRow,
  type PersonIdentityRow,
  type PersonRow,
  type RelationshipRow,
  type ThreadRow,
  type TimeEventRow,
} from "./rows.ts";

/**
 * SpineStore over PostgreSQL through supabase-js (PostgREST + RPC).
 *
 * Bound to ONE user id: every read filters `user_id = this.userId` (RLS
 * enforces the same for authenticated clients; the service role used by Edge
 * Functions bypasses RLS, so the explicit filter is what keeps the server
 * honest) and every write sets `user_id`.
 *
 * The client is accepted, never constructed here (see `createSpineClient`
 * for the one place that wraps `createClient`). Column names live in
 * `rows.ts`; conflict targets below name the UNIQUE constraints of
 * supabase/migrations/20260910000100_spine.sql.
 *
 * Error mapping: PostgREST errors with SQLSTATE 23503 (foreign_key_violation,
 * raised by `vx_validate_relationship`), 23505 (unique), 23514 (check) and
 * P0001 (raise_exception) become `SpineIntegrityError`; everything else is
 * rethrown as `SpineStorageError` carrying the PostgREST code.
 */
export class SpineStorageError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly details: string | null = null,
  ) {
    super(message);
    this.name = "SpineStorageError";
  }
}

interface PgError {
  readonly code?: string | null;
  readonly message?: string;
  readonly details?: string | null;
}

interface Result<T> {
  readonly data: T | null;
  readonly error: PgError | null;
}

const INTEGRITY_CODES = new Set(["23503", "23505", "23514", "P0001"]);
const CHUNK = 500;

export class SupabaseSpineStore implements SpineStore {
  /** Timestamps are set by the database (defaults + `vx_set_updated_at`), so no clock is needed here. */
  constructor(
    private readonly client: SupabaseClient,
    readonly userId: UserId,
  ) {}

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------
  // The client is used untyped (no generated Database types in Phase 1); rows are
  // narrowed through the explicit row types in rows.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private from(table: string): any {
    return this.client.from(table);
  }

  private async run<T>(q: PromiseLike<Result<T>>, context: string): Promise<T | null> {
    const res = await q;
    if (res.error) throw mapError(res.error, context);
    return res.data;
  }

  private async rows<T>(q: PromiseLike<Result<T[]>>, context: string): Promise<T[]> {
    return (await this.run(q, context)) ?? [];
  }

  private async required<T>(q: PromiseLike<Result<T>>, entity: string, id: string): Promise<T> {
    const row = await this.run(q, `${entity} ${id}`);
    if (row === null) throw new SpineNotFoundError(entity, id);
    return row;
  }

  private select(table: string): SelectBuilder {
    return this.from(table).select("*").eq("user_id", this.userId);
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------
  async listPeople(query: PeopleQuery = {}): Promise<Person[]> {
    let q = this.select("people");
    if (!query.includeMerged) q = q.is("merged_into_id", null);
    const search = query.search?.trim();
    if (search) {
      const pattern = orIlike(search);
      const identityRows = await this.rows<{ person_id: string }>(
        this.from("person_identities").select("person_id").eq("user_id", this.userId).ilike("value", ilike(search)).limit(200),
        "person identities search",
      );
      const ids = [...new Set(identityRows.map((r) => r.person_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
      const clauses = [`display_name.ilike.${pattern}`, `organization.ilike.${pattern}`, `primary_email.ilike.${pattern}`];
      if (ids.length) clauses.push(`id.in.(${ids.join(",")})`);
      q = q.or(clauses.join(","));
    }
    q = paged(q.order("display_name", { ascending: true }), query);
    return (await this.rows<PersonRow>(q, "people")).map(personFromRow);
  }

  async getPerson(id: string): Promise<Person | null> {
    const row = await this.run<PersonRow>(this.select("people").eq("id", id).maybeSingle(), `person ${id}`);
    return row ? personFromRow(row) : null;
  }

  async findPersonByIdentity(kind: PersonIdentityKind, value: string): Promise<Person | null> {
    const identity = await this.run<PersonIdentityRow>(
      this.select("person_identities").eq("kind", kind).eq("value", value).maybeSingle(),
      `identity ${kind}:${value}`,
    );
    return identity ? this.getPerson(identity.person_id) : null;
  }

  async listPersonIdentities(personId: string): Promise<PersonIdentity[]> {
    const rows = await this.rows<PersonIdentityRow>(this.select("person_identities").eq("person_id", personId).order("created_at"), "identities");
    return rows.map(personIdentityFromRow);
  }

  async upsertPerson(input: PersonInput): Promise<Person> {
    const row = personToRow(this.userId, input.id ?? newId(), input);
    const saved = await this.required<PersonRow>(this.from("people").upsert(row, { onConflict: "id" }).select().single(), "person", row.id);
    return personFromRow(saved);
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<Person> {
    const saved = await this.required<PersonRow>(
      this.from("people").update(personPatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(),
      "person",
      id,
    );
    return personFromRow(saved);
  }

  async upsertPersonIdentity(input: PersonIdentityInput): Promise<PersonIdentity> {
    const inserted = await this.run<PersonIdentityRow>(
      this.from("person_identities")
        .upsert(personIdentityToRow(this.userId, input), { onConflict: "user_id,kind,value", ignoreDuplicates: true })
        .select()
        .maybeSingle(),
      `identity ${input.kind}:${input.value}`,
    );
    if (inserted) return personIdentityFromRow(inserted);
    const existing = await this.run<PersonIdentityRow>(
      this.select("person_identities").eq("kind", input.kind).eq("value", input.value).maybeSingle(),
      `identity ${input.kind}:${input.value}`,
    );
    if (!existing) throw new SpineStorageError(`identity ${input.kind}:${input.value} vanished between upsert and read`, null);
    return personIdentityFromRow(existing);
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------
  async listThreads(query: ThreadsQuery = {}): Promise<Thread[]> {
    let q = this.select("threads");
    if (query.status) q = q.eq("status", query.status);
    const search = query.search?.trim();
    if (search) {
      const p = orIlike(search);
      q = q.or(`title.ilike.${p},summary.ilike.${p}`);
    }
    q = paged(q.order("updated_at", { ascending: false }), query);
    return (await this.rows<ThreadRow>(q, "threads")).map(threadFromRow);
  }

  async getThread(id: string): Promise<Thread | null> {
    const row = await this.run<ThreadRow>(this.select("threads").eq("id", id).maybeSingle(), `thread ${id}`);
    return row ? threadFromRow(row) : null;
  }

  async createThread(input: ThreadInput): Promise<Thread> {
    const row = threadToRow(this.userId, input.id ?? newId(), input);
    return threadFromRow(await this.required<ThreadRow>(this.from("threads").insert(row).select().single(), "thread", row.id));
  }

  async updateThread(id: string, patch: ThreadPatch): Promise<Thread> {
    return threadFromRow(
      await this.required<ThreadRow>(this.from("threads").update(threadPatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(), "thread", id),
    );
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------
  async listDocuments(query: DocumentsQuery = {}): Promise<Document[]> {
    let q = this.select("documents");
    const search = query.search?.trim();
    if (search) q = q.ilike("title", ilike(search));
    if (query.connectorAccountId) q = q.eq("connector_account_id", query.connectorAccountId);
    if (query.mimeTypePrefix) q = q.ilike("mime_type", `${escapeLike(query.mimeTypePrefix)}%`);
    if (query.updatedSince) q = q.gte("updated_at", query.updatedSince);
    q = paged(q.order("updated_at", { ascending: false }), query);
    return (await this.rows<DocumentRow>(q, "documents")).map(documentFromRow);
  }

  async getDocument(id: string): Promise<Document | null> {
    const row = await this.run<DocumentRow>(this.select("documents").eq("id", id).maybeSingle(), `document ${id}`);
    return row ? documentFromRow(row) : null;
  }

  async findDocumentByHash(contentHash: string): Promise<Document | null> {
    const row = await this.run<DocumentRow>(this.select("documents").eq("content_hash", contentHash).limit(1).maybeSingle(), "document by hash");
    return row ? documentFromRow(row) : null;
  }

  async findDocumentBySourceRef(connectorAccountId: string | null, sourceRef: JsonObject): Promise<Document | null> {
    let q = this.select("documents").contains("source_ref", sourceRef);
    q = connectorAccountId === null ? q.is("connector_account_id", null) : q.eq("connector_account_id", connectorAccountId);
    const rows = await this.rows<DocumentRow>(q.limit(10), "document by source ref");
    // `contains` is superset matching; keep exact equality semantics.
    const wanted = JSON.stringify(sortKeys(sourceRef));
    const hit = rows.find((r) => JSON.stringify(sortKeys(r.source_ref)) === wanted) ?? rows[0];
    return hit ? documentFromRow(hit) : null;
  }

  async upsertDocument(input: DocumentInput): Promise<Document> {
    const row = documentToRow(this.userId, input.id ?? newId(), input);
    return documentFromRow(await this.required<DocumentRow>(this.from("documents").upsert(row, { onConflict: "id" }).select().single(), "document", row.id));
  }

  async updateDocument(id: string, patch: DocumentPatch): Promise<Document> {
    return documentFromRow(
      await this.required<DocumentRow>(
        this.from("documents").update(documentPatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(),
        "document",
        id,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Mail
  // -------------------------------------------------------------------------
  async listMailMessages(query: MailQuery = {}): Promise<MailMessage[]> {
    let q = this.select("mail_messages");
    if (query.connectorAccountId) q = q.eq("connector_account_id", query.connectorAccountId);
    if (query.fromPersonId) q = q.eq("from_person_id", query.fromPersonId);
    if (query.receivedSince) q = q.gte("received_at", query.receivedSince);
    const search = query.search?.trim();
    if (search) {
      const p = orIlike(search);
      q = q.or(`subject.ilike.${p},snippet.ilike.${p},from_address.ilike.${p},from_name.ilike.${p}`);
    }
    q = paged(q.order("received_at", { ascending: false }), query);
    return (await this.rows<MailMessageRow>(q, "mail")).map(mailMessageFromRow);
  }

  async getMailMessage(id: string): Promise<MailMessage | null> {
    const row = await this.run<MailMessageRow>(this.select("mail_messages").eq("id", id).maybeSingle(), `mail ${id}`);
    return row ? mailMessageFromRow(row) : null;
  }

  async findMailMessageByExternalId(connectorAccountId: string, externalId: string): Promise<MailMessage | null> {
    const row = await this.run<MailMessageRow>(
      this.select("mail_messages").eq("connector_account_id", connectorAccountId).eq("external_id", externalId).maybeSingle(),
      `mail ${externalId}`,
    );
    return row ? mailMessageFromRow(row) : null;
  }

  async upsertMailMessages(connectorAccountId: string, messages: readonly MailMessageWrite[]): Promise<UpsertResult<MailMessage>> {
    if (!messages.length) return { rows: [], inserted: 0, updated: 0 };
    const existing = await this.existingExternalIds("mail_messages", connectorAccountId, messages.map((m) => m.externalId));
    const rows = lastByKey(
      messages.map((m) => mailMessageToRow(this.userId, connectorAccountId, m)),
      (r) => r.external_id,
    );
    const saved = await this.upsertChunked<MailMessageRow>("mail_messages", rows, "user_id,connector_account_id,external_id");
    return this.upsertResult(messages.map((m) => m.externalId), saved, (r) => r.external_id, existing, mailMessageFromRow);
  }

  async deleteMailMessages(connectorAccountId: string, externalIds: readonly string[]): Promise<number> {
    return this.deleteByExternalIds("mail_messages", connectorAccountId, externalIds);
  }

  // -------------------------------------------------------------------------
  // Money
  // -------------------------------------------------------------------------
  async listMoneyAccounts(connectorAccountId?: string): Promise<MoneyAccount[]> {
    let q = this.select("money_accounts");
    if (connectorAccountId) q = q.eq("connector_account_id", connectorAccountId);
    return (await this.rows<MoneyAccountRow>(q.order("name"), "money accounts")).map(moneyAccountFromRow);
  }

  async listMoneyTransactions(query: TransactionsQuery = {}): Promise<MoneyTransaction[]> {
    let q = this.select("money_transactions");
    if (query.connectorAccountId) q = q.eq("connector_account_id", query.connectorAccountId);
    if (query.moneyAccountId) q = q.eq("money_account_id", query.moneyAccountId);
    if (query.postedFrom) q = q.gte("posted_on", query.postedFrom);
    if (query.postedTo) q = q.lte("posted_on", query.postedTo);
    if (query.counterpartyPersonId) q = q.eq("counterparty_person_id", query.counterpartyPersonId);
    const search = query.search?.trim();
    if (search) {
      const p = orIlike(search);
      q = q.or(`description.ilike.${p},merchant_name.ilike.${p}`);
    }
    q = paged(q.order("posted_on", { ascending: false }), query);
    return (await this.rows<MoneyTransactionRow>(q, "transactions")).map(moneyTransactionFromRow);
  }

  async getMoneyTransaction(id: string): Promise<MoneyTransaction | null> {
    const row = await this.run<MoneyTransactionRow>(this.select("money_transactions").eq("id", id).maybeSingle(), `transaction ${id}`);
    return row ? moneyTransactionFromRow(row) : null;
  }

  async upsertMoneyAccounts(connectorAccountId: string, accounts: readonly NormalizedMoneyAccount[]): Promise<UpsertResult<MoneyAccount>> {
    if (!accounts.length) return { rows: [], inserted: 0, updated: 0 };
    const existing = await this.existingExternalIds("money_accounts", connectorAccountId, accounts.map((a) => a.externalId));
    const rows = lastByKey(
      accounts.map((a) => moneyAccountToRow(this.userId, connectorAccountId, a)),
      (r) => r.external_id,
    );
    const saved = await this.upsertChunked<MoneyAccountRow>("money_accounts", rows, "user_id,connector_account_id,external_id");
    return this.upsertResult(accounts.map((a) => a.externalId), saved, (r) => r.external_id, existing, moneyAccountFromRow);
  }

  async upsertMoneyTransactions(connectorAccountId: string, transactions: readonly MoneyTransactionWrite[]): Promise<UpsertResult<MoneyTransaction>> {
    if (!transactions.length) return { rows: [], inserted: 0, updated: 0 };
    const accountExternalIds = [...new Set(transactions.map((t) => t.accountExternalId))];
    const accountRows = await this.rows<{ id: string; external_id: string }>(
      this.from("money_accounts").select("id, external_id").eq("user_id", this.userId).eq("connector_account_id", connectorAccountId).in("external_id", accountExternalIds),
      "money accounts for transactions",
    );
    const accountIds = new Map(accountRows.map((r) => [r.external_id, r.id]));
    const rows = lastByKey(
      transactions.map((t) => {
        const moneyAccountId = accountIds.get(t.accountExternalId);
        if (!moneyAccountId) throw new SpineIntegrityError(`money account ${t.accountExternalId} does not exist for connector account ${connectorAccountId}`);
        return moneyTransactionToRow(this.userId, connectorAccountId, moneyAccountId, t);
      }),
      (r) => r.external_id,
    );
    const existing = await this.existingExternalIds("money_transactions", connectorAccountId, transactions.map((t) => t.externalId));
    const saved = await this.upsertChunked<MoneyTransactionRow>("money_transactions", rows, "user_id,connector_account_id,external_id");
    return this.upsertResult(transactions.map((t) => t.externalId), saved, (r) => r.external_id, existing, moneyTransactionFromRow);
  }

  async deleteMoneyTransactions(connectorAccountId: string, externalIds: readonly string[]): Promise<number> {
    return this.deleteByExternalIds("money_transactions", connectorAccountId, externalIds);
  }

  // -------------------------------------------------------------------------
  // Time
  // -------------------------------------------------------------------------
  async listTimeEvents(query: TimeQuery): Promise<TimeEvent[]> {
    let q = this.select("time_events").lte("starts_at", query.to).gte("ends_at", query.from);
    if (query.connectorAccountId) q = q.eq("connector_account_id", query.connectorAccountId);
    q = paged(q.order("starts_at", { ascending: true }), query);
    return (await this.rows<TimeEventRow>(q, "time events")).map(timeEventFromRow);
  }

  async getTimeEvent(id: string): Promise<TimeEvent | null> {
    const row = await this.run<TimeEventRow>(this.select("time_events").eq("id", id).maybeSingle(), `time event ${id}`);
    return row ? timeEventFromRow(row) : null;
  }

  async upsertTimeEvents(connectorAccountId: string, events: readonly TimeEventWrite[]): Promise<UpsertResult<TimeEvent>> {
    if (!events.length) return { rows: [], inserted: 0, updated: 0 };
    const key = (calendarId: string, externalId: string) => `${calendarId}\u0000${externalId}`;
    const existingRows = await this.rows<{ external_calendar_id: string; external_id: string }>(
      this.from("time_events")
        .select("external_calendar_id, external_id")
        .eq("user_id", this.userId)
        .eq("connector_account_id", connectorAccountId)
        .in("external_id", [...new Set(events.map((e) => e.externalId))]),
      "existing time events",
    );
    const existing = new Set(existingRows.map((r) => key(r.external_calendar_id, r.external_id)));
    const rows = lastByKey(
      events.map((e) => timeEventToRow(this.userId, connectorAccountId, e)),
      (r) => key(r.external_calendar_id, r.external_id),
    );
    const saved = await this.upsertChunked<TimeEventRow>("time_events", rows, "user_id,connector_account_id,external_calendar_id,external_id");
    return this.upsertResult(
      events.map((e) => key(e.externalCalendarId, e.externalId)),
      saved,
      (r) => key(r.external_calendar_id, r.external_id),
      existing,
      timeEventFromRow,
    );
  }

  async deleteTimeEvents(connectorAccountId: string, externalIds: readonly string[]): Promise<number> {
    return this.deleteByExternalIds("time_events", connectorAccountId, externalIds);
  }

  // -------------------------------------------------------------------------
  // Context events + conclusions
  // -------------------------------------------------------------------------
  async listContextEvents(query: ContextEventsQuery = {}): Promise<ContextEvent[]> {
    let q = this.select("context_events");
    if (query.attention) {
      const wanted: Attention[] = Array.isArray(query.attention) ? [...(query.attention as readonly Attention[])] : [query.attention as Attention];
      q = wanted.length === 1 ? q.eq("attention", wanted[0]) : q.in("attention", wanted);
    }
    if (query.occurredSince) q = q.gte("occurred_at", query.occurredSince);
    if (query.kindPrefix) q = q.ilike("kind", `${escapeLike(query.kindPrefix)}%`);
    if (query.subject) q = q.eq("subject_type", query.subject.type).eq("subject_id", query.subject.id);
    q = paged(q.order("occurred_at", { ascending: false }), query);
    return (await this.rows<ContextEventRow>(q, "context events")).map(contextEventFromRow);
  }

  async getContextEvent(id: string): Promise<ContextEvent | null> {
    const row = await this.run<ContextEventRow>(this.select("context_events").eq("id", id).maybeSingle(), `context event ${id}`);
    return row ? contextEventFromRow(row) : null;
  }

  async listConclusions(subject: EntityRef): Promise<Conclusion[]> {
    const rows = await this.rows<ConclusionRow>(
      this.select("conclusions").eq("subject_type", subject.type).eq("subject_id", subject.id).order("created_at", { ascending: false }),
      "conclusions",
    );
    return rows.map(conclusionFromRow);
  }

  async upsertContextEvents(events: readonly ContextEventInput[]): Promise<UpsertResult<ContextEvent>> {
    if (!events.length) return { rows: [], inserted: 0, updated: 0 };
    const keys = [...new Set(events.map((e) => e.dedupeKey))];
    const existingRows: ContextEventRow[] = [];
    for (const chunk of chunks(keys, CHUNK)) {
      existingRows.push(...(await this.rows<ContextEventRow>(this.select("context_events").in("dedupe_key", chunk), "existing context events")));
    }
    const byKey = new Map(existingRows.map((r) => [r.dedupe_key, r]));
    const fresh = lastByKey(
      events.filter((e) => !byKey.has(e.dedupeKey)).map((e) => contextEventToRow(this.userId, e.id ?? newId(), e)),
      (r) => r.dedupe_key,
    );
    // ON CONFLICT DO NOTHING: an existing event keeps its attention and its row.
    const insertedRows = fresh.length ? await this.upsertChunked<ContextEventRow>("context_events", fresh, "user_id,dedupe_key", true) : [];
    for (const r of insertedRows) byKey.set(r.dedupe_key, r);
    // A concurrent writer may have won the race: fetch what we could not insert.
    const missing = events.map((e) => e.dedupeKey).filter((k) => !byKey.has(k));
    if (missing.length) {
      for (const r of await this.rows<ContextEventRow>(this.select("context_events").in("dedupe_key", [...new Set(missing)]), "raced context events")) {
        byKey.set(r.dedupe_key, r);
      }
    }
    const rows: ContextEvent[] = [];
    for (const e of events) {
      const row = byKey.get(e.dedupeKey);
      if (row) rows.push(contextEventFromRow(row));
    }
    return { rows, inserted: insertedRows.length, updated: rows.length - insertedRows.length };
  }

  async setContextEventAttention(id: string, attention: Attention, metadata?: JsonObject): Promise<ContextEvent> {
    const patch: Partial<ContextEventRow> = { attention };
    if (metadata) {
      const current = await this.getContextEvent(id);
      if (!current) throw new SpineNotFoundError("context_event", id);
      patch.metadata = { ...current.metadata, ...metadata };
    }
    return contextEventFromRow(
      await this.required<ContextEventRow>(this.from("context_events").update(patch).eq("id", id).eq("user_id", this.userId).select().maybeSingle(), "context_event", id),
    );
  }

  async insertConclusion(input: ConclusionInput): Promise<Conclusion> {
    const row = conclusionToRow(this.userId, input.id ?? newId(), input);
    return conclusionFromRow(await this.required<ConclusionRow>(this.from("conclusions").insert(row).select().single(), "conclusion", row.id));
  }

  // -------------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------------
  async listRelationships(query: Page = {}): Promise<Relationship[]> {
    const q = paged(this.select("relationships").order("created_at", { ascending: true }), query);
    return (await this.rows<RelationshipRow>(q, "relationships")).map(relationshipFromRow);
  }

  async neighbors(node: EntityRef, query: NeighborsQuery = {}): Promise<NeighborRow[]> {
    const rows = await this.rows<NeighborRpcRow>(this.client.rpc("vx_neighbors", { p_type: node.type, p_id: node.id }), "neighbors");
    const direction = query.direction ?? "both";
    return rows
      .filter((r) => (direction === "both" || r.direction === direction) && (!query.kind || r.kind === query.kind))
      .map((r) => ({ relationshipId: r.relationship_id, kind: r.kind, direction: r.direction, ref: neighborRefFromRpc(r), confidence: numberFromDb(r.confidence) }))
      .filter((n) => !query.type || n.ref.type === query.type);
  }

  async relate(input: RelationshipInput): Promise<Relationship> {
    const id = await this.run<string>(
      this.client.rpc("vx_relate", {
        p_user_id: this.userId,
        p_from_type: input.from.type,
        p_from_id: input.from.id,
        p_kind: input.kind,
        p_to_type: input.to.type,
        p_to_id: input.to.id,
        p_confidence: input.confidence ?? 1,
        p_source: input.source ?? "user",
        p_metadata: input.metadata ?? {},
      }),
      "relate",
    );
    if (!id) throw new SpineStorageError("vx_relate returned no id", null);
    return relationshipFromRow(await this.required<RelationshipRow>(this.select("relationships").eq("id", id).maybeSingle(), "relationship", id));
  }

  async unrelate(input: Pick<RelationshipInput, "from" | "kind" | "to">): Promise<boolean> {
    const deleted = await this.rows<{ id: string }>(
      this.from("relationships")
        .delete()
        .eq("user_id", this.userId)
        .eq("from_type", input.from.type)
        .eq("from_id", input.from.id)
        .eq("kind", input.kind)
        .eq("to_type", input.to.type)
        .eq("to_id", input.to.id)
        .select("id"),
      "unrelate",
    );
    return deleted.length > 0;
  }

  // -------------------------------------------------------------------------
  // Connector accounts + sync states
  // -------------------------------------------------------------------------
  async listConnectorAccounts(): Promise<ConnectorAccount[]> {
    return (await this.rows<ConnectorAccountRow>(this.select("connector_accounts").order("created_at"), "connector accounts")).map(connectorAccountFromRow);
  }

  async getConnectorAccount(id: string): Promise<ConnectorAccount | null> {
    const row = await this.run<ConnectorAccountRow>(this.select("connector_accounts").eq("id", id).maybeSingle(), `connector account ${id}`);
    return row ? connectorAccountFromRow(row) : null;
  }

  async findConnectorAccount(provider: ConnectorAccount["provider"], externalAccountId: string): Promise<ConnectorAccount | null> {
    const row = await this.run<ConnectorAccountRow>(
      this.select("connector_accounts").eq("provider", provider).eq("external_account_id", externalAccountId).maybeSingle(),
      `connector account ${provider}/${externalAccountId}`,
    );
    return row ? connectorAccountFromRow(row) : null;
  }

  async listSyncStates(connectorAccountId?: string): Promise<ConnectorSyncState[]> {
    let q = this.select("connector_sync_states");
    if (connectorAccountId) q = q.eq("connector_account_id", connectorAccountId);
    return (await this.rows<ConnectorSyncStateRow>(q.order("capability"), "sync states")).map(syncStateFromRow);
  }

  async getSyncState(connectorAccountId: string, capability: ConnectorCapability): Promise<ConnectorSyncState | null> {
    const row = await this.run<ConnectorSyncStateRow>(
      this.select("connector_sync_states").eq("connector_account_id", connectorAccountId).eq("capability", capability).maybeSingle(),
      `sync state ${connectorAccountId}/${capability}`,
    );
    return row ? syncStateFromRow(row) : null;
  }

  async createConnectorAccount(input: ConnectorAccountInput): Promise<ConnectorAccount> {
    const row = connectorAccountToRow(this.userId, input.id ?? newId(), input);
    return connectorAccountFromRow(await this.required<ConnectorAccountRow>(this.from("connector_accounts").insert(row).select().single(), "connector_account", row.id));
  }

  async updateConnectorAccount(id: string, patch: ConnectorAccountPatch): Promise<ConnectorAccount> {
    return connectorAccountFromRow(
      await this.required<ConnectorAccountRow>(
        this.from("connector_accounts").update(connectorAccountPatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(),
        "connector_account",
        id,
      ),
    );
  }

  async upsertSyncState(connectorAccountId: string, capability: ConnectorCapability, patch: SyncStatePatch): Promise<ConnectorSyncState> {
    const row = syncStatePatchToRow(this.userId, connectorAccountId, capability, patch);
    // PostgREST upserts only the columns present in the body: an insert gets
    // table defaults for the rest, an update leaves them untouched.
    return syncStateFromRow(
      await this.required<ConnectorSyncStateRow>(
        this.from("connector_sync_states").upsert(row, { onConflict: "connector_account_id,capability" }).select().single(),
        "sync_state",
        `${connectorAccountId}/${capability}`,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Devices, handoffs, ingest, actions
  // -------------------------------------------------------------------------
  async listDevices(): Promise<Device[]> {
    return (await this.rows<DeviceRow>(this.select("devices").order("created_at"), "devices")).map(deviceFromRow);
  }

  async getDevice(id: string): Promise<Device | null> {
    const row = await this.run<DeviceRow>(this.select("devices").eq("id", id).maybeSingle(), `device ${id}`);
    return row ? deviceFromRow(row) : null;
  }

  async upsertDevice(input: DeviceInput): Promise<Device> {
    const row = deviceToRow(this.userId, input.id ?? newId(), input);
    return deviceFromRow(await this.required<DeviceRow>(this.from("devices").upsert(row, { onConflict: "id" }).select().single(), "device", row.id));
  }

  async updateDevice(id: string, patch: DevicePatch): Promise<Device> {
    return deviceFromRow(
      await this.required<DeviceRow>(this.from("devices").update(devicePatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(), "device", id),
    );
  }

  async listHandoffs(query: HandoffsQuery = {}): Promise<Handoff[]> {
    let q = this.select("handoffs");
    if (query.state) {
      const states = Array.isArray(query.state) ? [...query.state] : [query.state];
      q = states.length === 1 ? q.eq("state", states[0]) : q.in("state", states);
    }
    if (query.targetDeviceId !== undefined) {
      q = query.targetDeviceId === null ? q.is("target_device_id", null) : q.eq("target_device_id", query.targetDeviceId);
    }
    q = paged(q.order("created_at", { ascending: false }), query);
    return (await this.rows<HandoffRow>(q, "handoffs")).map(handoffFromRow);
  }

  async getHandoff(id: string): Promise<Handoff | null> {
    const row = await this.run<HandoffRow>(this.select("handoffs").eq("id", id).maybeSingle(), `handoff ${id}`);
    return row ? handoffFromRow(row) : null;
  }

  async createHandoff(input: HandoffInput): Promise<Handoff> {
    const row = handoffToRow(this.userId, input.id ?? newId(), input);
    return handoffFromRow(await this.required<HandoffRow>(this.from("handoffs").insert(row).select().single(), "handoff", row.id));
  }

  async updateHandoff(id: string, patch: HandoffPatch): Promise<Handoff> {
    return handoffFromRow(
      await this.required<HandoffRow>(this.from("handoffs").update(handoffPatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(), "handoff", id),
    );
  }

  async listIngestItems(query: IngestQuery = {}): Promise<IngestItem[]> {
    let q = this.select("ingest_items");
    if (query.status) q = q.eq("status", query.status);
    q = paged(q.order("created_at", { ascending: false }), query);
    return (await this.rows<IngestItemRow>(q, "ingest items")).map(ingestItemFromRow);
  }

  async getIngestItem(id: string): Promise<IngestItem | null> {
    const row = await this.run<IngestItemRow>(this.select("ingest_items").eq("id", id).maybeSingle(), `ingest item ${id}`);
    return row ? ingestItemFromRow(row) : null;
  }

  async createIngestItem(input: IngestItemInput): Promise<IngestItem> {
    const row = ingestItemToRow(this.userId, input.id ?? newId(), input);
    return ingestItemFromRow(await this.required<IngestItemRow>(this.from("ingest_items").insert(row).select().single(), "ingest_item", row.id));
  }

  async updateIngestItem(id: string, patch: IngestItemPatch): Promise<IngestItem> {
    return ingestItemFromRow(
      await this.required<IngestItemRow>(
        this.from("ingest_items").update(ingestItemPatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(),
        "ingest_item",
        id,
      ),
    );
  }

  async getActionRequest(id: string): Promise<ActionRequest | null> {
    const row = await this.run<ActionRequestRow>(this.select("action_requests").eq("id", id).maybeSingle(), `action request ${id}`);
    return row ? actionRequestFromRow(row) : null;
  }

  async findActionRequestByKey(idempotencyKey: string): Promise<ActionRequest | null> {
    const row = await this.run<ActionRequestRow>(this.select("action_requests").eq("idempotency_key", idempotencyKey).maybeSingle(), `action request ${idempotencyKey}`);
    return row ? actionRequestFromRow(row) : null;
  }

  async createActionRequest(input: ActionRequestInput): Promise<ActionRequestCreateResult> {
    const row = actionRequestToRow(this.userId, newId(), input);
    const inserted = await this.run<ActionRequestRow>(
      this.from("action_requests").upsert(row, { onConflict: "user_id,idempotency_key", ignoreDuplicates: true }).select().maybeSingle(),
      `action request ${input.idempotencyKey}`,
    );
    if (inserted) return { request: actionRequestFromRow(inserted), created: true };
    const existing = await this.findActionRequestByKey(input.idempotencyKey);
    if (!existing) throw new SpineStorageError(`action request ${input.idempotencyKey} vanished between upsert and read`, null);
    return { request: existing, created: false };
  }

  async updateActionRequest(id: string, patch: ActionRequestPatch): Promise<ActionRequest> {
    return actionRequestFromRow(
      await this.required<ActionRequestRow>(
        this.from("action_requests").update(actionRequestPatchToRow(patch)).eq("id", id).eq("user_id", this.userId).select().maybeSingle(),
        "action_request",
        id,
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Shared natural-key helpers
  // -------------------------------------------------------------------------
  private async existingExternalIds(table: string, connectorAccountId: string, externalIds: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunks([...new Set(externalIds)], CHUNK)) {
      const rows = await this.rows<{ external_id: string }>(
        this.from(table).select("external_id").eq("user_id", this.userId).eq("connector_account_id", connectorAccountId).in("external_id", chunk),
        `existing ${table}`,
      );
      for (const r of rows) found.add(r.external_id);
    }
    return found;
  }

  private async upsertChunked<TRow>(table: string, rows: readonly object[], onConflict: string, ignoreDuplicates = false): Promise<TRow[]> {
    const saved: TRow[] = [];
    for (const chunk of chunks(rows, CHUNK)) {
      saved.push(...(await this.rows<TRow>(this.from(table).upsert(chunk, { onConflict, ignoreDuplicates }).select(), `upsert ${table}`)));
    }
    return saved;
  }

  private upsertResult<TRow, T>(
    order: readonly string[],
    saved: readonly TRow[],
    keyOf: (row: TRow) => string,
    existing: ReadonlySet<string>,
    map: (row: TRow) => T,
  ): UpsertResult<T> {
    const byKey = new Map(saved.map((r) => [keyOf(r), r]));
    const rows: T[] = [];
    const seen = new Set<string>();
    let inserted = 0;
    let updated = 0;
    for (const key of order) {
      const row = byKey.get(key);
      if (!row) continue;
      rows.push(map(row));
      if (seen.has(key)) continue;
      seen.add(key);
      if (existing.has(key)) updated++;
      else inserted++;
    }
    return { rows, inserted, updated };
  }

  private async deleteByExternalIds(table: string, connectorAccountId: string, externalIds: readonly string[]): Promise<number> {
    if (!externalIds.length) return 0;
    let count = 0;
    for (const chunk of chunks([...new Set(externalIds)], CHUNK)) {
      const deleted = await this.rows<{ id: string }>(
        this.from(table).delete().eq("user_id", this.userId).eq("connector_account_id", connectorAccountId).in("external_id", chunk).select("id"),
        `delete ${table}`,
      );
      count += deleted.length;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SelectBuilder = any;

function mapError(err: PgError, context: string): Error {
  const code = err.code ?? null;
  const message = `${context}: ${err.message ?? "unknown PostgREST error"}`;
  if (code && INTEGRITY_CODES.has(code)) return new SpineIntegrityError(message);
  return new SpineStorageError(message, code, err.details ?? null);
}

function paged(q: SelectBuilder, page: Page): SelectBuilder {
  if (page.limit !== undefined) {
    const offset = page.offset ?? 0;
    return q.range(offset, offset + page.limit - 1);
  }
  if (page.offset) return q.range(page.offset, page.offset + 999);
  return q;
}

/** Escapes LIKE wildcards in user text. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** `%term%` for a direct `.ilike()` filter (supabase-js encodes the value). */
export function ilike(term: string): string {
  return `%${escapeLike(term)}%`;
}

/**
 * `%term%` quoted for PostgREST `.or()` syntax so commas / parentheses in the
 * search do not break the clause list. Double quotes and backslashes are dropped.
 */
export function orIlike(term: string): string {
  const cleaned = escapeLike(term.replace(/["\\]/g, ""));
  return `"%${cleaned}%"`;
}

/**
 * Collapses rows that share a natural key (last one wins). A provider page may
 * legitimately repeat a message / event; PostgREST's ON CONFLICT DO UPDATE
 * rejects a statement that touches the same row twice, while the in-memory
 * store just applies both. Deduping here keeps the two stores equivalent.
 */
function lastByKey<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) byKey.set(keyOf(r), r);
  return [...byKey.values()];
}

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
  return out;
}
