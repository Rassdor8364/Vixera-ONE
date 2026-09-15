import { describe, expect, it } from "vitest";
import historyFixture from "../__fixtures__/gmail-history.json";
import htmlOnly from "../__fixtures__/gmail-message-html-only.json";
import multipart from "../__fixtures__/gmail-message-multipart.json";
import profile from "../__fixtures__/gmail-profile.json";
import { FAKE_OAUTH, collect, makeContext } from "../testing/context.ts";
import { createFakeFetch, type FakeRoute } from "../testing/fake-fetch.ts";
import { GMAIL_API, parseGmailCheckpoint, planHistory, syncMail } from "./sync.ts";

const options = { oauth: FAKE_OAUTH, backfillDays: 30, concurrency: 2 };
/** The backfill window from the mock clock: 30 days back, as epoch seconds for `after:`. */
const SINCE_SECONDS = Math.floor(Date.parse("2026-08-11T12:00:00.000Z") / 1000);
/** What that backfill declares it covers (ADR-017): from the next full second on, whatever `after:` does at the boundary. */
const MAIL_SCOPE = { kind: "mail", receivedSince: "2026-08-11T12:00:01.000Z" };

/** A message fixture with a different id, so list pages can reference several messages. */
function messageWithId(id: string) {
  return { ...(multipart as Record<string, unknown>), id, threadId: id };
}

function messageRoute(ids: readonly string[]): FakeRoute {
  return {
    match: /\/users\/me\/messages\/[^?]+\?format=full/,
    reply: ({ call }) => {
      const id = decodeURIComponent(call.url.pathname.split("/").pop() ?? "");
      if (id === "18f2a1c3d4e5f700") return { json: htmlOnly };
      if (ids.includes(id)) return { json: messageWithId(id) };
      return { status: 404, json: { error: { code: 404, message: "Requested entity was not found." } } };
    },
  };
}

