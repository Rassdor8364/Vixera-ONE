import { describe, expect, it } from "vitest";
import multipart from "../__fixtures__/gmail-message-multipart.json";
import htmlOnly from "../__fixtures__/gmail-message-html-only.json";
import { MAX_BODY_CHARS, decodeBase64Url, htmlToText, normalizeGmailMessage, parseRfc2822Date } from "./normalize.ts";
import type { GmailMessage } from "./types.ts";

const raw = multipart as unknown as GmailMessage;

describe("normalizeGmailMessage (multipart with PDF)", () => {
  const m = normalizeGmailMessage(raw);

  it("keeps ids and the thread", () => {
    expect(m.externalId).toBe("18f2a1c3d4e5f607");
    expect(m.externalThreadId).toBe("18f2a1c3d4e5f600");
    expect(m.subject).toBe("Invoice #4800 — Brand");
  });

  it("parses addresses through the domain helpers (lowercased, quoted names with commas)", () => {
    expect(m.from).toEqual({ email: "eric.lindqvist@example.com", name: "Eric Lindqvist" });
    expect(m.to).toEqual([
      { email: "jane.doe@example.com", name: "Doe, Jane" },
      { email: "me@example.com", name: null },
    ]);
    expect(m.cc).toEqual([{ email: "accounts@example.org", name: "Accounts" }]);
  });

  it("derives receivedAt from internalDate and sentAt from the Date header (comment stripped)", () => {
    expect(m.receivedAt).toBe("2026-09-08T14:03:11.000Z");
    expect(m.sentAt).toBe("2026-09-08T14:03:11.000Z");
  });

  it("prefers the text/plain part over html", () => {
    expect(m.bodyText).toBe("Hi,\n\nAttached is the invoice for the Brand work: $4,800 due Friday.\n\nThanks,\nEric");
  });

  it("lists the PDF attachment and nothing else", () => {
    expect(m.attachments).toEqual([{ attachmentId: "ANGjdJ8fakeAttachmentId0001", filename: "invoice-4800.pdf", mimeType: "application/pdf", sizeBytes: 38122 }]);
  });

  it("maps UNREAD to isUnread and keeps labels", () => {
    expect(m.isUnread).toBe(true);
    expect(m.labels).toEqual(["INBOX", "UNREAD", "IMPORTANT"]);
    expect(m.metadata).toEqual({ gmailHistoryId: "884211", sizeEstimate: 48211, rfcMessageId: "<invoice-4800@mail.example.com>" });
  });

  it("does not carry provider-only structure or a user id", () => {
    expect(m).not.toHaveProperty("payload");
    expect(m).not.toHaveProperty("userId");
  });
});

describe("normalizeGmailMessage (html only, read, inline image)", () => {
  const m = normalizeGmailMessage(htmlOnly as unknown as GmailMessage);

  it("strips tags, scripts and entities from html when there is no text/plain", () => {
    expect(m.bodyText).toBe("Hello there,\nYour order 'A-1' has shipped & will arrive on Monday.\nRegards,\nShop <Team>");
  });

  it("ignores inline images without filename", () => {
    expect(m.attachments).toEqual([]);
  });

  it("is read, has a bare-address sender, and sentAt null for an unparsable Date header", () => {
    expect(m.isUnread).toBe(false);
    expect(m.from).toEqual({ email: "shop@example.net", name: null });
    expect(m.sentAt).toBeNull();
    expect(m.receivedAt).toBe("2026-09-09T06:40:00.000Z");
    expect(m.snippet).toBe("Hello there, Your order 'A-1' has shipped & will arrive on Monday.");
  });
});

describe("body handling", () => {
  it("truncates long bodies to MAX_BODY_CHARS", () => {
    const long = "x".repeat(MAX_BODY_CHARS + 500);
    const data = btoa(long).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const m = normalizeGmailMessage({ id: "m1", internalDate: "1788876191000", payload: { mimeType: "text/plain", body: { data } } });
    expect(m.bodyText).toHaveLength(MAX_BODY_CHARS);
  });

  it("decodes base64url with unicode and honours the part charset", () => {
    const bytes = new TextEncoder().encode("Faktura – 4 800 kr ✓");
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const data = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeBase64Url(data)).toBe("Faktura – 4 800 kr ✓");
    expect(decodeBase64Url(data, "no-such-charset")).toBe("Faktura – 4 800 kr ✓");
  });

  it("converts html blocks to line breaks and decodes numeric entities", () => {
    expect(htmlToText("<p>a&#x41;&#66;</p><ul><li>one</li><li>two</li></ul>")).toBe("aAB\none\ntwo");
  });

  it("rejects a message with no usable date", () => {
    expect(() => normalizeGmailMessage({ id: "m2", payload: { headers: [{ name: "Date", value: "junk" }] } })).toThrow(/no usable date/);
  });

  it("parses RFC 2822 dates and returns null otherwise", () => {
    expect(parseRfc2822Date("Tue, 8 Sep 2026 16:03:11 +0200 (CEST)")).toBe("2026-09-08T14:03:11.000Z");
    expect(parseRfc2822Date("yesterday-ish")).toBeNull();
    expect(parseRfc2822Date(undefined)).toBeNull();
  });
});
