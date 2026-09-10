/**
 * Test helpers: a `SyncContext` bound to a fake Microsoft account with an
 * obviously fake credential, plus a log collector. Never used at runtime.
 */
import type { ConnectorAccount, ConnectorCredential, JsonObject, SyncContext } from "@vixera/domain";
import { DEV_USER_ID } from "@vixera/domain";
import type { MicrosoftOAuthConfig } from "../oauth.ts";

export const FAKE_OAUTH: MicrosoftOAuthConfig = {
  clientId: "00000000-0000-0000-0000-00000000fake",
  clientSecret: "fake-client-secret-DO-NOT-LEAK",
  redirectUri: "https://example.com/oauth/callback",
};

export const FAKE_CREDENTIAL: ConnectorCredential = {
  kind: "oauth2",
  accessToken: "fake-access-token-1",
  refreshToken: "fake-refresh-token",
  expiresAt: "2026-09-10T13:00:00.000Z",
  scopes: ["openid", "offline_access", "User.Read", "Mail.Read", "Calendars.Read"],
  tokenType: "Bearer",
};

export const FAKE_ACCOUNT: ConnectorAccount = {
  id: "22222222-2222-4222-8222-222222222222" as ConnectorAccount["id"],
  userId: DEV_USER_ID,
  provider: "microsoft",
  externalAccountId: "fake-graph-user-1",
  label: "Me Example (me@example.com)",
  address: "me@example.com",
  capabilities: ["mail", "calendar"],
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
  readonly refreshed: ConnectorCredential[];
}

export function makeContext(fetchImpl: typeof fetch, overrides: Partial<SyncContext> = {}): TestContext {
  const logs: LogEntry[] = [];
  const refreshed: ConnectorCredential[] = [];
  return {
    account: FAKE_ACCOUNT,
    credential: FAKE_CREDENTIAL,
    now: () => new Date("2026-09-10T12:00:00.000Z"),
    fetch: fetchImpl,
    onCredentialRefreshed: async (c) => {
      refreshed.push(c);
    },
    log: (message, data) => logs.push(data ? { message, data } : { message }),
    ...overrides,
    logs,
    refreshed,
  };
}

/** Drains an async iterable into an array. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
