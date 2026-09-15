/**
 * Connecting accounts. The OAuth / Plaid exchange happens server-side in the
 * `connector-link` Edge Function; the Field only opens the provider page and
 * waits for the `connector_accounts` row to appear (Realtime refresh or a
 * 3 s poll for up to 3 min).
 */
import type { ConnectorAccount, ProviderId } from "@vixera/domain";
import type { SpineReader } from "@vixera/sync";
import { openUrl } from "../platform/files.ts";
import type { FunctionsClient } from "./functions.ts";

export type LinkProvider = "google" | "microsoft" | "plaid";

export interface LinkStartOAuth {
  readonly authorizationUrl: string;
  readonly expiresAt: string;
}

export interface LinkStartPlaid {
  readonly linkToken: string;
  readonly hostedLinkUrl: string | null;
  readonly expiration: string;
  readonly connectorAccountId?: string | null;
}

export interface StartLinkOptions {
  /**
   * Repair this account (needs_reauth) instead of linking a new one: Plaid
   * runs Link in update mode on the same Item; OAuth providers re-consent and
   * land on the same row. The result is that account turning active again.
   */
  readonly relink?: ConnectorAccount | null;
}

export interface LinkDeps {
  readonly functions: FunctionsClient;
  readonly reader: SpineReader;
  readonly open?: (url: string) => Promise<void>;
}

export interface PendingLink {
  readonly provider: LinkProvider;
  /** Resolves with the new account, or null on timeout. */
  readonly account: Promise<ConnectorAccount | null>;
  /** Plaid only: completes a hosted Link session once the user is done. */
  readonly complete: (() => Promise<ConnectorAccount>) | null;
  readonly cancel: () => void;
}

export const LINK_POLL_INTERVAL_MS = 3_000;
export const LINK_TIMEOUT_MS = 180_000;

export function isLinkProvider(value: string): value is LinkProvider {
  return value === "google" || value === "microsoft" || value === "plaid";
}

export async function startLink(deps: LinkDeps, provider: LinkProvider, options: StartLinkOptions = {}): Promise<PendingLink> {
  const open = deps.open ?? openUrl;
  const relink = options.relink ?? null;
  const known = new Set((await deps.reader.listConnectorAccounts()).map((a) => a.id));
  const controller = new AbortController();
  const outcome = () => (relink ? waitForReactivation(deps.reader, relink.id, controller.signal) : waitForNewAccount(deps.reader, known, controller.signal));

  if (provider === "plaid") {
    const relinkBody = relink ? { connectorAccountId: relink.id } : {};
    const start = await deps.functions.call<LinkStartPlaid>("connector-link", { provider, step: "start", ...relinkBody });
    if (!start.hostedLinkUrl) {
      throw new Error("Plaid Hosted Link is not enabled for this project; enable it or link from a web flow");
    }
    await open(start.hostedLinkUrl);
    const complete = async () => {
      const { account } = await deps.functions.call<{ account: ConnectorAccount }>("connector-link", { provider, step: "complete", linkToken: start.linkToken, ...relinkBody });
      controller.abort();
      return account;
    };
    return { provider, account: outcome(), complete, cancel: () => controller.abort() };
  }

  const start = await deps.functions.call<LinkStartOAuth>("connector-link", { provider, step: "start" });
  await open(start.authorizationUrl);
  return { provider, account: outcome(), complete: null, cancel: () => controller.abort() };
}

/** Polls until an account not in `known` shows up; null on timeout or cancel. */
export async function waitForNewAccount(
  reader: SpineReader,
  known: ReadonlySet<string>,
  signal: AbortSignal,
  options: { readonly intervalMs?: number; readonly timeoutMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<ConnectorAccount | null> {
  const interval = options.intervalMs ?? LINK_POLL_INTERVAL_MS;
  const timeout = options.timeoutMs ?? LINK_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeout;
  while (!signal.aborted && Date.now() < deadline) {
    const fresh = (await reader.listConnectorAccounts().catch(() => [])).find((a) => !known.has(a.id) && a.status !== "disconnected");
    if (fresh) return fresh;
    await sleep(interval);
  }
  return null;
}

/** Polls until the account being repaired is active again; null on timeout or cancel. */
export async function waitForReactivation(
  reader: SpineReader,
  connectorAccountId: string,
  signal: AbortSignal,
  options: { readonly intervalMs?: number; readonly timeoutMs?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<ConnectorAccount | null> {
  const interval = options.intervalMs ?? LINK_POLL_INTERVAL_MS;
  const timeout = options.timeoutMs ?? LINK_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeout;
  while (!signal.aborted && Date.now() < deadline) {
    const account = (await reader.listConnectorAccounts().catch(() => [])).find((a) => a.id === connectorAccountId);
    if (account?.status === "active") return account;
    await sleep(interval);
  }
  return null;
}

export async function disconnectAccount(functions: FunctionsClient, provider: ProviderId, connectorAccountId: string): Promise<void> {
  await functions.call<{ ok: true }>("connector-link", { provider, step: "disconnect", connectorAccountId });
}
