/**
 * Ingestion from the Field: files (drop, pick, Android share), text and URLs.
 *
 *   bytes  → hash (Rust `hash_file` for paths, WebCrypto for File objects)
 *          → upload to Storage `artifacts/<userId>/ingest/<uuid>-<safe name>`
 *          → dispatch `ingest.submit` through the action seam
 *          → the server (`ingest-process`) turns the item into a document,
 *            relationships and a context event; the Field refreshes.
 *
 * Only the upload is a client write; every durable context mutation is a
 * server action. The user id in the storage path comes from the bound store,
 * never from a payload.
 */
import { newId, type ActionOutcome, type ActionPayloads, type UserId } from "@vixera/domain";
import type { SpineReader } from "@vixera/sync";
import { hashFile, readFileBytes } from "../platform/files.ts";
import { isTauri } from "../platform/tauri.ts";
import { buildEnvelope, dispatchOrThrow, type ActionDispatcher } from "./actions.ts";
import type { ArtifactStorage } from "./storage.ts";

export type IngestSource = ActionPayloads["ingest.submit"]["source"];

export interface IngestDeps {
  readonly userId: UserId;
  readonly deviceId: string;
  readonly reader: SpineReader;
  readonly storage: ArtifactStorage;
  readonly dispatch: ActionDispatcher;
}

export interface IngestSubmission {
  readonly title: string;
  readonly outcome: ActionOutcome;
  readonly storagePath: string | null;
  readonly deduplicated: boolean;
}

/** A local file to ingest: a device path (Tauri) or a browser File. */
export type IngestFileInput = string | File | { readonly path: string; readonly title?: string | null; readonly mimeType?: string | null };

const MAX_NAME = 96;

/** Storage-safe object name: ASCII letters, digits, `.`, `_`, `-`; nothing else, never empty, bounded length. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let safe = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+\./g, ".")
    .replace(/\.-+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (safe.length > MAX_NAME) {
    const dot = safe.lastIndexOf(".");
    const ext = dot > 0 && safe.length - dot <= 12 ? safe.slice(dot) : "";
    safe = safe.slice(0, MAX_NAME - ext.length).replace(/[-.]+$/g, "") + ext;
  }
  return safe || "file";
}

export function ingestStoragePath(userId: string, objectId: string, filename: string): string {
  return `${userId}/ingest/${objectId}-${sanitizeFilename(filename)}`;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

export function detectMimeType(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return (ext && MIME_BY_EXT[ext]) || null;
}

export function ingestKindFor(mimeType: string | null): "file" | "image" {
  return mimeType?.startsWith("image/") ? "image" : "file";
}

export function filenameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** `Blob.arrayBuffer` is missing in some WebViews / jsdom; FileReader is the fallback. */
function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsArrayBuffer(blob);
  });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface LoadedFile {
  readonly filename: string;
  readonly title: string;
  readonly mimeType: string | null;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly originalPath: string | null;
}

async function loadFile(input: IngestFileInput): Promise<LoadedFile> {
  if (typeof File !== "undefined" && input instanceof File) {
    const bytes = new Uint8Array(await blobBytes(input));
    const mimeType = input.type || detectMimeType(input.name);
    return { filename: input.name, title: input.name, mimeType, bytes, sha256: await sha256Hex(bytes), size: bytes.byteLength, originalPath: null };
  }
  const spec = typeof input === "string" ? { path: input, title: null, mimeType: null } : (input as { path: string; title?: string | null; mimeType?: string | null });
  const path = spec.path;
  const filename = filenameOf(path);
  const title = spec.title || filename;
  const mimeType = spec.mimeType || detectMimeType(filename);
  const bytes = await readFileBytes(path);
  const hash = isTauri() ? await hashFile(path) : { sha256: await sha256Hex(bytes), size: bytes.byteLength };
  return { filename, title, mimeType, bytes, sha256: hash.sha256, size: hash.size, originalPath: path };
}

/** Ingests files one by one; a failure on one file does not stop the others (errors are returned per file). */
export async function ingestFiles(
  deps: IngestDeps,
  inputs: readonly IngestFileInput[],
  source: IngestSource,
): Promise<{ submitted: IngestSubmission[]; failed: { title: string; error: Error }[] }> {
  const submitted: IngestSubmission[] = [];
  const failed: { title: string; error: Error }[] = [];
  for (const input of inputs) {
    const title = typeof input === "string" ? filenameOf(input) : "name" in input && typeof File !== "undefined" && input instanceof File ? input.name : (input as { path: string; title?: string | null }).title || filenameOf((input as { path: string }).path);
    try {
      submitted.push(await ingestOne(deps, input, source));
    } catch (error) {
      failed.push({ title, error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  return { submitted, failed };
}

async function ingestOne(deps: IngestDeps, input: IngestFileInput, source: IngestSource): Promise<IngestSubmission> {
  const file = await loadFile(input);
  // Same bytes already known ⇒ reuse the stored object instead of uploading twice.
  const existing = await deps.reader.findDocumentByHash(file.sha256).catch(() => null);
  let storagePath: string;
  let deduplicated = false;
  if (existing && existing.location.kind === "storage") {
    storagePath = existing.location.path;
    deduplicated = true;
  } else {
    storagePath = ingestStoragePath(deps.userId, newId(), file.filename);
    await deps.storage.upload(storagePath, file.bytes, file.mimeType);
  }
  const envelope = buildEnvelope(
    "ingest.submit",
    {
      deviceId: deps.deviceId,
      kind: ingestKindFor(file.mimeType),
      source,
      title: file.title,
      mimeType: file.mimeType,
      sizeBytes: file.size,
      storagePath,
      metadata: {
        contentHash: file.sha256,
        filename: file.filename,
        ...(file.originalPath ? { originalPath: file.originalPath } : {}),
        ...(existing ? { existingDocumentId: existing.id } : {}),
      },
    },
    { actorDeviceId: deps.deviceId },
  );
  const outcome = await dispatchOrThrow(deps.dispatch, envelope);
  return { title: file.title, outcome, storagePath, deduplicated };
}

const URL_RE = /^(https?:\/\/)[^\s]+$/i;

export function isUrlText(text: string): boolean {
  return URL_RE.test(text.trim());
}

/** Ingests pasted / shared text; a bare http(s) URL becomes a `url` item. */
export async function ingestText(
  deps: IngestDeps,
  text: string,
  source: IngestSource,
  options: { readonly title?: string | null } = {},
): Promise<IngestSubmission> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Nothing to ingest");
  const url = isUrlText(trimmed);
  const envelope = buildEnvelope(
    "ingest.submit",
    {
      deviceId: deps.deviceId,
      kind: url ? "url" : "text",
      source,
      title: options.title?.trim() || (url ? hostOf(trimmed) : trimmed.slice(0, 80)),
      textContent: url ? null : trimmed,
      url: url ? trimmed : null,
      mimeType: url ? "text/uri-list" : "text/plain",
      sizeBytes: new TextEncoder().encode(trimmed).length,
      storagePath: null,
      metadata: {},
    },
    { actorDeviceId: deps.deviceId },
  );
  const outcome = await dispatchOrThrow(deps.dispatch, envelope);
  return { title: envelope.payload.title ?? "text", outcome, storagePath: null, deduplicated: false };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}
