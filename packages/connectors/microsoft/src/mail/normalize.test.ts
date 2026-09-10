import { describe, expect, it } from "vitest";
import attachmentsFixture from "../__fixtures__/mail-attachments.json";
import htmlMessage from "../__fixtures__/mail-message-html.json";
import { MAX_BODY_CHARS, normalizeAttachments, normalizeGraphMessage } from "./normalize.ts";
import type { GraphAttachment, GraphMessage } from "./types.ts";

const raw = htmlMessage as GraphMessage;
const attachments = attachmentsFixture.value as GraphAttachment[];

describe("normalizeGraphMessage", () => {
  it("normalizes an HTML message with a file attachment into the domain shape", () => {
    const message = normalizeGraphMessage(raw, attachments);
    expect(message.externalId).toBe("AAMkAGfake-msg-html");
    expect(message.externalThreadId).toBe("AAQkAGfake-conv-1");
    expect(message.subject).toBe("Invoice #4711 from Eric");
    expect(message.snippet).toBe("Hi, attached is the invoice for the Brand work.");
    expect(message.bodyText).toBe("Hi,\nAttached is the invoice for the Brand work – due tomorrow.\nTotal: €4,800\n\nEric");
    expect(message.from).toEqual({ email: "eric.lindqvist@studio.example", name: "Eric Lindqvist" });
    expect(message.to).toEqual([{ email: "me@example.com", name: null }]);
    expect(message.cc).toEqual([{ email: "anna@studio.example", name: "Anna Berg" }]);
    expect(message.sentAt).toBe("2026-09-09T08:15:00.000Z");
    expect(message.receivedAt).toBe("2026-09-09T08:15:07.000Z");
    expect(message.isUnread).toBe(true);
    expect(message.labels).toEqual(["Finance", "Brand"]);
    expect(message.attachments).toEqual([{ attachmentId: "att-invoice", filename: "invoice-4711.pdf", mimeType: "application/pdf", sizeBytes: 48213 }]);
    expect(message.metadata).toEqual({ lastModifiedDateTime: "2026-09-09T08:15:09Z", hasAttachments: true });
  });

  it("keeps provider fields out of the normalized object", () => {
    const message = normalizeGraphMessage(raw, attachments);
    const json = JSON.stringify(message);
    expect(json).not.toContain("toRecipients");
    expect(json).not.toContain("bodyPreview");
    expect(json).not.toContain("@odata");
  });

  it("maps isRead → isUnread and keeps text bodies as-is (CRLF folded)", () => {
    const message = normalizeGraphMessage({ ...raw, isRead: true, hasAttachments: false, body: { contentType: "text", content: "Line 1\r\nLine 2\r\n" } });
    expect(message.isUnread).toBe(false);
    expect(message.bodyText).toBe("Line 1\nLine 2");
    expect(message.attachments).toEqual([]);
  });

  it("truncates very long bodies and falls back to sentDateTime for receivedAt", () => {
    const message = normalizeGraphMessage({ ...raw, receivedDateTime: null, body: { contentType: "text", content: "x".repeat(MAX_BODY_CHARS + 10) } });
    expect(message.bodyText?.length).toBe(MAX_BODY_CHARS);
    expect(message.receivedAt).toBe("2026-09-09T08:15:00.000Z");
  });

  it("rejects messages without id or any timestamp", () => {
    expect(() => normalizeGraphMessage({ ...raw, id: "" })).toThrow(/without id/);
    expect(() => normalizeGraphMessage({ ...raw, receivedDateTime: null, sentDateTime: null })).toThrow(/receivedDateTime/);
  });
});

describe("normalizeAttachments", () => {
  it("keeps only non-inline file attachments", () => {
    expect(normalizeAttachments(attachments).map((a) => a.attachmentId)).toEqual(["att-invoice"]);
  });

  it("tolerates missing @odata.type and missing name/size", () => {
    expect(normalizeAttachments([{ id: "a1" }])).toEqual([{ attachmentId: "a1", filename: "attachment", mimeType: null, sizeBytes: null }]);
  });
});
