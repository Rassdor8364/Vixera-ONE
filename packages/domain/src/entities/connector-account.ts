import type { ConnectorAccountId, UserId } from "../ids.ts";
import type { IsoDateTime, JsonObject, Timestamped, UserScoped } from "./common.ts";

/** Provider identifiers. Adding a provider = adding a connector package, not touching the UI. */
export type ProviderId = "google" | "microsoft" | "plaid" | "praxion" | "mock";

/** What a connector account can feed. One Google account feeds mail AND calendar. */
export type ConnectorCapability = "mail" | "calendar" | "bank" | "document";

export type ConnectorAccountStatus = "active" | "paused" | "needs_reauth" | "error" | "disconnected";

/** Where the credential for an account is kept. */
export type CredentialLocation = "server_vault" | "device" | "none";

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

export type SyncStatus = "idle" | "running" | "error";

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
  readonly consecutiveFailures: number;
  readonly updatedAt: IsoDateTime;
}
