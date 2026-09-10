import type {
  ActionRequest,
  Conclusion,
  ConnectorAccount,
  ConnectorSyncState,
  ContextEvent,
  Device,
  Document,
  DocumentLocation,
  EntityRef,
  EntityType,
  EventParticipant,
  Handoff,
  IngestItem,
  Json,
  JsonObject,
  MailAddress,
  MailAttachmentMeta,
  MailMessage,
  MoneyAccount,
  MoneyTransaction,
  Person,
  PersonId,
  PersonIdentity,
  PraxionLocation,
  Relationship,
  Thread,
  TimeEvent,
  UserId,
} from "@vixera/domain";
import type { MailMessageWrite, MoneyTransactionWrite, TimeEventWrite } from "./spine-store.ts";
import type { NormalizedMoneyAccount } from "@vixera/domain";

/**
 * Row shapes of the tables in supabase/migrations/20260910000100_spine.sql
 * (snake_case, exactly as PostgREST returns them) and the mappers between
 * rows and domain objects. This is the only place where column names live.
 *
 * Conventions that matter when reading PostgREST JSON:
 *   - `numeric` columns arrive as strings ("12400.0000"), `bigint` as numbers
 *   - `timestamptz` arrives as "2026-09-10T09:00:00+00:00"; we re-normalize to
 *     the domain's `toISOString()` form so equality checks in tests hold
 *   - `date` arrives as "2026-09-10" and stays a string
 *   - jsonb columns (to_addresses, attachments, participants, organizer,
 *     source_ref, location, metadata, checkpoint, ...) arrive as parsed JSON
 *
 * `*Insert` types omit the columns the database owns (created_at, updated_at);
 * every insert row carries user_id set by the store, never by the caller.
 */

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
export interface PersonRow {
  id: string;
  user_id: string;
  display_name: string;
  primary_email: string | null;
  organization: string | null;
  notes: string | null;
  merged_into_id: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface PersonIdentityRow {
  id: string;
  user_id: string;
  person_id: string;
  kind: PersonIdentity["kind"];
  value: string;
  raw_value: string;
  provider: string | null;
  connector_account_id: string | null;
  created_at: string;
}

export interface ThreadRow {
  id: string;
  user_id: string;
  title: string;
  kind: string | null;
  status: Thread["status"];
  summary: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface DocumentRow {
  id: string;
  user_id: string;
  title: string;
  mime_type: string | null;
  source: Document["source"];
  connector_account_id: string | null;
  source_ref: JsonObject;
  location: JsonObject;
  praxion_document_id: string | null;
  size_bytes: number | string | null;
  content_hash: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

/** jsonb element of mail_messages.to_addresses / cc_addresses. */
export interface MailAddressJson {
  email: string;
  name: string | null;
  person_id: string | null;
}

export interface MailMessageRow {
  id: string;
  user_id: string;
  connector_account_id: string;
  external_id: string;
  external_thread_id: string | null;
  subject: string | null;
  snippet: string | null;
  body_text: string | null;
  from_address: string | null;
  from_name: string | null;
  from_person_id: string | null;
  to_addresses: MailAddressJson[];
  cc_addresses: MailAddressJson[];
  sent_at: string | null;
  received_at: string;
  is_unread: boolean;
  attachments: MailAttachmentMeta[];
  labels: string[];
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface MoneyAccountRow {
  id: string;
  user_id: string;
  connector_account_id: string;
  external_id: string;
  name: string;
  official_name: string | null;
  type: MoneyAccount["type"];
  currency: string;
  balance_current: string | number | null;
  balance_available: string | number | null;
  balance_as_of: string | null;
  mask: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface MoneyTransactionRow {
  id: string;
  user_id: string;
  connector_account_id: string;
  money_account_id: string;
  external_id: string;
  amount: string | number;
  currency: string;
  description: string;
  merchant_name: string | null;
  posted_on: string;
  authorized_at: string | null;
  pending: boolean;
  category: string[];
  counterparty_person_id: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

/** jsonb element of time_events.participants / organizer. */
export interface ParticipantJson {
  email: string | null;
  name: string | null;
  response: EventParticipant["response"];
  is_organizer: boolean;
  is_self: boolean;
  person_id: string | null;
}

export interface TimeEventRow {
  id: string;
  user_id: string;
  connector_account_id: string;
  external_calendar_id: string;
  external_id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  timezone: string | null;
  location: string | null;
  status: TimeEvent["status"];
  organizer: ParticipantJson | null;
  participants: ParticipantJson[];
  external_link: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface ContextEventRow {
  id: string;
  user_id: string;
  kind: string;
  subject_type: EntityType;
  subject_id: string;
  title: string;
  summary: string | null;
  occurred_at: string;
  importance: number;
  due_at: string | null;
  attention: ContextEvent["attention"];
  connector_account_id: string | null;
  dedupe_key: string;
  metadata: JsonObject;
  created_at: string;
}

export interface ConclusionRow {
  id: string;
  user_id: string;
  subject_type: EntityType;
  subject_id: string;
  text: string;
  produced_by: string;
  confidence: string | number;
  metadata: JsonObject;
  created_at: string;
}

export interface ConnectorAccountRow {
  id: string;
  user_id: string;
  provider: ConnectorAccount["provider"];
  external_account_id: string;
  label: string;
  address: string | null;
  capabilities: ConnectorAccount["capabilities"][number][];
  status: ConnectorAccount["status"];
  credential_location: ConnectorAccount["credentialLocation"];
  credential_ref: string | null;
  last_error: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface ConnectorSyncStateRow {
  connector_account_id: string;
  capability: ConnectorSyncState["capability"];
  user_id: string;
  enabled: boolean;
  status: ConnectorSyncState["status"];
  checkpoint: JsonObject | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  updated_at: string;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  platform: Device["platform"];
  name: string;
  praxion_available: boolean;
  last_seen_at: string | null;
  created_at: string;
}

export interface HandoffRow {
  id: string;
  user_id: string;
  source_device_id: string;
  target_device_id: string | null;
  state: Handoff["state"];
  focus_type: EntityType | null;
  focus_id: string | null;
  thread_id: string | null;
  document_id: string | null;
  artifact_storage_path: string | null;
  praxion_location: JsonObject | null;
  conclusions: string[];
  command_history: string[];
  created_at: string;
  delivered_at: string | null;
  accepted_at: string | null;
  expires_at: string | null;
  metadata: JsonObject;
}

export interface IngestItemRow {
  id: string;
  user_id: string;
  device_id: string | null;
  kind: IngestItem["kind"];
  source: IngestItem["source"];
  title: string | null;
  text_content: string | null;
  url: string | null;
  mime_type: string | null;
  size_bytes: number | string | null;
  storage_path: string | null;
  status: IngestItem["status"];
  document_id: string | null;
  error: string | null;
  metadata: JsonObject;
  created_at: string;
  processed_at: string | null;
}

export interface ActionRequestRow {
  id: string;
  user_id: string;
  action_type: string;
  idempotency_key: string;
  payload: JsonObject;
  status: ActionRequest["status"];
  result: JsonObject | null;
  error: string | null;
  attempts: number;
  actor_device_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelationshipRow {
  id: string;
  user_id: string;
  from_type: EntityType;
  from_id: string;
  kind: Relationship["kind"];
  to_type: EntityType;
  to_id: string;
  confidence: string | number;
  source: Relationship["source"];
  metadata: JsonObject;
  created_at: string;
}

/** Result row of `vx_neighbors(p_type, p_id)`. */
export interface NeighborRpcRow {
  relationship_id: string;
  kind: Relationship["kind"];
  direction: "out" | "in";
  neighbor_type: EntityType;
  neighbor_id: string;
  confidence: string | number;
  source: Relationship["source"];
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/** timestamptz → canonical ISO string. Leaves null alone. */
export function isoFromDb(value: string): string;
export function isoFromDb(value: string | null): string | null;
export function isoFromDb(value: string | null): string | null {
  if (value === null || value === undefined) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

/**
 * numeric → domain decimal string. Postgres pads to the column scale
 * ("12400.0000"); the domain keeps the shortest exact form ("12400", "-2400.5").
 */
export function decimalFromDb(value: string | number): string;
export function decimalFromDb(value: string | number | null): string | null;
export function decimalFromDb(value: string | number | null): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === "number" ? String(value) : value.trim();
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return s;
  let [int, frac = ""] = s.split(".") as [string, string?];
  frac = frac.replace(/0+$/, "");
  if (int.startsWith("+")) int = int.slice(1);
  const out = frac.length ? `${int}.${frac}` : int;
  return out === "-0" ? "0" : out;
}

export function numberFromDb(value: string | number): number;
export function numberFromDb(value: string | number | null): number | null;
export function numberFromDb(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value);
}

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------
export function personFromRow(r: PersonRow): Person {
  return {
    id: r.id as Person["id"],
    userId: r.user_id as UserId,
    displayName: r.display_name,
    primaryEmail: r.primary_email,
    organization: r.organization,
    notes: r.notes,
    mergedIntoId: r.merged_into_id as Person["mergedIntoId"],
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type PersonInsert = Omit<PersonRow, "created_at" | "updated_at">;

export function personToRow(userId: UserId, id: string, p: Omit<Person, "id" | "userId" | "createdAt" | "updatedAt" | "mergedIntoId"> & { mergedIntoId?: string | null }): PersonInsert {
  return {
    id,
    user_id: userId,
    display_name: p.displayName,
    primary_email: p.primaryEmail,
    organization: p.organization,
    notes: p.notes,
    merged_into_id: p.mergedIntoId ?? null,
    metadata: p.metadata,
  };
}

export function personPatchToRow(patch: Partial<Omit<Person, "id" | "userId" | "createdAt" | "updatedAt">>): Partial<PersonInsert> {
  const out: Partial<PersonInsert> = {};
  if (patch.displayName !== undefined) out.display_name = patch.displayName;
  if (patch.primaryEmail !== undefined) out.primary_email = patch.primaryEmail;
  if (patch.organization !== undefined) out.organization = patch.organization;
  if (patch.notes !== undefined) out.notes = patch.notes;
  if (patch.mergedIntoId !== undefined) out.merged_into_id = patch.mergedIntoId;
  if (patch.metadata !== undefined) out.metadata = patch.metadata;
  return out;
}

export function personIdentityFromRow(r: PersonIdentityRow): PersonIdentity {
  return {
    id: r.id,
    userId: r.user_id as UserId,
    personId: r.person_id as PersonIdentity["personId"],
    kind: r.kind,
    value: r.value,
    rawValue: r.raw_value,
    provider: r.provider,
    connectorAccountId: r.connector_account_id as PersonIdentity["connectorAccountId"],
    createdAt: isoFromDb(r.created_at),
  };
}

export type PersonIdentityInsert = Omit<PersonIdentityRow, "id" | "created_at">;

export function personIdentityToRow(userId: UserId, i: Omit<PersonIdentity, "id" | "userId" | "createdAt">): PersonIdentityInsert {
  return {
    user_id: userId,
    person_id: i.personId,
    kind: i.kind,
    value: i.value,
    raw_value: i.rawValue,
    provider: i.provider,
    connector_account_id: i.connectorAccountId,
  };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------
export function threadFromRow(r: ThreadRow): Thread {
  return {
    id: r.id as Thread["id"],
    userId: r.user_id as UserId,
    title: r.title,
    kind: r.kind,
    status: r.status,
    summary: r.summary,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type ThreadInsert = Omit<ThreadRow, "created_at" | "updated_at">;

export function threadToRow(userId: UserId, id: string, t: Omit<Thread, "id" | "userId" | "createdAt" | "updatedAt">): ThreadInsert {
  return { id, user_id: userId, title: t.title, kind: t.kind, status: t.status, summary: t.summary, metadata: t.metadata };
}

export function threadPatchToRow(patch: Partial<Omit<Thread, "id" | "userId" | "createdAt" | "updatedAt">>): Partial<ThreadInsert> {
  const out: Partial<ThreadInsert> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.kind !== undefined) out.kind = patch.kind;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.summary !== undefined) out.summary = patch.summary;
  if (patch.metadata !== undefined) out.metadata = patch.metadata;
  return out;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------
export function documentFromRow(r: DocumentRow): Document {
  return {
    id: r.id as Document["id"],
    userId: r.user_id as UserId,
    title: r.title,
    mimeType: r.mime_type,
    source: r.source,
    connectorAccountId: r.connector_account_id as Document["connectorAccountId"],
    sourceRef: asJsonObject(r.source_ref),
    location: locationFromJson(r.location),
    praxionDocumentId: r.praxion_document_id,
    sizeBytes: numberFromDb(r.size_bytes),
    contentHash: r.content_hash,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type DocumentInsert = Omit<DocumentRow, "created_at" | "updated_at">;

export function documentToRow(userId: UserId, id: string, d: Omit<Document, "id" | "userId" | "createdAt" | "updatedAt">): DocumentInsert {
  return {
    id,
    user_id: userId,
    title: d.title,
    mime_type: d.mimeType,
    source: d.source,
    connector_account_id: d.connectorAccountId,
    source_ref: d.sourceRef,
    location: d.location as unknown as JsonObject,
    praxion_document_id: d.praxionDocumentId,
    size_bytes: d.sizeBytes,
    content_hash: d.contentHash,
    metadata: d.metadata,
  };
}

export function documentPatchToRow(patch: Partial<Omit<Document, "id" | "userId" | "createdAt" | "updatedAt">>): Partial<DocumentInsert> {
  const out: Partial<DocumentInsert> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.mimeType !== undefined) out.mime_type = patch.mimeType;
  if (patch.source !== undefined) out.source = patch.source;
  if (patch.connectorAccountId !== undefined) out.connector_account_id = patch.connectorAccountId;
  if (patch.sourceRef !== undefined) out.source_ref = patch.sourceRef;
  if (patch.location !== undefined) out.location = patch.location as unknown as JsonObject;
  if (patch.praxionDocumentId !== undefined) out.praxion_document_id = patch.praxionDocumentId;
  if (patch.sizeBytes !== undefined) out.size_bytes = patch.sizeBytes;
  if (patch.contentHash !== undefined) out.content_hash = patch.contentHash;
  if (patch.metadata !== undefined) out.metadata = patch.metadata;
  return out;
}

function locationFromJson(value: unknown): DocumentLocation {
  const o = asJsonObject(value);
  switch (o["kind"]) {
    case "device_path":
      return { kind: "device_path", deviceId: String(o["deviceId"] ?? "") as DocumentLocation extends { deviceId: infer D } ? D : never, path: String(o["path"] ?? "") };
    case "storage":
      return { kind: "storage", bucket: String(o["bucket"] ?? ""), path: String(o["path"] ?? "") };
    case "provider":
      return { kind: "provider", provider: String(o["provider"] ?? ""), ref: asJsonObject(o["ref"]) };
    case "url":
      return { kind: "url", url: String(o["url"] ?? "") };
    default:
      return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------
function mailAddressFromJson(a: MailAddressJson): MailAddress {
  return { email: a.email, name: a.name ?? null, personId: (a.person_id ?? null) as PersonId | null };
}

function mailAddressToJson(a: { email: string; name: string | null }, personId: string | null | undefined): MailAddressJson {
  return { email: a.email, name: a.name, person_id: personId ?? null };
}

export function mailMessageFromRow(r: MailMessageRow): MailMessage {
  return {
    id: r.id as MailMessage["id"],
    userId: r.user_id as UserId,
    connectorAccountId: r.connector_account_id as MailMessage["connectorAccountId"],
    externalId: r.external_id,
    externalThreadId: r.external_thread_id,
    subject: r.subject,
    snippet: r.snippet,
    bodyText: r.body_text,
    from: r.from_address ? { email: r.from_address, name: r.from_name, personId: (r.from_person_id ?? null) as PersonId | null } : null,
    to: asArray<MailAddressJson>(r.to_addresses).map(mailAddressFromJson),
    cc: asArray<MailAddressJson>(r.cc_addresses).map(mailAddressFromJson),
    sentAt: isoFromDb(r.sent_at),
    receivedAt: isoFromDb(r.received_at),
    isUnread: r.is_unread,
    attachments: asArray<MailAttachmentMeta>(r.attachments).map((a) => ({
      attachmentId: a.attachmentId,
      filename: a.filename,
      mimeType: a.mimeType ?? null,
      sizeBytes: a.sizeBytes ?? null,
    })),
    labels: asArray<string>(r.labels),
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type MailMessageInsert = Omit<MailMessageRow, "id" | "created_at" | "updated_at">;

export function mailMessageToRow(userId: UserId, connectorAccountId: string, w: MailMessageWrite): MailMessageInsert {
  return {
    user_id: userId,
    connector_account_id: connectorAccountId,
    external_id: w.externalId,
    external_thread_id: w.externalThreadId,
    subject: w.subject,
    snippet: w.snippet,
    body_text: w.bodyText,
    from_address: w.from?.email ?? null,
    from_name: w.from?.name ?? null,
    from_person_id: w.from ? (w.fromPersonId ?? null) : null,
    to_addresses: w.to.map((a, i) => mailAddressToJson(a, w.toPersonIds?.[i])),
    cc_addresses: w.cc.map((a, i) => mailAddressToJson(a, w.ccPersonIds?.[i])),
    sent_at: w.sentAt,
    received_at: w.receivedAt,
    is_unread: w.isUnread,
    attachments: w.attachments.map((a) => ({ attachmentId: a.attachmentId, filename: a.filename, mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
    labels: [...w.labels],
    metadata: w.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------
export function moneyAccountFromRow(r: MoneyAccountRow): MoneyAccount {
  return {
    id: r.id as MoneyAccount["id"],
    userId: r.user_id as UserId,
    connectorAccountId: r.connector_account_id as MoneyAccount["connectorAccountId"],
    externalId: r.external_id,
    name: r.name,
    officialName: r.official_name,
    type: r.type,
    currency: r.currency,
    balanceCurrent: decimalFromDb(r.balance_current),
    balanceAvailable: decimalFromDb(r.balance_available),
    balanceAsOf: isoFromDb(r.balance_as_of),
    mask: r.mask,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type MoneyAccountInsert = Omit<MoneyAccountRow, "id" | "created_at" | "updated_at">;

export function moneyAccountToRow(userId: UserId, connectorAccountId: string, a: NormalizedMoneyAccount): MoneyAccountInsert {
  return {
    user_id: userId,
    connector_account_id: connectorAccountId,
    external_id: a.externalId,
    name: a.name,
    official_name: a.officialName,
    type: a.type,
    currency: a.currency,
    balance_current: a.balanceCurrent,
    balance_available: a.balanceAvailable,
    balance_as_of: a.balanceAsOf,
    mask: a.mask,
    metadata: a.metadata ?? {},
  };
}

export function moneyTransactionFromRow(r: MoneyTransactionRow): MoneyTransaction {
  return {
    id: r.id as MoneyTransaction["id"],
    userId: r.user_id as UserId,
    connectorAccountId: r.connector_account_id as MoneyTransaction["connectorAccountId"],
    moneyAccountId: r.money_account_id as MoneyTransaction["moneyAccountId"],
    externalId: r.external_id,
    amount: decimalFromDb(r.amount),
    currency: r.currency,
    description: r.description,
    merchantName: r.merchant_name,
    postedOn: r.posted_on,
    authorizedAt: isoFromDb(r.authorized_at),
    pending: r.pending,
    category: asArray<string>(r.category),
    counterpartyPersonId: r.counterparty_person_id as MoneyTransaction["counterpartyPersonId"],
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type MoneyTransactionInsert = Omit<MoneyTransactionRow, "id" | "created_at" | "updated_at">;

export function moneyTransactionToRow(userId: UserId, connectorAccountId: string, moneyAccountId: string, t: MoneyTransactionWrite): MoneyTransactionInsert {
  return {
    user_id: userId,
    connector_account_id: connectorAccountId,
    money_account_id: moneyAccountId,
    external_id: t.externalId,
    amount: t.amount,
    currency: t.currency,
    description: t.description,
    merchant_name: t.merchantName,
    posted_on: t.postedOn,
    authorized_at: t.authorizedAt,
    pending: t.pending,
    category: [...t.category],
    counterparty_person_id: t.counterpartyPersonId ?? null,
    metadata: t.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
export function participantFromJson(p: ParticipantJson): EventParticipant {
  return {
    email: p.email ?? null,
    name: p.name ?? null,
    response: p.response ?? "unknown",
    isOrganizer: p.is_organizer ?? false,
    isSelf: p.is_self ?? false,
    personId: (p.person_id ?? null) as PersonId | null,
  };
}

export function participantToJson(p: EventParticipant, personId?: string | null): ParticipantJson {
  return {
    email: p.email,
    name: p.name,
    response: p.response,
    is_organizer: p.isOrganizer,
    is_self: p.isSelf,
    person_id: personId !== undefined ? personId : (p.personId ?? null),
  };
}

export function timeEventFromRow(r: TimeEventRow): TimeEvent {
  return {
    id: r.id as TimeEvent["id"],
    userId: r.user_id as UserId,
    connectorAccountId: r.connector_account_id as TimeEvent["connectorAccountId"],
    externalCalendarId: r.external_calendar_id,
    externalId: r.external_id,
    title: r.title,
    description: r.description,
    startsAt: isoFromDb(r.starts_at),
    endsAt: isoFromDb(r.ends_at),
    allDay: r.all_day,
    timezone: r.timezone,
    location: r.location,
    status: r.status,
    organizer: r.organizer ? participantFromJson(r.organizer) : null,
    participants: asArray<ParticipantJson>(r.participants).map(participantFromJson),
    externalLink: r.external_link,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type TimeEventInsert = Omit<TimeEventRow, "id" | "created_at" | "updated_at">;

export function timeEventToRow(userId: UserId, connectorAccountId: string, e: TimeEventWrite): TimeEventInsert {
  const participants = e.participants.map((p, i) => participantToJson(p, e.participantPersonIds?.[i] ?? p.personId ?? null));
  const organizerPersonId = e.organizer ? (participants.find((p) => p.email && p.email === e.organizer?.email)?.person_id ?? e.organizer.personId ?? null) : null;
  return {
    user_id: userId,
    connector_account_id: connectorAccountId,
    external_calendar_id: e.externalCalendarId,
    external_id: e.externalId,
    title: e.title,
    description: e.description,
    starts_at: e.startsAt,
    ends_at: e.endsAt,
    all_day: e.allDay,
    timezone: e.timezone,
    location: e.location,
    status: e.status,
    organizer: e.organizer ? participantToJson(e.organizer, organizerPersonId) : null,
    participants,
    external_link: e.externalLink,
    metadata: e.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Context events + conclusions
// ---------------------------------------------------------------------------
export function contextEventFromRow(r: ContextEventRow): ContextEvent {
  return {
    id: r.id as ContextEvent["id"],
    userId: r.user_id as UserId,
    kind: r.kind,
    subject: { type: r.subject_type, id: r.subject_id },
    title: r.title,
    summary: r.summary,
    occurredAt: isoFromDb(r.occurred_at),
    importance: numberFromDb(r.importance),
    dueAt: isoFromDb(r.due_at),
    attention: r.attention,
    connectorAccountId: r.connector_account_id as ContextEvent["connectorAccountId"],
    dedupeKey: r.dedupe_key,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
  };
}

export type ContextEventInsert = Omit<ContextEventRow, "created_at">;

export function contextEventToRow(userId: UserId, id: string, e: Omit<ContextEvent, "id" | "userId" | "createdAt">): ContextEventInsert {
  return {
    id,
    user_id: userId,
    kind: e.kind,
    subject_type: e.subject.type,
    subject_id: e.subject.id,
    title: e.title,
    summary: e.summary,
    occurred_at: e.occurredAt,
    importance: e.importance,
    due_at: e.dueAt,
    attention: e.attention,
    connector_account_id: e.connectorAccountId,
    dedupe_key: e.dedupeKey,
    metadata: e.metadata,
  };
}

export function conclusionFromRow(r: ConclusionRow): Conclusion {
  return {
    id: r.id as Conclusion["id"],
    userId: r.user_id as UserId,
    subject: { type: r.subject_type, id: r.subject_id },
    text: r.text,
    producedBy: r.produced_by,
    confidence: numberFromDb(r.confidence),
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
  };
}

export type ConclusionInsert = Omit<ConclusionRow, "created_at">;

export function conclusionToRow(userId: UserId, id: string, c: Omit<Conclusion, "id" | "userId" | "createdAt">): ConclusionInsert {
  return {
    id,
    user_id: userId,
    subject_type: c.subject.type,
    subject_id: c.subject.id,
    text: c.text,
    produced_by: c.producedBy,
    confidence: c.confidence,
    metadata: c.metadata,
  };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------
export function relationshipFromRow(r: RelationshipRow): Relationship {
  return {
    id: r.id as Relationship["id"],
    userId: r.user_id as UserId,
    from: { type: r.from_type, id: r.from_id },
    kind: r.kind,
    to: { type: r.to_type, id: r.to_id },
    confidence: numberFromDb(r.confidence),
    source: r.source,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
  };
}

export function neighborRefFromRpc(r: NeighborRpcRow): EntityRef {
  return { type: r.neighbor_type, id: r.neighbor_id };
}

// ---------------------------------------------------------------------------
// Connector accounts + sync states
// ---------------------------------------------------------------------------
export function connectorAccountFromRow(r: ConnectorAccountRow): ConnectorAccount {
  return {
    id: r.id as ConnectorAccount["id"],
    userId: r.user_id as UserId,
    provider: r.provider,
    externalAccountId: r.external_account_id,
    label: r.label,
    address: r.address,
    capabilities: asArray<ConnectorAccount["capabilities"][number]>(r.capabilities),
    status: r.status,
    credentialLocation: r.credential_location,
    credentialRef: r.credential_ref,
    lastError: r.last_error,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type ConnectorAccountInsert = Omit<ConnectorAccountRow, "created_at" | "updated_at">;

export function connectorAccountToRow(userId: UserId, id: string, a: Omit<ConnectorAccount, "id" | "userId" | "createdAt" | "updatedAt">): ConnectorAccountInsert {
  return {
    id,
    user_id: userId,
    provider: a.provider,
    external_account_id: a.externalAccountId,
    label: a.label,
    address: a.address,
    capabilities: [...a.capabilities],
    status: a.status,
    credential_location: a.credentialLocation,
    credential_ref: a.credentialRef,
    last_error: a.lastError,
    metadata: a.metadata,
  };
}

export function connectorAccountPatchToRow(
  patch: Partial<Omit<ConnectorAccount, "id" | "userId" | "createdAt" | "updatedAt" | "provider" | "externalAccountId">>,
): Partial<ConnectorAccountInsert> {
  const out: Partial<ConnectorAccountInsert> = {};
  if (patch.label !== undefined) out.label = patch.label;
  if (patch.address !== undefined) out.address = patch.address;
  if (patch.capabilities !== undefined) out.capabilities = [...patch.capabilities];
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.credentialLocation !== undefined) out.credential_location = patch.credentialLocation;
  if (patch.credentialRef !== undefined) out.credential_ref = patch.credentialRef;
  if (patch.lastError !== undefined) out.last_error = patch.lastError;
  if (patch.metadata !== undefined) out.metadata = patch.metadata;
  return out;
}

export function syncStateFromRow(r: ConnectorSyncStateRow): ConnectorSyncState {
  return {
    userId: r.user_id as UserId,
    connectorAccountId: r.connector_account_id as ConnectorSyncState["connectorAccountId"],
    capability: r.capability,
    enabled: r.enabled,
    status: r.status,
    checkpoint: r.checkpoint === null || r.checkpoint === undefined ? null : asJsonObject(r.checkpoint),
    lastAttemptAt: isoFromDb(r.last_attempt_at),
    lastSuccessAt: isoFromDb(r.last_success_at),
    lastError: r.last_error,
    consecutiveFailures: numberFromDb(r.consecutive_failures),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type SyncStateUpsert = Partial<Omit<ConnectorSyncStateRow, "updated_at">> & Pick<ConnectorSyncStateRow, "user_id" | "connector_account_id" | "capability">;

export function syncStatePatchToRow(
  userId: UserId,
  connectorAccountId: string,
  capability: ConnectorSyncState["capability"],
  patch: Partial<Omit<ConnectorSyncState, "userId" | "connectorAccountId" | "capability" | "updatedAt">>,
): SyncStateUpsert {
  const out: SyncStateUpsert = { user_id: userId, connector_account_id: connectorAccountId, capability };
  if (patch.enabled !== undefined) out.enabled = patch.enabled;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.checkpoint !== undefined) out.checkpoint = patch.checkpoint;
  if (patch.lastAttemptAt !== undefined) out.last_attempt_at = patch.lastAttemptAt;
  if (patch.lastSuccessAt !== undefined) out.last_success_at = patch.lastSuccessAt;
  if (patch.lastError !== undefined) out.last_error = patch.lastError;
  if (patch.consecutiveFailures !== undefined) out.consecutive_failures = patch.consecutiveFailures;
  return out;
}

// ---------------------------------------------------------------------------
// Devices, handoffs, ingest, actions
// ---------------------------------------------------------------------------
export function deviceFromRow(r: DeviceRow): Device {
  return {
    id: r.id as Device["id"],
    userId: r.user_id as UserId,
    platform: r.platform,
    name: r.name,
    praxionAvailable: r.praxion_available,
    lastSeenAt: isoFromDb(r.last_seen_at),
    createdAt: isoFromDb(r.created_at),
  };
}

export type DeviceInsert = Omit<DeviceRow, "created_at">;

export function deviceToRow(userId: UserId, id: string, d: Omit<Device, "id" | "userId" | "createdAt">): DeviceInsert {
  return { id, user_id: userId, platform: d.platform, name: d.name, praxion_available: d.praxionAvailable, last_seen_at: d.lastSeenAt };
}

export function devicePatchToRow(patch: Partial<Omit<Device, "id" | "userId" | "createdAt">>): Partial<DeviceInsert> {
  const out: Partial<DeviceInsert> = {};
  if (patch.platform !== undefined) out.platform = patch.platform;
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.praxionAvailable !== undefined) out.praxion_available = patch.praxionAvailable;
  if (patch.lastSeenAt !== undefined) out.last_seen_at = patch.lastSeenAt;
  return out;
}

function praxionLocationFromJson(value: JsonObject | null): PraxionLocation | null {
  if (!value) return null;
  const page = value["page"];
  return {
    page: typeof page === "number" ? page : null,
    position: value["position"] && typeof value["position"] === "object" && !Array.isArray(value["position"]) ? (value["position"] as JsonObject) : null,
    selectionText: typeof value["selectionText"] === "string" ? value["selectionText"] : null,
  };
}

function praxionLocationToJson(loc: PraxionLocation | null): JsonObject | null {
  if (!loc) return null;
  return { page: loc.page, position: loc.position as Json, selectionText: loc.selectionText };
}

export function handoffFromRow(r: HandoffRow): Handoff {
  return {
    id: r.id as Handoff["id"],
    userId: r.user_id as UserId,
    sourceDeviceId: r.source_device_id as Handoff["sourceDeviceId"],
    targetDeviceId: r.target_device_id as Handoff["targetDeviceId"],
    state: r.state,
    focus: r.focus_type && r.focus_id ? { type: r.focus_type, id: r.focus_id } : null,
    threadId: r.thread_id as Handoff["threadId"],
    documentId: r.document_id as Handoff["documentId"],
    artifactStoragePath: r.artifact_storage_path,
    praxionLocation: praxionLocationFromJson(r.praxion_location),
    conclusions: asArray<string>(r.conclusions),
    commandHistory: asArray<string>(r.command_history),
    createdAt: isoFromDb(r.created_at),
    deliveredAt: isoFromDb(r.delivered_at),
    acceptedAt: isoFromDb(r.accepted_at),
    expiresAt: isoFromDb(r.expires_at),
    metadata: asJsonObject(r.metadata),
  };
}

export type HandoffInsert = Omit<HandoffRow, "created_at">;

export function handoffToRow(userId: UserId, id: string, h: Omit<Handoff, "id" | "userId" | "createdAt">): HandoffInsert {
  return {
    id,
    user_id: userId,
    source_device_id: h.sourceDeviceId,
    target_device_id: h.targetDeviceId,
    state: h.state,
    focus_type: h.focus?.type ?? null,
    focus_id: h.focus?.id ?? null,
    thread_id: h.threadId,
    document_id: h.documentId,
    artifact_storage_path: h.artifactStoragePath,
    praxion_location: praxionLocationToJson(h.praxionLocation),
    conclusions: [...h.conclusions],
    command_history: [...h.commandHistory],
    delivered_at: h.deliveredAt,
    accepted_at: h.acceptedAt,
    expires_at: h.expiresAt,
    metadata: h.metadata,
  };
}

export function handoffPatchToRow(patch: Partial<Omit<Handoff, "id" | "userId" | "createdAt" | "sourceDeviceId">>): Partial<HandoffInsert> {
  const out: Partial<HandoffInsert> = {};
  if (patch.targetDeviceId !== undefined) out.target_device_id = patch.targetDeviceId;
  if (patch.state !== undefined) out.state = patch.state;
  if (patch.focus !== undefined) {
    out.focus_type = patch.focus?.type ?? null;
    out.focus_id = patch.focus?.id ?? null;
  }
  if (patch.threadId !== undefined) out.thread_id = patch.threadId;
  if (patch.documentId !== undefined) out.document_id = patch.documentId;
  if (patch.artifactStoragePath !== undefined) out.artifact_storage_path = patch.artifactStoragePath;
  if (patch.praxionLocation !== undefined) out.praxion_location = praxionLocationToJson(patch.praxionLocation);
  if (patch.conclusions !== undefined) out.conclusions = [...patch.conclusions];
  if (patch.commandHistory !== undefined) out.command_history = [...patch.commandHistory];
  if (patch.deliveredAt !== undefined) out.delivered_at = patch.deliveredAt;
  if (patch.acceptedAt !== undefined) out.accepted_at = patch.acceptedAt;
  if (patch.expiresAt !== undefined) out.expires_at = patch.expiresAt;
  if (patch.metadata !== undefined) out.metadata = patch.metadata;
  return out;
}

export function ingestItemFromRow(r: IngestItemRow): IngestItem {
  return {
    id: r.id as IngestItem["id"],
    userId: r.user_id as UserId,
    deviceId: r.device_id as IngestItem["deviceId"],
    kind: r.kind,
    source: r.source,
    title: r.title,
    textContent: r.text_content,
    url: r.url,
    mimeType: r.mime_type,
    sizeBytes: numberFromDb(r.size_bytes),
    storagePath: r.storage_path,
    status: r.status,
    documentId: r.document_id as IngestItem["documentId"],
    error: r.error,
    metadata: asJsonObject(r.metadata),
    createdAt: isoFromDb(r.created_at),
    processedAt: isoFromDb(r.processed_at),
  };
}

export type IngestItemInsert = Omit<IngestItemRow, "created_at">;

export function ingestItemToRow(userId: UserId, id: string, i: Omit<IngestItem, "id" | "userId" | "createdAt">): IngestItemInsert {
  return {
    id,
    user_id: userId,
    device_id: i.deviceId,
    kind: i.kind,
    source: i.source,
    title: i.title,
    text_content: i.textContent,
    url: i.url,
    mime_type: i.mimeType,
    size_bytes: i.sizeBytes,
    storage_path: i.storagePath,
    status: i.status,
    document_id: i.documentId,
    error: i.error,
    metadata: i.metadata,
    processed_at: i.processedAt,
  };
}

export function ingestItemPatchToRow(patch: Partial<Omit<IngestItem, "id" | "userId" | "createdAt">>): Partial<IngestItemInsert> {
  const out: Partial<IngestItemInsert> = {};
  if (patch.deviceId !== undefined) out.device_id = patch.deviceId;
  if (patch.kind !== undefined) out.kind = patch.kind;
  if (patch.source !== undefined) out.source = patch.source;
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.textContent !== undefined) out.text_content = patch.textContent;
  if (patch.url !== undefined) out.url = patch.url;
  if (patch.mimeType !== undefined) out.mime_type = patch.mimeType;
  if (patch.sizeBytes !== undefined) out.size_bytes = patch.sizeBytes;
  if (patch.storagePath !== undefined) out.storage_path = patch.storagePath;
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.documentId !== undefined) out.document_id = patch.documentId;
  if (patch.error !== undefined) out.error = patch.error;
  if (patch.metadata !== undefined) out.metadata = patch.metadata;
  if (patch.processedAt !== undefined) out.processed_at = patch.processedAt;
  return out;
}

export function actionRequestFromRow(r: ActionRequestRow): ActionRequest {
  return {
    id: r.id as ActionRequest["id"],
    userId: r.user_id as UserId,
    actionType: r.action_type,
    idempotencyKey: r.idempotency_key,
    payload: asJsonObject(r.payload),
    status: r.status,
    result: r.result === null || r.result === undefined ? null : asJsonObject(r.result),
    error: r.error,
    attempts: numberFromDb(r.attempts),
    actorDeviceId: r.actor_device_id as ActionRequest["actorDeviceId"],
    createdAt: isoFromDb(r.created_at),
    updatedAt: isoFromDb(r.updated_at),
  };
}

export type ActionRequestInsert = Pick<ActionRequestRow, "id" | "user_id" | "action_type" | "idempotency_key" | "payload" | "status" | "actor_device_id">;

export function actionRequestToRow(
  userId: UserId,
  id: string,
  input: { actionType: string; idempotencyKey: string; payload: JsonObject; actorDeviceId?: string | null },
): ActionRequestInsert {
  return {
    id,
    user_id: userId,
    action_type: input.actionType,
    idempotency_key: input.idempotencyKey,
    payload: input.payload,
    status: "queued",
    actor_device_id: input.actorDeviceId ?? null,
  };
}

export function actionRequestPatchToRow(patch: { status?: ActionRequest["status"]; result?: JsonObject | null; error?: string | null; attempts?: number }): Partial<ActionRequestRow> {
  const out: Partial<ActionRequestRow> = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.result !== undefined) out.result = patch.result;
  if (patch.error !== undefined) out.error = patch.error;
  if (patch.attempts !== undefined) out.attempts = patch.attempts;
  return out;
}
