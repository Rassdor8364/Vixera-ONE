import {
  ConnectorError,
  type BankSyncBatch,
  type CalendarSyncBatch,
  type Checkpoint,
  type Connector,
  type ConnectorCapability,
  type ConnectorCredential,
  type DiscoveredAccount,
  type MailSyncBatch,
  type NormalizedDeletion,
  type NormalizedMailMessage,
  type NormalizedMoneyAccount,
  type NormalizedMoneyTransaction,
  type NormalizedTimeEvent,
  type ProviderId,
  type SyncContext,
  type SyncPage,
} from "@vixera/domain";
import { MOCK_NOW, MOCK_SELF_ADDRESS } from "./fixtures.ts";

/**
 * MockConnector: provider "mock", capabilities mail + calendar + bank, serving
 * a deterministic slice of the brief's world:
 *
 *   - Eric Lindqvist's invoice mail (unread, PDF attachment) from
 *     eric@lindqvist.example, in the "Brand" thread
 *   - Priya Natarajan's kickoff agenda mail (read)
 *   - the Northwind kickoff calendar event tomorrow with priya@northwind.example
 *   - a checking account with a +12,400 USD Northwind payout and a
 *     -2,400 USD Lindqvist Studio payment
 *
 * Checkpoints are `{ version, page }` per capability. A second run with the
 * checkpoint the first run produced returns one empty page unless the fixtures
 * changed since (`setFixtures`, `changeEvent`, `addMessage`, ...), which bumps
 * that capability's version so the whole capability is served again — exactly
 * what the linker's dedupe keys must absorb.
 *
 * Failure modes for tests: `failOn(capability, error)` throws that error on
 * the next sync of the capability until `clearFailures()`;
 * `invalidateNextCheckpoint(capability)` throws `checkpoint_invalid` once
 * when called with a non-null checkpoint. `pageSize` splits items into
 * several pages so checkpoint-per-page behaviour can be observed.
 */
export interface MockFixtures {
  mail: { messages: NormalizedMailMessage[]; deleted: NormalizedDeletion[] };
  calendar: { events: NormalizedTimeEvent[]; deleted: NormalizedDeletion[] };
  bank: { accounts: NormalizedMoneyAccount[]; transactions: NormalizedMoneyTransaction[]; deleted: NormalizedDeletion[] };
}

export interface MockConnectorOptions {
  readonly fixtures?: MockFixtures;
  /** Items per page; default serves each capability in one page. */
  readonly pageSize?: number;
  readonly externalAccountId?: string;
  readonly address?: string;
}

export interface MockCall {
  readonly capability: ConnectorCapability;
  readonly connectorAccountId: string;
  readonly checkpoint: Checkpoint | null;
  readonly accessToken: string;
}

type SyncCapability = "mail" | "calendar" | "bank";

export const ERIC_EMAIL = "eric@lindqvist.example";
export const PRIYA_EMAIL = "priya@northwind.example";
export const ERIC_INVOICE_MESSAGE_ID = "msg-eric-invoice-0231";
export const PRIYA_AGENDA_MESSAGE_ID = "msg-priya-agenda";
export const ERIC_INVOICE_ATTACHMENT_ID = "att-0231";
export const NORTHWIND_KICKOFF_EVENT_ID = "evt-northwind-kickoff";
export const MOCK_CALENDAR_ID = "primary";
export const MOCK_CHECKING_ACCOUNT_ID = "acct-checking-0001";
export const NORTHWIND_PAYOUT_TX_ID = "txn-northwind-payout";
export const LINDQVIST_PAYMENT_TX_ID = "txn-lindqvist-studio";

