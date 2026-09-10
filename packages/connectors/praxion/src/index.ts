/**
 * @vixera/praxion — versioned Praxion local connector contract + client.
 *
 * Praxion is a separate product that owns the document artifact; Vixera only
 * defines the loopback contract and a client that degrades cleanly when
 * Praxion is not installed. This entry exports web-standard code only; the
 * Node mock server lives in scripts/ and is never exported.
 */
export * from "./contract.ts"; // also re-exports ./version.ts helpers
export * from "./transport.ts";
export * from "./connector.ts";
export * from "./testing/in-memory-praxion.ts";
export * from "./testing/fixtures.ts";
