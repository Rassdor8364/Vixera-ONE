import type { JsonObject } from "../entities/common.ts";
import type { ConnectorAccount, ConnectorCapability, ProviderId } from "../entities/connector-account.ts";
import type { ConnectorCredential } from "./credentials.ts";
import type { BankSyncBatch, CalendarSyncBatch, MailSyncBatch } from "./normalized.ts";

/** Opaque provider checkpoint (Gmail historyId, Graph deltaLink, Plaid cursor). */
export type Checkpoint = JsonObject;

export interface SyncContext {
  readonly account: ConnectorAccount;
  readonly credential: ConnectorCredential;
  /** Wall clock, injectable for tests. */
  readonly now: () => Date;
  /** Provider-neutral fetch, injectable for tests and for the Tauri HTTP plugin. */
  readonly fetch: typeof fetch;
  /** Called by the connector when it refreshed the credential; the engine persists it. */
  readonly onCredentialRefreshed?: (credential: ConnectorCredential) => Promise<void>;
  readonly log?: (message: string, data?: JsonObject) => void;
}

/**
 * One page of a sync. `checkpoint` is what to persist after this page is
 * durably stored; `done` tells the engine whether to ask for another page.
 * `fullResync` means the provider invalidated the previous checkpoint and the
 * engine must treat the batch as authoritative from scratch.
 */
export interface SyncPage<TBatch> {
  readonly batch: TBatch;
  readonly checkpoint: Checkpoint | null;
  readonly done: boolean;
  readonly fullResync?: boolean;
}

export interface MailSyncSource {
  syncMail(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<MailSyncBatch>>;
}

export interface CalendarSyncSource {
  syncCalendar(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<CalendarSyncBatch>>;
}

export interface BankSyncSource {
  syncBank(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<BankSyncBatch>>;
}

/**
 * Provider account identity discovered at link time. The engine turns this
 * into a `ConnectorAccount` row.
 */
export interface DiscoveredAccount {
  readonly externalAccountId: string;
  readonly label: string;
  readonly address: string | null;
  readonly capabilities: readonly ConnectorCapability[];
  readonly metadata?: JsonObject;
}

/**
 * Every external service lives behind this interface. A connector knows its
 * provider's specifics; nothing else does. A connector instance is stateless
 * with respect to accounts: the same instance serves every account of its
 * provider (multi-account by construction).
 */
export interface Connector extends Partial<MailSyncSource>, Partial<CalendarSyncSource>, Partial<BankSyncSource> {
  readonly provider: ProviderId;
  readonly capabilities: readonly ConnectorCapability[];
  /** Resolve who this credential belongs to (used when linking a new account). */
  discoverAccount(ctx: Omit<SyncContext, "account">): Promise<DiscoveredAccount>;
  /** Refresh an expiring credential if the provider supports it. */
  refreshCredential?(ctx: Omit<SyncContext, "account">): Promise<ConnectorCredential>;
}

export function supports<K extends ConnectorCapability>(
  connector: Connector,
  capability: K,
): connector is Connector &
  (K extends "mail" ? MailSyncSource : K extends "calendar" ? CalendarSyncSource : K extends "bank" ? BankSyncSource : unknown) {
  return connector.capabilities.includes(capability);
}

export type ConnectorErrorCode =
  | "unauthorized"
  | "rate_limited"
  | "checkpoint_invalid"
  | "provider_unavailable"
  | "invalid_response"
  | "unsupported"
  | "unknown";

export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly retryable: boolean = code === "rate_limited" || code === "provider_unavailable",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ConnectorError";
  }
}
