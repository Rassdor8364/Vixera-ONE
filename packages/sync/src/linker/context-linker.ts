import {
  displayNameFromEmail,
  normalizeEmail,
  ref,
  type BankSyncBatch,
  type CalendarSyncBatch,
  type ConnectorAccount,
  type Document,
  type EventParticipant,
  type JsonObject,
  type MailAttachmentMeta,
  type MailSyncBatch,
  type NormalizedMailMessage,
  type NormalizedMoneyTransaction,
  type NormalizedTimeEvent,
  type Person,
  type RelationshipInput,
} from "@vixera/domain";
import type { ContextEventInput, MailMessageWrite, MoneyTransactionWrite, SpineStore, TimeEventWrite } from "../store/spine-store.ts";
import { hashParts } from "./hash.ts";
import {
  KIND_MAIL_RECEIVED,
  KIND_MONEY_TRANSACTION_POSTED,
  mailAttention,
  mailImportance,
  moneyAttention,
  moneyImportance,
  timeAttention,
  timeEventKind,
  timeImportance,
} from "./rules.ts";

/**
 * ContextLinker: turns normalized connector batches into spine rows, people,
 * documents, relationships and context events. It is the only code that
 * decides "who is this address" and "what does this batch mean"; connectors
 * only normalize, the engine only orchestrates.
 *
 * People: every address / participant resolves to ONE Person by normalized
 * email identity (`findPersonByIdentity`), created on first sight with the
 * address name (else `displayNameFromEmail`) plus an email identity.
 * Addresses of the user (`selfAddresses`, the account's own address,
 * participants flagged `isSelf`) never become people.
 *
 * Graph: mail_message/time_event `has_person` person; attachment documents
 * `originated_from` mail_message and `has_person` sender; transactions whose
 * merchant matches a person's display name / organization `has_person` that
 * person (and carry `counterpartyPersonId`).
 *
 * Context events carry deterministic dedupe keys so re-running a batch never
 * duplicates anything:
 *   mail  "mail:<accountId>:<externalId>"
 *   time  "time:<accountId>:<calendarId>:<externalId>:<version>"  (version =
 *         FNV-1a of title+startsAt+endsAt+status → a changed event is a new
 *         `time.event.changed`, an unchanged re-sync is nothing)
 *   money "money:<accountId>:<externalId>"
 * Importance / attention rules live in `rules.ts`. Deletions remove rows (and
 * through the store, their edges and events) and emit nothing.
 */
export interface ContextLinkerOptions {
  readonly now: () => Date;
  /** Addresses that belong to the user, in any case. */
  readonly selfAddresses?: readonly string[];
  readonly log?: (message: string, data?: JsonObject) => void;
}

export interface LinkCounts {
  /** Domain rows inserted / updated / deleted by this batch (messages, events, accounts+transactions). */
  inserted: number;
  updated: number;
  deleted: number;
  peopleCreated: number;
  documents: number;
  /** Edges asserted (existing edges count too: relate() is idempotent). */
  relationships: number;
  /** Context events newly created (deduped ones do not count). */
  contextEvents: number;
}

export function emptyCounts(): LinkCounts {
  return { inserted: 0, updated: 0, deleted: 0, peopleCreated: 0, documents: 0, relationships: 0, contextEvents: 0 };
}

export function addCounts(into: LinkCounts, from: LinkCounts): LinkCounts {
  for (const k of Object.keys(from) as (keyof LinkCounts)[]) into[k] += from[k];
  return into;
}

interface Resolved {
  readonly person: Person;
  /** False when the person existed before this batch. */
  readonly created: boolean;
}

/** Per-batch memo so the same address is resolved once and "known before this batch" stays stable. */
interface Batch {
  readonly cache: Map<string, Resolved | null>;
  readonly counts: LinkCounts;
}

export class ContextLinker {
  private readonly selfAddresses: Set<string>;

  constructor(
    private readonly store: SpineStore,
    private readonly options: ContextLinkerOptions,
  ) {
    this.selfAddresses = new Set((options.selfAddresses ?? []).map(normalizeEmail).filter((e): e is string => e !== null));
  }

