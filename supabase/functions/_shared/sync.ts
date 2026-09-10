/**
 * Runs the SyncEngine for one user inside an Edge Function, with a wall-clock
 * budget: the edge runtime kills long invocations, so after `budgetMs` no new
 * (account, capability) run is started and the remaining pairs are reported
 * as skipped ("time budget exhausted"). Each capability persists its own
 * checkpoint per page, so the next scheduled run resumes where this one
 * stopped; nothing is lost by skipping.
 *
 * `selfAddresses` = the addresses of the user's own connector accounts, so
 * the user never becomes a person in their own graph.
 */
import { type ConnectorAccount, type ConnectorRegistry, type CredentialStore, type JsonObject, type UserId } from "@vixera/domain";
import { ContextLinker, SyncEngine, addCounts, emptyCounts, errorMessage, type SpineStore, type SyncOutcome, type SyncReport } from "@vixera/sync";
import { buildRegistry } from "./connectors.ts";
import { VaultCredentialStore } from "./credentials.ts";
import type { FunctionEnv } from "./env.ts";
import { serviceClient, spineForUser } from "./spine.ts";

export const DEFAULT_SYNC_BUDGET_MS = 100_000;

export interface SyncDeps {
  readonly store: SpineStore;
  readonly credentials: CredentialStore;
  readonly registry: ConnectorRegistry;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  readonly log?: (message: string, data?: JsonObject) => void;
}

export interface SyncRunOptions {
  /** Only this account (must belong to the store's user); null/undefined = every account. */
  readonly accountId?: string | null;
  /** Wall-clock budget from `startedAt`; default 100 s. */
  readonly budgetMs?: number;
  /** Absolute deadline (epoch ms) that wins over `budgetMs` when earlier — used by the scheduled all-users run. */
  readonly deadlineAt?: number;
}

export interface BudgetedSyncReport extends SyncReport {
  /** (account, capability) pairs not started because the budget ran out. */
  readonly skippedForBudget: number;
}

export class SyncAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`connector account ${accountId} not found`);
    this.name = "SyncAccountNotFoundError";
  }
}

/** Core runner over injected dependencies (tests use InMemorySpineStore + MockConnector). */
export async function runSync(deps: SyncDeps, options: SyncRunOptions = {}): Promise<BudgetedSyncReport> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const started = now();
  const budgetMs = options.budgetMs ?? DEFAULT_SYNC_BUDGET_MS;
  const deadline = Math.min(started.getTime() + budgetMs, options.deadlineAt ?? Number.POSITIVE_INFINITY);

  const allAccounts = await deps.store.listConnectorAccounts();
  let accounts: ConnectorAccount[];
  if (options.accountId) {
    const account = allAccounts.find((a) => a.id === options.accountId) ?? (await deps.store.getConnectorAccount(options.accountId));
    if (!account) throw new SyncAccountNotFoundError(options.accountId);
    accounts = [account];
  } else {
    accounts = allAccounts;
  }

  // Every address the user owns, whichever account is being synced: the user never becomes a person.
  const selfAddresses = allAccounts.map((a) => a.address).filter((a): a is string => typeof a === "string" && a.length > 0);
  const linker = new ContextLinker(deps.store, { now, selfAddresses, log });
  const engine = new SyncEngine({ store: deps.store, registry: deps.registry, credentials: deps.credentials, linker, now, log, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

  const outcomes: SyncOutcome[] = [];
  let skippedForBudget = 0;
  for (const account of accounts) {
    if (account.status === "disconnected" || account.status === "paused") {
      for (const capability of account.capabilities) outcomes.push(skipped(account, capability, `account ${account.status}`, now()));
      continue;
    }
    let current: ConnectorAccount = account;
    for (const capability of account.capabilities) {
      if (now().getTime() >= deadline) {
        skippedForBudget++;
        outcomes.push(skipped(current, capability, "time budget exhausted", now()));
        continue;
      }
      if (current.status === "needs_reauth") {
        outcomes.push(skipped(current, capability, "account needs_reauth", now()));
        continue;
      }
      try {
        outcomes.push(await engine.runCapability(current, capability, deadline));
      } catch (err) {
        // runCapability isolates failures itself; this is the last line of defence.
        log("sync: capability run failed unexpectedly", { connectorAccountId: current.id, capability, error: errorMessage(err) });
        outcomes.push({ ...skipped(current, capability, errorMessage(err), now()), status: "error", errorCode: "unknown" });
      }
      current = (await deps.store.getConnectorAccount(account.id)) ?? current;
    }
  }

  const finished = now();
  const counts = emptyCounts();
  for (const o of outcomes) addCounts(counts, o.counts);
  if (skippedForBudget > 0) log("sync: budget exhausted", { skippedForBudget, budgetMs });
  return {
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    accounts: accounts.length,
    outcomes,
    ok: outcomes.filter((o) => o.status === "ok").length,
    errors: outcomes.filter((o) => o.status === "error").length,
    skipped: outcomes.filter((o) => o.status === "skipped").length,
    counts,
    skippedForBudget,
  };
}

function skipped(account: ConnectorAccount, capability: ConnectorAccount["capabilities"][number], reason: string, at: Date): SyncOutcome {
  return {
    connectorAccountId: account.id,
    provider: account.provider,
    label: account.label,
    capability,
    status: "skipped",
    reason,
    errorCode: null,
    pages: 0,
    counts: emptyCounts(),
    checkpointAdvanced: false,
    startedAt: at.toISOString(),
    finishedAt: at.toISOString(),
    durationMs: 0,
  };
}

/** Production wiring: Supabase spine + Vault credentials + the configured registry, for one user. */
export function runSyncForUser(userId: UserId, options: SyncRunOptions & { readonly env: FunctionEnv; readonly registry?: ConnectorRegistry; readonly log?: SyncDeps["log"] }): Promise<BudgetedSyncReport> {
  const client = serviceClient(options.env);
  const deps: SyncDeps = {
    store: spineForUser(client, userId),
    credentials: new VaultCredentialStore(client, userId),
    registry: options.registry ?? buildRegistry(options.env),
    ...(options.log ? { log: options.log } : {}),
  };
  return runSync(deps, options);
}

/** A compact JSON summary of a report for action results and responses. */
export function summarizeReport(report: BudgetedSyncReport): JsonObject {
  return {
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    accounts: report.accounts,
    ok: report.ok,
    errors: report.errors,
    skipped: report.skipped,
    skippedForBudget: report.skippedForBudget,
    counts: { ...report.counts },
    outcomes: report.outcomes.map((o) => ({
      connectorAccountId: o.connectorAccountId,
      provider: o.provider,
      capability: o.capability,
      status: o.status,
      reason: o.reason,
      errorCode: o.errorCode,
      pages: o.pages,
      checkpointAdvanced: o.checkpointAdvanced,
      durationMs: o.durationMs,
    })),
  };
}