export function briefWorldFixtures(): MockFixtures {
  const iso = (offsetHours: number) => new Date(MOCK_NOW.getTime() + offsetHours * 3600_000).toISOString();
  return {
    mail: {
      messages: [
        {
          externalId: ERIC_INVOICE_MESSAGE_ID,
          externalThreadId: "thr-brand",
          subject: "Invoice #0231 — Brand identity work",
          snippet: "Hi, attached is invoice #0231 for the brand identity work. Due tomorrow.",
          bodyText: "Hi,\n\nAttached is invoice #0231 for the brand identity work. Due tomorrow.\n\nEric",
          from: { email: ERIC_EMAIL, name: "Eric Lindqvist" },
          to: [{ email: MOCK_SELF_ADDRESS, name: null }],
          cc: [],
          sentAt: iso(-17),
          receivedAt: iso(-17),
          isUnread: true,
          attachments: [{ attachmentId: ERIC_INVOICE_ATTACHMENT_ID, filename: "Lindqvist-Invoice-0231.pdf", mimeType: "application/pdf", sizeBytes: 184_233 }],
          labels: ["INBOX"],
        },
        {
          externalId: PRIYA_AGENDA_MESSAGE_ID,
          externalThreadId: "thr-northwind",
          subject: "Northwind kickoff agenda",
          snippet: "Agenda for Thursday: scope, timeline, first deliverables.",
          bodyText: "Agenda for Thursday: scope, timeline, first deliverables.\n\nPriya",
          from: { email: PRIYA_EMAIL, name: "Priya Natarajan" },
          to: [{ email: MOCK_SELF_ADDRESS, name: null }],
          cc: [],
          sentAt: iso(-47),
          receivedAt: iso(-47),
          isUnread: false,
          attachments: [],
          labels: ["INBOX"],
        },
      ],
      deleted: [],
    },
    calendar: {
      events: [
        {
          externalCalendarId: MOCK_CALENDAR_ID,
          externalId: NORTHWIND_KICKOFF_EVENT_ID,
          title: "Northwind kickoff",
          description: "Kickoff with Northwind Traders.",
          startsAt: iso(29),
          endsAt: iso(30),
          allDay: false,
          timezone: "UTC",
          location: "Northwind HQ, Room 4",
          status: "confirmed",
          organizer: { email: MOCK_SELF_ADDRESS, name: null, response: "accepted", isOrganizer: true, isSelf: true },
          participants: [
            { email: MOCK_SELF_ADDRESS, name: null, response: "accepted", isOrganizer: true, isSelf: true },
            { email: PRIYA_EMAIL, name: "Priya Natarajan", response: "accepted", isOrganizer: false, isSelf: false },
          ],
          externalLink: null,
        },
      ],
      deleted: [],
    },
    bank: {
      accounts: [
        {
          externalId: MOCK_CHECKING_ACCOUNT_ID,
          name: "Operating checking",
          officialName: "Business Checking",
          type: "checking",
          currency: "USD",
          balanceCurrent: "18342.17",
          balanceAvailable: "18342.17",
          balanceAsOf: MOCK_NOW.toISOString(),
          mask: "0001",
        },
      ],
      transactions: [
        {
          externalId: NORTHWIND_PAYOUT_TX_ID,
          accountExternalId: MOCK_CHECKING_ACCOUNT_ID,
          amount: "12400",
          currency: "USD",
          description: "NORTHWIND TRADERS PAYOUT",
          merchantName: "Northwind Traders",
          postedOn: "2026-09-09",
          authorizedAt: iso(-20),
          pending: false,
          category: ["income"],
        },
        {
          externalId: LINDQVIST_PAYMENT_TX_ID,
          accountExternalId: MOCK_CHECKING_ACCOUNT_ID,
          amount: "-2400",
          currency: "USD",
          description: "LINDQVIST STUDIO INV 0198",
          merchantName: "Lindqvist Studio",
          postedOn: "2026-09-08",
          authorizedAt: iso(-44),
          pending: false,
          category: ["services"],
        },
      ],
      deleted: [],
    },
  };
}

export class MockConnector implements Connector {
  readonly provider: ProviderId = "mock";
  readonly capabilities: readonly ConnectorCapability[] = ["mail", "calendar", "bank"];
  readonly calls: MockCall[] = [];
  refreshCount = 0;

  private fixtures: MockFixtures;
  private readonly pageSize: number;
  private readonly externalAccountId: string;
  private readonly address: string;
  private readonly versions: Record<SyncCapability, number> = { mail: 1, calendar: 1, bank: 1 };
  private readonly failures = new Map<ConnectorCapability, Error>();
  private readonly invalidateOnce = new Set<ConnectorCapability>();

  constructor(options: MockConnectorOptions = {}) {
    this.fixtures = options.fixtures ?? briefWorldFixtures();
    this.pageSize = options.pageSize ?? Number.POSITIVE_INFINITY;
    this.externalAccountId = options.externalAccountId ?? "mock-user-1";
    this.address = options.address ?? MOCK_SELF_ADDRESS;
  }

  // --- test controls -----------------------------------------------------
  failOn(capability: ConnectorCapability, error: Error = new ConnectorError("provider_unavailable", `mock ${capability} is down`)): this {
    this.failures.set(capability, error);
    return this;
  }

  clearFailures(): this {
    this.failures.clear();
    return this;
  }

  invalidateNextCheckpoint(capability: SyncCapability): this {
    this.invalidateOnce.add(capability);
    return this;
  }

  version(capability: SyncCapability): number {
    return this.versions[capability];
  }

  getFixtures(): MockFixtures {
    return this.fixtures;
  }

