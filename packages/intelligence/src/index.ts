/**
 * @vixera/intelligence — models behind a seam.
 *
 *   model-provider.ts     ModelProvider + capabilities, ModelRegistry, NullModelProvider
 *   errors.ts             one class per failure mode; none carries content
 *   context-selection.ts  explicit, allow-listed, budgeted context + a content-free manifest
 *   tasks.ts              TaskRunner: timeout, cancellation, locality, JSON validation, audit
 *   intelligence.ts       the six task-shaped operations (classify, summarize, extract, compare, suggest, answer)
 *   audit.ts              audit events and sinks (content-free)
 *   testing/              ScriptedModelProvider for tests
 *
 * Runtime-neutral (WebView, Node, Deno). Adapters that hold API keys are
 * server-side only. Nothing in this package writes to the spine or calls a
 * provider's API on its own: outputs are data for the caller.
 */
export * from "./model-provider.ts";
export * from "./errors.ts";
export * from "./context-selection.ts";
export * from "./tasks.ts";
export * from "./intelligence.ts";
export * from "./audit.ts";
export { ScriptedModelProvider, type ScriptedAnswer, type ScriptedProviderOptions } from "./testing/scripted-provider.ts";