  // -------------------------------------------------------------------------
  // Mail
  // -------------------------------------------------------------------------
  async applyMailBatch(account: ConnectorAccount, batch: MailSyncBatch): Promise<LinkCounts> {
    const b = newBatch();
    const now = this.options.now();
    const self = this.selfFor(account);

    const resolved: { fromResolved: Resolved | null; people: Set<string> }[] = [];
    const writes: MailMessageWrite[] = [];
    for (const m of batch.messages) {
      const people = new Set<string>();
      const fromResolved = m.from ? await this.resolve(b, account, m.from, self) : null;
      if (fromResolved) people.add(fromResolved.person.id);
      const toIds: (string | null)[] = [];
      for (const a of m.to) {
        const r = await this.resolve(b, account, a, self);
        toIds.push(r?.person.id ?? null);
        if (r) people.add(r.person.id);
      }
      const ccIds: (string | null)[] = [];
      for (const a of m.cc) {
        const r = await this.resolve(b, account, a, self);
        ccIds.push(r?.person.id ?? null);
        if (r) people.add(r.person.id);
      }
      resolved.push({ fromResolved, people });
      writes.push({ ...m, fromPersonId: fromResolved?.person.id ?? null, toPersonIds: toIds, ccPersonIds: ccIds });
    }

    if (writes.length) {
      const result = await this.store.upsertMailMessages(account.id, writes);
      b.counts.inserted += result.inserted;
      b.counts.updated += result.updated;
      const rowsByExternalId = new Map(result.rows.map((r) => [r.externalId, r]));
      const events: ContextEventInput[] = [];

      for (let i = 0; i < batch.messages.length; i++) {
        const m = batch.messages[i] as NormalizedMailMessage;
        const link = resolved[i] as (typeof resolved)[number];
        const row = rowsByExternalId.get(m.externalId);
        if (!row) continue;
        const mailRef = ref("mail_message", row.id);

        for (const personId of link.people) {
          await this.relate(b, { from: mailRef, kind: "has_person", to: ref("person", personId), source: "connector" });
        }

        for (const attachment of m.attachments) {
          const doc = await this.upsertAttachmentDocument(account, m, attachment);
          b.counts.documents++;
          const docRef = ref("document", doc.id);
          await this.relate(b, { from: docRef, kind: "originated_from", to: mailRef, source: "connector" });
          if (link.fromResolved) {
            await this.relate(b, { from: docRef, kind: "has_person", to: ref("person", link.fromResolved.person.id), source: "connector" });
          }
        }

        events.push({
          kind: KIND_MAIL_RECEIVED,
          subject: mailRef,
          title: m.subject?.trim() || "(no subject)",
          summary: m.snippet,
          occurredAt: m.receivedAt,
          importance: mailImportance({ message: m, senderKnown: link.fromResolved !== null && !link.fromResolved.created }),
          dueAt: null,
          attention: mailAttention(m, now),
          connectorAccountId: account.id,
          dedupeKey: mailDedupeKey(account.id, m.externalId),
          metadata: {
            from: m.from?.email ?? null,
            fromName: m.from?.name ?? null,
            fromPersonId: link.fromResolved?.person.id ?? null,
            attachmentCount: m.attachments.length,
            externalThreadId: m.externalThreadId,
            isUnread: m.isUnread,
          },
        });
      }
      const ev = await this.store.upsertContextEvents(events);
      b.counts.contextEvents += ev.inserted;
    }

    if (batch.deleted.length) {
      b.counts.deleted += await this.store.deleteMailMessages(
        account.id,
        batch.deleted.map((d) => d.externalId),
      );
    }
    this.log("mail batch applied", account, b.counts);
    return b.counts;
  }

