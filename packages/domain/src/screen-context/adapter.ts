import type { IsoDateTime, JsonObject } from "../entities/common.ts";
import type { PraxionLocation } from "../entities/handoff.ts";

/**
 * Everything Vixera learns about "what is on screen" arrives through this
 * seam. Praxion structured content is the primary implementation in Phase 1;
 * explicit user capture is the second. OCR of arbitrary applications is
 * deliberately NOT an implementation.
 */
export type ScreenContextSource = "praxion" | "explicit_capture" | "windows_foreign_app" | "android_assist";

export interface ScreenDocumentRef {
  readonly title: string;
  /** Praxion's document id, or a path / URL for other sources. */
  readonly externalRef: string | null;
  readonly mimeType: string | null;
  readonly praxionDocumentId: string | null;
}

export interface StructuredBlock {
  readonly kind: "heading" | "paragraph" | "list_item" | "table" | "caption" | "other";
  readonly text: string;
  readonly page: number | null;
  readonly metadata?: JsonObject;
}

export interface ScreenContext {
  readonly source: ScreenContextSource;
  readonly capturedAt: IsoDateTime;
  readonly document: ScreenDocumentRef | null;
  readonly location: PraxionLocation | null;
  readonly selection: string | null;
  /** Structured content when the source can provide it (Praxion), else null. */
  readonly structuredContent: readonly StructuredBlock[] | null;
  /** Plain text for sources that only have text (explicit capture). */
  readonly text: string | null;
  readonly metadata: JsonObject;
}

export interface ScreenContextAdapter {
  readonly id: string;
  readonly source: ScreenContextSource;
  /** Cheap, safe to call often. */
  isAvailable(): Promise<boolean>;
  /** Null when nothing is in focus. */
  getCurrentContext(): Promise<ScreenContext | null>;
}

/**
 * Chooses the first available adapter in priority order. UI and intelligence
 * code only ever talk to the registry, never to Praxion directly.
 */
export class ScreenContextRegistry {
  private readonly adapters: ScreenContextAdapter[] = [];

  register(adapter: ScreenContextAdapter, priority = this.adapters.length): this {
    this.adapters.splice(priority, 0, adapter);
    return this;
  }

  list(): readonly ScreenContextAdapter[] {
    return this.adapters;
  }

  async available(): Promise<ScreenContextAdapter[]> {
    const flags = await Promise.all(this.adapters.map((a) => a.isAvailable().catch(() => false)));
    return this.adapters.filter((_, i) => flags[i]);
  }

  /** First adapter (in priority order) that is available and has a context. */
  async current(): Promise<ScreenContext | null> {
    for (const adapter of this.adapters) {
      const ok = await adapter.isAvailable().catch(() => false);
      if (!ok) continue;
      const ctx = await adapter.getCurrentContext().catch(() => null);
      if (ctx) return ctx;
    }
    return null;
  }
}
