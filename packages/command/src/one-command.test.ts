import { describe, expect, it } from "vitest";
import { ref } from "@vixera/domain";
import { CommandExecutor } from "./executor.ts";
import { CommandHistory } from "./history.ts";
import type { CommandContext } from "./intent.ts";
import { OneCommand } from "./one-command.ts";
import { RuleBasedIntentRouter } from "./router.ts";
import { briefReader, briefWorld, BRIEF_NOW } from "./testing/brief-world.ts";

const ctx: CommandContext = { area: "now", focus: null, now: BRIEF_NOW };
const world = briefWorld();

describe("OneCommand end to end (brief examples)", () => {
  const reader = briefReader();
  const one = new OneCommand({ router: new RuleBasedIntentRouter(reader), executor: new CommandExecutor(reader) });

  it("Find Eric.", async () => {
    const { routed, result } = await one.run("Find Eric.", ctx);
    expect(routed.intent.type).toBe("find_person");
    expect(result.focus).toEqual(ref("person", world.eric.id));
  });

  it("Show Eric's documents.", async () => {
    const { result } = await one.run("Show Eric's documents.", ctx);
    expect(result.items).toEqual([{ type: "document", document: world.invoice }]);
  });

  it("Show today's events.", async () => {
    const { result } = await one.run("Show today's events.", ctx);
    expect(result.items).toEqual([{ type: "time_event", event: world.brandReview }]);
  });

  it("Find the invoice from Eric.", async () => {
    const { result } = await one.run("Find the invoice from Eric.", ctx);
    expect(result.items).toEqual([{ type: "document", document: world.invoice }]);
    expect(result.focus).toEqual(ref("document", world.invoice.id));
  });

  it("Show recent files.", async () => {
    const { result } = await one.run("Show recent files.", ctx);
    expect(result.items.map((i) => (i.type === "document" ? i.document.title : ""))).toEqual(["Invoice #0231", "Northwind pilot brief.docx", "Operating agreement v3.pdf"]);
  });

  it("Show transactions related to Brand.", async () => {
    const { result } = await one.run("Show transactions related to Brand.", ctx);
    expect(result.items.map((i) => (i.type === "transaction" ? i.transaction.description : ""))).toEqual(["Payment to Lindqvist Studio", "Print shop — brand collateral"]);
  });

  it("open money", async () => {
    const { result } = await one.run("open money", ctx);
    expect(result).toMatchObject({ kind: "navigate", area: "money" });
  });

  it("documents while focused on Eric", async () => {
    const { routed, result } = await one.run("documents", { ...ctx, area: "people", focus: ref("person", world.eric.id) });
    expect(routed.intent).toEqual({ type: "show_person_documents", personQuery: "Eric Lindqvist" });
    expect(result.items).toEqual([{ type: "document", document: world.invoice }]);
  });

  it("unknown text", async () => {
    const { routed, result } = await one.run("make me a sandwich", ctx);
    expect(routed).toEqual({ intent: { type: "unknown", text: "make me a sandwich" }, confidence: 0, matchedRule: null });
    expect(result.kind).toBe("unknown");
  });

  it("records understood commands in history (oldest first, for handoff.commandHistory)", () => {
    expect(one.history.toArray()).toEqual([
      "Find Eric.",
      "Show Eric's documents.",
      "Show today's events.",
      "Find the invoice from Eric.",
      "Show recent files.",
      "Show transactions related to Brand.",
      "open money",
      "documents",
    ]);
  });
});

describe("CommandHistory", () => {
  it("is a bounded ring that collapses consecutive duplicates", () => {
    const h = new CommandHistory(3);
    h.push("a");
    h.push("a");
    h.push("b");
    h.push(" ");
    h.push("c");
    h.push("d");
    expect(h.toArray()).toEqual(["b", "c", "d"]);
    expect(h.recent(2)).toEqual(["d", "c"]);
    expect(h.recent(0)).toEqual([]);
    expect(h.size).toBe(3);
    h.clear();
    expect(h.size).toBe(0);
    expect(() => new CommandHistory(0)).toThrow();
  });
});
