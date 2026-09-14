import { describe, expect, it } from "vitest";
import { INTENT_CATALOG, parseIntent } from "./intent-schema.ts";
import type { Intent } from "./intent.ts";

describe("parseIntent — the boundary a model's JSON must cross", () => {
  const accepted: readonly [unknown, Intent][] = [
    [{ type: "find_person", query: " eric " }, { type: "find_person", query: "eric" }],
    [{ type: "show_person_documents", personQuery: "eric" }, { type: "show_person_documents", personQuery: "eric" }],
    [{ type: "show_person_mail", personQuery: "eric" }, { type: "show_person_mail", personQuery: "eric" }],
    [{ type: "show_thread", query: "brand" }, { type: "show_thread", query: "brand" }],
    [{ type: "show_events", range: "tomorrow" }, { type: "show_events", range: "tomorrow" }],
    [{ type: "show_events", range: { from: "2026-09-01", to: "2026-09-30" } }, { type: "show_events", range: { from: "2026-09-01", to: "2026-09-30" } }],
    [{ type: "show_events", range: { from: "2028-02-29", to: "2028-02-29T23:59:59Z" } }, { type: "show_events", range: { from: "2028-02-29", to: "2028-02-29T23:59:59Z" } }],
    [{ type: "find_document", kind: "invoice", fromPersonQuery: "eric" }, { type: "find_document", kind: "invoice", fromPersonQuery: "eric" }],
    [{ type: "find_document" }, { type: "find_document" }],
    [{ type: "show_recent_files", limit: 5 }, { type: "show_recent_files", limit: 5 }],
    [{ type: "show_transactions", scope: { threadQuery: "brand" }, range: "month" }, { type: "show_transactions", scope: { threadQuery: "brand" }, range: "month" }],
    [{ type: "show_transactions" }, { type: "show_transactions" }],
    [{ type: "open_area", area: "money" }, { type: "open_area", area: "money" }],
    [{ type: "unknown", text: "??" }, { type: "unknown", text: "??" }],
  ];
  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input)}`, () => expect(parseIntent(input)).toEqual(expected));
  }

  const rejected: readonly [string, unknown][] = [
    ["a type the executor has no case for", { type: "delete_everything", query: "x" }],
    ["a type that looks like an action", { type: "pay_invoice", id: "d1" }],
    ["a missing required field", { type: "find_person" }],
    ["an empty query", { type: "show_thread", query: "   " }],
    ["a query over the length cap", { type: "find_person", query: "x".repeat(201) }],
    ["a limit that is not an integer", { type: "show_recent_files", limit: 2.5 }],
    ["a limit over the cap", { type: "show_recent_files", limit: 10_000 }],
    ["a limit of zero", { type: "show_recent_files", limit: 0 }],
    ["an unknown area", { type: "open_area", area: "settings" }],
    ["an unknown document kind", { type: "find_document", kind: "passport" }],
    ["an unknown transaction range", { type: "show_transactions", range: "year" }],
    ["a scope that is not an object", { type: "show_transactions", scope: "brand" }],
    ["a date range with from after to", { type: "show_events", range: { from: "2026-09-30", to: "2026-09-01" } }],
    ["a date range that is not ISO", { type: "show_events", range: { from: "yesterday", to: "today" } }],
    ["a date that is not on the calendar (V8 would roll Feb 30 to Mar 2)", { type: "show_events", range: { from: "2026-02-30", to: "2026-02-31" } }],
    ["a month that does not exist", { type: "show_events", range: { from: "2026-13-01", to: "2026-13-02" } }],
    ["a time that does not exist", { type: "show_events", range: { from: "2026-09-01T25:00:00Z", to: "2026-09-02T00:00:00Z" } }],
    ["a range whose instants are reversed once offsets are applied", { type: "show_events", range: { from: "2026-09-01T09:00:00Z", to: "2026-09-01T10:00:00+02:00" } }],
    ["a number where a string is expected", { type: "find_person", query: 42 }],
    ["an array", [{ type: "find_person", query: "eric" }]],
    ["a string", "find eric"],
    ["null", null],
    ["a type that is not a string", { type: 1 }],
  ];
  for (const [why, input] of rejected) {
    it(`rejects ${why}`, () => expect(parseIntent(input)).toBeNull());
  }

  it("drops fields the union does not declare rather than passing them through", () => {
    expect(parseIntent({ type: "find_person", query: "eric", userId: "someone-else", sql: "drop table" })).toEqual({ type: "find_person", query: "eric" });
  });

  it("the catalog names every intent type exactly once and every example parses", () => {
    const types = INTENT_CATALOG.map((c) => c.type);
    expect(new Set(types).size).toBe(types.length);
    for (const entry of INTENT_CATALOG) {
      const parsed = parseIntent(JSON.parse(entry.example));
      expect(parsed, entry.type).not.toBeNull();
      expect(parsed?.type).toBe(entry.type);
    }
  });
});
