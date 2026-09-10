/**
 * File access for the Field: hashing (document identity), picking, reading bytes
 * for upload, and opening with the OS viewer — the fallback when Praxion is absent.
 * All paths are absolute paths on this device (picked, dropped or shared files).
 */
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { openPath, openUrl as openerOpenUrl } from "@tauri-apps/plugin-opener";
import { invoke, isTauri, NotInTauriError, toError } from "./tauri.ts";

export interface FileHash {
  /** Lowercase hex SHA-256. */
  readonly sha256: string;
  readonly size: number;
}

/** Streams the file through SHA-256 in Rust; never loads it into the WebView. */
export function hashFile(path: string): Promise<FileHash> {
  return invoke<FileHash>("hash_file", { path });
}

export interface PickFilesOptions {
  readonly title?: string;
  readonly multiple?: boolean;
  /** e.g. [{ name: "Documents", extensions: ["pdf"] }] */
  readonly filters?: ReadonlyArray<{ readonly name: string; readonly extensions: readonly string[] }>;
}

/** Native file picker. Resolves to [] when cancelled or outside Tauri. */
export async function pickFiles(options: PickFilesOptions = {}): Promise<string[]> {
  if (!isTauri()) return [];
  const selection = await openDialog({
    multiple: options.multiple ?? true,
    directory: false,
    ...(options.title !== undefined ? { title: options.title } : {}),
    ...(options.filters !== undefined ? { filters: options.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })) } : {}),
  });
  if (selection === null) return [];
  return Array.isArray(selection) ? selection : [selection];
}

/** Whole-file bytes for uploads (artifact payloads, shared files). */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  if (!isTauri()) throw new NotInTauriError("readFileBytes");
  try {
    return await readFile(path);
  } catch (error) {
    throw toError(error, `readFileBytes(${path})`);
  }
}

/** Open a local file with whatever the OS associates with it (Praxion-absent fallback). */
export async function openWithSystem(path: string): Promise<void> {
  if (!isTauri()) throw new NotInTauriError("openWithSystem");
  try {
    await openPath(path);
  } catch (error) {
    throw toError(error, `openWithSystem(${path})`);
  }
}

/** Open an http(s) URL in the default browser; falls back to `window.open` outside Tauri. */
export async function openUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`openUrl only opens http(s) URLs, got ${parsed.protocol}`);
  }
  if (!isTauri()) {
    globalThis.open?.(parsed.toString(), "_blank", "noopener");
    return;
  }
  await openerOpenUrl(parsed.toString());
}
