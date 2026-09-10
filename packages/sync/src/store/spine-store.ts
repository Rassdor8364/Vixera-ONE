import type {
  ActionRequest,
  ActionRequestStatus,
  Attention,
  Conclusion,
  ConnectorAccount,
  ConnectorCapability,
  ConnectorSyncState,
  ContextEvent,
  Device,
  Document,
  EntityRef,
  EntityType,
  Handoff,
  HandoffState,
  IngestItem,
  IngestStatus,
  IsoDateTime,
  JsonObject,
  MailMessage,
  MoneyAccount,
  MoneyTransaction,
  NormalizedMailMessage,
  NormalizedMoneyAccount,
  NormalizedMoneyTransaction,
  NormalizedTimeEvent,
  Person,
  PersonIdentity,
  PersonIdentityKind,
  Relationship,
  RelationshipInput,
  RelationshipKind,
  Thread,
  ThreadStatus,
  TimeEvent,
  UserId,
} from "@vixera/domain";

/**
 * The spine as seen by application code. Two implementations:
 *   - SupabaseSpineStore  (PostgreSQL through supabase-js; RLS applies)
 *   - InMemorySpineStore  (tests, dev fixtures)
 *
 * Every store is bound to ONE user id at construction (from currentUser()).
 * No method takes a user id; no method can reach another user's rows.
 * Provider objects never appear here: connectors hand the engine normalized
 * objects and the store persists them under natural keys.
 */

// ---------------------------------------------------------------------------
// Query shapes
// ---------------------------------------------------------------------------
export interface Page {
  readonly limit?: number;
  readonly offset?: number;
}

export interface PeopleQuery extends Page {
  /** Case-insensitive substring over display name, organization and identities. */
  readonly search?: string;
  readonly includeMerged?: boolean;
}

export interface ThreadsQuery extends Page {
  readonly status?: ThreadStatus;
  readonly search?: string;
}

export interface DocumentsQuery extends Page {
  readonly search?: string;
  readonly connectorAccountId?: string;
  readonly mimeTypePrefix?: string;
  readonly updatedSince?: IsoDateTime;
}

export interface MailQuery extends Page {
  readonly connectorAccountId?: string;
  readonly fromPersonId?: string;
  readonly receivedSince?: IsoDateTime;
  readonly search?: string;
}

export interface TransactionsQuery extends Page {
  readonly connectorAccountId?: string;
  readonly moneyAccountId?: string;
  readonly postedFrom?: string;
  readonly postedTo?: string;
  readonly search?: string;
  readonly counterpartyPersonId?: string;
}

export interface TimeQuery extends Page {
  readonly from: IsoDateTime;
  readonly to: IsoDateTime;
  readonly connectorAccountId?: string;
}

export interface ContextEventsQuery extends Page {
  readonly attention?: Attention | readonly Attention[];
  readonly occurredSince?: IsoDateTime;
  readonly kindPrefix?: string;
  readonly subject?: EntityRef;
}

export interface NeighborsQuery {
  readonly kind?: RelationshipKind;
  readonly type?: EntityType;
  readonly direction?: "out" | "in" | "both";
}

export interface NeighborRow {
  readonly relationshipId: string;
  readonly kind: RelationshipKind;
  readonly direction: "out" | "in";
  readonly ref: EntityRef;
  readonly confidence: number;
}

export interface HandoffsQuery extends Page {
  readonly state?: HandoffState | readonly HandoffState[];
  readonly targetDeviceId?: string | null;
}

export interface IngestQuery extends Page {
  readonly status?: IngestStatus;
}

// ---------------------------------------------------------------------------
// Input shapes (ids / user id / timestamps assigned by the store)
// ---------------------------------------------------------------------------
type Input<T, K extends keyof T = never> = Omit<T, "id" | "userId" | "createdAt" | "updatedAt" | K> & { readonly id?: string };
type Patch<T, K extends keyof T = never> = Partial<Omit<T, "id" | "userId" | "createdAt" | "updatedAt" | K>>;

