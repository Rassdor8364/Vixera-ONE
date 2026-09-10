/**
 * ScreenContextAdapter for explicit user capture (source "explicit_capture").
 *
 * The user hands Vixera something on purpose: Android share sheet, a
 * "capture this" button, a drop on the Field. The surface calls `provide()`
 * with what it has (text, title, structured blocks, a document reference);
 * the adapter holds exactly one capture until `clear()` or the next
 * `provide()`. It is available only while a capture is held, so the registry
 * falls through to it only when the user actually gave Vixera something.
 *
 * This is NOT screen reading. Nothing is observed; everything here was
 * explicitly provided.
 */
import type { IsoDateTime, JsonObject, ScreenContext, ScreenContextAdapter, ScreenDocumentRef, StructuredBlock } from "@vixera/domain";

export interface ExplicitCapture {
  readonly text?: string | null;
  readonly title?: string | null;
  readonly blocks?: readonly StructuredBlock[] | null;
  /** Partial reference; missing fields default to null, `title` defaults to the capture title. */
  readonly documentRef?: Partial<ScreenDocumentRef> | null;
  readonly metadata?: JsonObject;
  /** Override the capture time (e.g. when the share happened before the app woke). */
  readonly capturedAt?: IsoDateTime;
}

export interface ExplicitCaptureAdapterOptions {
  readonly now?: () => Date;
}

export class ExplicitCaptureAdapter implements ScreenContextAdapter {
  readonly id = "explicit_capture";
  readonly source = "explicit_capture" as const;
  private readonly now: () => Date;
  private held: ScreenContext | null = null;

  constructor(options: ExplicitCaptureAdapterOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Stores a capture and returns the ScreenContext it became. Replaces any previous capture. */
  provide(capture: ExplicitCapture): ScreenContext {
    const text = normalizeText(capture.text);
    const blocks = capture.blocks && capture.blocks.length > 0 ? [...capture.blocks] : null;
    const title = normalizeText(capture.title);
    const ref = capture.documentRef ?? null;
    if (text === null && blocks === null && !ref) {
      throw new TypeError("ExplicitCapture needs at least text, blocks or a documentRef");
    }
    const document: ScreenDocumentRef | null = ref
      ? {
          title: normalizeText(ref.title) ?? title ?? "Untitled capture",
          externalRef: ref.externalRef ?? null,
          mimeType: ref.mimeType ?? null,
          praxionDocumentId: ref.praxionDocumentId ?? null,
        }
      : null;
    const context: ScreenContext = {
      source: "explicit_capture",
      capturedAt: capture.capturedAt ?? this.now().toISOString(),
      document,
      location: null,
      selection: null,
      structuredContent: blocks,
      text: text ?? (blocks ? blocks.map((b) => b.text).join("\n") : null),
      metadata: { ...(capture.metadata ?? {}), ...(title !== null ? { title } : {}) },
    };
    this.held = context;
    return context;
  }

  clear(): void {
    this.held = null;
  }

  async isAvailable(): Promise<boolean> {
    return this.held !== null;
  }

  async getCurrentContext(): Promise<ScreenContext | null> {
    return this.held;
  }
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
