import type { ConnectorAccountId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, Timestamped, UserScoped } from "./common.ts";

/** Provider identifiers. Adding a provider = adding a connector package, not touching the UI. */
export const PROVIDER_IDS = ["google", "microsoft", "plaid", "praxion", "mock"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** What a connector account can feed. One Google account feeds mail AND calendar. */
export const CONNECTOR_CAPABILITIES = ["mail", "calendar", "bank", "document"] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export const CONNECTOR_ACCOUNT_STATUSES = ["active", "paused", "needs_reauth", "error", "disconnected"] as const;
export type ConnectorAccountStatus = (typeof CONNECTOR_ACCOUNT_STATUSES)[number];

/** Where the credential for an account is kept. */
export const CREDENTIAL_LOCATIONS = ["server_vault", "device", "none"] as const;
export type CredentialLocation = (typeof CREDENTIAL_LOCATIONS)[number];

/**
 * One user → many connector accounts, possibly several per provider
 * (personal Gmail + Workspace Gmail). Never `user.hasGoogle = true`.
 */
export interface ConnectorAccount extends UserScoped, Timestamped {
  readonly id: ConnectorAccountId;
  readonly userId: UserId;
  readonly provider: ProviderId;
  /** Provider-side account identity (Google sub, Graph user id, Plaid item id). */
  readonly externalAccountId: string;
  /** Human label: "Personal Gmail", "Conung Microsoft". */
  readonly label: string;
  /** Provider-side address when there is one (informational). */
  readonly address: string | null;
  readonly capabilities: readonly ConnectorCapability[];
  readonly status: ConnectorAccountStatus;
  readonly credentialLocation: CredentialLocation;
  /** Opaque reference into the credential store. Never the secret itself. */
  readonly credentialRef: string | null;
  readonly lastError: string | null;
  readonly metadata: JsonObject;
}

export const SYNC_STATUSES = ["idle", "running", "error"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** Why the last run of a capability failed: a connector error code, or a credential the vault no longer has. */
export const SYNC_ERROR_CODES = ["unauthorized", "rate_limited", "checkpoint_invalid", "provider_unavailable", "invalid_response", "unsupported", "unknown", "credential_missing"] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

/**
 * The rows a from-scratch pass re-lists. A connector declares it on every
 * page of such a pass; when the pass is a full resync (the provider
 * invalidated the checkpoint, or the engine restarted after one it rejected)
 * the engine deletes, once the pass completes, the rows inside this scope the
 * pass did not touch — what the provider removed while the checkpoint was
 * dead. Nothing outside the scope is touched: a 30-day mail backfill says
 * nothing about older mail.
 */
export type ResyncScope =
  | { readonly kind: "all" }
  | { readonly kind: "mail"; readonly receivedSince: IsoDateTime }
  | { readonly kind: "calendar"; readonly calendarIds: readonly string[]; readonly from: IsoDateTime; readonly to: IsoDateTime };

/**
 * One listing unit of a full resync in progress: rows of the capability inside
 * `scope` with `updated_at` before `since` are gone at the provider once the
 * pass completes. A unit is a mail window, one calendar inside its window, or
 * a whole bank Item. A resumed page declares the very same scope and keeps the
 * unit's watermark; a listing that starts a unit over (a fresh window)
 * replaces it. Persisted with the sync state so a pass the run budget splits
 * across runs still reconciles.
 */
export interface ReconcileState {
  readonly since: IsoDateTime;
  readonly scope: ResyncScope;
}

/**
 * Independent sync state per (account, capability). A failed mail sync does
 * not block the calendar sync of the same account, nor any other account.
 */
export interface ConnectorSyncState extends UserScoped {
  readonly userId: UserId;
  readonly connectorAccountId: ConnectorAccountId;
  readonly capability: ConnectorCapability;
  readonly enabled: boolean;
  readonly status: SyncStatus;
  /** Provider cursor / checkpoint (Gmail historyId, Graph deltaLink, Plaid cursor). */
  readonly checkpoint: JsonObject | null;
  readonly lastAttemptAt: IsoDateTime | null;
  readonly lastSuccessAt: IsoDateTime | null;
  readonly lastError: string | null;
  /** The code of the failure `lastError` describes; null after a success. */
  readonly lastErrorCode: SyncErrorCode | null;
  /**
   * Whether that failure is expected to pass on its own (a rate limit, an
   * outage: the scheduler backs off from 10 minutes) or to repeat until
   * something changes (a declined scope, a body the normalizer cannot read:
   * held for the backoff cap at once). Null after a success, and on a state
   * written before the column existed (treated as retryable).
   */
  readonly lastErrorRetryable: boolean | null;
  readonly consecutiveFailures: number;
  /** A full resync in progress, one entry per listing unit (see ReconcileState); empty otherwise. */
  readonly reconcile: readonly ReconcileState[];
  readonly updatedAt: IsoDateTime;
}
