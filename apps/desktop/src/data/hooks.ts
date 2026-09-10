/**
 * Read hooks over the SpineReader. Each returns plain data derived from the
 * spine; none writes. Writes go through `useSpine().act` (the action seam).
 */
import { useMemo } from "react";
import {
  deriveNow,
  ref,
  type Conclusion,
  type ConnectorAccount,
  type ConnectorSyncState,
  type ContextEvent,
  type Device,
  type Document,
  type EntityRef,
  type EntityType,
  type Handoff,
  type IngestItem,
  type MailMessage,
  type MoneyAccount,
  type MoneyTransaction,
  type NowResult,
  type Person,
  type PersonIdentity,
  type Thread,
  type TimeEvent,
} from "@vixera/domain";
import type { NeighborRow, SpineReader } from "@vixera/sync";
import { listPendingHandoffs } from "./handoff.ts";
import { useSpine, useSpineQuery, type QueryState } from "./spine-provider.tsx";

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

export interface NowData {
  readonly now: NowResult;
  readonly contextEvents: readonly ContextEvent[];
  readonly threads: readonly Thread[];
  readonly upcomingWeek: readonly TimeEvent[];
}

/** NOW: context events (needs_attention + quiet, 30 days), time (−1d..+7d), money (30 days), threads, relationships → deriveNow. */
export function useNow(): QueryState<NowData> {
  return useSpineQuery(async (reader) => {
    const t = Date.now();
    const [contextEvents, timeEvents, moneyTransactions, threads, relationships] = await Promise.all([
      reader.listContextEvents({ attention: ["needs_attention", "quiet"], occurredSince: iso(t - 30 * DAY), limit: 500 }),
      reader.listTimeEvents({ from: iso(t - DAY), to: iso(t + 7 * DAY) }),
      reader.listMoneyTransactions({ postedFrom: iso(t - 30 * DAY).slice(0, 10), limit: 200 }),
      reader.listThreads({ limit: 200 }),
      reader.listRelationships({ limit: 5000 }),
    ]);
    const now = deriveNow({ contextEvents, timeEvents, moneyTransactions, threads, relationships, now: new Date(t) });
    const upcomingWeek = timeEvents.filter((e) => e.status !== "cancelled" && Date.parse(e.endsAt) >= t).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    return { now, contextEvents, threads, upcomingWeek };
  }, []);
}

export function useThreads(): QueryState<Thread[]> {
  return useSpineQuery(async (reader) => {
    const rows = await reader.listThreads({ limit: 200 });
    const rank: Record<Thread["status"], number> = { active: 0, quiet: 1, archived: 2 };
    return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }, []);
}

export interface Neighborhood {
  readonly people: Person[];
  readonly documents: Document[];
  readonly mail: MailMessage[];
  readonly timeEvents: TimeEvent[];
  readonly transactions: MoneyTransaction[];
  readonly conclusions: Conclusion[];
  readonly threads: Thread[];
}

/** Resolves the neighbors of an entity, grouped by type (one hop). */
export async function loadNeighborhood(reader: SpineReader, subject: EntityRef): Promise<Neighborhood> {
  const rows = await reader.neighbors(subject);
  const ids = (type: EntityType) => [...new Set(rows.filter((r) => r.ref.type === type).map((r) => r.ref.id))];
  async function many<T>(type: EntityType, get: (id: string) => Promise<T | null>): Promise<T[]> {
    const rows = await Promise.all(ids(type).map(get));
    return rows.filter((x): x is Awaited<T> => x !== null) as T[];
  }
  const [people, documents, mail, timeEvents, transactions, threads, conclusions] = await Promise.all([
    many("person", (id) => reader.getPerson(id)),
    many("document", (id) => reader.getDocument(id)),
    many("mail_message", (id) => reader.getMailMessage(id)),
    many("time_event", (id) => reader.getTimeEvent(id)),
    many("money_transaction", (id) => reader.getMoneyTransaction(id)),
    many("thread", (id) => reader.getThread(id)),
    reader.listConclusions(subject),
  ]);
  return { people, documents, mail, timeEvents, transactions, threads, conclusions };
}

export interface ThreadDetail {
  readonly thread: Thread;
  readonly neighborhood: Neighborhood;
}

export function useThread(id: string | null): QueryState<ThreadDetail | null> {
  return useSpineQuery(
    async (reader) => {
      if (!id) return null;
      const thread = await reader.getThread(id);
      if (!thread) return null;
      return { thread, neighborhood: await loadNeighborhood(reader, ref("thread", id)) };
    },
    [id],
  );
}

