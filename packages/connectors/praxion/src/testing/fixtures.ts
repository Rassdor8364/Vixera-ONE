/**
 * Fixture documents for the in-memory Praxion fake. Shared by unit tests and
 * by `scripts/mock-server.ts`. Obviously fake paths and hashes; no personal
 * data.
 */
import type { InMemoryPraxionDocument } from "./in-memory-praxion.ts";

export const OPERATING_AGREEMENT: InMemoryPraxionDocument = {
  id: "doc-operating-agreement-v3",
  title: "Operating agreement v3.pdf",
  path: "C:\\Users\\example\\Documents\\Brand\\Operating agreement v3.pdf",
  mimeType: "application/pdf",
  pageCount: 18,
  sizeBytes: 412_884,
  contentHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  createdAt: "2026-08-21T09:12:00.000Z",
  modifiedAt: "2026-09-08T16:40:00.000Z",
  metadata: { producer: "Praxion mock", author: "Example Legal LLP" },
  location: { page: 7, position: { x: 0.12, y: 0.48 }, selectionText: "7.1 Distributions shall be made quarterly" },
  selection: "7.1 Distributions shall be made quarterly, pro rata to each Member's Percentage Interest, within 30 days of quarter end.",
  blocks: [
    { kind: "heading", text: "Article 7 — Distributions", page: 7 },
    { kind: "paragraph", text: "7.1 Distributions shall be made quarterly, pro rata to each Member's Percentage Interest, within 30 days of quarter end.", page: 7 },
    { kind: "paragraph", text: "7.2 No distribution shall be made if, after giving effect to it, the Company would be unable to pay its debts as they become due.", page: 7 },
    { kind: "list_item", text: "(a) Tax distributions take priority over discretionary distributions.", page: 7 },
    { kind: "list_item", text: "(b) The Managing Member may withhold reserves it deems reasonable.", page: 8 },
    { kind: "heading", text: "Article 8 — Transfers of Interests", page: 9 },
    { kind: "paragraph", text: "8.1 No Member may transfer any Interest without the prior written consent of the other Members.", page: 9 },
  ],
};

export const INVOICE_0231: InMemoryPraxionDocument = {
  id: "doc-invoice-0231",
  title: "Invoice 0231 — Brand identity.pdf",
  path: "C:\\Users\\example\\Documents\\Brand\\Invoice 0231.pdf",
  mimeType: "application/pdf",
  pageCount: 2,
  sizeBytes: 88_120,
  contentHash: "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  createdAt: "2026-09-01T12:00:00.000Z",
  modifiedAt: "2026-09-01T12:00:00.000Z",
  metadata: { producer: "Praxion mock" },
  location: { page: 1, position: null, selectionText: null },
  selection: null,
  blocks: [
    { kind: "heading", text: "Invoice 0231", page: 1 },
    { kind: "paragraph", text: "Brand identity — phase 2 deliverables.", page: 1 },
    { kind: "table", text: "Design retainer | 1 | 4,800.00 USD\nTotal due | | 4,800.00 USD", page: 1 },
    { kind: "paragraph", text: "Payment due within 14 days of the invoice date.", page: 2 },
  ],
};

export const FIXTURE_DOCUMENTS: readonly InMemoryPraxionDocument[] = [OPERATING_AGREEMENT, INVOICE_0231];