export type PersonInput = Input<Person, "mergedIntoId"> & { readonly mergedIntoId?: Person["mergedIntoId"] };
export type PersonPatch = Patch<Person>;
export type PersonIdentityInput = Omit<PersonIdentity, "id" | "userId" | "createdAt">;
export type ThreadInput = Input<Thread>;
export type ThreadPatch = Patch<Thread>;
export type DocumentInput = Input<Document>;
export type DocumentPatch = Patch<Document>;
export type ConnectorAccountInput = Input<ConnectorAccount>;
export type ConnectorAccountPatch = Patch<ConnectorAccount, "provider" | "externalAccountId">;
export type SyncStatePatch = Partial<Omit<ConnectorSyncState, "userId" | "connectorAccountId" | "capability" | "updatedAt">>;
export type DeviceInput = Omit<Device, "id" | "userId" | "createdAt"> & { readonly id?: string };
export type DevicePatch = Partial<Omit<Device, "id" | "userId" | "createdAt">>;
export type HandoffInput = Omit<Handoff, "id" | "userId" | "createdAt"> & { readonly id?: string };
export type HandoffPatch = Partial<Omit<Handoff, "id" | "userId" | "createdAt" | "sourceDeviceId">>;
export type IngestItemInput = Omit<IngestItem, "id" | "userId" | "createdAt"> & { readonly id?: string };
export type IngestItemPatch = Partial<Omit<IngestItem, "id" | "userId" | "createdAt">>;
export type ConclusionInput = Omit<Conclusion, "id" | "userId" | "createdAt"> & { readonly id?: string };
export type ContextEventInput = Omit<ContextEvent, "id" | "userId" | "createdAt"> & { readonly id?: string };
export type ActionRequestInput = Pick<ActionRequest, "actionType" | "idempotencyKey" | "payload"> & { readonly actorDeviceId?: string | null };
export type ActionRequestPatch = { readonly status?: ActionRequestStatus; readonly result?: JsonObject | null; readonly error?: string | null; readonly attempts?: number };

/** Normalized mail with the linker's resolved person ids applied. */
export type MailMessageWrite = NormalizedMailMessage & {
  readonly fromPersonId?: string | null;
  readonly toPersonIds?: readonly (string | null)[];
  readonly ccPersonIds?: readonly (string | null)[];
};
export type TimeEventWrite = NormalizedTimeEvent & { readonly participantPersonIds?: readonly (string | null)[] };
export type MoneyTransactionWrite = NormalizedMoneyTransaction & { readonly counterpartyPersonId?: string | null };

export interface UpsertResult<T> {
  readonly rows: readonly T[];
  readonly inserted: number;
  readonly updated: number;
}

export interface ActionRequestCreateResult {
  readonly request: ActionRequest;
  /** False when the idempotency key already existed (replay). */
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------
export interface SpineReader {
  readonly userId: UserId;

  listPeople(query?: PeopleQuery): Promise<Person[]>;
  getPerson(id: string): Promise<Person | null>;
  findPersonByIdentity(kind: PersonIdentityKind, value: string): Promise<Person | null>;
  listPersonIdentities(personId: string): Promise<PersonIdentity[]>;

  listThreads(query?: ThreadsQuery): Promise<Thread[]>;
  getThread(id: string): Promise<Thread | null>;

  listDocuments(query?: DocumentsQuery): Promise<Document[]>;
  getDocument(id: string): Promise<Document | null>;
  findDocumentByHash(contentHash: string): Promise<Document | null>;
  findDocumentBySourceRef(connectorAccountId: string | null, sourceRef: JsonObject): Promise<Document | null>;

  listMailMessages(query?: MailQuery): Promise<MailMessage[]>;
  getMailMessage(id: string): Promise<MailMessage | null>;
  findMailMessageByExternalId(connectorAccountId: string, externalId: string): Promise<MailMessage | null>;

  listMoneyAccounts(connectorAccountId?: string): Promise<MoneyAccount[]>;
  listMoneyTransactions(query?: TransactionsQuery): Promise<MoneyTransaction[]>;
  getMoneyTransaction(id: string): Promise<MoneyTransaction | null>;

  listTimeEvents(query: TimeQuery): Promise<TimeEvent[]>;
  getTimeEvent(id: string): Promise<TimeEvent | null>;

  listContextEvents(query?: ContextEventsQuery): Promise<ContextEvent[]>;
  getContextEvent(id: string): Promise<ContextEvent | null>;
  listConclusions(subject: EntityRef): Promise<Conclusion[]>;

  listRelationships(query?: Page): Promise<Relationship[]>;
  neighbors(ref: EntityRef, query?: NeighborsQuery): Promise<NeighborRow[]>;

  listConnectorAccounts(): Promise<ConnectorAccount[]>;
  getConnectorAccount(id: string): Promise<ConnectorAccount | null>;
  findConnectorAccount(provider: ConnectorAccount["provider"], externalAccountId: string): Promise<ConnectorAccount | null>;
  listSyncStates(connectorAccountId?: string): Promise<ConnectorSyncState[]>;
  getSyncState(connectorAccountId: string, capability: ConnectorCapability): Promise<ConnectorSyncState | null>;