export function usePeople(search: string): QueryState<Person[]> {
  return useSpineQuery((reader) => reader.listPeople({ search: search.trim() || undefined, limit: 200 } as Parameters<SpineReader["listPeople"]>[0]), [search]);
}

export interface PersonDetail {
  readonly person: Person;
  readonly identities: PersonIdentity[];
  readonly neighborhood: Neighborhood;
  readonly mail: MailMessage[];
  readonly transactions: MoneyTransaction[];
}

export function usePerson(id: string | null): QueryState<PersonDetail | null> {
  return useSpineQuery(
    async (reader) => {
      if (!id) return null;
      const person = await reader.getPerson(id);
      if (!person) return null;
      const [identities, neighborhood, mail, transactions] = await Promise.all([
        reader.listPersonIdentities(id),
        loadNeighborhood(reader, ref("person", id)),
        reader.listMailMessages({ fromPersonId: id, limit: 50 }),
        reader.listMoneyTransactions({ counterpartyPersonId: id, limit: 50 }),
      ]);
      return { person, identities, neighborhood, mail: dedupe([...neighborhood.mail, ...mail]), transactions: dedupe([...neighborhood.transactions, ...transactions]) };
    },
    [id],
  );
}

function dedupe<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export interface TimeRange {
  readonly from: string;
  readonly to: string;
}

export function useTime(range: TimeRange): QueryState<TimeEvent[]> {
  return useSpineQuery(
    async (reader) => (await reader.listTimeEvents({ from: range.from, to: range.to })).filter((e) => e.status !== "cancelled").sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    [range.from, range.to],
  );
}

export interface MoneyData {
  readonly accounts: MoneyAccount[];
  readonly transactions: MoneyTransaction[];
}

export function useMoney(search: string): QueryState<MoneyData> {
  return useSpineQuery(
    async (reader) => {
      const [accounts, transactions] = await Promise.all([reader.listMoneyAccounts(), reader.listMoneyTransactions({ search: search.trim() || undefined, limit: 200 } as Parameters<SpineReader["listMoneyTransactions"]>[0])]);
      return { accounts, transactions: [...transactions].sort((a, b) => b.postedOn.localeCompare(a.postedOn)) };
    },
    [search],
  );
}

export interface FilesData {
  readonly documents: Document[];
  readonly pendingIngest: IngestItem[];
}

export function useFiles(search: string): QueryState<FilesData> {
  return useSpineQuery(
    async (reader) => {
      const [documents, pendingIngest] = await Promise.all([reader.listDocuments({ search: search.trim() || undefined, limit: 100 } as Parameters<SpineReader["listDocuments"]>[0]), reader.listIngestItems({ status: "received", limit: 50 })]);
      return { documents, pendingIngest };
    },
    [search],
  );
}

export function useQuiet(): QueryState<ContextEvent[]> {
  return useSpineQuery((reader) => reader.listContextEvents({ attention: "quiet", occurredSince: iso(Date.now() - 60 * DAY), limit: 300 }), []);
}

export interface ConnectorsData {
  readonly accounts: ConnectorAccount[];
  readonly syncStates: ConnectorSyncState[];
}

export function useConnectorAccounts(): QueryState<ConnectorsData> {
  return useSpineQuery(async (reader) => {
    const [accounts, syncStates] = await Promise.all([reader.listConnectorAccounts(), reader.listSyncStates()]);
    return { accounts, syncStates };
  }, []);
}

export interface HandoffsData {
  readonly pending: Handoff[];
  readonly devices: Device[];
}

export function useHandoffs(): QueryState<HandoffsData> {
  const { device } = useSpine();
  return useSpineQuery(
    async (reader) => {
      const [pending, devices] = await Promise.all([listPendingHandoffs(reader, device.deviceId), reader.listDevices()]);
      return { pending, devices };
    },
    [device.deviceId],
  );
}

export function useDevices(): QueryState<Device[]> {
  return useSpineQuery((reader) => reader.listDevices(), []);
}

export function useDocument(id: string | null): QueryState<Document | null> {
  return useSpineQuery((reader) => (id ? reader.getDocument(id) : Promise.resolve(null)), [id]);
}

/** Threads an entity belongs to (for "Open thread" on NOW items). */
export function useThreadIndex(): Map<string, Thread> {
  const threads = useThreads();
  return useMemo(() => new Map((threads.data ?? []).map((t) => [t.id, t])), [threads.data]);
}

export type { NeighborRow };
