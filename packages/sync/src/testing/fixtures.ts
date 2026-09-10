import {
  DEV_USER_ID,
  type ConnectorAccount,
  type ConnectorCapability,
  type ConnectorCredential,
  type CredentialStore,
  type ProviderId,
  type UserId,
} from "@vixera/domain";
import type { ConnectorAccountInput, SpineStore } from "../store/spine-store.ts";
import { InMemorySpineStore } from "../store/in-memory-spine-store.ts";

/**
 * Test fixtures for the sync spine. Every value is obviously fake
 * (example domains, "fake-token"). `MOCK_NOW` is the fixed clock the mock
 * connector's world is built around: the brief's Northwind kickoff is
 * "tomorrow", Eric's invoice arrived "yesterday".
 */
export const MOCK_NOW = new Date("2026-09-10T09:00:00.000Z");

/** The mock account's own address: never becomes a person. */
export const MOCK_SELF_ADDRESS = "me@example.com";

export function fixedClock(at: Date = MOCK_NOW): () => Date {
  return () => new Date(at.getTime());
}

/** A clock that advances by `stepMs` on every call, so timestamps stay distinct but deterministic. */
export function tickingClock(start: Date = MOCK_NOW, stepMs = 1000): () => Date {
  let t = start.getTime();
  return () => new Date((t += stepMs));
}

export function fakeCredential(overrides: Partial<Extract<ConnectorCredential, { kind: "oauth2" }>> = {}): ConnectorCredential {
  return {
    kind: "oauth2",
    accessToken: "fake-token",
    refreshToken: "fake-refresh-token",
    expiresAt: new Date(MOCK_NOW.getTime() + 3600_000).toISOString(),
    scopes: ["mock.read"],
    ...overrides,
  };
}

export function expiredCredential(): ConnectorCredential {
  return fakeCredential({ expiresAt: new Date(MOCK_NOW.getTime() - 60_000).toISOString(), accessToken: "fake-expired-token" });
}

export interface MockAccountOptions {
  readonly provider?: ProviderId;
  readonly externalAccountId?: string;
  readonly label?: string;
  readonly address?: string | null;
  readonly capabilities?: readonly ConnectorCapability[];
  readonly status?: ConnectorAccount["status"];
  readonly credentialRef?: string | null;
}

export function mockAccountInput(options: MockAccountOptions = {}): ConnectorAccountInput {
  const credentialRef = options.credentialRef === undefined ? "fake-cred-ref" : options.credentialRef;
  return {
    provider: options.provider ?? "mock",
    externalAccountId: options.externalAccountId ?? "mock-user-1",
    label: options.label ?? "Mock account",
    address: options.address === undefined ? MOCK_SELF_ADDRESS : options.address,
    capabilities: options.capabilities ?? ["mail", "calendar", "bank"],
    status: options.status ?? "active",
    credentialLocation: credentialRef ? "server_vault" : "none",
    credentialRef,
    lastError: null,
    metadata: {},
  };
}

/**
 * Creates a connector account row in the store and stores its credential.
 * Returns the persisted account (with the credential ref the store handed back).
 */
export async function seedMockAccount(
  store: SpineStore,
  credentials: CredentialStore,
  options: MockAccountOptions & { readonly credential?: ConnectorCredential | null } = {},
): Promise<ConnectorAccount> {
  const credential = options.credential === undefined ? fakeCredential() : options.credential;
  const ref = credential ? await credentials.put(null, credential) : null;
  return store.createConnectorAccount(mockAccountInput({ ...options, credentialRef: ref }));
}

export function newStore(userId: UserId = DEV_USER_ID, now: () => Date = tickingClock()): InMemorySpineStore {
  return new InMemorySpineStore(userId, { now });
}
