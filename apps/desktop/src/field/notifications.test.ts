import { describe, expect, it } from "vitest";
import type { NowItem } from "@vixera/domain";
import { createNeedsMeNotifier, pickNewNeedsMe, readShownIds, writeShownIds } from "./notifications.ts";

function item(id: string | null, title = "Invoice"): NowItem {
  return { bucket: "needs_me", score: 90, title, summary: null, subject: { type: "document", id: "d" }, contextEventId: id, kind: "mail.received", occurredAt: "2026-09-10T08:00:00Z", dueAt: null, threadIds: [], reasons: [] };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe("needs-me notifications", () => {
  it("only picks items not yet shown, skipping untrackable ones", () => {
    expect(pickNewNeedsMe([item("a"), item("b"), item(null)], new Set(["a"])).map((i) => i.contextEventId)).toEqual(["b"]);
  });

  it("round-trips shown ids through storage", () => {
    const s = memoryStorage();
    writeShownIds(s, new Set(["x", "y"]));
    expect([...readShownIds(s)]).toEqual(["x", "y"]);
    expect(readShownIds({ getItem: () => "not json" }).size).toBe(0);
  });

  it("announces each context event once per device and never the initial batch", async () => {
    const sent: string[] = [];
    const storage = memoryStorage();
    const n = createNeedsMeNotifier({ storage, send: async (t) => (sent.push(t), true) });
    expect(await n.observe([item("a", "first")])).toEqual([]);
    expect(sent).toEqual([]);
    await n.observe([item("a", "first"), item("b", "second")]);
    await n.observe([item("a", "first"), item("b", "second")]);
    expect(sent).toEqual(["second"]);
    const again = createNeedsMeNotifier({ storage, send: async (t) => (sent.push(t), true), announceInitial: true });
    await again.observe([item("a"), item("b"), item("c", "third")]);
    expect(sent).toEqual(["second", "third"]);
  });
});
