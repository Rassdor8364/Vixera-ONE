/**
 * Every Spine runtime is bound to the user it was created for. This is the
 * other half of "never in the Field as the wrong user": App keys the
 * SpineProvider on `runtime.userId` and rebuilds the runtime when the id
 * changes, and the runtime it builds must read as exactly that user — the
 * store's own userId, not a global.
 */
import { describe, expect, it, vi } from "vitest";
import type { UserId } from "@vixera/domain";
import { FetchPraxionTransport, PRAXION_DEFAULT_BASE_URL, PraxionClient } from "@vixera/praxion";
import { parseConfig } from "./config.ts";
import { boundAccessToken, createSessionRuntime, createShell } from "./runtime.ts";

function fakeSupabase() {
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    channel: vi.fn(() => ({ on() { return this; }, subscribe() { return this; }, unsubscribe() {} })),
    from: vi.fn(),
  } as never;
}

async function supabaseShell() {
  const config = parseConfig({ VITE_SUPABASE_URL: "https://proj.supabase.co", VITE_SUPABASE_ANON_KEY: "anon-key" });
  expect(config.mode).toBe("supabase");
  const praxion = new PraxionClient(new FetchPraxionTransport(PRAXION_DEFAULT_BASE_URL, async () => { throw new Error("no praxion"); }), { cacheMs: 60_000 });
  const device = { deviceId: "11111111-1111-4111-8111-111111111111", platform: "unknown" as const, name: "Test", createdAt: new Date(0).toISOString() };
  return createShell(config, { supabase: fakeSupabase(), praxion, device });
}

describe("createSessionRuntime binding", () => {
  it("binds the reader and the runtime to the exact user id it was given", async () => {
    const shell = await supabaseShell();
    const a = "aaaaaaaa-0000-4000-8000-000000000001" as UserId;
    const runtime = createSessionRuntime(shell, a);
    expect(runtime.userId).toBe(a);
    expect(runtime.reader.userId).toBe(a);
    expect(runtime.mode).toBe("supabase");
  });

  it("two runtimes for two users never share a reader — no cross-user bleed", async () => {
    const shell = await supabaseShell();
    const a = "aaaaaaaa-0000-4000-8000-000000000001" as UserId;
    const b = "bbbbbbbb-0000-4000-8000-000000000002" as UserId;
    const ra = createSessionRuntime(shell, a);
    const rb = createSessionRuntime(shell, b);
    expect(ra.reader).not.toBe(rb.reader);
    expect(ra.reader.userId).toBe(a);
    expect(rb.reader.userId).toBe(b);
    // The One Command reader is the same user-bound store, so a command can never
    // reach the other user's rows.
    expect(ra.command).not.toBe(rb.command);
  });
});

describe("boundAccessToken", () => {
  const a = "aaaaaaaa-0000-4000-8000-000000000001" as UserId;
  const future = Math.floor(Date.now() / 1000) + 3600;
  const session = (id: string, token: string) => ({ access_token: token, expires_at: future, user: { id } });

  it("returns this user's cached token", async () => {
    const get = boundAccessToken(a, () => session(a, "tok-a"), async () => null);
    expect(await get()).toBe("tok-a");
  });

  it("never returns another user's token — after an account switch a stale runtime fails closed", async () => {
    const b = "bbbbbbbb-0000-4000-8000-000000000002";
    const get = boundAccessToken(a, () => session(b, "tok-b"), async () => session(b, "tok-b"));
    expect(await get()).toBeNull();
  });

  it("falls through to a fresh session when the cached one is expiring, still for the same user only", async () => {
    const stale = { access_token: "old", expires_at: Math.floor(Date.now() / 1000) + 5, user: { id: a } };
    expect(await boundAccessToken(a, () => stale, async () => session(a, "fresh"))()).toBe("fresh");
    expect(await boundAccessToken(a, () => stale, async () => session("someone-else", "theirs"))()).toBeNull();
    expect(await boundAccessToken(a, () => null, async () => null)()).toBeNull();
  });
});
