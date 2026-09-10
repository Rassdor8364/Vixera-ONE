/**
 * Platform bridge for the Vixera One Field. Thin TypeScript bindings over the
 * Rust commands and Tauri plugins; every function works in the browser too
 * (fallback or no-op) so the Field can be developed with plain Vite.
 */
export * from "./tauri.ts";
export * from "./credentials.ts";
export * from "./device.ts";
export * from "./files.ts";
export * from "./praxion-transport.ts";
export * from "./share.ts";
export * from "./notifications.ts";