  listDevices(): Promise<Device[]>;
  getDevice(id: string): Promise<Device | null>;
  listHandoffs(query?: HandoffsQuery): Promise<Handoff[]>;
  getHandoff(id: string): Promise<Handoff | null>;
  listIngestItems(query?: IngestQuery): Promise<IngestItem[]>;
  getIngestItem(id: string): Promise<IngestItem | null>;
  getActionRequest(id: string): Promise<ActionRequest | null>;
  findActionRequestByKey(idempotencyKey: string): Promise<ActionRequest | null>;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------
export interface SpineWriter {
  upsertPerson(input: PersonInput): Promise<Person>;
  updatePerson(id: string, patch: PersonPatch): Promise<Person>;
  /** Idempotent on (kind, value): returns the existing identity if present (possibly for another person). */
  upsertPersonIdentity(input: PersonIdentityInput): Promise<PersonIdentity>;

  createThread(input: ThreadInput): Promise<Thread>;
  updateThread(id: string, patch: ThreadPatch): Promise<Thread>;

  upsertDocument(input: DocumentInput): Promise<Document>;
  updateDocument(id: string, patch: DocumentPatch): Promise<Document>;

  /** Natural key (connectorAccountId, externalId). Re-running the same batch changes nothing. */
  upsertMailMessages(connectorAccountId: string, messages: readonly MailMessageWrite[]): Promise<UpsertResult<MailMessage>>;
  deleteMailMessages(connectorAccountId: string, externalIds: readonly string[]): Promise<number>;

  upsertMoneyAccounts(connectorAccountId: string, accounts: readonly NormalizedMoneyAccount[]): Promise<UpsertResult<MoneyAccount>>;
  /** Transactions reference accounts by `accountExternalId`; the store resolves the money account id. */
  upsertMoneyTransactions(connectorAccountId: string, transactions: readonly MoneyTransactionWrite[]): Promise<UpsertResult<MoneyTransaction>>;
  deleteMoneyTransactions(connectorAccountId: string, externalIds: readonly string[]): Promise<number>;

  upsertTimeEvents(connectorAccountId: string, events: readonly TimeEventWrite[]): Promise<UpsertResult<TimeEvent>>;
  /** Scoped to one calendar when `externalCalendarId` is given (the same event id can live in two calendars). */
  deleteTimeEvents(connectorAccountId: string, externalIds: readonly string[], externalCalendarId?: string): Promise<number>;

  /** Natural key dedupeKey: existing events are returned unchanged (attention decisions are never overwritten). */
  upsertContextEvents(events: readonly ContextEventInput[]): Promise<UpsertResult<ContextEvent>>;
  setContextEventAttention(id: string, attention: Attention, metadata?: JsonObject): Promise<ContextEvent>;
  insertConclusion(input: ConclusionInput): Promise<Conclusion>;

  /** Idempotent by natural key; existing edge returned. Rejects edges to entities that do not exist. */
  relate(input: RelationshipInput): Promise<Relationship>;
  unrelate(input: Pick<RelationshipInput, "from" | "kind" | "to">): Promise<boolean>;

  createConnectorAccount(input: ConnectorAccountInput): Promise<ConnectorAccount>;
  updateConnectorAccount(id: string, patch: ConnectorAccountPatch): Promise<ConnectorAccount>;
  upsertSyncState(connectorAccountId: string, capability: ConnectorCapability, patch: SyncStatePatch): Promise<ConnectorSyncState>;

  upsertDevice(input: DeviceInput): Promise<Device>;
  updateDevice(id: string, patch: DevicePatch): Promise<Device>;
  createHandoff(input: HandoffInput): Promise<Handoff>;
  updateHandoff(id: string, patch: HandoffPatch): Promise<Handoff>;
  createIngestItem(input: IngestItemInput): Promise<IngestItem>;
  updateIngestItem(id: string, patch: IngestItemPatch): Promise<IngestItem>;

  /** Idempotent on idempotencyKey. */
  createActionRequest(input: ActionRequestInput): Promise<ActionRequestCreateResult>;
  updateActionRequest(id: string, patch: ActionRequestPatch): Promise<ActionRequest>;
}

export interface SpineStore extends SpineReader, SpineWriter {}

export class SpineNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`);
    this.name = "SpineNotFoundError";
  }
}

export class SpineIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpineIntegrityError";
  }
}
