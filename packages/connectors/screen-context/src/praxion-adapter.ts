/**
 * ScreenContextAdapter backed by Praxion structured content (source "praxion").
 *
 * Primary screen-context source in Phase 1. Praxion tells Vixera which
 * document is focused, where in it the user is, what is selected, and the
 * document's structured blocks; this adapter folds those into one
 * `ScreenContext`. It never inspects pixels or windows, and it never talks
 * to Praxion except through `PraxionConnector` (which is cheap when Praxion
 * is absent: one cached probe).
 */
import type { JsonObject, ScreenContext, ScreenContextAdapter, StructuredBlock } from "@vixera/domain";
import { PraxionRequestError, type PraxionConnector } from "@vixera/praxion";

export interface PraxionAdapterOptions {
  /** Cap on structured blocks carried into the ScreenContext. Default 500. */
  readonly maxBlocks?: number;
  /** Fetch structured content at all (false = document + location + selection only). Default true. */
  readonly includeContent?: boolean;
}

export class PraxionStructuredContentAdapter implements ScreenContextAdapter {
  readonly id = "praxion";
  readonly source = "praxion" as const;
  private readonly connector: PraxionConnector;
  private readonly maxBlocks: number;
  private readonly includeContent: boolean;

  constructor(connector: PraxionConnector, options: PraxionAdapterOptions = {}) {
    if (options.maxBlocks !== undefined && (!Number.isInteger(options.maxBlocks) || options.maxBlocks < 0)) {
      throw new TypeError("maxBlocks must be a non-negative integer");
    }
    this.connector = connector;
    this.maxBlocks = options.maxBlocks ?? 500;
    this.includeContent = options.includeContent ?? true;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.connector.availability()).state === "available";
  }

  async getCurrentContext(): Promise<ScreenContext | null> {
    const current = await this.connector.currentContext();
    if (!current || !current.document) return null;
    const doc = current.document;

    let blocks: readonly StructuredBlock[] | null = null;
    let serverTruncated = false;
    let clientTruncated = false;
    let contentError: string | null = null;
    if (this.includeContent) {
      // The document, its location and the selection are the context; the
      // content is the best part of it, not a condition for it. A content
      // endpoint that errors (a document Praxion cannot parse) must not turn
      // the whole ScreenContext into null, or the registry would fall through
      // to a stale explicit capture and describe the wrong document.
      let content: Awaited<ReturnType<PraxionConnector["getContent"]>> = null;
      try {
        content = await this.connector.getContent(doc.id);
      } catch (error) {
        if (!(error instanceof PraxionRequestError)) throw error;
        contentError = error.code;
      }
      if (content) {
        serverTruncated = content.truncated;
        clientTruncated = content.blocks.length > this.maxBlocks;
        blocks = clientTruncated ? content.blocks.slice(0, this.maxBlocks) : content.blocks;
      }
    }

    const location = current.location ?? null;
    const selection = current.selection ?? location?.selectionText ?? null;

    const metadata: JsonObject = {
      praxionDocumentId: doc.id,
      pageCount: doc.pageCount,
      blockCount: blocks ? blocks.length : 0,
      contentAvailable: blocks !== null,
      truncated: serverTruncated || clientTruncated,
      ...(contentError ? { contentError } : {}),
    };

    return {
      source: "praxion",
      capturedAt: current.capturedAt,
      document: {
        title: doc.title,
        externalRef: doc.path ?? doc.id,
        mimeType: doc.mimeType,
        praxionDocumentId: doc.id,
      },
      location,
      selection,
      structuredContent: blocks,
      text: null,
      metadata,
    };
  }
}
