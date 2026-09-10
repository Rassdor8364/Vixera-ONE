/**
 * Artifact bytes (ingested files, handoff payloads) live in the private
 * Storage bucket `artifacts` under `<userId>/…`. Uploading bytes is a pure
 * upload — the durable context mutation that follows (ingest.submit) goes
 * through the action seam.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const ARTIFACTS_BUCKET = "artifacts";

export interface ArtifactStorage {
  upload(path: string, bytes: Uint8Array, contentType: string | null): Promise<void>;
  download(path: string): Promise<Uint8Array>;
  /** Short-lived URL the OS viewer / browser can open. */
  signedUrl(path: string, expiresInSeconds?: number): Promise<string>;
}

export function createSupabaseArtifactStorage(client: SupabaseClient): ArtifactStorage {
  const bucket = () => client.storage.from(ARTIFACTS_BUCKET);
  return {
    async upload(path, bytes, contentType) {
      const body = new Blob([bytes as BlobPart], contentType ? { type: contentType } : {});
      const { error } = await bucket().upload(path, body, { upsert: false, ...(contentType ? { contentType } : {}) });
      if (error) throw new Error(`upload ${path}: ${error.message}`);
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) throw new Error(`download ${path}: ${error?.message ?? "no data"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    async signedUrl(path, expiresInSeconds = 300) {
      const { data, error } = await bucket().createSignedUrl(path, expiresInSeconds);
      if (error || !data) throw new Error(`signedUrl ${path}: ${error?.message ?? "no data"}`);
      return data.signedUrl;
    },
  };
}

/** DEV ONLY: process-memory storage for dev-fixture mode and tests. */
export function createMemoryArtifactStorage(): ArtifactStorage & { readonly objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async upload(path, bytes) {
      if (objects.has(path)) throw new Error(`upload ${path}: already exists`);
      objects.set(path, bytes);
    },
    async download(path) {
      const b = objects.get(path);
      if (!b) throw new Error(`download ${path}: not found`);
      return b;
    },
    async signedUrl(path) {
      return `memory://${path}`;
    },
  };
}
