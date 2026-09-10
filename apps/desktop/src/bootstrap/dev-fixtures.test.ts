/**
 * The dev dispatcher must behave like `action-dispatch`: same envelope
 * shapes, idempotent by key (replay ⇒ stored outcome, no re-execution),
 * audited in action_requests, failure reported as an outcome.
 */
import { describe, expect, it } from "vitest";
import { ACTION_TYPES, DEV_USER_ID, ref, type ActionEnvelope } from "@vixera/domain";
import { MOCK_NOW, ERIC_EMAIL } from "@vixera/sync/testing";
import { buildEnvelope } from "../data/actions.ts";
import { attachKindFor, createDevActionDispatcher, createDevWorld } from "./dev-fixtures.ts";

describe("dev world", () => {
  it("syncs the mock world and seeds the Brand thread around Eric", async () => {
    const world = await createDevWorld(DEV_USER_ID, { now: () => new Date(MOCK_NOW) });
    const eric = await world.store.findPersonByIdentity("email", ERIC_EMAIL);
    expect(eric?.displayName).toBe("Eric Lindqvist");
    const [brand] = await world.store.listThreads();
    expect(brand?.title).toBe("Brand");
    const neighbors = await world.store.neighbors(ref("thread", brand?.id ?? ""));
    expect(neighbors.some((n) => n.ref.type === "person" && n.ref.id === eric?.id)).toBe(true);
    expect(neighbors.some((n) => n.ref.type === "document")).toBe(true);
    expect((await world.store.listContextEvents()).length).toBeGreaterThan(0);
  });
});

describe("dev action dispatcher parity", () => {
  it("executes once per idempotency key and replays the stored outcome", async () => {
    const world = await createDevWorld(DEV_USER_ID, { now: () => new Date(MOCK_NOW) });
    const [event] = await world.store.listContextEvents({ attention: "needs_attention", limit: 1 });
    const envelope = buildEnvelope("context_event.quiet", { contextEventId: event?.id ?? "" }, { actorDeviceId: "dev-1" });
    const first = await world.dispatch(envelope);
    expect(first).toMatchObject({ status: "done", replayed: false, error: null });
    expect((await world.store.getContextEvent(event?.id ?? ""))?.attention).toBe("quiet");
    await world.store.setContextEventAttention(event?.id ?? "", "needs_attention");
    const second = await world.dispatch(envelope);
    expect(second).toMatchObject({ status: "done", replayed: true, actionRequestId: first.actionRequestId });
    // replay never re-executes
    expect((await world.store.getContextEvent(event?.id ?? ""))?.attention).toBe("needs_attention");
    const audit = await world.store.findActionRequestByKey(envelope.idempotencyKey);
    expect(audit?.status).toBe("done");
    expect(audit?.actorDeviceId).toBe("dev-1");
  });

  it("reports failures as outcomes, not exceptions", async () => {
    const world = await createDevWorld(DEV_USER_ID, { now: () => new Date(MOCK_NOW) });
    const outcome = await world.dispatch(buildEnvelope("context_event.dismiss", { contextEventId: "00000000-0000-4000-8000-00000000dead" }));
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBeTruthy();
    const unknown = await world.dispatch({ actionType: "nope" as never, idempotencyKey: "k", payload: {} as never });
    expect(unknown.status).toBe("failed");
  });

  it("covers every ACTION_TYPE with the domain payload shapes", async () => {
    const world = await createDevWorld(DEV_USER_ID, { now: () => new Date(MOCK_NOW) });
    const store = world.store;
    const eric = await store.findPersonByIdentity("email", ERIC_EMAIL);
    const [doc] = await store.listDocuments({ limit: 1 });
    const [ev] = await store.listContextEvents({ limit: 1 });
    const priya = (await store.listPeople({ search: "priya" }))[0];
    for (const id of ["win", "droid"]) await store.upsertDevice({ id, platform: "windows", name: id, praxionAvailable: false, lastSeenAt: null });
    const envelopes: ActionEnvelope[] = [
      buildEnvelope("context_event.dismiss", { contextEventId: ev?.id ?? "" }),
      buildEnvelope("context_event.quiet", { contextEventId: ev?.id ?? "" }),
      buildEnvelope("context_event.snooze", { contextEventId: ev?.id ?? "", until: "2026-09-12T09:00:00Z" }),
      buildEnvelope("thread.create", { title: "Northwind", attach: [{ entityType: "person", entityId: priya?.id ?? "" }] }),
      buildEnvelope("thread.attach", { threadId: (await store.listThreads())[0]?.id ?? "", entityType: "document", entityId: doc?.id ?? "" }),
      buildEnvelope("handoff.create", { sourceDeviceId: "win", targetDeviceId: "droid", focus: { type: "document", id: doc?.id ?? "" }, documentId: doc?.id ?? "" }),
      buildEnvelope("ingest.submit", { kind: "text", source: "capture", textContent: "note", deviceId: "win" }),
      buildEnvelope("connector.sync_now", { connectorAccountId: null }),
      buildEnvelope("person.merge", { survivorId: eric?.id ?? "", mergedId: priya?.id ?? "" }),
    ];
    for (const e of envelopes) {
      const o = await world.dispatch(e);
      expect(o.status, e.actionType).toBe("done");
    }
    const [handoff] = await store.listHandoffs();
    const accept = await world.dispatch(buildEnvelope("handoff.accept", { handoffId: handoff?.id ?? "", deviceId: "droid" }));
    expect(accept.status).toBe("done");
    expect((await store.getHandoff(handoff?.id ?? ""))?.state).toBe("accepted");
    const covered = new Set([...envelopes.map((e) => e.actionType), "handoff.accept"]);
    for (const t of ACTION_TYPES) expect(covered.has(t), t).toBe(true);
    expect(attachKindFor("person")).toBe("has_person");
    expect(attachKindFor("conclusion")).toBe("relates_to");
    void createDevActionDispatcher;
  });
});
