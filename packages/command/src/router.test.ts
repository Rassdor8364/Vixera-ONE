import { describe, expect, it } from "vitest";
import { ref } from "@vixera/domain";
import type { CommandContext, Intent } from "./intent.ts";
import { RuleBasedIntentRouter } from "./router.ts";
import { briefReader, briefWorld, BRIEF_NOW, person } from "./testing/brief-world.ts";

const ctx: CommandContext = { area: "now", focus: null, now: BRIEF_NOW };

describe("RuleBasedIntentRouter", () => {
  const router = new RuleBasedIntentRouter(briefReader());

  const cases: readonly [string, Intent][] = [
    ["Find Eric.", { type: "find_person", query: "eric" }],
    ["who is Marta Ruiz?", { type: "find_person", query: "marta ruiz" }],
    ["Show Eric's documents.", { type: "show_person_documents", personQuery: "eric" }],
    ["show eric’s files", { type: "show_person_documents", personQuery: "eric" }],
    ["Show Eric's mail", { type: "show_person_mail", personQuery: "eric" }],
    ["show messages from marta", { type: "show_person_mail", personQuery: "marta" }],
    ["show documents from Eric", { type: "show_person_documents", personQuery: "eric" }],
    ["Show today's events.", { type: "show_events", range: "today" }],
    ["show today's calendar", { type: "show_events", range: "today" }],
    ["what's today", { type: "show_events", range: "today" }],
    ["What's on tomorrow?", { type: "show_events", range: "tomorrow" }],
    ["show tomorrow's events", { type: "show_events", range: "tomorrow" }],
    ["this week", { type: "show_events", range: "week" }],
    ["Find the invoice from Eric.", { type: "find_document", kind: "invoice", fromPersonQuery: "eric" }],
    ["find the contract from marta", { type: "find_document", kind: "contract", fromPersonQuery: "marta" }],
    ["show the agreement", { type: "find_document", kind: "agreement" }],
    ["find eric's invoices", { type: "find_document", kind: "invoice", fromPersonQuery: "eric" }],
    ["Show recent files.", { type: "show_recent_files", limit: 10 }],
    ["recent documents", { type: "show_recent_files", limit: 10 }],
    ["show the last 5 files", { type: "show_recent_files", limit: 5 }],
    ["Show transactions related to Brand.", { type: "show_transactions", scope: { threadQuery: "brand" } }],
    ["money for northwind pilot", { type: "show_transactions", scope: { threadQuery: "northwind pilot" } }],
    ["transactions with eric this month", { type: "show_transactions", scope: { personQuery: "eric" }, range: "month" }],
    ["show transactions this week", { type: "show_transactions", range: "week" }],
    ["open money", { type: "open_area", area: "money" }],
    ["go to files", { type: "open_area", area: "files" }],
    ["Open calendar", { type: "open_area", area: "time" }],
    ["quiet", { type: "open_area", area: "quiet" }],
    ["show thread Brand", { type: "show_thread", query: "brand" }],
    ["open the northwind pilot thread", { type: "show_thread", query: "northwind pilot" }],
    ["Brand", { type: "show_thread", query: "brand" }],
    ["northwind pilot", { type: "show_thread", query: "northwind pilot" }],
    ["find brand", { type: "show_thread", query: "brand" }],
    ["find operating agreement", { type: "find_document", query: "operating agreement" }],
    // "northwind" is Priya's email domain and a thread title: the thread name wins over a substring hit.
    ["find northwind", { type: "show_thread", query: "northwind" }],
    ["northwind", { type: "show_thread", query: "northwind" }],
    ["eric lindqvist", { type: "find_person", query: "eric lindqvist" }],
    ["eric", { type: "find_person", query: "eric" }],
  ];

  for (const [text, expected] of cases) {
    it(`routes ${JSON.stringify(text)}`, async () => {
      const routed = await router.route(text, ctx);
      expect(routed.intent).toEqual(expected);
      expect(routed.confidence).toBeGreaterThan(0);
      expect(routed.matchedRule).not.toBeNull();
    });
  }

  it("returns unknown with confidence 0 for text it cannot place", async () => {
    for (const text of ["", "   ", "make me a sandwich", "xyzzy plugh", "mail"]) {
      const routed = await router.route(text, ctx);
      expect(routed.intent.type).toBe("unknown");
      expect(routed.confidence).toBe(0);
      expect(routed.matchedRule).toBeNull();
    }
  });

  it("is deterministic: the same text and context always route the same way", async () => {
    const texts = cases.map(([t]) => t);
    const first = await Promise.all(texts.map((t) => router.route(t, ctx)));
    const second = await Promise.all(texts.map((t) => router.route(t, ctx)));
    const again = await Promise.all(texts.map((t) => new RuleBasedIntentRouter(briefReader()).route(t, ctx)));
    expect(second).toEqual(first);
    expect(again).toEqual(first);
  });

  it("scopes bare nouns to the focused person", async () => {
    const world = briefWorld();
    const focused: CommandContext = { ...ctx, area: "people", focus: ref("person", world.eric.id) };
    expect((await router.route("documents", focused)).intent).toEqual({ type: "show_person_documents", personQuery: "Eric Lindqvist" });
    expect((await router.route("show files", focused)).intent).toEqual({ type: "show_person_documents", personQuery: "Eric Lindqvist" });
    expect((await router.route("mail", focused)).intent).toEqual({ type: "show_person_mail", personQuery: "Eric Lindqvist" });
    expect((await router.route("transactions", focused)).intent).toEqual({ type: "show_transactions", scope: { personQuery: "Eric Lindqvist" } });
    expect((await router.route("documents", focused)).matchedRule).toMatch(/focus_person$/);
  });

  it("scopes bare transactions to the focused thread and falls back sensibly without focus", async () => {
    const world = briefWorld();
    const onThread: CommandContext = { ...ctx, area: "threads", focus: ref("thread", world.brand.id) };
    expect((await router.route("transactions", onThread)).intent).toEqual({ type: "show_transactions", scope: { threadQuery: "Brand" } });
    expect((await router.route("transactions", ctx)).intent).toEqual({ type: "show_transactions" });
    expect((await router.route("documents", ctx)).intent).toEqual({ type: "show_recent_files", limit: 10 });
  });

  it("keeps an ambiguous name as a query string instead of picking one", async () => {
    const twoMartas = new RuleBasedIntentRouter(briefReader((w) => ({ ...w, people: [...(w.people ?? []), person(9, "Marta Chen", "marta@chen.example")] })));
    const routed = await twoMartas.route("find marta", ctx);
    expect(routed.intent).toEqual({ type: "find_person", query: "marta" });
    expect(routed.confidence).toBeLessThan(1);
  });

  it("prefers the exact thread over a person with the same words when routing transactions", async () => {
    const world = briefWorld();
    const r = new RuleBasedIntentRouter(briefReader((w) => ({ ...w, people: [...(w.people ?? []), person(8, "Brand Nguyen", "brand@nguyen.example")] })));
    expect((await r.route("show transactions related to brand", ctx)).intent).toEqual({ type: "show_transactions", scope: { threadQuery: "brand" } });
    expect((await r.route("show transactions related to brand nguyen", ctx)).intent).toEqual({ type: "show_transactions", scope: { personQuery: "brand nguyen" } });
    expect(world.brand.title).toBe("Brand");
  });
});