describe("syncMail initial backfill", () => {
  it("pages users/me/messages with an absolute after: window, fetches with bounded concurrency, and yields a checkpoint per page", async () => {
    const ids = ["a1", "a2", "a3"];
    let inFlight = 0;
    let maxInFlight = 0;
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/profile`, reply: { json: profile } },
      {
        match: (url) => url.pathname.endsWith("/users/me/messages"),
        reply: ({ call }) => {
          const token = call.url.searchParams.get("pageToken");
          if (!token) return { json: { messages: [{ id: "a1" }, { id: "a2" }], nextPageToken: "page-2" } };
          return { json: { messages: [{ id: "a3" }, { id: "gone" }] } };
        },
      },
      {
        match: /\/users\/me\/messages\/[^?]+\?format=full/,
        reply: async ({ call }) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight--;
          const id = call.url.pathname.split("/").pop() ?? "";
          return ids.includes(id) ? { json: messageWithId(id) } : { status: 404, json: { error: { code: 404, message: "Requested entity was not found." } } };
        },
      },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, null, options));

    expect(pages).toHaveLength(2);
    expect(pages[0]?.batch.messages.map((m) => m.externalId)).toEqual(["a1", "a2"]);
    expect(pages[0]?.checkpoint).toEqual({ historyId: "884000", backfill: { pageToken: "page-2", since: "2026-08-11T12:00:00.000Z" } });
    expect(pages[0]?.done).toBe(false);
    expect(pages[0]?.fullResync).toBeUndefined();
    // a backfill declares its scope on every page so the engine can reconcile inside it
    expect(pages.map((p) => p.resyncScope)).toEqual([MAIL_SCOPE, MAIL_SCOPE]);
    // a 404 on an individual message (deleted between list and get) is skipped, not fatal
    expect(pages[1]?.batch.messages.map((m) => m.externalId)).toEqual(["a3"]);
    expect(pages[1]?.checkpoint).toEqual({ historyId: "884000" });
    expect(pages[1]?.done).toBe(true);

    const lists = fake.callsTo("/users/me/messages?");
    // drafts and chats never reach the spine; messages.list already excludes SPAM/TRASH by default
    expect(lists[0]?.url.searchParams.get("q")).toBe(`after:${SINCE_SECONDS} -in:drafts -in:chats`);
    expect(lists[0]?.url.searchParams.get("maxResults")).toBe("100");
    expect(lists[1]?.url.searchParams.get("pageToken")).toBe("page-2");
    expect(fake.callsTo("format=full")).toHaveLength(4);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    for (const call of fake.calls) expect(call.headers.authorization).toBe("Bearer fake-access-token-1");
  });

  it("resumes a backfill from the persisted page token without re-reading the profile", async () => {
    const fake = createFakeFetch([
      { match: (url) => url.pathname.endsWith("/users/me/messages"), reply: { json: { messages: [{ id: "b1" }] } } },
      messageRoute(["b1"]),
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { historyId: "884000", backfill: { pageToken: "page-9", since: "2026-08-11T12:00:00.000Z" } }, options));
    // a resumed backfill continues the very query of the pass it resumes (the stored since), and declares that pass's scope
    expect(fake.callsTo("/messages")[0]?.url.searchParams.get("q")).toBe(`after:${SINCE_SECONDS} -in:drafts -in:chats`);
    for (const p of pages) expect(p.resyncScope).toEqual(MAIL_SCOPE);
    expect(fake.callsTo("/profile")).toHaveLength(0);
    expect(fake.callsTo("/users/me/messages?")[0]?.url.searchParams.get("pageToken")).toBe("page-9");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.checkpoint).toEqual({ historyId: "884000" });
    expect(pages[0]?.done).toBe(true);
  });
});

describe("syncMail incremental history", () => {
  it("fetches added and unread-changed messages, emits deletions, and advances historyId", async () => {
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/history`, reply: { json: historyFixture } },
      messageRoute(["18f2a1c3d4e5f800", "18f2a1c3d4e5f607"]),
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { historyId: "884000" }, options));

    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.batch.messages.map((m) => m.externalId).sort()).toEqual(["18f2a1c3d4e5f607", "18f2a1c3d4e5f800"]);
    expect(page.batch.deleted).toEqual([{ externalId: "18f2a1c3d4e5f900" }]);
    expect(page.checkpoint).toEqual({ historyId: "884450" });
    expect(page.done).toBe(true);
    expect(page.fullResync).toBeUndefined();
    expect(page.resyncScope).toBeUndefined(); // a history round never declares a scope: nothing to reconcile

    const history = fake.callsTo("/history")[0]!;
    expect(history.url.searchParams.get("startHistoryId")).toBe("884000");
    expect(history.url.searchParams.getAll("historyTypes")).toEqual(["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]);
    // STARRED-only label change is not re-fetched
    expect(fake.callsTo("18f2a1c3d4e5fa00")).toHaveLength(0);
  });

  it("checkpoints intermediate history pages at the last record id so a crash loses nothing", async () => {
    const fake = createFakeFetch([
      {
        match: `${GMAIL_API}/history`,
        reply: ({ call }) =>
          call.url.searchParams.get("pageToken")
            ? { json: { history: [{ id: "900002", messagesDeleted: [{ message: { id: "z2" } }] }], historyId: "900010" } }
            : { json: { history: [{ id: "900001", messagesDeleted: [{ message: { id: "z1" } }] }], nextPageToken: "h2", historyId: "900010" } },
      },
    ]);
    const pages = await collect(syncMail(makeContext(fake.fetch), { historyId: "884000" }, options));
    expect(pages.map((p) => p.checkpoint)).toEqual([{ historyId: "900001" }, { historyId: "900010" }]);
    expect(pages.map((p) => p.done)).toEqual([false, true]);
    expect(pages[1]?.batch.deleted).toEqual([{ externalId: "z2" }]);
    // the page-2 request keeps the original startHistoryId: only pageToken may differ between pages
    const calls = fake.callsTo("/history");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.searchParams.get("pageToken")).toBe("h2");
    expect(calls[1]?.url.searchParams.get("startHistoryId")).toBe("884000");
  });

  it("falls back to a full backfill with fullResync when history returns 404", async () => {
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/history`, reply: { status: 404, json: { error: { code: 404, message: "Requested entity was not found." } } } },
      { match: `${GMAIL_API}/profile`, reply: { json: { ...profile, historyId: "990000" } } },
      {
        match: (url) => url.pathname.endsWith("/users/me/messages"),
        reply: ({ call }) => (call.url.searchParams.get("pageToken") ? { json: { messages: [{ id: "c2" }] } } : { json: { messages: [{ id: "c1" }], nextPageToken: "p2" } }),
      },
      messageRoute(["c1", "c2"]),
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { historyId: "1" }, options));
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.fullResync === true)).toBe(true);
    expect(pages.map((p) => p.resyncScope)).toEqual([MAIL_SCOPE, MAIL_SCOPE]);
    expect(pages[0]?.checkpoint).toEqual({ historyId: "990000", backfill: { pageToken: "p2", since: "2026-08-11T12:00:00.000Z", fullResync: true } });
    expect(pages[1]?.checkpoint).toEqual({ historyId: "990000" });
    expect(ctx.logs.some((l) => l.message === "gmail.history.expired")).toBe(true);
    // a resumed resync page keeps the fullResync marker
    const resumed = parseGmailCheckpoint(pages[0]!.checkpoint);
    expect(resumed?.backfill?.fullResync).toBe(true);
  });

  it("applies Gmail label semantics: Trash/Spam are deletions, hidden labels are never fetched, restored mail is re-fetched", async () => {
    const fake = createFakeFetch([
      {
        match: `${GMAIL_API}/history`,
        reply: {
          json: {
            history: [
              // user trashed a stored invoice: a deletion, without fetching it
              { id: "900001", labelsAdded: [{ message: { id: "trashed1" }, labelIds: ["TRASH"] }] },
              // Gmail moved a stored message to spam later on
              { id: "900002", labelsAdded: [{ message: { id: "spammed1" }, labelIds: ["SPAM"] }] },
              // an arrival whose history ref carries no labels: fetched, then dropped on its (SPAM) labels
              { id: "900003", messagesAdded: [{ message: { id: "spam-new" } }] },
              // born hidden (a draft being written, mail filed as spam on arrival): never fetched at all
              { id: "900004", messagesAdded: [{ message: { id: "draft1", labelIds: ["DRAFT"] } }, { message: { id: "spam-born", labelIds: ["SPAM", "UNREAD"] } }] },
              // a message the user took out of the trash: fetched again
              { id: "900005", labelsRemoved: [{ message: { id: "restored1" }, labelIds: ["TRASH"] }] },
              // an ordinary arrival
              { id: "900006", messagesAdded: [{ message: { id: "fresh1", labelIds: ["INBOX", "UNREAD"] } }] },
            ],
            historyId: "900010",
          },
        },
      },
      {
        match: /\/users\/me\/messages\/[^?]+\?format=full/,
        reply: ({ call }) => {
          const id = call.url.pathname.split("/").pop() ?? "";
          if (id === "spam-new") return { json: { ...messageWithId(id), labelIds: ["SPAM", "UNREAD"] } };
          return { json: messageWithId(id) };
        },
      },
    ]);
    const pages = await collect(syncMail(makeContext(fake.fetch), { historyId: "884000" }, options));

    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    expect(page.batch.messages.map((m) => m.externalId).sort()).toEqual(["fresh1", "restored1"]);
    expect(page.batch.deleted.map((d) => d.externalId).sort()).toEqual(["spam-new", "spammed1", "trashed1"]);
    expect(page.checkpoint).toEqual({ historyId: "900010" });
    for (const neverFetched of ["trashed1", "spammed1", "draft1", "spam-born"]) expect(fake.callsTo(`/messages/${neverFetched}?`)).toHaveLength(0);
    expect(fake.callsTo("format=full")).toHaveLength(3);
  });

  it("drops a backfilled message that was trashed between list and get, as a deletion", async () => {
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/profile`, reply: { json: profile } },
      { match: (url) => url.pathname.endsWith("/users/me/messages"), reply: { json: { messages: [{ id: "keep" }, { id: "binned" }] } } },
      {
        match: /\/users\/me\/messages\/[^?]+\?format=full/,
        reply: ({ call }) => {
          const id = call.url.pathname.split("/").pop() ?? "";
          return { json: id === "binned" ? { ...messageWithId(id), labelIds: ["TRASH"] } : messageWithId(id) };
        },
      },
    ]);
    const pages = await collect(syncMail(makeContext(fake.fetch), null, options));
    expect(pages[0]?.batch.messages.map((m) => m.externalId)).toEqual(["keep"]);
    expect(pages[0]?.batch.deleted).toEqual([{ externalId: "binned" }]);
  });

  it("never turns a 200 with an empty or non-JSON messages.get body into a deletion", async () => {
    for (const bad of [{ text: "" }, { text: "<html>upstream hiccup</html>" }]) {
      const fake = createFakeFetch([
        { match: `${GMAIL_API}/history`, reply: { json: { history: [{ id: "900001", messagesAdded: [{ message: { id: "flaky" } }] }], historyId: "900010" } } },
        { match: /\/users\/me\/messages\/flaky\?format=full/, reply: { status: 200, ...bad } },
      ]);
      const pages: unknown[] = [];
      const error = await (async () => {
        try {
          for await (const page of syncMail(makeContext(fake.fetch), { historyId: "884000" }, options)) pages.push(page);
          return null;
        } catch (e) {
          return e as { code?: string; retryable?: boolean };
        }
      })();
      // the run fails (retried by the next run from the same historyId) and no page — so no deletion — was emitted
      expect(error).toMatchObject({ code: "invalid_response", retryable: true });
      expect(pages).toEqual([]);
    }
  });

  it("a 404 without Gmail's error body is a failed fetch, not a deletion", async () => {
    for (const bad of [{ text: "" }, { text: "<html>not found</html>" }, { json: {} }]) {
      const fake = createFakeFetch([
        { match: `${GMAIL_API}/history`, reply: { json: { history: [{ id: "900001", messagesAdded: [{ message: { id: "flaky" } }] }], historyId: "900010" } } },
        { match: /\/users\/me\/messages\/flaky\?format=full/, reply: { status: 404, ...bad } },
      ]);
      const pages: unknown[] = [];
      const error = await (async () => {
        try {
          for await (const page of syncMail(makeContext(fake.fetch), { historyId: "884000" }, options)) pages.push(page);
          return null;
        } catch (e) {
          return e as { code?: string; retryable?: boolean };
        }
      })();
      expect(error).toMatchObject({ code: "invalid_response", retryable: true });
      expect(pages).toEqual([]);
    }
  });

  it("treats an unrecognized checkpoint as a fresh full resync", async () => {
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/profile`, reply: { json: profile } },
      { match: (url) => url.pathname.endsWith("/users/me/messages"), reply: { json: {} } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { deltaLink: "not-gmail" }, options));
    expect(pages).toEqual([{ batch: { messages: [], deleted: [] }, checkpoint: { historyId: "884000" }, done: true, fullResync: true, resyncScope: MAIL_SCOPE }]);
    expect(ctx.logs[0]?.message).toBe("gmail.checkpoint.invalid");
  });
});

describe("planHistory", () => {
  it("lets deletion win over add and only re-fetches UNREAD label changes", () => {
    const { toFetch, deleted } = planHistory([
      { id: "1", messagesAdded: [{ message: { id: "x" } }] },
      { id: "2", messagesDeleted: [{ message: { id: "x" } }] },
      { id: "3", labelsAdded: [{ message: { id: "y" }, labelIds: ["UNREAD"] }] },
      { id: "4", labelsRemoved: [{ message: { id: "w" }, labelIds: ["INBOX"] }] },
    ]);
    expect([...toFetch]).toEqual(["y"]);
    expect([...deleted]).toEqual(["x"]);
  });

  it("folds Trash/Spam label changes in order: the last move wins, a purge always wins", () => {
    const { toFetch, deleted } = planHistory([
      // arrived, then trashed: never fetched
      { id: "1", messagesAdded: [{ message: { id: "a" } }] },
      { id: "2", labelsAdded: [{ message: { id: "a" }, labelIds: ["TRASH"] }] },
      // trashed, then taken out again: re-fetched, not deleted
      { id: "3", labelsAdded: [{ message: { id: "b" }, labelIds: ["TRASH"] }] },
      { id: "4", labelsRemoved: [{ message: { id: "b" }, labelIds: ["TRASH"] }] },
      // spam, restored, then purged for good
      { id: "5", labelsAdded: [{ message: { id: "c" }, labelIds: ["SPAM"] }] },
      { id: "6", labelsRemoved: [{ message: { id: "c" }, labelIds: ["SPAM"] }] },
      { id: "7", messagesDeleted: [{ message: { id: "c" } }] },
      // born hidden: no fetch, no deletion either (it was never stored)
      { id: "8", messagesAdded: [{ message: { id: "d", labelIds: ["DRAFT"] } }] },
      { id: "9", messagesAdded: [{ message: { id: "e", labelIds: ["CHAT"] } }] },
    ]);
    expect([...toFetch].sort()).toEqual(["b"]);
    expect([...deleted].sort()).toEqual(["a", "c"]);
  });
});

describe("a stored Gmail page token that Gmail later rejects", () => {
  it("is reported as checkpoint_invalid, so the engine can clear it and restart", async () => {
    const fake = createFakeFetch([
      {
        match: /\/users\/me\/messages\?/,
        reply: ({ call }) =>
          call.url.searchParams.get("pageToken")
            ? { status: 400, json: { error: { code: 400, message: "Invalid pageToken" } } }
            : { json: { messages: [] } },
      },
      { match: `${GMAIL_API}/profile`, reply: { json: profile } },
    ]);
    const ctx = makeContext(fake.fetch);
    const resume = { historyId: "1", backfill: { pageToken: "stale-token", since: "2026-08-10T00:00:00Z" } };

    const error = await collect(syncMail(ctx, resume, options)).then(
      () => null,
      (e: unknown) => e as { code?: string; message?: string },
    );
    expect(error?.code).toBe("checkpoint_invalid");
    expect(error?.message).toContain("page token");

    // With the checkpoint cleared (what the engine does next) the backfill runs.
    const pages = await collect(syncMail(ctx, null, options));
    expect(pages.length).toBeGreaterThan(0);
  });
});
