import {
  type IsoDateTime,
  type ResyncScope,
  type ReconcileState,
  ConnectorError,
  isExpired,
  type BankSyncBatch,
  type CalendarSyncBatch,
  type Checkpoint,
  type Connector,
  type ConnectorAccount,
  type ConnectorCapability,
  type ConnectorCredential,
  type ConnectorErrorCode,
  type ConnectorRegistry,
  type ConnectorSyncState,
  type CredentialStore,
  type JsonObject,
  type MailSyncBatch,
  type SyncContext,
  type SyncPage,
} from "@vixera/domain";
import type { SpineStore } from "../store/spine-store.ts";
import { addCounts, emptyCounts, type ContextLinker, type LinkCounts } from "../linker/context-linker.ts";

/**
 * SyncEngine: runs every enabled (account, capability) pair through its
 * connector and the ContextLinker, with failure isolation and restartable
 * checkpoints. Runtime neutral: it only needs a SpineStore, a
 * ConnectorRegistry, a CredentialStore and the linker, so the same class runs
 * in the `connector-sync` Edge Function today and could run on a device later.
 *
 * Per (account, capability):
 *   1. skip accounts that are disconnected / paused and states with enabled=false
 *   2. mark the state running (+ lastAttemptAt)
 *   3. load the credential by `account.credentialRef`; missing ⇒ account
 *      needs_reauth, state error, continue with the next capability
 *   4. refresh an expired credential through `connector.refreshCredential`
 *      and persist it with `credentials.put(ref, …)`; connectors that refresh
 *      on their own report through `ctx.onCredentialRefreshed`
 *   5. for EACH page: apply the batch through the linker FIRST, THEN persist
 *      the page checkpoint — a crash between the two re-applies an idempotent
 *      page, it never loses one. A checkpoint counts as progress only when it
 *      differs from the one the pass started from: real connectors echo the
 *      previous cursor on intermediate pages.
 *   6. ConnectorError unauthorized ⇒ account needs_reauth; checkpoint_invalid
 *      ⇒ clear the checkpoint and retry once from scratch; any error ⇒ state
 *      error + lastError (credentials redacted) + consecutiveFailures+1, and
 *      the run CONTINUES with the next capability / account
 *   7. success ⇒ state idle, lastSuccessAt, consecutiveFailures 0
 *
 * Before 2: a capability in `error` is held back for an exponential backoff
 * (10 min doubling to 6 h) derived from consecutiveFailures, and one whose
 * state says `running` within the last 15 min is left alone — unless the run
 * is `force`d (a user's Sync now).
 *
 * `runAll()` never throws because one connector failed; the SyncReport says
 * what happened where.
 */
export interface SyncEngineOptions {
  readonly store: SpineStore;
  readonly registry: ConnectorRegistry;
  readonly credentials: CredentialStore;
  readonly linker: ContextLinker;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (message: string, data?: JsonObject) => void;
}

export type SyncOutcomeStatus = "ok" | "error" | "skipped";

export interface CapabilityRunOptions {
  /** Ignore backoff and a recent `running` state: a user asked for this run. */
  readonly force?: boolean;
}

export interface SyncOutcome {
  readonly connectorAccountId: string;
  readonly provider: ConnectorAccount["provider"];
  readonly label: string;
  readonly capability: ConnectorCapability;
  readonly status: SyncOutcomeStatus;
  /** Why it was skipped, or the (redacted) error message. */
  readonly reason: string | null;
  readonly errorCode: ConnectorErrorCode | "credential_missing" | "unknown" | null;
  readonly pages: number;
  readonly counts: LinkCounts;
  readonly checkpointAdvanced: boolean;
  /**
   * The deadline passed before a resume point existed, so the pass stopped
   * without a checkpoint: the pages applied are kept (idempotent), but the next
   * run starts this pass over. Persistent interruption means the connector
   * must emit per-page checkpoints, not that the engine should run longer.
   */
  readonly interrupted: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface SyncReport {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly accounts: number;
  readonly outcomes: readonly SyncOutcome[];
  readonly ok: number;
  readonly errors: number;
  readonly skipped: number;
  readonly interrupted: number;
  readonly counts: LinkCounts;
}

const MAX_PAGES = 10_000;
export const BACKOFF_BASE_MS = 10 * 60_000;
export const BACKOFF_MAX_MS = 6 * 3600_000;
export const RUNNING_STALE_MS = 15 * 60_000;

/** 10 min after the first failure, doubling, capped at 6 h. 0 for no failures. */
export function backoffMs(consecutiveFailures: number): number {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 20));
}

