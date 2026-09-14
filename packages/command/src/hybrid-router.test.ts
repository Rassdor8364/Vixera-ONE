import { describe, expect, it, vi } from "vitest";
import { HybridIntentRouter } from "./hybrid-router.ts";
import type { CommandContext } from "./intent.ts";
import { ModelIntentRouter, type IntentClassifier } from "./model-router.ts";
import { RuleBasedIntentRouter, type IntentRouter, type RoutedIntent } from "./router.ts";
import { briefReader, BRIEF_NOW } from "./testing/brief-world.ts";

const ctx: CommandContext = { area: "now", focus: null, now: BRIEF_NOW };
const rules = new RuleBasedIntentRouter(briefReader());
const stub = (answer: RoutedIntent): IntentRouter & { route: ReturnType<typeof vi.fn> } => ({ route: vi.fn(async () => answer) });

describe("HybridIntentRouter", () => {
  it("a confident grammar match never reaches the model", async () => {
    const model = stub({ intent: { type: "open_area", area: "quiet" }, confidence: 0.85, matchedRule: "model.open_area" });
    const routed = await new HybridIntentRouter(rules, model).route("Find Eric.", ctx);
    expect(routed).toMatchObject({ intent: { type: "find_person", query: "eric" }, source: "rules" });
    expect(model.route).not.toHaveBeenCalled();
  });

  it("with no model wired it is exactly the rule-based router", async () => {
    const hybrid = new HybridIntentRouter(rules, null);
    for (const text of ["Find Eric.", "asdf qwerty", "show transactions"]) {
      const a = await hybrid.route(text, ctx);
      const b = await rules.route(text, ctx);
      expect(a).toEqual({ ...b, source: "rules" });
    }
  });

  it("when the rules are unsure, a more confident model answer wins", async () => {
    // "asdf qwerty" matches no rule → unknown, 0
    const model = stub({ intent: { type: "show_events", range: "tomorrow" }, confidence: 0.7, matchedRule: "model.show_events" });
    const consulted = vi.fn();
    const routed = await new HybridIntentRouter(rules, model, { onConsulted: consulted }).route("asdf qwerty", ctx);
    expect(routed).toMatchObject({ intent: { type: "show_events", range: "tomorrow" }, confidence: 0.7, source: "model" });
    expect(consulted).toHaveBeenCalledWith(expect.objectContaining({ confidence: 0 }), expect.objectContaining({ confidence: 0.7 }), "model");
  });

  it("a model answer that is unknown, or no more confident than the rules, is ignored", async () => {
    // "find operating agreement" → find_document at 0.6 (below the 0.8 threshold)
    const weaker = stub({ intent: { type: "open_area", area: "money" }, confidence: 0.5, matchedRule: "model.open_area" });
    expect(await new HybridIntentRouter(rules, weaker).route("find operating agreement", ctx)).toMatchObject({ intent: { type: "find_document", query: "operating agreement" }, source: "rules" });
    const unknown = stub({ intent: { type: "unknown", text: "x" }, confidence: 0, matchedRule: null });
    expect(await new HybridIntentRouter(rules, unknown).route("find operating agreement", ctx)).toMatchObject({ intent: { type: "find_document", query: "operating agreement" }, source: "rules" });
  });

  it("a model that fails changes nothing: the rules' answer stands", async () => {
    const failing: IntentClassifier = { classify: async () => { throw new Error("boom"); } };
    const hybrid = new HybridIntentRouter(rules, new ModelIntentRouter(failing));
    expect(await hybrid.route("find operating agreement", ctx)).toMatchObject({ intent: { type: "find_document", query: "operating agreement" }, source: "rules" });
    expect(await hybrid.route("asdf qwerty", ctx)).toMatchObject({ intent: { type: "unknown", text: "asdf qwerty" }, confidence: 0, source: "rules" });
  });

  it("the threshold is configurable and a model can never outrank a certain match", async () => {
    const model = stub({ intent: { type: "open_area", area: "quiet" }, confidence: 0.85, matchedRule: "model.open_area" });
    // "show transactions" routes at 0.8 by the rules; with threshold 0.9 the model is consulted…
    const routed = await new HybridIntentRouter(rules, model, { threshold: 0.9 }).route("show transactions", ctx);
    expect(model.route).toHaveBeenCalledTimes(1);
    expect(routed.source).toBe("model");
    // …but a grammar-certain match ("open money" is 1.0; "Find Eric." is 0.9, a
    // whole-name-token match) clears any threshold ≤ 1, so the model is not asked.
    model.route.mockClear();
    const certain = await new HybridIntentRouter(rules, model, { threshold: 1.0 }).route("open money", ctx);
    expect(certain).toMatchObject({ intent: { type: "open_area", area: "money" }, confidence: 1, source: "rules" });
    expect(model.route).not.toHaveBeenCalled();
  });
});
