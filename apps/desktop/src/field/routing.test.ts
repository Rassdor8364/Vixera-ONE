import { describe, expect, it } from "vitest";
import type { CommandResult } from "@vixera/command";
import { briefWorld } from "@vixera/command/testing";
import { areaForEntity, locationForItem, locationForResult, parseShortcut, readLastArea } from "./routing.ts";

describe("shortcuts", () => {
  it("opens One Command on Alt+Space and Ctrl/Cmd+K, closes on Escape", () => {
    expect(parseShortcut({ key: " ", altKey: true })).toBe("open-command");
    expect(parseShortcut({ key: "k", ctrlKey: true })).toBe("open-command");
    expect(parseShortcut({ key: "K", metaKey: true })).toBe("open-command");
    expect(parseShortcut({ key: "Escape" })).toBe("close");
    expect(parseShortcut({ key: "k" })).toBeNull();
    expect(parseShortcut({ key: " " })).toBeNull();
    expect(parseShortcut({ key: "k", ctrlKey: true, altKey: true })).toBeNull();
  });
});

describe("routing", () => {
  const world = briefWorld();

  it("maps entity types to areas", () => {
    expect(areaForEntity("person")).toBe("people");
    expect(areaForEntity("money_transaction")).toBe("money");
    expect(areaForEntity("document")).toBe("files");
    expect(areaForEntity("context_event")).toBe("now");
    // Mail is context inside People (there is no mail area); the People area
    // resolves a focused message to its sender.
    expect(areaForEntity("mail_message")).toBe("people");
    expect(areaForEntity("time_event")).toBe("time");
    expect(areaForEntity("ingest_item")).toBe("files");
    expect(areaForEntity("handoff")).toBe("now");
  });

  it("turns result items into focus locations", () => {
    const eric = world.eric;
    expect(locationForItem({ type: "person", person: eric })).toEqual({ area: "people", focus: { type: "person", id: eric.id } });
    const doc = world.invoice;
    expect(locationForItem({ type: "document", document: doc })).toEqual({ area: "files", focus: { type: "document", id: doc.id } });
  });

  it("navigates for navigate results and single-entity results only", () => {
    const current = { area: "now" as const, focus: null };
    const nav: CommandResult = { kind: "navigate", area: "money", title: "Money", items: [] };
    expect(locationForResult(nav, current)).toEqual({ area: "money", focus: null });
    const eric = world.eric;
    const one: CommandResult = { kind: "results", area: "people", focus: { type: "person", id: eric.id }, title: "Eric", items: [{ type: "person", person: eric }] };
    expect(locationForResult(one, current)).toEqual({ area: "people", focus: { type: "person", id: eric.id } });
    const many: CommandResult = { kind: "results", area: "files", title: "Files", items: [{ type: "document", document: world.invoice }, { type: "document", document: world.agreement }] };
    expect(locationForResult(many, current)).toBeNull();
    const unknown: CommandResult = { kind: "unknown", title: "?", items: [], message: "I don't know that yet" };
    expect(locationForResult(unknown, current)).toBeNull();
  });

  it("restores a valid last area only", () => {
    expect(readLastArea({ getItem: () => "money" })).toBe("money");
    expect(readLastArea({ getItem: () => "dashboard" })).toBe("now");
    expect(readLastArea(null)).toBe("now");
  });
});
