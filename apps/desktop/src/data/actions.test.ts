import { describe, expect, it } from "vitest";
import { notificationIdempotencyKey, isUuid } from "@vixera/domain";
import { buildEnvelope, idempotencyKeyFor, createHttpActionDispatcher, ActionInProgressError } from "./actions.ts";
import { FunctionError, createHttpFunctionsClient, parseFunctionError } from "./functions.ts";

describe("idempotency keys", () => {
  it("derives notification-style keys from the subject, so a repeat is a replay", () => {
    const a = idempotencyKeyFor("context_event.dismiss", { contextEventId: "ev-1" });
    const b = idempotencyKeyFor("context_event.dismiss", { contextEventId: "ev-1" });
    expect(a).toBe(b);
    expect(a).toBe(notificationIdempotencyKey("context_event.dismiss", "ev-1"));
    expect(idempotencyKeyFor("context_event.quiet", { contextEventId: "ev-1" })).not.toBe(a);
    expect(idempotencyKeyFor("handoff.accept", { handoffId: "h1", deviceId: "d1" })).toBe("handoff.accept:h1:d1");
    expect(idempotencyKeyFor("context_event.snooze", { contextEventId: "ev-1", until: "2026-09-11T00:00:00Z" })).toContain("2026-09-11");
  });

  it("uses a fresh uuid for user-initiated actions", () => {
    const a = idempotencyKeyFor("thread.create", { title: "Brand" });
    const b = idempotencyKeyFor("thread.create", { title: "Brand" });
    expect(isUuid(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isUuid(idempotencyKeyFor("ingest.submit", { kind: "text", source: "capture" }))).toBe(true);
  });

  it("builds an ActionEnvelope with the actor device", () => {
    const env = buildEnvelope("context_event.quiet", { contextEventId: "ev-9" }, { actorDeviceId: "dev-1" });
    expect(env).toEqual({ actionType: "context_event.quiet", idempotencyKey: "context_event.quiet:ev-9", payload: { contextEventId: "ev-9" }, actorDeviceId: "dev-1" });
  });
});

describe("HTTP action dispatch", () => {
  const client = (handler: (url: string, init: RequestInit) => Response) =>
    createHttpFunctionsClient({ baseUrl: "https://x.supabase.co/functions/v1", anonKey: "anon", accessToken: async () => "token", fetchImpl: async (url, init) => handler(String(url), init ?? {}) });

  it("posts the envelope with bearer + apikey headers and returns the outcome", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const dispatch = createHttpActionDispatcher(
      client((url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ status: "done", result: {}, error: null, replayed: false, actionRequestId: "ar-1" }), { status: 200 });
      }),
    );
    const outcome = await dispatch(buildEnvelope("context_event.dismiss", { contextEventId: "ev-1" }));
    expect(outcome.status).toBe("done");
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(s.url).toBe("https://x.supabase.co/functions/v1/action-dispatch");
    const headers = s.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer token");
    expect(headers["apikey"]).toBe("anon");
    expect(JSON.parse(String(s.init.body)).idempotencyKey).toBe("context_event.dismiss:ev-1");
  });

  it("maps 409 in_progress to ActionInProgressError and other errors to FunctionError", async () => {
    const busy = createHttpActionDispatcher(client(() => new Response(JSON.stringify({ error: { code: "in_progress", message: "running" } }), { status: 409 })));
    await expect(busy(buildEnvelope("context_event.dismiss", { contextEventId: "ev-1" }))).rejects.toBeInstanceOf(ActionInProgressError);
    const denied = createHttpActionDispatcher(client(() => new Response(JSON.stringify({ error: { code: "forbidden", message: "nope" } }), { status: 403 })));
    await expect(denied(buildEnvelope("context_event.dismiss", { contextEventId: "ev-1" }))).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(parseFunctionError(401, null)).toEqual({ code: "unauthorized", message: "request failed with status 401" });
  });

  it("refuses to call without a session", async () => {
    const c = createHttpFunctionsClient({ baseUrl: "https://x", anonKey: "a", accessToken: async () => null, fetchImpl: async () => new Response("{}") });
    await expect(c.call("action-dispatch", {})).rejects.toBeInstanceOf(FunctionError);
  });
});