  /** Replaces fixtures for the given capabilities and bumps their versions (a "change at the provider"). */
  setFixtures(patch: Partial<MockFixtures>): this {
    for (const cap of Object.keys(patch) as SyncCapability[]) {
      const next = patch[cap];
      if (!next) continue;
      this.fixtures = { ...this.fixtures, [cap]: next };
      this.versions[cap]++;
    }
    return this;
  }

  changeEvent(externalId: string, patch: Partial<NormalizedTimeEvent>): this {
    const events = this.fixtures.calendar.events.map((e) => (e.externalId === externalId ? { ...e, ...patch } : e));
    return this.setFixtures({ calendar: { ...this.fixtures.calendar, events } });
  }

  addMessage(message: NormalizedMailMessage): this {
    return this.setFixtures({ mail: { ...this.fixtures.mail, messages: [...this.fixtures.mail.messages, message] } });
  }

  deleteMessage(externalId: string): this {
    return this.setFixtures({
      mail: { messages: this.fixtures.mail.messages.filter((m) => m.externalId !== externalId), deleted: [...this.fixtures.mail.deleted, { externalId }] },
    });
  }

  addTransaction(tx: NormalizedMoneyTransaction): this {
    return this.setFixtures({ bank: { ...this.fixtures.bank, transactions: [...this.fixtures.bank.transactions, tx] } });
  }

  // --- Connector -----------------------------------------------------------
  async discoverAccount(): Promise<DiscoveredAccount> {
    return { externalAccountId: this.externalAccountId, label: "Mock account", address: this.address, capabilities: this.capabilities };
  }

  async refreshCredential(ctx: Omit<SyncContext, "account">): Promise<ConnectorCredential> {
    this.refreshCount++;
    const scopes = ctx.credential.kind === "oauth2" ? ctx.credential.scopes : ["mock.read"];
    const refreshToken = ctx.credential.kind === "oauth2" ? ctx.credential.refreshToken : null;
    return {
      kind: "oauth2",
      accessToken: `fake-refreshed-token-${this.refreshCount}`,
      refreshToken,
      expiresAt: new Date(ctx.now().getTime() + 3600_000).toISOString(),
      scopes,
    };
  }

  syncMail(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<MailSyncBatch>> {
    const { messages, deleted } = this.fixtures.mail;
    return this.pages("mail", ctx, checkpoint, messages, (items, last) => ({ messages: items, deleted: last ? deleted : [] }));
  }

  syncCalendar(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<CalendarSyncBatch>> {
    const { events, deleted } = this.fixtures.calendar;
    return this.pages("calendar", ctx, checkpoint, events, (items, last) => ({ events: items, deleted: last ? deleted : [] }));
  }

  syncBank(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<BankSyncBatch>> {
    const { accounts, transactions, deleted } = this.fixtures.bank;
    return this.pages("bank", ctx, checkpoint, transactions, (items, last, first) => ({
      accounts: first ? accounts : [],
      transactions: items,
      deleted: last ? deleted : [],
    }));
  }

  private async *pages<TItem, TBatch>(
    capability: SyncCapability,
    ctx: SyncContext,
    checkpoint: Checkpoint | null,
    items: readonly TItem[],
    toBatch: (items: TItem[], last: boolean, first: boolean) => TBatch,
  ): AsyncGenerator<SyncPage<TBatch>> {
    this.calls.push({ capability, connectorAccountId: ctx.account.id, checkpoint, accessToken: accessTokenOf(ctx.credential) });
    const failure = this.failures.get(capability);
    if (failure) throw failure;
    if (checkpoint && this.invalidateOnce.has(capability)) {
      this.invalidateOnce.delete(capability);
      throw new ConnectorError("checkpoint_invalid", `mock ${capability} checkpoint expired`);
    }

    const version = this.versions[capability];
    const cpVersion = typeof checkpoint?.["version"] === "number" ? (checkpoint["version"] as number) : null;
    const cpPage = typeof checkpoint?.["page"] === "number" ? (checkpoint["page"] as number) : 0;
    const pageCount = Math.max(1, Math.ceil(items.length / this.pageSize));

    if (cpVersion === version && cpPage >= pageCount) {
      yield { batch: toBatch([], false, false), checkpoint: { version, page: pageCount }, done: true };
      return;
    }
    const start = cpVersion === version ? cpPage : 0;
    for (let p = start; p < pageCount; p++) {
      const slice = Number.isFinite(this.pageSize) ? items.slice(p * this.pageSize, (p + 1) * this.pageSize) : [...items];
      const last = p === pageCount - 1;
      yield { batch: toBatch(slice, last, p === 0), checkpoint: { version, page: p + 1 }, done: last };
    }
  }
}

function accessTokenOf(credential: ConnectorCredential): string {
  return credential.kind === "api_key" ? credential.apiKey : credential.accessToken;
}
