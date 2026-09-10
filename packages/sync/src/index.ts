/**
 * @vixera/sync — the sync spine.
 *
 *   store/    SpineStore contract + InMemorySpineStore + SupabaseSpineStore (+ row mappers, client helper)
 *   linker/   ContextLinker: normalized batches → rows, people, documents, relationships, context events
 *   engine/   SyncEngine: accounts × capabilities → connector pages → linker → checkpoints, failure isolated
 *   testing/  MockConnector (brief world fixtures) and fixture helpers for tests of any package
 */
export * from "./store/spine-store.ts";
export * from "./store/in-memory-spine-store.ts";
export * from "./store/rows.ts";
export * from "./store/supabase-spine-store.ts";
export * from "./store/supabase-client.ts";
export * from "./linker/hash.ts";
export * from "./linker/rules.ts";
export * from "./linker/context-linker.ts";
export * from "./engine/sync-engine.ts";
export * from "./testing/fixtures.ts";
export * from "./testing/mock-connector.ts";