/** Why a capability should not run right now, or null. Pure; exported for tests. */
export function holdReason(state: ConnectorSyncState | null, now: number): string | null {
  if (!state?.lastAttemptAt) return null;
  const attempted = Date.parse(state.lastAttemptAt);
  if (Number.isNaN(attempted)) return null;
  if (state.status === "running" && now - attempted < RUNNING_STALE_MS) {
    return `already running since ${state.lastAttemptAt}`;
  }
  if (state.status === "error" && state.consecutiveFailures > 0) {
    const until = attempted + backoffMs(state.consecutiveFailures);
    if (now < until) return `backing off after ${state.consecutiveFailures} consecutive failure(s) until ${new Date(until).toISOString()}`;
  }
  return null;
}

/** Key-order-independent, so `{a,b}` and `{b,a}` compare equal. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export class SyncEngine {
  private readonly store: SpineStore;
  private readonly registry: ConnectorRegistry;
  private readonly credentials: CredentialStore;
  private readonly linker: ContextLinker;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (message: string, data?: JsonObject) => void;

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.credentials = options.credentials;
    this.linker = options.linker;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  async runAll(options: CapabilityRunOptions = {}): Promise<SyncReport> {
    const started = this.now();
    const outcomes: SyncOutcome[] = [];
    let accounts: ConnectorAccount[] = [];
    try {
      accounts = await this.store.listConnectorAccounts();
    } catch (err) {
      this.log("sync: could not list connector accounts", { error: errorMessage(err) });
    }
    for (const account of accounts) {
      try {
        outcomes.push(...(await this.runAccount(account, options)));
      } catch (err) {
        // runAccount isolates failures itself; this is the last line of defence.
        this.log("sync: account run failed unexpectedly", { connectorAccountId: account.id, error: errorMessage(err) });
        outcomes.push(this.outcome(account, account.capabilities[0] ?? "mail", "error", started, { reason: errorMessage(err), errorCode: "unknown" }));
      }
    }
    return this.report(started, accounts.length, outcomes);
  }

  /** Runs every capability of one account. Accepts an id or a loaded row. */
  async runAccount(accountOrId: string | ConnectorAccount, options: CapabilityRunOptions = {}): Promise<SyncOutcome[]> {
    const account = typeof accountOrId === "string" ? await this.store.getConnectorAccount(accountOrId) : accountOrId;
    if (!account) throw new Error(`connector account ${String(accountOrId)} not found`);
    const outcomes: SyncOutcome[] = [];
    if (account.status === "disconnected" || account.status === "paused") {
      const started = this.now();
      for (const capability of account.capabilities) {
        outcomes.push(this.outcome(account, capability, "skipped", started, { reason: `account ${account.status}` }));
      }
      return outcomes;
    }
    // Re-read the account between capabilities: a needs_reauth from mail must stop calendar.
    let current: ConnectorAccount = account;
    for (const capability of account.capabilities) {
      if (current.status === "needs_reauth") {
        outcomes.push(this.outcome(current, capability, "skipped", this.now(), { reason: "account needs_reauth" }));
        continue;
      }
      outcomes.push(await this.runCapability(current, capability, undefined, options));
      current = (await this.store.getConnectorAccount(account.id)) ?? current;
    }
    return outcomes;
  }

  /**
   * `deadlineAt` bounds the run in wall clock. After each page, if the deadline
   * has passed: when that page moved the checkpoint the pass stops there, at a
   * durable resume point; when it did not (the connector echoed the cursor it
   * started with, or yields none until the end) the pass stops anyway and is
   * reported `interrupted` — bounded, so the runtime never hard-kills a run
   * and leaves the state `running` forever, at the price of restarting that
   * pass next time. The cure for a pass that is always interrupted is a
   * connector that emits per-page checkpoints (Gmail does; see the connector
   * docs for the others), not a longer budget.
   */
  async runCapability(account: ConnectorAccount, capability: ConnectorCapability, deadlineAt?: number, options: CapabilityRunOptions = {}): Promise<SyncOutcome> {
    const started = this.now();
    const counts = emptyCounts();
    let pages = 0;
    let checkpointAdvanced = false;

    const state = await this.store.getSyncState(account.id, capability);
    if (state && !state.enabled) return this.outcome(account, capability, "skipped", started, { reason: "sync disabled" });
    if (!account.capabilities.includes(capability)) {
      return this.outcome(account, capability, "skipped", started, { reason: "capability not enabled on account" });
    }
    // Documents (Praxion) are a local connector, never paged by this engine: skip, do not record a failure every cycle.
    if (capability === "document") {
      return this.outcome(account, capability, "skipped", started, { reason: "document capability is not synced by the engine" });
    }
    if (!options.force) {
      const hold = holdReason(state, started.getTime());
      if (hold) return this.outcome(account, capability, "skipped", started, { reason: hold });
    }

    let connector: Connector;
    try {
      connector = this.registry.get(account.provider);
    } catch (err) {
      return this.fail(account, capability, state, started, err, counts, pages, checkpointAdvanced);
    }
    const source = pageSource(connector, capability);
    if (!source) {
      return this.fail(account, capability, state, started, new ConnectorError("unsupported", `${account.provider} does not support ${capability}`), counts, pages, checkpointAdvanced);
    }

    // The row's own updated_at (the store's clock) is the watermark a full
    // resync reconciles against: every row this run touches is stamped later.
    const running = await this.store.upsertSyncState(account.id, capability, { status: "running", lastAttemptAt: started.toISOString() });

    // --- credential -------------------------------------------------------
    const ref = account.credentialRef;
    let credential: ConnectorCredential | null = null;
    if (ref) {
      try {
        credential = await this.credentials.get(ref);
      } catch (err) {
        return this.fail(account, capability, state, started, err, counts, pages, checkpointAdvanced);
      }
    }
    if (!credential) {
      await this.markNeedsReauth(account, "credential missing");
      return this.fail(account, capability, state, started, new MissingCredentialError(), counts, pages, checkpointAdvanced);
    }

    const ctx: SyncContext = {
      account,
      credential,
      now: this.now,
      fetch: this.fetchImpl,
      onCredentialRefreshed: async (next) => {
        await this.credentials.put(ref as string, next);
        this.log("sync: credential refreshed by connector", { connectorAccountId: account.id });
      },
      log: this.log,
    };

    if (isExpired(credential, this.now()) && connector.refreshCredential) {
      try {
        const refreshed = await connector.refreshCredential(ctx);
        await this.credentials.put(ref as string, refreshed);
        credential = refreshed;
        this.log("sync: credential refreshed", { connectorAccountId: account.id, capability });
      } catch (err) {
        if (err instanceof ConnectorError && err.code === "unauthorized") await this.markNeedsReauth(account, err.message, err);
        return this.fail(account, capability, state, started, err, counts, pages, checkpointAdvanced, credential);
      }
    }
    const liveCtx: SyncContext = { ...ctx, credential };

    // --- pages ------------------------------------------------------------
    let checkpoint: Checkpoint | null = state?.checkpoint ?? null;
    let retriedCheckpoint = false;
    let outOfTime = false;
    let interrupted = false;
    // A full resync in progress, one unit per listing, possibly begun in an earlier run (ADR-017).
    let reconcile: readonly ReconcileState[] = state?.reconcile ?? [];
    for (;;) {
      const startedFrom = stableStringify(checkpoint);
      try {
        for await (const page of source(liveCtx, checkpoint)) {
          if (++pages > MAX_PAGES) throw new ConnectorError("invalid_response", `more than ${MAX_PAGES} pages`);
          if (page.fullResync) this.log("sync: full resync page", { connectorAccountId: account.id, capability });
          // A from-scratch pass that is a real resync — the provider dropped the
          // checkpoint, or we did after it was rejected — and says what it covers:
          // remember when it began and its scope, so rows it never mentions can go.
          if ((page.fullResync === true || retriedCheckpoint) && page.resyncScope) {
            const next = declareResync(reconcile, page.resyncScope, running.updatedAt);
            if (stableStringify(next) !== stableStringify(reconcile)) {
              reconcile = next;
              await this.store.upsertSyncState(account.id, capability, { reconcile: next });
            }
          }
          // Apply FIRST, then move the checkpoint: a crash in between replays an idempotent page.
          addCounts(counts, await this.applyPage(account, capability, page));
          // Progress is a checkpoint that differs from the one this pass started
          // from. Persisting an echoed cursor and calling it a resume point made
          // a capability restart the same page every run, forever, reporting ok.
          const advanced = page.checkpoint !== null && page.checkpoint !== undefined && stableStringify(page.checkpoint) !== startedFrom;
          if (advanced) {
            checkpoint = page.checkpoint as Checkpoint;
            await this.store.upsertSyncState(account.id, capability, { checkpoint });
            checkpointAdvanced = true;
          }
          if (page.done) {
            if (reconcile.length > 0) {
              // The pass is complete: everything the provider still has inside each
              // unit was touched after that unit's watermark; the rest is gone there.
              let removed = 0;
              for (const unit of reconcile) removed += await this.store.deleteUntouched(account.id, capability, unit);
              counts.deleted += removed;
              this.log("sync: full resync reconciled", { connectorAccountId: account.id, capability, removed, units: reconcile.length, scope: reconcile[0]!.scope.kind });
              reconcile = [];
              await this.store.upsertSyncState(account.id, capability, { reconcile: [] });
            }
            break;
          }
          if (deadlineAt !== undefined && this.now().getTime() >= deadlineAt) {
            if (advanced) {
              outOfTime = true;
              this.log("sync: budget reached, stopping at a checkpoint", { connectorAccountId: account.id, capability, pages });
            } else {
              interrupted = true;
              this.log("sync: budget reached before a resume point; this pass restarts next run", { connectorAccountId: account.id, capability, pages });
            }
            break;
          }
        }
        break;
      } catch (err) {
        if (err instanceof ConnectorError && err.code === "checkpoint_invalid" && !retriedCheckpoint) {
          retriedCheckpoint = true;
          checkpoint = null;
          await this.store.upsertSyncState(account.id, capability, { checkpoint: null });
          this.log("sync: checkpoint invalid, retrying from scratch", { connectorAccountId: account.id, capability });
          continue;
        }
        if (err instanceof ConnectorError && err.code === "unauthorized") await this.markNeedsReauth(account, err.message, err);
        return this.fail(account, capability, state, started, err, counts, pages, checkpointAdvanced, credential);
      }
    }

    await this.store.upsertSyncState(account.id, capability, {
      status: "idle",
      // An interrupted pass is not a success: lastSuccessAt stays where it was.
      ...(interrupted ? {} : { lastSuccessAt: this.now().toISOString() }),
      lastError: null,
      consecutiveFailures: 0,
    });
    if (account.status === "error") await this.store.updateConnectorAccount(account.id, { status: "active", lastError: null });
    return this.outcome(account, capability, "ok", started, {
      pages,
      counts,
      checkpointAdvanced,
      interrupted,
      ...(outOfTime
        ? { reason: "stopped at a checkpoint: time budget exhausted" }
        : interrupted
          ? { reason: "interrupted before a resume point: time budget exhausted and the connector emitted no per-page checkpoint" }
          : {}),
    });
  }

  // -------------------------------------------------------------------------
  private async applyPage(account: ConnectorAccount, capability: ConnectorCapability, page: SyncPage<unknown>): Promise<LinkCounts> {
    switch (capability) {
      case "mail":
        return this.linker.applyMailBatch(account, page.batch as MailSyncBatch);
      case "calendar":
        return this.linker.applyCalendarBatch(account, page.batch as CalendarSyncBatch);
      case "bank":
        return this.linker.applyBankBatch(account, page.batch as BankSyncBatch);
      case "document":
        throw new ConnectorError("unsupported", "document sync is not part of the connector sync engine");
    }
  }

  /**
   * Parks the account. The provider's own code (when the error carried one)
   * goes into metadata so connector-link can tell a repairable Item from one
   * the provider no longer knows; a successful re-link clears it.
   */
  private async markNeedsReauth(account: ConnectorAccount, reason: string, err: unknown = null): Promise<void> {
    const providerCode = err instanceof ConnectorError ? err.providerCode : null;
    const metadata: JsonObject = { ...account.metadata, reauthCode: providerCode, reauthAt: this.now().toISOString() };
    await this.store.updateConnectorAccount(account.id, { status: "needs_reauth", lastError: reason.slice(0, 500), metadata });
  }

  private async fail(
    account: ConnectorAccount,
    capability: ConnectorCapability,
    state: ConnectorSyncState | null,
    started: Date,
    err: unknown,
    counts: LinkCounts,
    pages: number,
    checkpointAdvanced: boolean,
    credential?: ConnectorCredential | null,
  ): Promise<SyncOutcome> {
    const message = redactCredential(errorMessage(err), credential ?? null).slice(0, 1000);
    const errorCode: SyncOutcome["errorCode"] = err instanceof ConnectorError ? err.code : err instanceof MissingCredentialError ? "credential_missing" : "unknown";
    try {
      await this.store.upsertSyncState(account.id, capability, {
        status: "error",
        lastError: message,
        consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
      });
    } catch (stateErr) {
      this.log("sync: could not persist error state", { connectorAccountId: account.id, capability, error: errorMessage(stateErr) });
    }
    this.log("sync: capability failed", { connectorAccountId: account.id, capability, errorCode, error: message });
    return this.outcome(account, capability, "error", started, { reason: message, errorCode, pages, counts, checkpointAdvanced });
  }

  private outcome(
    account: ConnectorAccount,
    capability: ConnectorCapability,
    status: SyncOutcomeStatus,
    started: Date,
    extra: Partial<Pick<SyncOutcome, "reason" | "errorCode" | "pages" | "counts" | "checkpointAdvanced" | "interrupted">> = {},
  ): SyncOutcome {
    const finished = this.now();
    return {
      connectorAccountId: account.id,
      provider: account.provider,
      label: account.label,
      capability,
      status,
      reason: extra.reason ?? null,
      errorCode: extra.errorCode ?? null,
      pages: extra.pages ?? 0,
      counts: extra.counts ?? emptyCounts(),
      checkpointAdvanced: extra.checkpointAdvanced ?? false,
      interrupted: extra.interrupted ?? false,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
    };
  }

  private report(started: Date, accounts: number, outcomes: SyncOutcome[]): SyncReport {
    const finished = this.now();
    const counts = emptyCounts();
    for (const o of outcomes) addCounts(counts, o.counts);
    return {
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: Math.max(0, finished.getTime() - started.getTime()),
      accounts,
      outcomes,
      ok: outcomes.filter((o) => o.status === "ok").length,
      errors: outcomes.filter((o) => o.status === "error").length,
      skipped: outcomes.filter((o) => o.status === "skipped").length,
      interrupted: outcomes.filter((o) => o.interrupted).length,
      counts,
    };
  }
}

