import { describe, expect, it } from "vitest";
import { ref } from "@vixera/domain";
import { CommandExecutor, matchesKind, type CommandResult } from "./executor.ts";
import type { CommandContext } from "./intent.ts";
import { briefReader, briefWorld, BRIEF_NOW, person, document } from "./testing/brief-world.ts";
import { FakeSpineReader } from "./testing/fake-spine-reader.ts";

const ctx: CommandContext = { area: "now", focus: null, now: BRIEF_NOW };
const world = briefWorld();

function ids(result: CommandResult): string[] {
  return result.items.map((i) => {
    switch (i.type) {
      case "person":
        return i.person.id;
      case "thread":
        return i.thread.id;
      case "document":
        return i.document.id;
      case "mail":
        return i.message.id;
      case "time_event":
        return i.event.id;
      case "transaction":
        return i.transaction.id;
    }
  });
}

describe("CommandExecutor", () => {
  const reader = briefReader();
  const executor = new CommandExecutor(reader);

  it("find_person navigates to Eric", async () => {
    const result = await executor.execute({ type: "find_person", query: "eric" }, ctx);
    expect(result.kind).toBe("navigate");
    expect(result.area).toBe("people");
    expect(result.focus).toEqual(ref("person", world.eric.id));
    expect(ids(result)).toEqual([world.eric.id]);
    expect(result.title).toBe("Eric Lindqvist");
  });

  it("show_person_documents lists Invoice #0231 for Eric (edge + mail attachment), nothing else", async () => {
    const result = await executor.execute({ type: "show_person_documents", personQuery: "eric" }, ctx);
    expect(result.kind).toBe("results");
    expect(result.area).toBe("files");
    expect(result.focus).toEqual(ref("person", world.eric.id));
    expect(ids(result)).toEqual([world.invoice.id]);
  });

  it("finds a document reachable only through the person's mail", async () => {
    const onlyViaMail = briefReader((w) => ({
      ...w,
      edges: (w.edges ?? []).filter((e) => !(e.from.type === "person" && e.to.type === "document")),
    }));
    const result = await new CommandExecutor(onlyViaMail).execute({ type: "show_person_documents", personQuery: "eric" }, ctx);
    expect(ids(result)).toEqual([world.invoice.id]);
  });

  it("show_person_mail lists Eric's mail, recent first", async () => {
    const result = await executor.execute({ type: "show_person_mail", personQuery: "Eric Lindqvist" }, ctx);
    expect(ids(result)).toEqual([world.ericInvoiceMail.id]);
  });

  it("show_events today returns only today's events, in order", async () => {
    const result = await executor.execute({ type: "show_events", range: "today" }, ctx);
    expect(result.area).toBe("time");
    expect(ids(result)).toEqual([world.brandReview.id]);
    expect(result.title).toBe("Today");
  });

  it("show_events tomorrow / week / explicit range", async () => {
    expect(ids(await executor.execute({ type: "show_events", range: "tomorrow" }, ctx))).toEqual([world.northwindKickoff.id]);
    // 2026-09-10 is a Thursday: Mon 7 – Sun 13. Last week's sync (Sep 4) and next Monday's planning (Sep 14) are out.
    expect(ids(await executor.execute({ type: "show_events", range: "week" }, ctx))).toEqual([world.brandReview.id, world.northwindKickoff.id]);
    const explicit = await executor.execute({ type: "show_events", range: { from: "2026-09-01T00:00:00Z", to: "2026-09-30T00:00:00Z" } }, ctx);
    expect(ids(explicit)).toEqual([world.lastWeekSync.id, world.brandReview.id, world.northwindKickoff.id, world.nextMondayPlanning.id]);
  });

  it("show_events is half-open: an event that ended exactly at midnight is yesterday's, one starting at midnight is today's", async () => {
    const { event } = await import("./testing/brief-world.ts");
    const endedAtMidnight = event(8, "Late night", "2026-09-09T23:00:00.000Z", "2026-09-10T00:00:00.000Z");
    const startsAtMidnight = event(9, "Early start", "2026-09-10T00:00:00.000Z", "2026-09-10T00:30:00.000Z");
    const r = briefReader((w) => ({ ...w, events: [...(w.events ?? []), endedAtMidnight, startsAtMidnight] }));
    expect(ids(await new CommandExecutor(r).execute({ type: "show_events", range: "today" }, ctx))).toEqual([startsAtMidnight.id, world.brandReview.id]);
  });

  it("show_events falls back to UTC instead of throwing on an invalid timezone", async () => {
    const bad: CommandContext = { ...ctx, timezone: "Not/AZone" };
    expect(ids(await executor.execute({ type: "show_events", range: "today" }, bad))).toEqual([world.brandReview.id]);
  });

  it("show_events respects the user's timezone when computing today", async () => {
    // 09:00Z on Sep 10 is still Sep 9 in Honolulu (UTC-10): the Brand review at 14:00Z is 04:00 local Sep 10 → "tomorrow".
    const honolulu: CommandContext = { ...ctx, timezone: "Pacific/Honolulu" };
    expect(ids(await executor.execute({ type: "show_events", range: "today" }, honolulu))).toEqual([]);
    expect(ids(await executor.execute({ type: "show_events", range: "tomorrow" }, honolulu))).toEqual([world.brandReview.id]);
  });

  it("find_document invoice from Eric → Invoice #0231, focused", async () => {
    const result = await executor.execute({ type: "find_document", kind: "invoice", fromPersonQuery: "eric" }, ctx);
    expect(ids(result)).toEqual([world.invoice.id]);
    expect(result.focus).toEqual(ref("document", world.invoice.id));
    expect(result.title).toBe("Invoices from Eric Lindqvist");
  });

  it("find_document by kind and by query without a person", async () => {
    expect(ids(await executor.execute({ type: "find_document", kind: "agreement" }, ctx))).toEqual([world.agreement.id]);
    expect(ids(await executor.execute({ type: "find_document", kind: "pdf" }, ctx))).toEqual([world.invoice.id, world.agreement.id]);
    expect(ids(await executor.execute({ type: "find_document", query: "northwind" }, ctx))).toEqual([world.brief.id]);
    const none = await executor.execute({ type: "find_document", kind: "image" }, ctx);
    expect(none.items).toEqual([]);
    expect(none.message).toMatch(/No images found/);
  });

  it("show_recent_files sorts by updatedAt descending regardless of store order and honours the limit", async () => {
    const result = await executor.execute({ type: "show_recent_files", limit: 10 }, ctx);
    expect(ids(result)).toEqual([world.invoice.id, world.brief.id, world.agreement.id]);
    const two = await executor.execute({ type: "show_recent_files", limit: 2 }, ctx);
    expect(ids(two)).toEqual([world.invoice.id, world.brief.id]);
  });

  it("show_transactions related to Brand: direct edge plus two hops through the invoice", async () => {
    const result = await executor.execute({ type: "show_transactions", scope: { threadQuery: "brand" } }, ctx);
    expect(result.area).toBe("money");
    expect(result.focus).toEqual(ref("thread", world.brand.id));
    expect(ids(result)).toEqual([world.ericPayment.id, world.brandPrinting.id]);
  });

  it("show_transactions for Northwind and for a person; unscoped with a range", async () => {
    expect(ids(await executor.execute({ type: "show_transactions", scope: { threadQuery: "northwind pilot" } }, ctx))).toEqual([world.northwindDeposit.id]);
    expect(ids(await executor.execute({ type: "show_transactions", scope: { personQuery: "eric" } }, ctx))).toEqual([world.ericPayment.id]);
    expect(ids(await executor.execute({ type: "show_transactions", range: "week" }, ctx))).toEqual([world.coffee.id, world.ericPayment.id]);
    expect(ids(await executor.execute({ type: "show_transactions", range: "month" }, ctx))).toEqual([world.coffee.id, world.ericPayment.id, world.northwindDeposit.id]);
    expect(ids(await executor.execute({ type: "show_transactions" }, ctx))).toEqual([world.coffee.id, world.ericPayment.id, world.northwindDeposit.id, world.brandPrinting.id]);
  });

  it("show_thread and open_area navigate", async () => {
    const thread = await executor.execute({ type: "show_thread", query: "Brand" }, ctx);
    expect(thread).toMatchObject({ kind: "navigate", area: "threads", focus: ref("thread", world.brand.id), title: "Brand" });
    const money = await executor.execute({ type: "open_area", area: "money" }, ctx);
    expect(money).toEqual({ kind: "navigate", area: "money", focus: null, title: "Money", items: [] });
  });

  it("unknown intents produce an unknown result with a message", async () => {
    const result = await executor.execute({ type: "unknown", text: "make me a sandwich" }, ctx);
    expect(result.kind).toBe("unknown");
    expect(result.items).toEqual([]);
    expect(result.message).toContain("make me a sandwich");
  });

  it("an ambiguous name yields candidates rather than a wrong pick", async () => {
    const chen = person(9, "Marta Chen", "marta@chen.example");
    const twoMartas = new CommandExecutor(briefReader((w) => ({ ...w, people: [...(w.people ?? []), chen] })));
    const result = await twoMartas.execute({ type: "show_person_documents", personQuery: "marta" }, ctx);
    expect(result.kind).toBe("results");
    expect(result.area).toBe("people");
    expect(result.focus).toBeNull();
    expect(ids(result).sort()).toEqual([world.marta.id, chen.id].sort());
    expect(result.message).toMatch(/Several people match "marta"/);
    // The full name still resolves.
    const exact = await twoMartas.execute({ type: "find_person", query: "Marta Ruiz" }, ctx);
    expect(exact.focus).toEqual(ref("person", world.marta.id));
  });

  it("an unknown name is an empty result, not an error", async () => {
    const result = await executor.execute({ type: "show_person_documents", personQuery: "nobody" }, ctx);
    expect(result.items).toEqual([]);
    expect(result.message).toMatch(/No one named "nobody"/);
  });

  it("the focused person wins when a scoped intent names them, even with a namesake", async () => {
    const namesake = person(7, "Eric Lindqvist", "eric@other.example");
    const r = briefReader((w) => ({ ...w, people: [...(w.people ?? []), namesake] }));
    const focused: CommandContext = { ...ctx, area: "people", focus: ref("person", world.eric.id) };
    const result = await new CommandExecutor(r).execute({ type: "show_person_documents", personQuery: "Eric Lindqvist" }, focused);
    expect(result.focus).toEqual(ref("person", world.eric.id));
    expect(ids(result)).toEqual([world.invoice.id]);
    const unfocused = await new CommandExecutor(r).execute({ type: "show_person_documents", personQuery: "Eric Lindqvist" }, ctx);
    expect(unfocused.message).toMatch(/Several people match/);
  });

  it("never phrases a query with a user id: the reader is the only user boundary", async () => {
    const r = briefReader();
    const ex = new CommandExecutor(r);
    await ex.execute({ type: "show_person_documents", personQuery: "eric" }, ctx);
    await ex.execute({ type: "show_transactions", scope: { threadQuery: "brand" } }, ctx);
    await ex.execute({ type: "show_events", range: "today" }, ctx);
    const serialized = JSON.stringify(r.calls.map((c) => c.args));
    expect(serialized).not.toContain(r.userId);
    expect(serialized).not.toMatch(/userId|user_id/);
  });

  it("matchesKind uses title, mime type and metadata.kind", () => {
    expect(matchesKind(world.invoice, "invoice")).toBe(true);
    expect(matchesKind(world.invoice, "pdf")).toBe(true);
    expect(matchesKind(world.invoice, "contract")).toBe(false);
    expect(matchesKind(world.agreement, "agreement")).toBe(true);
    const photo = document(9, "site visit", "image/jpeg", BRIEF_NOW.toISOString());
    expect(matchesKind(photo, "image")).toBe(true);
    expect(matchesKind(photo, "pdf")).toBe(false);
    const tagged = document(10, "scan 0042", null, BRIEF_NOW.toISOString(), { metadata: { kind: "invoice" } });
    expect(matchesKind(tagged, "invoice")).toBe(true);
  });
});

describe("thread transactions also reach rows linked through a person", () => {
  it("finds a merchant-matched transaction with no document between it and the thread", async () => {
    // The only path is thread → person (user attached) and person → transaction
    // (the linker matched the merchant). Nothing links the thread to the row.
    const w = briefWorld();
    const reader = new FakeSpineReader({
      people: [w.eric],
      threads: [w.brand],
      transactions: [w.ericPayment],
      edges: [
        { from: ref("thread", w.brand.id), kind: "has_person", to: ref("person", w.eric.id) },
        { from: ref("money_transaction", w.ericPayment.id), kind: "has_person", to: ref("person", w.eric.id), confidence: 0.8 },
      ],
    });
    const result = await new CommandExecutor(reader).execute({ type: "show_transactions", scope: { threadQuery: "brand" } }, ctx);
    expect(ids(result)).toEqual([w.ericPayment.id]);
  });
});
