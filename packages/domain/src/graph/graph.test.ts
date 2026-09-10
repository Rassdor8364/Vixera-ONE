import { describe, expect, it } from "vitest";
import { ContextGraph } from "./graph.ts";
import { edgeKey, ref } from "./relationship.ts";
import { DEV_USER_ID } from "../identity/current-user.ts";
import type { UserId } from "../ids.ts";

const eric = ref("person", "11111111-1111-4111-8111-000000000001");
const invoice = ref("document", "11111111-1111-4111-8111-000000000002");
const brand = ref("thread", "11111111-1111-4111-8111-000000000003");
const mail = ref("mail_message", "11111111-1111-4111-8111-000000000004");
const tx = ref("money_transaction", "11111111-1111-4111-8111-000000000005");
const meeting = ref("time_event", "11111111-1111-4111-8111-000000000006");

function brandGraph(): ContextGraph {
  const g = new ContextGraph(DEV_USER_ID);
  g.relate({ from: eric, kind: "relates_to", to: invoice });
  g.relate({ from: invoice, kind: "belongs_to", to: brand });
  g.relate({ from: invoice, kind: "originated_from", to: mail });
  g.relate({ from: invoice, kind: "relates_to", to: tx });
  g.relate({ from: brand, kind: "has_person", to: eric });
  g.relate({ from: brand, kind: "has_time", to: meeting });
  return g;
}

describe("ContextGraph", () => {
  it("models the brief's example graph", () => {
    const g = brandGraph();
    expect(g.size).toBe(6);
    expect(g.related(brand, "person")).toEqual([eric]);
    expect(g.related(invoice, "thread")).toEqual([brand]);
    expect(g.neighbors(invoice, { kind: "originated_from", direction: "out" })[0]?.ref).toEqual(mail);
  });

  it("dedupes the same fact asserted twice (idempotent relate)", () => {
    const g = brandGraph();
    const first = g.relate({ from: eric, kind: "relates_to", to: invoice, source: "rule" });
    const second = g.relate({ from: eric, kind: "relates_to", to: invoice });
    expect(second.id).toBe(first.id);
    expect(g.size).toBe(6);
  });

  it("direction is part of identity", () => {
    const g = new ContextGraph(DEV_USER_ID);
    g.relate({ from: eric, kind: "relates_to", to: invoice });
    g.relate({ from: invoice, kind: "relates_to", to: eric });
    expect(g.size).toBe(2);
    expect(edgeKey({ from: eric, kind: "relates_to", to: invoice })).not.toBe(
      edgeKey({ from: invoice, kind: "relates_to", to: eric }),
    );
  });

  it("answers neighbors in both directions with typed filters", () => {
    const g = brandGraph();
    const ericNeighbors = g.neighbors(eric);
    expect(ericNeighbors).toHaveLength(2);
    expect(g.neighbors(eric, { direction: "in", type: "thread" })[0]?.ref).toEqual(brand);
    expect(g.neighbors(eric, { direction: "out" }).map((n) => n.ref)).toEqual([invoice]);
  });

  it("reaches the transaction from the thread in two hops", () => {
    const g = brandGraph();
    const two = g.reachable(brand, 2, "money_transaction");
    expect(two).toEqual([tx]);
    expect(g.reachable(brand, 1, "money_transaction")).toEqual([]);
  });

  it("removing an entity removes every edge touching it", () => {
    const g = brandGraph();
    expect(g.removeEntity(invoice)).toBe(4);
    expect(g.size).toBe(2);
    expect(g.related(eric, "document")).toEqual([]);
  });

  it("refuses self-relationships and foreign-user edges", () => {
    const g = brandGraph();
    expect(() => g.relate({ from: eric, kind: "relates_to", to: eric })).toThrow();
    const foreign = new ContextGraph("22222222-2222-4222-8222-222222222222" as UserId);
    const e = foreign.relate({ from: eric, kind: "relates_to", to: invoice });
    expect(() => new ContextGraph(DEV_USER_ID, [e])).toThrow(/another user/);
  });

  it("clamps confidence to [0,1] and defaults source to user", () => {
    const g = new ContextGraph(DEV_USER_ID);
    const e = g.relate({ from: eric, kind: "mentions", to: brand, confidence: 7 });
    expect(e.confidence).toBe(1);
    expect(e.source).toBe("user");
  });
});
