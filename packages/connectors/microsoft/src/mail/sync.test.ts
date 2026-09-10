import { describe, expect, it } from "vitest";
import attachmentsFixture from "../__fixtures__/mail-attachments.json";
import page1 from "../__fixtures__/mail-delta-page1.json";
import page2 from "../__fixtures__/mail-delta-page2.json";
import { collect, FAKE_OAUTH, makeContext } from "../testing/context.ts";
import { createFakeFetch, sequence, type FakeRoute } from "../testing/fake-fetch.ts";
import { parseMailCheckpoint, syncMail, type MailSyncOptions } from "./sync.ts";

const OPTIONS: MailSyncOptions = { oauth: FAKE_OAUTH, backfillDays: 30, pageSize: 50 };
const DELTA_1 = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-delta-1";
const attachmentsRoute: FakeRoute = { match: "/me/messages/AAMkAGfake-msg-html/attachments", reply: { json: attachmentsFixture } };

describe("syncMail (Microsoft Graph delta)", () => {
  it("starts an initial backfill with select, receivedDateTime filter and text-body preference", async () => {
    const fake = createFakeFetch([
      { match: /messages\/delta\?\$select=/, reply: { json: { value: [], "@odata.deltaLink": DELTA_1 } } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, null, OPTIONS));
    expect(pages).toEqual([{ batch: { messages: [], deleted: [] }, checkpoint: { deltaLink: DELTA_1 }, done: true }]);

    const call = fake.calls[0];
    expect(call?.url.toString()).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/mailFolders\/inbox\/messages\/delta\?\$select=/);
    expect(call?.url.search).toContain("$filter=receivedDateTime%20ge%20");
    expect(call?.url.searchParams.get("$select")).toContain("conversationId");
    expect(call?.url.searchParams.get("$select")).toContain("lastModifiedDateTime");
    expect(call?.url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-08-11T12:00:00.000Z");
    expect(call?.headers.prefer).toBe('odata.maxpagesize=50, outlook.body-content-type="text"');
    expect(call?.headers.authorization).toBe("Bearer fake-access-token-1");
  });

  it("follows nextLink pages, yields each as a page, and only the last page carries the new deltaLink", async () => {
    const fake = createFakeFetch([
      { match: "$skiptoken=fake-skip-1", reply: { json: page2 } },
      { match: "/messages/delta", reply: { json: page1 } },
      attachmentsRoute,
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, null, OPTIONS));
    expect(pages).toHaveLength(2);

    const [first, second] = pages;
    expect(first?.done).toBe(false);
    expect(first?.checkpoint).toBeNull(); // no previous delta round to fall back on
    expect(first?.fullResync).toBeUndefined();
    expect(first?.batch.messages.map((m) => m.externalId)).toEqual(["AAMkAGfake-msg-html", "AAMkAGfake-msg-text"]);
    expect(first?.batch.messages[0]?.attachments).toEqual([{ attachmentId: "att-invoice", filename: "invoice-4711.pdf", mimeType: "application/pdf", sizeBytes: 48213 }]);
    expect(first?.batch.messages[0]?.bodyText).toBe("Hi, attached is the invoice for the Brand work.");
    expect(first?.batch.messages[1]?.attachments).toEqual([]);

    expect(second?.done).toBe(true);
    expect(second?.checkpoint).toEqual({ deltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-delta-2" });
    expect(second?.batch.messages.map((m) => m.externalId)).toEqual(["AAMkAGfake-msg-3"]);
    expect(second?.batch.deleted).toEqual([{ externalId: "AAMkAGfake-msg-gone" }]);

    // Attachments are fetched only for messages that have them, with the metadata select.
    const attachmentCalls = fake.callsTo("/attachments");
    expect(attachmentCalls).toHaveLength(1);
    expect(attachmentCalls[0]?.url.searchParams.get("$select")).toBe("id,name,contentType,size,isInline");
    // The nextLink is followed verbatim (Graph encodes the paging state in it).
    expect(fake.callsTo("$skiptoken=")[0]?.url.toString()).toBe(page1["@odata.nextLink"]);
  });

  it("resumes from a stored deltaLink and keeps it on intermediate pages", async () => {
    const fake = createFakeFetch([
      { match: "$skiptoken=fake-skip-1", reply: { json: page2 } },
      { match: "$deltatoken=fake-delta-1", reply: { json: page1 } },
      attachmentsRoute,
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { deltaLink: DELTA_1 }, OPTIONS));
    expect(fake.calls[0]?.url.toString()).toBe(DELTA_1);
    expect(fake.calls[0]?.url.searchParams.has("$filter")).toBe(false);
    expect(pages[0]?.checkpoint).toEqual({ deltaLink: DELTA_1 });
    expect(pages[1]?.checkpoint).toEqual({ deltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-delta-2" });
    expect(pages.every((p) => p.fullResync === undefined)).toBe(true);
  });

  it("restarts from the initial backfill with fullResync when the delta token is gone (410)", async () => {
    const fake = createFakeFetch([
      { match: "$deltatoken=fake-delta-1", reply: { status: 410, json: { error: { code: "SyncStateNotFound", message: "The sync state is not found." } } } },
      { match: "$skiptoken=fake-skip-1", reply: { json: page2 } },
      { match: /messages\/delta\?\$select=/, reply: { json: page1 } },
      attachmentsRoute,
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { deltaLink: DELTA_1 }, OPTIONS));
    expect(pages).toHaveLength(2);
    expect(pages.every((p) => p.fullResync === true)).toBe(true);
    expect(pages[0]?.checkpoint).toBeNull();
    expect(pages[1]?.done).toBe(true);
    expect(pages[1]?.checkpoint).toEqual({ deltaLink: "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=fake-delta-2" });
    expect(fake.calls[1]?.url.searchParams.get("$filter")).toMatch(/^receivedDateTime ge /);
    expect(ctx.logs.map((l) => l.message)).toContain("microsoft.mail.delta.expired");
  });

  it("treats an unparseable checkpoint as a full resync instead of trusting it", async () => {
    const fake = createFakeFetch([{ match: /messages\/delta\?\$select=/, reply: { json: { value: [], "@odata.deltaLink": DELTA_1 } } }]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, { deltaLink: "https://evil.example/steal?token" }, OPTIONS));
    expect(pages[0]?.fullResync).toBe(true);
    expect(fake.calls.every((c) => c.url.hostname === "graph.microsoft.com")).toBe(true);
  });

  it("skips a message whose attachment listing 404s the message away, and keeps the rest", async () => {
    const fake = createFakeFetch([
      { match: "/messages/delta", reply: { json: { value: page1.value, "@odata.deltaLink": DELTA_1 } } },
      { match: "/attachments", reply: { status: 404, json: { error: { code: "ErrorItemNotFound", message: "gone" } } } },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, null, OPTIONS));
    expect(pages[0]?.batch.messages.map((m) => m.externalId)).toEqual(["AAMkAGfake-msg-html", "AAMkAGfake-msg-text"]);
    expect(pages[0]?.batch.messages[0]?.attachments).toEqual([]);
  });

  it("refreshes once on 401 and retries the same delta request", async () => {
    const fake = createFakeFetch([
      { match: "/oauth2/v2.0/token", reply: { json: { access_token: "fake-access-token-2", refresh_token: "fake-refresh-2", expires_in: 3600 } } },
      { match: "/messages/delta", reply: sequence({ status: 401, json: { error: { code: "InvalidAuthenticationToken" } } }, { json: { value: [], "@odata.deltaLink": DELTA_1 } }) },
    ]);
    const ctx = makeContext(fake.fetch);
    const pages = await collect(syncMail(ctx, null, OPTIONS));
    expect(pages).toHaveLength(1);
    const deltaCalls = fake.callsTo("/messages/delta");
    expect(deltaCalls).toHaveLength(2);
    expect(deltaCalls[1]?.headers.authorization).toBe("Bearer fake-access-token-2");
    expect(ctx.refreshed).toHaveLength(1);
  });
});

describe("parseMailCheckpoint", () => {
  it("accepts only https Graph delta links", () => {
    expect(parseMailCheckpoint(null)).toBeNull();
    expect(parseMailCheckpoint({})).toBeNull();
    expect(parseMailCheckpoint({ deltaLink: 5 })).toBeNull();
    expect(parseMailCheckpoint({ deltaLink: "http://graph.microsoft.com/x" })).toBeNull();
    expect(parseMailCheckpoint({ deltaLink: DELTA_1 })).toEqual({ deltaLink: DELTA_1 });
  });
});
