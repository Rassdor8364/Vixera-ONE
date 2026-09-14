import { describe, expect, it, vi } from "vitest";
import { ref } from "@vixera/domain";
import type { CommandContext } from "./intent.ts";
import { ModelIntentRouter, type IntentClassifier, type IntentClassifierInput } from "./model-router.ts";
import { BRIEF_NOW } from "./testing/brief-world.ts";

const ctx: CommandContext = { area: "now", focus: ref("thread", "thread-1"), now: BRIEF_NOW, timezone: "Europe/Stockholm" };
const classifierReturning = (value: unknown, confidence = 0.7): IntentClassifier => ({ classify: vi.fn(async () => ({ intent: value, confidence })) });

describe("ModelIntentRouter", () => {
  it("hands the classifier the text, area, focus TYPE and timezone — never the focus id or any names", async () => {
    const classifier = classifierReturning({ type: "find_person", query: "eric" });
    await new ModelIntentRouter(classifier).route("find eric", ctx);
    const input = (classifier.classify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as IntentClassifierInput;
    expect(input).toMatchObject({ text: "find eric", area: "now", focusType: "thread", timezone: "Europe/Stockholm" });
    expect(JSON.stringify(input)).not.toContain("thread-1");
    expect(input.catalog.length).toBeGreaterThan(5);
  });

  it("returns a typed intent with the model's confidence, capped", async () => {
    const routed = await new ModelIntentRouter(classifierReturning({ type: "show_thread", query: "brand" }, 0.99)).route("brand pls", ctx);
    expect(routed).toEqual({ intent: { type: "show_thread", query: "brand" }, confidence: 0.85, matchedRule: "model.show_thread", source: "model" });
    expect((await new ModelIntentRouter(classifierReturning({ type: "show_thread", query: "brand" }, 0.5), { maxConfidence: 0.6 }).route("x", ctx)).confidence).toBe(0.5);
  });

  it("anything that is not an Intent becomes unknown with confidence 0", async () => {
    for (const bad of [{ type: "execute_sql", sql: "drop table people" }, { type: "find_person" }, "find eric", null, { type: "unknown", text: "x" }]) {
      const routed = await new ModelIntentRouter(classifierReturning(bad, 1)).route("find eric", ctx);
      expect(routed).toEqual({ intent: { type: "unknown", text: "find eric" }, confidence: 0, matchedRule: null, source: "model" });
    }
  });

  it("a classifier that throws (unavailable, timeout, cancelled) is the same as no answer", async () => {
    const classifier: IntentClassifier = { classify: async () => { throw new Error("ModelTimeoutError"); } };
    const routed = await new ModelIntentRouter(classifier).route("find eric", ctx);
    expect(routed.intent).toEqual({ type: "unknown", text: "find eric" });
    expect(routed.confidence).toBe(0);
  });

  it("nonsense confidence is clamped into 0..1", async () => {
    expect((await new ModelIntentRouter(classifierReturning({ type: "open_area", area: "money" }, Number.NaN)).route("x", ctx)).confidence).toBe(0);
    expect((await new ModelIntentRouter(classifierReturning({ type: "open_area", area: "money" }, -3)).route("x", ctx)).confidence).toBe(0);
  });
});
