import { describe, expect, it } from "vitest";
import historyFixture from "../__fixtures__/gmail-history.json";
import htmlOnly from "../__fixtures__/gmail-message-html-only.json";
import multipart from "../__fixtures__/gmail-message-multipart.json";
import profile from "../__fixtures__/gmail-profile.json";
import { FAKE_OAUTH, collect, makeContext } from "../testing/context.ts";
import { createFakeFetch, type FakeRoute } from "../testing/fake-fetch.ts";
import { GMAIL_API, parseGmailCheckpoint, planHistory, syncMail } from "./sync.ts";

const options = { oauth: FAKE_OAUTH, backfillDays: 30, concurrency: 2 };

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
  it("pages users/me/messages with newer_than, fetches with bounded concurrency, and yields a checkpoint per page", async () => {
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
          return ids.includes(id) ? { json: messageWithId(id) } : { status: 404, json: {} };
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
    // a 404 on an individual message (deleted between list and get) is skipped, not fatal
    expect(pages[1]?.batch.messages.map((m) => m.externalId)).toEqual(["a3"]);
    expect(pages[1]?.checkpoint).toEqual({ historyId: "884000" });
    expect(pages[1]?.done).toBe(true);

    const lists = fake.callsTo("/users/me/messages?");
    expect(lists[0]?.url.searchParams.get("q")).toBe("newer_than:30d");
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
    expect(pages[0]?.checkpoint).toEqual({ historyId: "990000", backfill: { pageToken: "p2", since: "2026-08-11T12:00:00.000Z", fullResync: true } });
    expect(pages[1]?.checkpoint).toEqual({ historyId: "990000" });
    expect(ctx.logs.some((l) => l.message === "gmail.history.expired")).toBe(true);
    // a resumed resync page keeps the fullResync marker
    const resumed = parseGmailCheckpoint(pages[0]!.checkpoint);
    expect(resumed?.backfill?.fullResync).toBe(true);
  });

  it("treats an unrecognized checkpoint as a fresh full resync", async () => {
    const fake = createFakeFetch([
      { match: `${GMAIL_API}/profile`, reply: { json: profile } },
      { match: (url) => url.pathname.endsWith("/users/me/messages"), reply: { json: {} } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { deltaLink: "not-gmail" }, options));
    expect(pages).toEqual([{ batch: { messages: [], deleted: [] }, checkpoint: { historyId: "884000" }, done: true, fullResync: true }]);
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
