import { describe, expect, it, vi } from "vitest";
import type { ConnectorAccount } from "@vixera/domain";
import type { SpineReader } from "@vixera/sync";
import type { FunctionsClient } from "./functions.ts";
import { startLink, waitForReactivation } from "./link.ts";

const account = (patch: Partial<ConnectorAccount>): ConnectorAccount =>
  ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    userId: "u",
    provider: "plaid",
    externalAccountId: "fake-item-id-1",
    label: "Example Bank",
    address: null,
    capabilities: ["bank"],
    status: "needs_reauth",
    credentialLocation: "server_vault",
    credentialRef: "vault:1",
    lastError: "Plaid /transactions/sync rejected the credential (ITEM_LOGIN_REQUIRED)",
    metadata: { reauthCode: "ITEM_LOGIN_REQUIRED" },
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    ...patch,
  }) as ConnectorAccount;

/** A reader whose account list can be changed between polls. */
function readerOf(initial: ConnectorAccount[]) {
  let rows = initial;
  const reader = { listConnectorAccounts: vi.fn(async () => rows) } as unknown as SpineReader;
  return { reader, set: (next: ConnectorAccount[]) => (rows = next) };
}

function functionsOf(answers: Record<string, unknown>) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const functions: FunctionsClient = {
    call: (async (name: string, body: unknown) => {
      calls.push({ name, body: body as Record<string, unknown> });
      return answers[(body as { step: string }).step];
    }) as FunctionsClient["call"],
  };
  return { functions, calls };
}

describe("startLink for a parked account", () => {
  it("plaid: sends the account id on start and complete, and its outcome is that same row active again", async () => {
    const parked = account({});
    const { reader, set } = readerOf([parked]);
    const { functions, calls } = functionsOf({
      start: { linkToken: "link-sandbox-update", hostedLinkUrl: "https://hosted.plaid.com/link/fake", expiration: "x", connectorAccountId: parked.id },
      complete: { account: account({ status: "active", lastError: null, metadata: {} }) },
    });
    const opened: string[] = [];
    // The server flips the row before the Field's first poll: the outcome is that row, not "a new account appeared".
    set([account({ status: "active" })]);
    const pending = await startLink({ functions, reader, open: async (url) => void opened.push(url) }, "plaid", { relink: parked });
    expect(opened).toEqual(["https://hosted.plaid.com/link/fake"]);
    expect(calls[0]).toEqual({ name: "connector-link", body: { provider: "plaid", step: "start", connectorAccountId: parked.id } });
    expect((await pending.account)?.id).toBe(parked.id);

    const done = await pending.complete!();
    expect(done.status).toBe("active");
    expect(calls[1]?.body).toEqual({ provider: "plaid", step: "complete", linkToken: "link-sandbox-update", connectorAccountId: parked.id });
    pending.cancel();
  });

  it("oauth: re-consents through the normal start and waits for the same row to turn active, not for a new row", async () => {
    const parked = account({ provider: "google", externalAccountId: "google-sub-1" });
    const { reader, set } = readerOf([parked]);
    const { functions, calls } = functionsOf({ start: { authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x", expiresAt: "x" } });
    set([account({ provider: "google", externalAccountId: "google-sub-1", status: "active" })]);
    const pending = await startLink({ functions, reader, open: async () => {} }, "google", { relink: parked });
    expect(calls[0]?.body).toEqual({ provider: "google", step: "start" });
    expect(pending.complete).toBeNull();
    expect((await pending.account)?.status).toBe("active");
    pending.cancel();
  });

  it("waitForReactivation ignores other accounts and gives up at the deadline", async () => {
    const parked = account({});
    const other = account({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as ConnectorAccount["id"], status: "active" });
    const { reader } = readerOf([parked, other]);
    const result = await waitForReactivation(reader, parked.id, new AbortController().signal, { intervalMs: 1, timeoutMs: 5, sleep: async () => {} });
    expect(result).toBeNull();
  });
});
