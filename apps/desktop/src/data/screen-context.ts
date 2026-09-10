/**
 * "What is on screen": the ScreenContextRegistry (Praxion structured content
 * first, explicit capture second) polled by the NOW area. No OCR, no
 * accessibility reading.
 */
import { useEffect, useState } from "react";
import type { ScreenContext, ScreenContextRegistry } from "@vixera/domain";
import { ExplicitCaptureAdapter, createScreenContextRegistry } from "@vixera/screen-context";
import type { PraxionConnector } from "@vixera/praxion";

export interface ScreenContextSetup {
  readonly registry: ScreenContextRegistry;
  readonly explicit: ExplicitCaptureAdapter;
}

export function createFieldScreenContext(praxion: PraxionConnector): ScreenContextSetup {
  const explicit = new ExplicitCaptureAdapter();
  return { registry: createScreenContextRegistry({ praxion, explicit }), explicit };
}

export const SCREEN_CONTEXT_INTERVAL_MS = 15_000;

/** Current screen context, re-read on an interval while `enabled`. */
export function useScreenContext(registry: ScreenContextRegistry, enabled: boolean, intervalMs = SCREEN_CONTEXT_INTERVAL_MS): ScreenContext | null {
  const [context, setContext] = useState<ScreenContext | null>(null);
  useEffect(() => {
    if (!enabled) {
      setContext(null);
      return;
    }
    let cancelled = false;
    const read = async () => {
      const next = await registry.current().catch(() => null);
      if (!cancelled) setContext((prev) => (sameContext(prev, next) ? prev : next));
    };
    void read();
    const timer = setInterval(() => void read(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [registry, enabled, intervalMs]);
  return context;
}

function sameContext(a: ScreenContext | null, b: ScreenContext | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.source === b.source && a.document?.externalRef === b.document?.externalRef && a.document?.title === b.document?.title && a.location?.page === b.location?.page && a.selection === b.selection;
}