export class MissingCredentialError extends Error {
  constructor() {
    super("credential missing for connector account");
    this.name = "MissingCredentialError";
  }
}

type PageSource = (ctx: SyncContext, checkpoint: Checkpoint | null) => AsyncIterable<SyncPage<unknown>>;

function pageSource(connector: Connector, capability: ConnectorCapability): PageSource | null {
  switch (capability) {
    case "mail":
      return connector.syncMail ? (ctx, cp) => connector.syncMail!(ctx, cp) : null;
    case "calendar":
      return connector.syncCalendar ? (ctx, cp) => connector.syncCalendar!(ctx, cp) : null;
    case "bank":
      return connector.syncBank ? (ctx, cp) => connector.syncBank!(ctx, cp) : null;
    case "document":
      return null;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : JSON.stringify(err) ?? "unknown error";
}

/** Strips any secret material of the credential out of a message before it is persisted. */
export function redactCredential(message: string, credential: ConnectorCredential | null): string {
  if (!credential) return message;
  const secrets: string[] = [];
  if (credential.kind === "api_key") secrets.push(credential.apiKey);
  else {
    secrets.push(credential.accessToken);
    if (credential.kind === "oauth2" && credential.refreshToken) secrets.push(credential.refreshToken);
  }
  let out = message;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out;
}

/**
 * A page of a from-scratch pass declared what it covers. Split it into listing
 * units — a mail window, each calendar inside its window, a whole Item — and
 * fold them into the pending state. A unit already pending with the very same
 * scope is the same listing continuing (a resumed page): it keeps the
 * watermark it started with, so rows the earlier run listed count as touched.
 * Any other declaration is a listing starting over (a fresh window after a
 * rejected page token or link): it replaces the unit with a watermark at
 * `since`, this run's start — never the union of the two windows, because the
 * earlier, partial listing cannot vouch for rows the new window does not cover.
 */
export function declareResync(pending: readonly ReconcileState[], scope: ResyncScope, since: IsoDateTime): ReconcileState[] {
  const units: ResyncScope[] = scope.kind === "calendar" ? scope.calendarIds.map((id) => ({ kind: "calendar", calendarIds: [id], from: scope.from, to: scope.to })) : [scope];
  const out = [...pending];
  for (const unit of units) {
    const key = unitKey(unit);
    const at = out.findIndex((p) => unitKey(p.scope) === key);
    if (at >= 0 && stableStringify(out[at]!.scope) === stableStringify(unit)) continue;
    const entry: ReconcileState = { since, scope: unit };
    if (at >= 0) out[at] = entry;
    else out.push(entry);
  }
  return out;
}

function unitKey(scope: ResyncScope): string {
  return scope.kind === "calendar" ? `calendar:${scope.calendarIds[0] ?? ""}` : scope.kind;
}
