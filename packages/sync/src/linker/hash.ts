/**
 * FNV-1a 32-bit string hash. Small, dependency-free, stable across runtimes
 * (Deno, browsers, Node). Used to version calendar events in context-event
 * dedupe keys: the same title/start/end/status always hashes the same, so a
 * re-sync of an unchanged event produces no new context event, while any
 * change produces a new key and therefore a new `time.event.changed` event.
 *
 * Not a cryptographic hash and never used as one.
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit multiply by the FNV prime 16777619 without overflowing doubles.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Unit separator: cannot appear in titles, ISO dates or enum values, so "ab"+"c" never collides with "a"+"bc". */
export const SEPARATOR = "\u001f";

/** Joins parts with `SEPARATOR` (null / undefined become ""), then hashes. */
export function hashParts(...parts: readonly (string | number | boolean | null | undefined)[]): string {
  return fnv1a(parts.map((p) => (p === null || p === undefined ? "" : String(p))).join(SEPARATOR));
}
