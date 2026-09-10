/**
 * Opening a document on this device: Praxion when it is present, the OS
 * viewer when it is not. Praxion's absence disables only Praxion features.
 */
import type { Document, JsonObject, PraxionLocation } from "@vixera/domain";
import type { PraxionConnector } from "@vixera/praxion";
import { appCacheDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { openUrl, openWithSystem } from "../platform/files.ts";
import { isTauri } from "../platform/tauri.ts";
import type { ArtifactStorage } from "./storage.ts";

export interface OpenDocumentDeps {
  readonly deviceId: string;
  readonly praxion: PraxionConnector;
  readonly storage: ArtifactStorage;
}

export type OpenedWith = "praxion" | "system" | "browser";

export interface OpenDocumentResult {
  readonly openedWith: OpenedWith;
  readonly detail: string | null;
  /**
   * Praxion's own id for the artifact, learned from the open call. Praxion ids
   * are per installation, so this is a session fact — never persisted onto the
   * document row, and the only way a Praxion action can name the artifact.
   */
  readonly praxionDocumentId?: string | null;
}

/** Artifact actions Praxion owns. Vixera asks; Praxion decides and performs. */
export type ArtifactAction = "compare" | "annotate" | "sign" | "goto";

export interface ArtifactActionResult {
  readonly supported: boolean;
  readonly accepted: boolean;
  readonly message: string | null;
}

/**
 * Requests an artifact action from Praxion. Vixera implements none of it: it
 * opens the document (which yields Praxion's id) and hands the request over.
 */
export async function requestArtifactAction(
  deps: OpenDocumentDeps,
  doc: Document,
  action: ArtifactAction,
  params: JsonObject = {},
): Promise<ArtifactActionResult> {
  const availability = await deps.praxion.availability();
  if (availability.state !== "available") {
    return { supported: false, accepted: false, message: "Praxion is not running on this device" };
  }
  if (!(await deps.praxion.supports(`action:${action}` as never))) {
    return { supported: false, accepted: false, message: `Praxion does not offer ${action}` };
  }
  const opened = await openDocument(deps, doc);
  const documentId = opened.praxionDocumentId ?? doc.praxionDocumentId;
  if (!documentId) {
    return { supported: false, accepted: false, message: "Praxion could not identify this document" };
  }
  const response = await deps.praxion.requestAction({ action, documentId, params });
  return { supported: response.supported, accepted: response.accepted, message: response.message };
}

/** Local path of the document on this device, if the spine knows one. */
export function localPathOf(doc: Document, deviceId: string): string | null {
  return doc.location.kind === "device_path" && doc.location.deviceId === deviceId ? doc.location.path : null;
}

export async function openDocument(deps: OpenDocumentDeps, doc: Document, location: PraxionLocation | null = null): Promise<OpenDocumentResult> {
  const availability = await deps.praxion.availability();
  const praxionReady = availability.state === "available";
  const localPath = localPathOf(doc, deps.deviceId);

  if (praxionReady) {
    if (doc.praxionDocumentId) {
      const response = await deps.praxion.openDocument({ documentId: doc.praxionDocumentId, ...(location ? { location } : {}), focus: true });
      return { openedWith: "praxion", detail: null, praxionDocumentId: response.document.id };
    }
    const path = localPath ?? (doc.location.kind === "storage" ? await cacheFromStorage(deps.storage, doc) : null);
    if (path) {
      const response = await deps.praxion.openDocument({ path, ...(location ? { location } : {}), focus: true });
      return { openedWith: "praxion", detail: null, praxionDocumentId: response.document.id };
    }
  }

  if (localPath) {
    await openWithSystem(localPath);
    return { openedWith: "system", detail: null };
  }
  switch (doc.location.kind) {
    case "storage": {
      const cached = await cacheFromStorage(deps.storage, doc);
      if (cached) {
        await openWithSystem(cached);
        return { openedWith: "system", detail: null };
      }
      await openUrl(await deps.storage.signedUrl(doc.location.path));
      return { openedWith: "browser", detail: "opened a short-lived link" };
    }
    case "url":
      await openUrl(doc.location.url);
      return { openedWith: "browser", detail: null };
    case "device_path":
      throw new Error(`This document lives on another device (${doc.location.path.split(/[\\/]/).pop() ?? "file"})`);
    case "provider":
      throw new Error("This document is only known at its source; sync it or share it to Vixera to open it here");
    case "none":
      throw new Error("Vixera has no copy of this document");
  }
}

/**
 * Downloads the artifact to $APPCACHE/vixera-artifacts/<document id>-<name> so
 * the OS viewer or Praxion can open a real path. Returns null when the file
 * system is not writable from the WebView (browser, or the fs capability
 * lacks write permission); callers then fall back to a signed URL.
 */
async function cacheFromStorage(storage: ArtifactStorage, doc: Document): Promise<string | null> {
  if (!isTauri() || doc.location.kind !== "storage") return null;
  try {
    const dir = await join(await appCacheDir(), "vixera-artifacts");
    if (!(await exists(dir))) await mkdir(dir, { recursive: true });
    const name = doc.location.path.split("/").pop() ?? "artifact";
    const target = await join(dir, `${doc.id}-${name}`);
    if (!(await exists(target))) {
      const bytes = await storage.download(doc.location.path);
      await writeFile(target, bytes);
    }
    return target;
  } catch {
    return null;
  }
}
