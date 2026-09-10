/**
 * Share-to-Vixera bindings (Android companion). Wraps the `vixera-share` plugin:
 *
 *   getPendingShares()  -> objects the user shared since the last clear
 *   clearPendingShares() -> empties the queue and deletes the cached copies
 *   onShare(listener)   -> called with the whole pending queue whenever it changes
 *
 * Shares can arrive before the Field has mounted (cold start from the share
 * sheet), so the Field should call `getPendingShares()` once on startup and use
 * `onShare` for shares received while running. Off Android every call is a
 * no-op: no items, and `onShare` returns an unsubscribe that does nothing.
 *
 * A `ShareItem` is a platform object. Turning it into an `IngestItem` (type,
 * source, metadata, document, relationships) is the ingestion pipeline's job.
 */
import { addPluginListener, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { isAndroid, toError } from "./tauri.ts";

export const SHARE_PLUGIN = "vixera-share";

export type ShareKind = "file" | "image" | "url" | "text";

export interface ShareItem {
  readonly id: string;
  readonly kind: ShareKind;
  /** Absolute path of the cached copy (`<cacheDir>/vixera-shares/<uuid>.<ext>`) for file/image. */
  readonly path: string | null;
  /** URL or text payload for url/text. */
  readonly text: string | null;
  readonly mimeType: string | null;
  readonly filename: string | null;
  readonly sizeBytes: number | null;
  /** EXTRA_SUBJECT of the sharing intent, when present. */
  readonly title: string | null;
  /** RFC 3339 UTC timestamp. */
  readonly receivedAt: string;
}

export interface PendingShares {
  readonly items: readonly ShareItem[];
}

export type ShareListener = (pending: PendingShares) => void;
export type Unsubscribe = () => Promise<void>;

/** Normalizes the plugin payload: missing optional fields become null. */
export function normalizePendingShares(raw: unknown): PendingShares {
  const items = Array.isArray((raw as { items?: unknown })?.items) ? ((raw as { items: unknown[] }).items) : [];
  return { items: items.flatMap((item) => (isRecord(item) ? [normalizeItem(item)] : [])) };
}

function normalizeItem(raw: Record<string, unknown>): ShareItem {
  const kind = raw["kind"];
  return {
    id: str(raw["id"]) ?? crypto.randomUUID(),
    kind: kind === "file" || kind === "image" || kind === "url" || kind === "text" ? kind : "file",
    path: str(raw["path"]),
    text: str(raw["text"]),
    mimeType: str(raw["mimeType"]),
    filename: str(raw["filename"]),
    sizeBytes: typeof raw["sizeBytes"] === "number" ? raw["sizeBytes"] : null,
    title: str(raw["title"]),
    receivedAt: str(raw["receivedAt"]) ?? new Date().toISOString(),
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function getPendingShares(): Promise<PendingShares> {
  if (!isAndroid()) return { items: [] };
  try {
    return normalizePendingShares(await tauriInvoke<unknown>(`plugin:${SHARE_PLUGIN}|get_pending_shares`));
  } catch (error) {
    throw toError(error, "getPendingShares");
  }
}

export async function clearPendingShares(): Promise<void> {
  if (!isAndroid()) return;
  try {
    await tauriInvoke<void>(`plugin:${SHARE_PLUGIN}|clear_pending_shares`);
  } catch (error) {
    throw toError(error, "clearPendingShares");
  }
}

export async function onShare(listener: ShareListener): Promise<Unsubscribe> {
  if (!isAndroid()) return async () => {};
  const handle = await addPluginListener<unknown>(SHARE_PLUGIN, "share", (payload) => {
    listener(normalizePendingShares(payload));
  });
  return () => handle.unregister();
}
