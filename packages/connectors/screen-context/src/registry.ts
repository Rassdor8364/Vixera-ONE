/**
 * Builds the Phase 1 ScreenContextRegistry: Praxion structured content first,
 * explicit capture second. UI and intelligence code hold the registry and
 * call `current()`; they never talk to an adapter directly.
 *
 * Deliberately NOT registered here (see docs/screen-context.md):
 *   - WindowsForeignAppAdapter (source "windows_foreign_app"): reading the
 *     foreground window of arbitrary Windows apps via UI Automation / OCR.
 *   - AndroidAssistAdapter (source "android_assist"): Android accessibility /
 *     assist-structure screen reading.
 * Both are future implementations of the same `ScreenContextAdapter`
 * interface and would slot in between Praxion and explicit capture. The
 * brief excludes generalized OCR / accessibility surveillance from Phase 1.
 */
import { ScreenContextRegistry } from "@vixera/domain";
import type { PraxionConnector } from "@vixera/praxion";
import { ExplicitCaptureAdapter } from "./explicit-capture-adapter.ts";
import { PraxionStructuredContentAdapter, type PraxionAdapterOptions } from "./praxion-adapter.ts";

export interface ScreenContextRegistryOptions {
  readonly praxion?: PraxionConnector;
  readonly praxionOptions?: PraxionAdapterOptions;
  readonly explicit?: ExplicitCaptureAdapter;
}

export function createScreenContextRegistry(options: ScreenContextRegistryOptions = {}): ScreenContextRegistry {
  const registry = new ScreenContextRegistry();
  if (options.praxion) registry.register(new PraxionStructuredContentAdapter(options.praxion, options.praxionOptions));
  if (options.explicit) registry.register(options.explicit);
  return registry;
}
