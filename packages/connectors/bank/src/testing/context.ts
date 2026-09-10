/**
 * Test helpers: a `SyncContext` bound to a fake Plaid item with an obviously
 * fake credential and server config, plus a log collector. Never used at runtime.
 */
import type { ConnectorAccount, ConnectorCredential, JsonObject, SyncContext } from "@vixera/domain";
import { DEV_USER_ID } from "@vixera/domain";
import type { PlaidConfig } from "../plaid/client.ts";

export const FAKE_PLAID_CONFIG: PlaidConfig = {
  clientId: "fake-plaid-client-id",
  secret: "fake-plaid-secret-DO-NOT-LEAK",
  environment: "sandbox",
};

export const FAKE_CREDENTIAL: ConnectorCredential = {
  kind: "access_token",
  accessToken: "access-sandbox-fake-token-1",
  expiresAt: null,
};

export const FAKE_ACCOUNT: ConnectorAccount = {
  id: "22222222-2222-4222-8222-222222222222" as ConnectorAccount["id"],
  userId: DEV_USER_ID,
  provider: "plaid",
  externalAccountId: "fake-item-id-1",
  label: "Example Bank",
  address: null,
  capabilities: ["bank"],
  status: "active",
  credentialLocation: "server_vault",
  credentialRef: "vault:fake-ref",
  lastError: null,
  metadata: {},
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

export interface LogEntry {
  readonly message: string;
  readonly data?: JsonObject;
}

export interface TestContext extends SyncContext {
  readonly logs: LogEntry[];
}

export function makeContext(fetchImpl: typeof fetch, overrides: Partial<SyncContext> = {}): TestContext {
  const logs: LogEntry[] = [];
  return {
    account: FAKE_ACCOUNT,
    credential: FAKE_CREDENTIAL,
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    fetch: fetchImpl,
    log: (message, data) => logs.push(data ? { message, data } : { message }),
    ...overrides,
    logs,
  };
}

/** A fetch that fails loudly: for providers that must not touch the network. */
export const noFetch: typeof fetch = async (input) => {
  throw new Error(`unexpected network call: ${typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url}`);
};

/** Drains an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
