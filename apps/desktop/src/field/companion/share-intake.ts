/**
 * Android share sheet → ingestion. `ShareItem`s are platform objects; each
 * becomes an `ingest.submit` action (file/image bytes uploaded first). The
 * queue is cleared only after every item was dispatched successfully.
 */
import type { PendingShares, ShareItem } from "../../platform/share.ts";
import { ingestFiles, ingestText, type IngestDeps, type IngestSubmission } from "../../data/ingest.ts";

export interface ShareIntakeResult {
  readonly submitted: IngestSubmission[];
  readonly failed: { title: string; error: Error }[];
  /** True when every item was dispatched and the queue may be cleared. */
  readonly complete: boolean;
}

export function splitShares(items: readonly ShareItem[]): { files: ShareItem[]; texts: ShareItem[] } {
  const files = items.filter((i) => (i.kind === "file" || i.kind === "image") && i.path !== null);
  const texts = items.filter((i) => (i.kind === "url" || i.kind === "text") && i.text !== null);
  return { files, texts };
}

export async function intakeShares(deps: IngestDeps, items: readonly ShareItem[]): Promise<ShareIntakeResult> {
  const { files, texts } = splitShares(items);
  const fileResult = await ingestFiles(
    deps,
    files.map((f) => ({ path: f.path as string, title: f.title ?? f.filename, mimeType: f.mimeType })),
    "share",
  );
  const submitted = [...fileResult.submitted];
  const failed = [...fileResult.failed];
  for (const t of texts) {
    try {
      submitted.push(await ingestText(deps, t.text as string, "share", { title: t.title }));
    } catch (error) {
      failed.push({ title: t.title ?? "shared text", error: error instanceof Error ? error : new Error(String(error)) });
    }
  }
  const skipped = items.length - files.length - texts.length;
  return { submitted, failed, complete: failed.length === 0 && skipped === 0 };
}

export interface ShareQueue {
  readonly getPending: () => Promise<PendingShares>;
  readonly clear: () => Promise<void>;
}

/**
 * Ingests `initial`, then re-reads the queue: anything shared meanwhile is
 * ingested too, and the queue is cleared only once every item in it has been
 * dispatched successfully. A failed batch leaves the queue untouched so the
 * items are retried on the next launch.
 */
export async function drainShares(deps: IngestDeps, queue: ShareQueue, initial: readonly ShareItem[]): Promise<ShareIntakeResult> {
  const processed = new Set<string>();
  const submitted: IngestSubmission[] = [];
  const failed: { title: string; error: Error }[] = [];
  let batch = initial.filter((i) => !processed.has(i.id));
  while (batch.length > 0) {
    const result = await intakeShares(deps, batch);
    submitted.push(...result.submitted);
    failed.push(...result.failed);
    if (!result.complete) return { submitted, failed, complete: false };
    for (const item of batch) processed.add(item.id);
    const latest = (await queue.getPending()).items;
    batch = latest.filter((i) => !processed.has(i.id));
  }
  if (processed.size > 0) await queue.clear();
  return { submitted, failed, complete: true };
}
