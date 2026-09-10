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

export async function startLink(deps: LinkDeps, provider: LinkProvider): Promise<PendingLink> {
  const open = deps.open ?? openUrl;
  const known = new Set((await deps.reader.listConnectorAccounts()).map((a) => a.id));
  const controller = new AbortController();

  if (provider === "plaid") {
    const start = await deps.functions.call<LinkStartPlaid>("connector-link", { provider, step: "start" });
    if (!start.hostedLinkUrl) {
      throw new Error("Plaid Hosted Link is not enabled for this project; enable it or link from a web flow");
    }
    await open(start.hostedLinkUrl);
    const complete = async () => {
      const { account } = await deps.functions.call<{ account: ConnectorAccount }>("connector-link", { provider, step: "complete", linkToken: start.linkToken });
      controller.abort();
      return account;
    };
    return { provider, account: waitForNewAccount(deps.reader, known, controller.signal), complete, cancel: () => controller.abort() };
  }

  const start = await deps.functions.call<LinkStartOAuth>("connector-link", { provider, step: "start" });
  await open(start.authorizationUrl);
  return { provider, account: waitForNewAccount(deps.reader, known, controller.signal), complete: null, cancel: () => controller.abort() };
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

export async function disconnectAccount(functions: FunctionsClient, provider: ProviderId, connectorAccountId: string): Promise<void> {
  await functions.call<{ ok: true }>("connector-link", { provider, step: "disconnect", connectorAccountId });
}
