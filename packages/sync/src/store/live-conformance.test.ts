/**
 * The same SpineStore conformance suite, run against a REAL PostgreSQL +
 * PostgREST with the migrations applied — the seam a fake query builder cannot
 * cover (PostgREST filter syntax, `on conflict` targets, jsonb round-trips,
 * numeric-as-string, RPC signatures, trigger-raised errors, RLS).
 *
 *   scripts/live-stack.sh up      # prints VIXERA_LIVE_URL / VIXERA_LIVE_JWT_SECRET
 *   VIXERA_LIVE_URL=… VIXERA_LIVE_JWT_SECRET=… pnpm --filter @vixera/sync test
 *   scripts/live-stack.sh down
 *
 * Skipped (not failed) when the stack is not running, so `pnpm test` stays
 * dependency-free.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { newId, ref, type UserId } from "@vixera/domain";
import { SupabaseSpineStore } from "./supabase-spine-store.ts";
import { runSpineStoreConformance } from "./conformance.ts";

const URL = process.env.VIXERA_LIVE_URL;
const SECRET = process.env.VIXERA_LIVE_JWT_SECRET;
const live = Boolean(URL && SECRET);

// `pnpm test:live` sets VIXERA_LIVE_REQUIRED so an accidentally skipped suite
// cannot pass for a green run.
if (!live && process.env.VIXERA_LIVE_REQUIRED === "1") {
  throw new Error("VIXERA_LIVE_REQUIRED=1 but VIXERA_LIVE_URL / VIXERA_LIVE_JWT_SECRET are not set");
}

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc({ ...claims, exp: Math.floor(Date.now() / 1000) + 3600 });
  const sig = createHmac("sha256", SECRET as string).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

function client(token: string) {
  return createClient(URL as string, token, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/**
 * A fresh user per test. `public.users.id` references `auth.users`, which the
 * real Supabase auth service owns, so the live stack exposes a service-role
 * helper (scripts/sql/live-grants.sql) that mints both rows.
 */
async function freshUser(): Promise<UserId> {
  const id = newId<UserId>();
  const admin = client(jwt({ role: "service_role" }));
  const { error } = await admin.rpc("vx_test_create_user", { p_id: id });
  if (error) throw new Error(`could not create user: ${JSON.stringify(error)}`);
  return id;
}

describe.skipIf(!live)("live stack", () => {
  runSpineStoreConformance("supabase (live PostgREST)", async () => {
    const userId = await freshUser();
    return { store: new SupabaseSpineStore(client(jwt({ role: "service_role" })), userId), userId };
  });

  it("RLS: an authenticated user sees only their own rows and cannot write another user's", async () => {
    const mine = await freshUser();
    const theirs = await freshUser();
    const admin = new SupabaseSpineStore(client(jwt({ role: "service_role" })), mine);
    await admin.createThread({ title: "Mine", kind: null, status: "active", summary: null, metadata: {} });

    const asMe = new SupabaseSpineStore(client(jwt({ role: "authenticated", sub: mine })), mine);
    expect((await asMe.listThreads()).map((t) => t.title)).toEqual(["Mine"]);

    const asThem = new SupabaseSpineStore(client(jwt({ role: "authenticated", sub: theirs })), theirs);
    expect(await asThem.listThreads()).toHaveLength(0);

    // A client bound to another user's id gets nothing back and cannot insert.
    const impostor = new SupabaseSpineStore(client(jwt({ role: "authenticated", sub: theirs })), mine);
    expect(await impostor.listThreads()).toHaveLength(0);
    await expect(impostor.createThread({ title: "Intruder", kind: null, status: "active", summary: null, metadata: {} })).rejects.toThrow();
  });

  it("RLS: connector credentials, sync checkpoints and the action audit are server-only", async () => {
    const userId = await freshUser();
    const admin = new SupabaseSpineStore(client(jwt({ role: "service_role" })), userId);
    const account = await admin.createConnectorAccount({
      provider: "mock", externalAccountId: `acct-${newId()}`, label: "Server linked", address: null,
      capabilities: ["mail"], status: "active", credentialLocation: "none", credentialRef: null, lastError: null, metadata: {},
    });
    await admin.upsertSyncState(account.id, "mail", { checkpoint: { historyId: "42" }, status: "idle" });

    const asMe = client(jwt({ role: "authenticated", sub: userId }));
    // readable
    expect((await asMe.from("connector_accounts").select("label").eq("id", account.id)).data).toHaveLength(1);
    // a permitted column
    expect((await asMe.from("connector_accounts").update({ label: "Renamed" }).eq("id", account.id)).error).toBeNull();
    // the credential seam is not
    expect((await asMe.from("connector_accounts").update({ credential_ref: "planted" }).eq("id", account.id)).error).not.toBeNull();
    expect((await asMe.from("connector_sync_states").update({ checkpoint: { historyId: "0" } }).eq("connector_account_id", account.id)).error).not.toBeNull();
    expect((await asMe.from("action_requests").insert({ user_id: userId, action_type: "context_event.dismiss", idempotency_key: "forged", status: "done" })).error).not.toBeNull();
    expect((await asMe.rpc("vx_credential_get", { p_ref: newId() })).error).not.toBeNull();
    // enabled is the one sync-state column a client may set
    expect((await asMe.from("connector_sync_states").update({ enabled: false }).eq("connector_account_id", account.id)).error).toBeNull();
  });

  it("cross-user foreign keys and dangling subjects are rejected by the database", async () => {
    const mine = await freshUser();
    const theirs = await freshUser();
    const admin = client(jwt({ role: "service_role" }));
    const theirStore = new SupabaseSpineStore(admin, theirs);
    const theirAccount = await theirStore.createConnectorAccount({
      provider: "mock", externalAccountId: `acct-${newId()}`, label: "Theirs", address: null,
      capabilities: ["mail"], status: "active", credentialLocation: "none", credentialRef: null, lastError: null, metadata: {},
    });
    // Even the service role cannot attach my mail to their connector account.
    const bad = await admin.from("mail_messages").insert({ user_id: mine, connector_account_id: theirAccount.id, external_id: "x", received_at: new Date().toISOString() });
    expect(bad.error?.code).toBe("23503");
    const dangling = await admin.from("context_events").insert({ user_id: mine, kind: "x", subject_type: "document", subject_id: newId(), title: "x", dedupe_key: `x-${newId()}` });
    expect(dangling.error).not.toBeNull();
  });

  it("the neighbors RPC is user scoped", async () => {
    const mine = await freshUser();
    const admin = client(jwt({ role: "service_role" }));
    const store = new SupabaseSpineStore(admin, mine);
    const person = await store.upsertPerson({ displayName: "Eric", primaryEmail: null, organization: null, notes: null, metadata: {} });
    const thread = await store.createThread({ title: "Brand", kind: null, status: "active", summary: null, metadata: {} });
    await store.relate({ from: ref("thread", thread.id), kind: "has_person", to: ref("person", person.id) });
    expect(await store.neighbors(ref("thread", thread.id))).toHaveLength(1);
    const otherUser = await freshUser();
    const otherView = new SupabaseSpineStore(admin, otherUser);
    expect(await otherView.neighbors(ref("thread", thread.id))).toHaveLength(0);
  });
});
