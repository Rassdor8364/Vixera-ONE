import { describe, expect, it } from "vitest";
import { ref } from "@vixera/domain";
import { CONTEXT_BUDGET_CEILING, CONTEXT_FIELD_ALLOWLIST, ContextSelectionError, byteLength, selectContext, type ContextItem } from "./index.ts";

const mail = (id: string, extra: Record<string, string> = {}): ContextItem => ({
  ref: ref("mail_message", id),
  fields: { subject: "Invoice 0231", snippet: "Please find attached", receivedAt: "2026-09-10T10:00:00Z", fromDisplayName: "Eric", hasAttachments: true, ...extra },
});

describe("selectContext", () => {
  it("keeps only allow-listed fields: bodies, snippets and raw addresses never reach a prompt", () => {
    const sel = selectContext([mail("m1", { body: "SECRET BODY", bodyText: "SECRET BODY", fromEmail: "eric@example.com", accessToken: "x" })]);
    expect(sel.items[0]?.fields).toEqual({ subject: "Invoice 0231", receivedAt: "2026-09-10T10:00:00Z" });
    expect(sel.serialize()).not.toContain("SECRET BODY");
    expect(sel.serialize()).not.toContain("Please find attached"); // the snippet is a body excerpt
    expect(sel.serialize()).not.toContain("eric@example.com");
  });

  it("the manifest describes what was sent by reference and field name only", () => {
    const sel = selectContext([mail("m1"), { ref: ref("person", "p1"), fields: { displayName: "Eric Lindqvist", email: "e@x" } }]);
    expect(sel.manifest.itemCount).toBe(2);
    expect(sel.manifest.refs).toEqual([ref("mail_message", "m1"), ref("person", "p1")]);
    expect(sel.manifest.fieldsByType).toEqual({ mail_message: ["receivedAt", "subject"], person: ["displayName"] });
    expect(JSON.stringify(sel.manifest)).not.toContain("Eric");
    expect(sel.manifest.bytes).toBe(byteLength(sel.serialize()));
  });

  it("enforces the byte and item budgets and counts what it dropped", () => {
    const many = Array.from({ length: 10 }, (_, i) => mail(`m${i}`));
    expect(selectContext(many, { maxItems: 3 }).manifest).toMatchObject({ itemCount: 3, truncatedItems: 7 });
    const tight = selectContext(many, { maxBytes: 300 });
    expect(tight.manifest.bytes).toBeLessThanOrEqual(300);
    expect(tight.manifest.itemCount + tight.manifest.truncatedItems).toBe(10);
  });

  it("cuts long string fields rather than sending whole documents", () => {
    const sel = selectContext([{ ref: ref("document", "d1"), fields: { title: "x".repeat(2000) } }], { maxFieldChars: 20 });
    expect(sel.items[0]?.fields["title"]).toHaveLength(20);
    expect(String(sel.items[0]?.fields["title"])).toMatch(/…$/);
  });

  it("refuses an entity type with no allow-list instead of silently sending nothing", () => {
    expect(() => selectContext([{ ref: { type: "secret_table" as never, id: "1" }, fields: { a: 1 } }])).toThrow(ContextSelectionError);
  });

  it("a caller cannot raise the budget past the ceiling, and a zero field cap cannot leak a field", () => {
    const many = Array.from({ length: 300 }, (_, i) => mail(`m${i}`));
    const huge = selectContext(many, { maxBytes: 10 * 1024 * 1024, maxItems: 10_000, maxFieldChars: 1_000_000 });
    expect(huge.manifest.bytes).toBeLessThanOrEqual(CONTEXT_BUDGET_CEILING.maxBytes);
    expect(huge.manifest.itemCount).toBeLessThanOrEqual(CONTEXT_BUDGET_CEILING.maxItems);
    const zero = selectContext([{ ref: ref("document", "d1"), fields: { title: "x".repeat(100) } }], { maxFieldChars: 0 });
    expect(String(zero.items[0]?.fields["title"]).length).toBeLessThanOrEqual(8);
    const nan = selectContext([mail("m1")], { maxBytes: Number.NaN, maxItems: -5 });
    expect(nan.manifest.itemCount).toBe(1);
  });

  it("counts bytes on the wire, not UTF-16 units", () => {
    const sel = selectContext([{ ref: ref("thread", "t1"), fields: { title: "Björk — 𝄞" } }]);
    expect(sel.manifest.bytes).toBe(byteLength(sel.serialize()));
    expect(sel.manifest.bytes).toBeGreaterThan(sel.serialize().length);
  });

  it("every allow-list is narrow: no field name that smells like a body, address or token", () => {
    const forbidden = /body|html|email|address|phone|token|secret|password|raw|snippet|content$|bodyText/i;
    for (const [type, fields] of Object.entries(CONTEXT_FIELD_ALLOWLIST)) {
      for (const f of fields) expect(f, `${type}.${f}`).not.toMatch(forbidden);
    }
  });

  it("serializes deterministically: same items, same text, sorted fields", () => {
    const a = selectContext([{ ref: ref("thread", "t1"), fields: { title: "Brand", status: "open" } }]);
    const b = selectContext([{ ref: ref("thread", "t1"), fields: { status: "open", title: "Brand" } }]);
    expect(a.serialize()).toBe(b.serialize());
    expect(a.serialize()).toBe('thread:t1 {"status":"open","title":"Brand"}');
  });
});