  private async upsertAttachmentDocument(account: ConnectorAccount, m: NormalizedMailMessage, attachment: MailAttachmentMeta): Promise<Document> {
    const sourceRef: JsonObject = { connectorAccountId: account.id, messageExternalId: m.externalId, attachmentId: attachment.attachmentId };
    const existing = await this.store.findDocumentBySourceRef(account.id, sourceRef);
    return this.store.upsertDocument({
      ...(existing ? { id: existing.id } : {}),
      title: attachment.filename || "(attachment)",
      mimeType: attachment.mimeType,
      source: "mail_attachment",
      connectorAccountId: account.id,
      sourceRef,
      location: { kind: "provider", provider: account.provider, ref: { messageExternalId: m.externalId, attachmentId: attachment.attachmentId } },
      praxionDocumentId: existing?.praxionDocumentId ?? null,
      sizeBytes: attachment.sizeBytes,
      contentHash: existing?.contentHash ?? null,
      metadata: {
        ...(existing?.metadata ?? {}),
        subject: m.subject,
        from: m.from?.email ?? null,
        receivedAt: m.receivedAt,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Calendar
  // -------------------------------------------------------------------------
  async applyCalendarBatch(account: ConnectorAccount, batch: CalendarSyncBatch): Promise<LinkCounts> {
    const b = newBatch();
    const now = this.options.now();
    const self = this.selfFor(account);

    const peoplePerEvent: Set<string>[] = [];
    const writes: TimeEventWrite[] = [];
    for (const e of batch.events) {
      const people = new Set<string>();
      const ids: (string | null)[] = [];
      for (const p of e.participants) {
        const r = await this.resolveParticipant(b, account, p, self);
        ids.push(r?.person.id ?? null);
        if (r) people.add(r.person.id);
      }
      if (e.organizer) {
        const r = await this.resolveParticipant(b, account, e.organizer, self);
        if (r) people.add(r.person.id);
      }
      peoplePerEvent.push(people);
      writes.push({ ...e, participantPersonIds: ids });
    }

    if (writes.length) {
      const result = await this.store.upsertTimeEvents(account.id, writes);
      b.counts.inserted += result.inserted;
      b.counts.updated += result.updated;
      const rowsByKey = new Map(result.rows.map((r) => [`${r.externalCalendarId} ${r.externalId}`, r]));
      const events: ContextEventInput[] = [];

      for (let i = 0; i < batch.events.length; i++) {
        const e = batch.events[i] as NormalizedTimeEvent;
        const row = rowsByKey.get(`${e.externalCalendarId} ${e.externalId}`);
        if (!row) continue;
        const eventRef = ref("time_event", row.id);
        for (const personId of peoplePerEvent[i] ?? []) {
          await this.relate(b, { from: eventRef, kind: "has_person", to: ref("person", personId), source: "connector" });
        }

        const version = timeEventVersion(e);
        const dedupeKey = timeDedupeKey(account.id, e.externalCalendarId, e.externalId, version);
        // First sight = no context event about this row yet. Same version ⇒ dedupe, nothing new.
        const prior = await this.store.listContextEvents({ subject: eventRef, kindPrefix: "time.event.", limit: 1 });
        events.push({
          kind: timeEventKind(e, prior.length === 0),
          subject: eventRef,
          title: e.title || "(untitled event)",
          summary: e.location ?? e.description ?? null,
          occurredAt: now.toISOString(),
          importance: timeImportance(e, now),
          dueAt: e.startsAt,
          attention: timeAttention(e, now),
          connectorAccountId: account.id,
          dedupeKey,
          metadata: {
            version,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
            status: e.status,
            externalCalendarId: e.externalCalendarId,
            participantCount: e.participants.length,
          },
        });
      }
      const ev = await this.store.upsertContextEvents(events);
      b.counts.contextEvents += ev.inserted;
    }

    if (batch.deleted.length) {
      // Group by calendar: time_events are keyed by (account, calendar, event id).
      const byCalendar = new Map<string | undefined, string[]>();
      for (const d of batch.deleted) {
        const list = byCalendar.get(d.externalCalendarId) ?? [];
        list.push(d.externalId);
        byCalendar.set(d.externalCalendarId, list);
      }
      for (const [calendarId, ids] of byCalendar) {
        b.counts.deleted += await this.store.deleteTimeEvents(account.id, ids, calendarId);
      }
    }
    this.log("calendar batch applied", account, b.counts);
    return b.counts;
  }

  // -------------------------------------------------------------------------
  // Bank
  // -------------------------------------------------------------------------
  async applyBankBatch(account: ConnectorAccount, batch: BankSyncBatch): Promise<LinkCounts> {
    const b = newBatch();

    if (batch.accounts.length) {
      const accounts = await this.store.upsertMoneyAccounts(account.id, batch.accounts);
      b.counts.inserted += accounts.inserted;
      b.counts.updated += accounts.updated;
    }

    if (batch.transactions.length) {
      const counterparties = await this.counterpartyIndex(batch.transactions);
      const writes: MoneyTransactionWrite[] = batch.transactions.map((t) => ({
        ...t,
        counterpartyPersonId: t.merchantName ? (counterparties.get(t.merchantName.trim().toLowerCase())?.id ?? null) : null,
      }));
      const result = await this.store.upsertMoneyTransactions(account.id, writes);
      b.counts.inserted += result.inserted;
      b.counts.updated += result.updated;
      const rowsByExternalId = new Map(result.rows.map((r) => [r.externalId, r]));
      const events: ContextEventInput[] = [];

      for (const t of batch.transactions) {
        const row = rowsByExternalId.get(t.externalId);
        if (!row) continue;
        const txRef = ref("money_transaction", row.id);
        if (row.counterpartyPersonId) {
          await this.relate(b, { from: txRef, kind: "has_person", to: ref("person", row.counterpartyPersonId), source: "rule", confidence: 0.8 });
        }
        events.push({
          kind: KIND_MONEY_TRANSACTION_POSTED,
          subject: txRef,
          title: (t.merchantName?.trim() || t.description.trim() || "Transaction") + ` ${formatAmount(t.amount, t.currency)}`,
          summary: t.description,
          occurredAt: t.authorizedAt ?? `${t.postedOn}T00:00:00.000Z`,
          importance: moneyImportance(t),
          dueAt: null,
          attention: moneyAttention(t),
          connectorAccountId: account.id,
          dedupeKey: moneyDedupeKey(account.id, t.externalId),
          metadata: {
            amount: t.amount,
            currency: t.currency,
            merchantName: t.merchantName,
            pending: t.pending,
            moneyAccountId: row.moneyAccountId,
            counterpartyPersonId: row.counterpartyPersonId,
          },
        });
      }
      const ev = await this.store.upsertContextEvents(events);
      b.counts.contextEvents += ev.inserted;
    }

    if (batch.deleted.length) {
      b.counts.deleted += await this.store.deleteMoneyTransactions(
        account.id,
        batch.deleted.map((d) => d.externalId),
      );
    }
    this.log("bank batch applied", account, b.counts);
    return b.counts;
  }

  /** lower-cased display name / organization → person, for merchant matching. Exact match only. */
  private async counterpartyIndex(transactions: readonly NormalizedMoneyTransaction[]): Promise<Map<string, Person>> {
    const index = new Map<string, Person>();
    if (!transactions.some((t) => t.merchantName)) return index;
    const people = await this.store.listPeople({ includeMerged: false });
    for (const p of people) {
      const name = p.displayName.trim().toLowerCase();
      if (name && !index.has(name)) index.set(name, p);
      const org = p.organization?.trim().toLowerCase();
      if (org && !index.has(org)) index.set(org, p);
    }
    return index;
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------
  /**
   * Find-or-create the person behind an address. Returns null for the user's
   * own addresses and for unparseable emails. Public so ingestion and the
   * command layer can resolve people the same way the connectors do.
   */
  async resolvePerson(account: ConnectorAccount, address: { readonly email: string; readonly name: string | null }): Promise<Person | null> {
    const r = await this.resolve(newBatch(), account, address, this.selfFor(account));
    return r?.person ?? null;
  }

  private async resolve(b: Batch, account: ConnectorAccount, address: { readonly email: string; readonly name: string | null }, self: ReadonlySet<string>): Promise<Resolved | null> {
    const email = normalizeEmail(address.email);
    if (!email || self.has(email)) return null;
    const cached = b.cache.get(email);
    if (cached !== undefined) return cached;

    let resolved: Resolved | null;
    const found = await this.store.findPersonByIdentity("email", email);
    if (found) {
      resolved = { person: found.mergedIntoId ? ((await this.store.getPerson(found.mergedIntoId)) ?? found) : found, created: false };
    } else {
      const created = await this.store.upsertPerson({
        displayName: address.name?.trim() || displayNameFromEmail(email),
        primaryEmail: email,
        organization: null,
        notes: null,
        metadata: {},
      });
      const identity = await this.store.upsertPersonIdentity({
        personId: created.id,
        kind: "email",
        value: email,
        rawValue: address.email.trim(),
        provider: account.provider,
        connectorAccountId: account.id,
      });
      if (identity.personId !== created.id) {
        // Lost a race: someone else created the identity meanwhile. Use theirs.
        const winner = await this.store.getPerson(identity.personId);
        resolved = winner ? { person: winner, created: false } : { person: created, created: true };
      } else {
        resolved = { person: created, created: true };
        b.counts.peopleCreated++;
      }
    }
    b.cache.set(email, resolved);
    return resolved;
  }

  private async resolveParticipant(b: Batch, account: ConnectorAccount, p: EventParticipant, self: ReadonlySet<string>): Promise<Resolved | null> {
    if (p.isSelf || !p.email) return null;
    return this.resolve(b, account, { email: p.email, name: p.name }, self);
  }

  private selfFor(account: ConnectorAccount): Set<string> {
    const self = new Set(this.selfAddresses);
    const own = account.address ? normalizeEmail(account.address) : null;
    if (own) self.add(own);
    return self;
  }

  private async relate(b: Batch, input: RelationshipInput): Promise<void> {
    await this.store.relate(input);
    b.counts.relationships++;
  }

  private log(message: string, account: ConnectorAccount, counts: LinkCounts): void {
    this.options.log?.(message, { connectorAccountId: account.id, provider: account.provider, ...counts });
  }
}

// ---------------------------------------------------------------------------
// Dedupe keys (exported so tests and the Field can compute them)
// ---------------------------------------------------------------------------
export function mailDedupeKey(accountId: string, externalId: string): string {
  return `mail:${accountId}:${externalId}`;
}

export function timeEventVersion(e: Pick<NormalizedTimeEvent, "title" | "startsAt" | "endsAt" | "status">): string {
  return hashParts(e.title, e.startsAt, e.endsAt, e.status);
}

export function timeDedupeKey(accountId: string, calendarId: string, externalId: string, version: string): string {
  return `time:${accountId}:${calendarId}:${externalId}:${version}`;
}

export function moneyDedupeKey(accountId: string, externalId: string): string {
  return `money:${accountId}:${externalId}`;
}

function newBatch(): Batch {
  return { cache: new Map(), counts: emptyCounts() };
}

function formatAmount(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  const sign = n < 0 ? "-" : "+";
  return `${sign}${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
