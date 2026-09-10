/**
 * Seams of the platform bridge that can be exercised without a Tauri runtime:
 * browser fallbacks, the credential key guard, share payload normalization and
 * the Praxion transport's degrade-not-throw contract (with an injected fetch).
 */
import { describe, expect, it, vi } from "vitest";
import { PRAXION_CONTRACT_HEADER, PraxionTransportError } from "@vixera/praxion";
import { CREDENTIAL_KEYS, MemoryCredentialStore, createCredentialStore, isAllowedCredentialKey } from "./credentials.ts";
import { getDeviceIdentity, resetDeviceIdentityCache } from "./device.ts";
import { TauriPraxionTransport } from "./praxion-transport.ts";
import { clearPendingShares, getPendingShares, normalizePendingShares, onShare } from "./share.ts";
import { currentPlatform, isAndroid, isTauri } from "./tauri.ts";

describe("runtime detection outside Tauri", () => {
  it("reports browser mode", () => {
    expect(isTauri()).toBe(false);
    expect(currentPlatform()).toBe("unknown");
    expect(isAndroid()).toBe(false);
  });
});

describe("credentials", () => {
  it("falls back to a memory store in the browser and round-trips", async () => {
    const store = createCredentialStore();
    expect(store).toBeInstanceOf(MemoryCredentialStore);
    expect(await store.getItem(CREDENTIAL_KEYS.supabaseSession)).toBeNull();
    await store.setItem(CREDENTIAL_KEYS.supabaseSession, "fake-session");
    expect(await store.getItem(CREDENTIAL_KEYS.supabaseSession)).toBe("fake-session");
    await store.removeItem(CREDENTIAL_KEYS.supabaseSession);
    expect(await store.getItem(CREDENTIAL_KEYS.supabaseSession)).toBeNull();
  });

  it("only accepts namespaced Vixera keys", async () => {
    expect(isAllowedCredentialKey("supabase.session")).toBe(true);
    expect(isAllowedCredentialKey("device.key")).toBe(true);
    expect(isAllowedCredentialKey("connector.acct-1")).toBe(true);
    // Keys supabase-js derives from storageKey (sign-out and PKCE) belong to the session namespace.
    expect(isAllowedCredentialKey("supabase.session-user")).toBe(true);
    expect(isAllowedCredentialKey("supabase.session-code-verifier")).toBe(true);
    expect(isAllowedCredentialKey("supabase.session-flow-2b1c6c8e-code-verifier")).toBe(true);
    expect(isAllowedCredentialKey("supabase.session-")).toBe(false);
    expect(isAllowedCredentialKey("supabase.sessionX")).toBe(false);
    expect(isAllowedCredentialKey("connector.")).toBe(false);
    expect(isAllowedCredentialKey("sb-project-auth-token")).toBe(false);
    const store = new MemoryCredentialStore();
    await expect(store.setItem("random", "x")).rejects.toThrow(/not a Vixera credential key/);
    expect(store.size).toBe(0);
  });
});

describe("device identity in the browser", () => {
  it("is a random uuid, stable across calls and reloads", async () => {
    resetDeviceIdentityCache();
    const first = await getDeviceIdentity();
    expect(first.deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first.platform).toBe("unknown");
    resetDeviceIdentityCache();
    const second = await getDeviceIdentity();
    expect(second.deviceId).toBe(first.deviceId);
    localStorage.clear();
    resetDeviceIdentityCache();
    const third = await getDeviceIdentity();
    expect(third.deviceId).not.toBe(first.deviceId);
  });
});

describe("share bindings off Android", () => {
  it("are no-ops", async () => {
    expect(await getPendingShares()).toEqual({ items: [] });
    await expect(clearPendingShares()).resolves.toBeUndefined();
    const listener = vi.fn();
    const unsubscribe = await onShare(listener);
    await expect(unsubscribe()).resolves.toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it("normalizes plugin payloads with missing fields", () => {
    const pending = normalizePendingShares({
      items: [
        { id: "a", kind: "image", path: "/cache/vixera-shares/a.jpg", mimeType: "image/jpeg", sizeBytes: 10, receivedAt: "2026-09-10T00:00:00Z" },
        { id: "b", kind: "url", text: "https://example.com/x" },
        { id: "c", kind: "bogus" },
        "not an item",
      ],
    });
    expect(pending.items).toHaveLength(3);
    expect(pending.items[0]).toMatchObject({ id: "a", kind: "image", filename: null, title: null, text: null });
    expect(pending.items[1]).toMatchObject({ kind: "url", path: null, sizeBytes: null });
    expect(pending.items[2]?.kind).toBe("file");
    expect(normalizePendingShares(null)).toEqual({ items: [] });
  });
});

describe("TauriPraxionTransport", () => {
  it("rejects non-loopback base URLs at construction", () => {
    expect(() => new TauriPraxionTransport("https://example.com")).toThrow(PraxionTransportError);
  });

  it("sends the contract header and parses JSON", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers[PRAXION_CONTRACT_HEADER]).toBe("1");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ app: "praxion" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const transport = new TauriPraxionTransport("http://127.0.0.1:47815/", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await transport.request<{ app: string }>({ method: "GET", path: "/v1/health" });
    expect(response.status).toBe(200);
    expect(response.body?.app).toBe("praxion");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:47815/v1/health");
  });

  it("never throws: refused connections resolve to status 0 / network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    const transport = new TauriPraxionTransport(undefined, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await transport.request({ method: "GET", path: "/v1/health" });
    expect(response).toEqual({ status: 0, body: null, failure: { kind: "network", message: "connection refused" } });
  });

  it("maps an aborted request to a timeout failure", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const transport = new TauriPraxionTransport(undefined, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await transport.request({ method: "POST", path: "/v1/actions", body: { action: "goto" }, timeoutMs: 5 });
    expect(response.status).toBe(0);
    expect(response.failure?.kind).toBe("timeout");
  });

  it("treats empty and non-JSON bodies as null", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    const transport = new TauriPraxionTransport(undefined, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await transport.request({ method: "GET", path: "/v1/health" });
    expect(response).toEqual({ status: 200, body: null });
  });
});
