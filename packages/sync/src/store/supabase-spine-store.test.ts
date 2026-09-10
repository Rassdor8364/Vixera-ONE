import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEV_USER_ID, ref } from "@vixera/domain";
import { SupabaseSpineStore, escapeLike, ilike, orIlike } from "./supabase-spine-store.ts";
import { SpineIntegrityError, SpineNotFoundError } from "./spine-store.ts";
import { SpineStorageError } from "./supabase-spine-store.ts";

/**
 * A recording fake of the supabase-js query builder. Every chained call is
 * recorded; awaiting the builder resolves with the response the test scripted
 * for that (table|rpc, operation). Enough to assert *what the store asks the
 * database for* — user_id filters, conflict targets, rpc names — without a
 * network or a real PostgREST.
 */
interface Call {
  readonly target: string;
  readonly ops: { readonly name: string; readonly args: readonly unknown[] }[];
}

type Responder = (call: Call) => { data: unknown; error: { code?: string; message: string; details?: string } | null };

function fakeClient(respond: Responder): { client: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];
  const builder = (target: string, first?: { name: string; args: unknown[] }) => {
    const call: Call = { target, ops: first ? [first] : [] };
    calls.push(call);
    const proxy: Record<string, unknown> = {};
    const handler: ProxyHandler<Record<string, unknown>> = {
      get(_t, prop) {
        if (prop === "then") {
          const res = respond(call);
          return (resolve: (v: unknown) => void) => resolve(res);
        }
        return (...args: unknown[]) => {
          call.ops.push({ name: String(prop), args });
          return new Proxy(proxy, handler);
        };
      },
    };
    return new Proxy(proxy, handler);
  };
  const client = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: unknown) => builder(`rpc:${fn}`, { name: "rpc", args: [args] }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const has = (call: Call, name: string, ...args: unknown[]) => call.ops.some((o) => o.name === name && JSON.stringify(o.args) === JSON.stringify(args));
const op = (call: Call, name: string) => call.ops.find((o) => o.name === name);

const PERSON_ROW = {
  id: "33333333-3333-4333-8333-333333333333",
  user_id: DEV_USER_ID,
  display_name: "Eric Lindqvist",
  primary_email: "eric@lindqvist.example",
  organization: null,
  notes: null,
  merged_into_id: null,
  metadata: {},
  created_at: "2026-09-10T09:00:00+00:00",
  updated_at: "2026-09-10T09:00:00+00:00",
};

describe("SupabaseSpineStore query shape", () => {
  it("filters every read by the bound user id and maps rows", async () => {
    const { client, calls } = fakeClient((call) => {
      if (call.target === "person_identities") return { data: [{ person_id: PERSON_ROW.id }], error: null };
      return { data: call.ops.some((o) => o.name === "maybeSingle") ? PERSON_ROW : [PERSON_ROW], error: null };
    });
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const person = await store.getPerson(PERSON_ROW.id);
    expect(person?.displayName).toBe("Eric Lindqvist");
    expect(person?.createdAt).toBe("2026-09-10T09:00:00.000Z");
    const people = await store.listPeople({ search: "eric, (studio)", limit: 10, offset: 20 });
    expect(people).toHaveLength(1);
    for (const call of calls) expect(has(call, "eq", "user_id", DEV_USER_ID)).toBe(true);
    const list = calls.find((c) => c.target === "people" && op(c, "or"))!;
    expect(calls.find((c) => c.target === "person_identities")).toBeDefined();
    expect(has(list, "is", "merged_into_id", null)).toBe(true);
    expect(op(list, "or")?.args[0]).toBe(`display_name.ilike."%eric, (studio)%",organization.ilike."%eric, (studio)%",primary_email.ilike."%eric, (studio)%",id.in.(${PERSON_ROW.id})`);
    expect(has(list, "range", 20, 29)).toBe(true);
  });

  it("upserts natural keys with the schema's conflict targets, sets user_id and counts inserted vs updated", async () => {
    const account = "22222222-2222-4222-8222-222222222222";
    const { client, calls } = fakeClient((call) => {
      if (op(call, "select")?.args[0] === "external_id") return { data: [{ external_id: "m1" }], error: null };
      const rows = (op(call, "upsert")?.args[0] as Record<string, unknown>[]).map((r, i) => ({
        ...r,
        id: `4444444${i}-4444-4444-8444-444444444444`,
        created_at: "2026-09-10T09:00:00+00:00",
        updated_at: "2026-09-10T09:00:00+00:00",
      }));
      return { data: rows, error: null };
    });
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const message = (externalId: string) => ({
      externalId,
      externalThreadId: null,
      subject: "s",
      snippet: null,
      bodyText: null,
      from: { email: "a@example.com", name: null },
      to: [],
      cc: [],
      sentAt: null,
      receivedAt: "2026-09-09T10:00:00.000Z",
      isUnread: true,
      attachments: [],
      labels: [],
    });
    const result = await store.upsertMailMessages(account, [message("m1"), message("m2")]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.rows.map((r) => r.externalId)).toEqual(["m1", "m2"]);
    expect(result.rows.every((r) => r.userId === DEV_USER_ID && r.connectorAccountId === account)).toBe(true);
    const upsert = calls.find((c) => op(c, "upsert"))!;
    expect(upsert.target).toBe("mail_messages");
    expect(op(upsert, "upsert")?.args[1]).toEqual({ onConflict: "user_id,connector_account_id,external_id", ignoreDuplicates: false });
    expect((op(upsert, "upsert")?.args[0] as { user_id: string }[]).every((r) => r.user_id === DEV_USER_ID)).toBe(true);
  });

  it("collapses duplicate natural keys within one page so PostgREST never updates the same row twice", async () => {
    const account = "22222222-2222-4222-8222-222222222222";
    const { client, calls } = fakeClient((call) => {
      if (op(call, "select")?.args[0] === "external_id") return { data: [], error: null };
      const rows = (op(call, "upsert")?.args[0] as Record<string, unknown>[]).map((r, i) => ({
        ...r,
        id: `4444444${i}-4444-4444-8444-444444444444`,
        created_at: "2026-09-10T09:00:00+00:00",
        updated_at: "2026-09-10T09:00:00+00:00",
      }));
      return { data: rows, error: null };
    });
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const message = (externalId: string, subject: string) => ({
      externalId,
      externalThreadId: null,
      subject,
      snippet: null,
      bodyText: null,
      from: null,
      to: [],
      cc: [],
      sentAt: null,
      receivedAt: "2026-09-09T10:00:00.000Z",
      isUnread: true,
      attachments: [],
      labels: [],
    });
    const result = await store.upsertMailMessages(account, [message("m1", "first"), message("m1", "second")]);
    const upsert = calls.find((c) => op(c, "upsert"))!;
    const sent = op(upsert, "upsert")?.args[0] as { external_id: string; subject: string }[];
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ external_id: "m1", subject: "second" });
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.rows.map((r) => r.subject)).toEqual(["second", "second"]);
  });

  it("context events: existing dedupe keys are read back untouched, only new ones are inserted with DO NOTHING", async () => {
    const existing = {
      id: "55555555-5555-4555-8555-555555555555",
      user_id: DEV_USER_ID,
      kind: "mail.received",
      subject_type: "mail_message",
      subject_id: "44444444-4444-4444-8444-444444444444",
      title: "old",
      summary: null,
      occurred_at: "2026-09-09T10:00:00+00:00",
      importance: 45,
      due_at: null,
      attention: "quiet",
      connector_account_id: null,
      dedupe_key: "k-existing",
      metadata: {},
      created_at: "2026-09-09T10:00:00+00:00",
    };
    const { client, calls } = fakeClient((call) => {
      if (op(call, "in")) return { data: [existing], error: null };
      const rows = (op(call, "upsert")?.args[0] as Record<string, unknown>[]).map((r) => ({ ...r, created_at: "2026-09-10T09:00:00+00:00" }));
      return { data: rows, error: null };
    });
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const base = { kind: "mail.received", subject: ref("mail_message", existing.subject_id), title: "new", summary: null, occurredAt: "2026-09-10T09:00:00.000Z", importance: 45, dueAt: null, attention: "needs_attention" as const, connectorAccountId: null, metadata: {} };
    const result = await store.upsertContextEvents([
      { ...base, dedupeKey: "k-existing" },
      { ...base, dedupeKey: "k-new" },
    ]);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.rows[0]).toMatchObject({ dedupeKey: "k-existing", attention: "quiet", title: "old" });
    expect(result.rows[1]).toMatchObject({ dedupeKey: "k-new", attention: "needs_attention" });
    const upsert = calls.find((c) => op(c, "upsert"))!;
    expect(op(upsert, "upsert")?.args[1]).toEqual({ onConflict: "user_id,dedupe_key", ignoreDuplicates: true });
    expect((op(upsert, "upsert")?.args[0] as { dedupe_key: string }[]).map((r) => r.dedupe_key)).toEqual(["k-new"]);
  });

  it("relate() goes through vx_relate with the user id and maps the FK trigger error to SpineIntegrityError", async () => {
    const { client, calls } = fakeClient(() => ({ data: null, error: { code: "23503", message: "relationship target person 1 does not exist for user" } }));
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const from = ref("mail_message", "44444444-4444-4444-8444-444444444444");
    const to = ref("person", "33333333-3333-4333-8333-333333333333");
    await expect(store.relate({ from, kind: "has_person", to, source: "connector" })).rejects.toBeInstanceOf(SpineIntegrityError);
    expect(calls[0]?.target).toBe("rpc:vx_relate");
    expect(calls[0]?.ops[0]?.args[0]).toEqual({
      p_user_id: DEV_USER_ID,
      p_from_type: "mail_message",
      p_from_id: from.id,
      p_kind: "has_person",
      p_to_type: "person",
      p_to_id: to.id,
      p_confidence: 1,
      p_source: "connector",
      p_metadata: {},
    });

    const raised = fakeClient(() => ({ data: null, error: { code: "P0001", message: "raised" } }));
    await expect(new SupabaseSpineStore(raised.client, DEV_USER_ID).relate({ from, kind: "has_person", to })).rejects.toBeInstanceOf(SpineIntegrityError);
  });

  it("neighbors() uses vx_neighbors and filters kind / type / direction client-side", async () => {
    const rpcRows = [
      { relationship_id: "r1", kind: "has_person", direction: "out", neighbor_type: "person", neighbor_id: "p1", confidence: "1.000", source: "connector" },
      { relationship_id: "r2", kind: "originated_from", direction: "in", neighbor_type: "document", neighbor_id: "d1", confidence: "0.500", source: "connector" },
    ];
    const { client, calls } = fakeClient(() => ({ data: rpcRows, error: null }));
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const node = ref("mail_message", "44444444-4444-4444-8444-444444444444");
    const all = await store.neighbors(node);
    expect(all).toHaveLength(2);
    expect(all[1]?.confidence).toBe(0.5);
    expect(calls[0]?.target).toBe("rpc:vx_neighbors");
    expect(calls[0]?.ops[0]?.args[0]).toEqual({ p_user_id: DEV_USER_ID, p_type: "mail_message", p_id: node.id });
    expect((await store.neighbors(node, { direction: "in" })).map((n) => n.relationshipId)).toEqual(["r2"]);
    expect((await store.neighbors(node, { kind: "has_person", type: "person" })).map((n) => n.ref)).toEqual([{ type: "person", id: "p1" }]);
    expect(await store.neighbors(node, { kind: "has_person", type: "document" })).toEqual([]);
  });

  it("createActionRequest replays by idempotency key and updates 404 as SpineNotFoundError", async () => {
    const existing = {
      id: "66666666-6666-4666-8666-666666666666",
      user_id: DEV_USER_ID,
      action_type: "context_event.quiet",
      idempotency_key: "k1",
      payload: { contextEventId: "x" },
      status: "done",
      result: { ok: true },
      error: null,
      attempts: 1,
      actor_device_id: null,
      created_at: "2026-09-10T09:00:00+00:00",
      updated_at: "2026-09-10T09:00:00+00:00",
    };
    const { client, calls } = fakeClient((call) => (op(call, "upsert") ? { data: null, error: null } : { data: existing, error: null }));
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const res = await store.createActionRequest({ actionType: "context_event.quiet", idempotencyKey: "k1", payload: { contextEventId: "y" } });
    expect(res.created).toBe(false);
    expect(res.request.status).toBe("done");
    expect(op(calls[0]!, "upsert")?.args[1]).toEqual({ onConflict: "user_id,idempotency_key", ignoreDuplicates: true });
    expect(has(calls[1]!, "eq", "idempotency_key", "k1")).toBe(true);

    const missing = fakeClient(() => ({ data: null, error: null }));
    await expect(new SupabaseSpineStore(missing.client, DEV_USER_ID).updatePerson(PERSON_ROW.id, { notes: "x" })).rejects.toBeInstanceOf(SpineNotFoundError);
    expect(has(missing.calls[0]!, "eq", "user_id", DEV_USER_ID)).toBe(true);
    expect(op(missing.calls[0]!, "update")?.args[0]).toEqual({ notes: "x" });
  });

  it("wraps other PostgREST errors as SpineStorageError with the code", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }));
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const err = await store.listThreads().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpineStorageError);
    expect((err as SpineStorageError).code).toBe("42P01");
  });

  it("upsertSyncState sends only the patched columns under the primary-key conflict target", async () => {
    const stateRow = {
      connector_account_id: "22222222-2222-4222-8222-222222222222",
      capability: "mail",
      user_id: DEV_USER_ID,
      enabled: true,
      status: "running",
      checkpoint: null,
      last_attempt_at: "2026-09-10T09:00:00+00:00",
      last_success_at: null,
      last_error: null,
      consecutive_failures: 0,
      updated_at: "2026-09-10T09:00:00+00:00",
    };
    const { client, calls } = fakeClient(() => ({ data: stateRow, error: null }));
    const store = new SupabaseSpineStore(client, DEV_USER_ID);
    const state = await store.upsertSyncState(stateRow.connector_account_id, "mail", { status: "running", lastAttemptAt: "2026-09-10T09:00:00.000Z" });
    expect(state.lastAttemptAt).toBe("2026-09-10T09:00:00.000Z");
    expect(op(calls[0]!, "upsert")?.args).toEqual([
      { user_id: DEV_USER_ID, connector_account_id: stateRow.connector_account_id, capability: "mail", status: "running", last_attempt_at: "2026-09-10T09:00:00.000Z" },
      { onConflict: "connector_account_id,capability" },
    ]);
  });
});

describe("filter helpers", () => {
  it("escapes LIKE wildcards and quotes or-clause values", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(ilike("eric")).toBe("%eric%");
    expect(orIlike('eric "the" studio, inc')).toBe('"%eric the studio, inc%"');
  });
});
