/**
 * @vixera/screen-context — implementations of the `ScreenContextAdapter`
 * seam from @vixera/domain. Phase 1 ships two: Praxion structured content
 * (primary) and explicit capture (secondary). No OCR, no accessibility
 * reading; see ./registry.ts for what is deferred.
 */
export * from "./praxion-adapter.ts";
export * from "./explicit-capture-adapter.ts";
export * from "./registry.ts";
