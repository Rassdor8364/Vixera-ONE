/**
 * Microsoft Graph mail sync source: delta query over the inbox.
 *
 *   initial      GET /me/mailFolders/inbox/messages/delta?$select=…&$filter=receivedDateTime ge <now − backfillDays>
 *   incremental  GET <deltaLink>
 *   paging       every `@odata.nextLink` page is one `SyncPage`; the final page
 *                carries the new `@odata.deltaLink`
 *   HTTP 410     Graph dropped the delta token → restart from the initial
 *                backfill with every page marked `fullResync: true`
 *   HTTP 400/410 on a STORED link (deltaLink or backfill nextLink), or any
 *                4xx on it whose error code is in Graph's sync-state family
 *                (syncStateNotFound, resyncRequired, …) → same restart: a link
 *                that came out of our checkpoint and that Graph rejects is a
 *                dead checkpoint, not a permanent error. A 400 on a fresh query
 *                or on a Graph-issued nextLink stays a real error, so a run
 *                cannot loop; across runs a persistently rejected checkpoint
 *                means a full resync every run (logged, not hidden).
 *
 * Checkpoint (opaque to the engine, owned by this file), one of:
 *   { deltaLink: string }                                   a complete delta round
 *   { backfill: { nextLink: string, fullResync?: true } }   initial backfill in progress
 *
 * The initial backfill can be larger than one run's time budget, and the
 * engine stops at the deadline and restarts the pass next run unless a page
 * moved the checkpoint. So every intermediate backfill page persists its
 * `@odata.nextLink` and the next run resumes there — on the assumption, which
 * Graph documents for deltaLinks but not for nextLinks, that the skiptoken
 * carries the same sync state hours later; a rejected one falls back to the
 * restart above. Intermediate pages of an
 * incremental round keep the previous deltaLink instead: rounds are small and
 * replaying one is cheaper than losing the last complete round. Every page is
 * idempotent for the store (natural key = message id). Tombstones (`@removed`)
 * become deletions.
 *
 * Bodies are requested as text (`Prefer: outlook.body-content-type="text"`);
 * page size goes through `Prefer: odata.maxpagesize` because message delta
 * ignores `$top`. Messages with `hasAttachments` get one extra request for
 * attachment metadata (non-inline file attachments only).
 */
import { ConnectorError, type Checkpoint, type MailSyncBatch, type NormalizedDeletion, type NormalizedMailMessage, type SyncContext, type SyncPage } from "@vixera/domain";
import { GRAPH_API, GraphApiClient, graphUrl, isDeadCheckpoint, mapConcurrent, mapGraphError } from "../http.ts";
import type { MicrosoftOAuthConfig } from "../oauth.ts";
import { normalizeGraphMessage } from "./normalize.ts";
import type { GraphAttachment, GraphCollection, GraphDeltaPage, GraphMessage, GraphMessageDeltaEntry } from "./types.ts";

export const MAIL_DELTA_SELECT = [
  "id",
  "conversationId",
  "subject",
  "bodyPreview",
  "body",
  "from",
  "toRecipients",
  "ccRecipients",
  "sentDateTime",
  "receivedDateTime",
  "isRead",
  "hasAttachments",
  "categories",
  "lastModifiedDateTime",
].join(",");
export const ATTACHMENT_SELECT = "id,name,contentType,size,isInline";
const ATTACHMENT_CONCURRENCY = 4;

export interface MailBackfillState {
  /** The `@odata.nextLink` of the backfill page to fetch next. */
  readonly nextLink: string;
  /** Set when this backfill replaces a checkpoint Graph invalidated. */
  readonly fullResync?: true;
}

export type MailCheckpoint =
  | { readonly deltaLink: string; readonly backfill?: undefined }
  | { readonly deltaLink?: undefined; readonly backfill: MailBackfillState };

export interface MailSyncOptions {
  readonly oauth: MicrosoftOAuthConfig;
  readonly backfillDays: number;
  readonly pageSize: number;
}

export function parseMailCheckpoint(checkpoint: Checkpoint | null): MailCheckpoint | null {
  if (!checkpoint) return null;
  const { deltaLink, backfill } = checkpoint;
  if (deltaLink !== undefined && backfill !== undefined) return null;
  if (backfill !== undefined) {
    if (!backfill || typeof backfill !== "object" || Array.isArray(backfill)) return null;
    const nextLink = backfill.nextLink;
    if (typeof nextLink !== "string" || !nextLink || !isGraphUrl(nextLink)) return null;
    return { backfill: { nextLink, ...(backfill.fullResync === true ? { fullResync: true as const } : {}) } };
  }
  if (typeof deltaLink !== "string" || !deltaLink) return null;
  if (!isGraphUrl(deltaLink)) return null;
  return { deltaLink };
}

function toCheckpoint(cp: MailCheckpoint): Checkpoint {
  if (cp.backfill) return { backfill: { nextLink: cp.backfill.nextLink, ...(cp.backfill.fullResync ? { fullResync: true } : {}) } };
  return { deltaLink: cp.deltaLink };
}

/** Delta links must point at Graph; anything else is a corrupted checkpoint, not a place to send a bearer token. */
function isGraphUrl(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "graph.microsoft.com";
  } catch {
    return false;
  }
}

export function initialMailDeltaUrl(now: Date, backfillDays: number): string {
  const since = new Date(now.getTime() - backfillDays * 86_400_000).toISOString();
  return graphUrl(`${GRAPH_API}/me/mailFolders/inbox/messages/delta`, { $select: MAIL_DELTA_SELECT, $filter: `receivedDateTime ge ${since}` });
}

export async function* syncMail(
  ctx: SyncContext,
  checkpoint: Checkpoint | null,
  options: MailSyncOptions,
): AsyncIterable<SyncPage<MailSyncBatch>> {
  const client = new GraphApiClient(ctx, options.oauth);
  const parsed = parseMailCheckpoint(checkpoint);
  if (checkpoint && !parsed) {
    ctx.log?.("microsoft.mail.checkpoint.invalid", { keys: Object.keys(checkpoint) });
    yield* run(ctx, client, options, null, true);
    return;
  }
  yield* run(ctx, client, options, parsed, parsed?.backfill?.fullResync === true);
}

async function* run(
  ctx: SyncContext,
  client: GraphApiClient,
  options: MailSyncOptions,
  previous: MailCheckpoint | null,
  fullResync: boolean,
): AsyncIterable<SyncPage<MailSyncBatch>> {
  const prefer = `odata.maxpagesize=${options.pageSize}, outlook.body-content-type="text"`;
  const round = previous?.deltaLink ?? null;
  let next: string = round ?? previous?.backfill?.nextLink ?? initialMailDeltaUrl(ctx.now(), options.backfillDays);
  // The first request of a run may carry a link out of our own checkpoint; only that one can be a dead checkpoint.
  let stored = previous !== null;
  ctx.log?.(round ? "microsoft.mail.delta.start" : "microsoft.mail.backfill.start", { fullResync, resumed: previous?.backfill !== undefined, backfillDays: options.backfillDays });

  for (;;) {
    const res = await client.getJson<GraphDeltaPage<GraphMessageDeltaEntry>>(next, { tolerate: stored ? [400, 404, 410] : [410], headers: { prefer } });
    if (isDeadCheckpoint(res, stored)) {
      if (!previous) throw new ConnectorError("checkpoint_invalid", "Microsoft Graph returned 410 for a fresh mail delta query", false);
      ctx.log?.(round !== null && res.status === 410 ? "microsoft.mail.delta.expired" : "microsoft.mail.checkpoint.rejected", { status: res.status });
      yield* run(ctx, client, options, null, true);
      return;
    }
    if (res.status === 404) throw mapGraphError(res.status, res.headers, res.body); // tolerated only to read its code
    stored = false;
    const entries = res.body?.value ?? [];
    const deleted: NormalizedDeletion[] = [];
    const live: GraphMessage[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || !entry.id) continue;
      if (entry["@removed"]) deleted.push({ externalId: entry.id });
      else live.push(entry as GraphMessage);
    }
    const messages = await normalizeAll(ctx, client, live);

    const nextLink = res.body?.["@odata.nextLink"] ?? null;
    const deltaLink = res.body?.["@odata.deltaLink"] ?? null;
    if (!nextLink && !deltaLink) {
      throw new ConnectorError("invalid_response", "Microsoft Graph mail delta page has neither nextLink nor deltaLink", false);
    }
    const done = nextLink === null;
    if (!done && !isGraphUrl(nextLink)) throw new ConnectorError("invalid_response", "Microsoft Graph nextLink points outside Graph", false);
    // Done: the new round. Backfill in progress: resume at the next page. Incremental round in progress: keep the last complete round.
    const checkpoint: MailCheckpoint = done
      ? { deltaLink: deltaLink as string }
      : round === null
        ? { backfill: { nextLink: nextLink as string, ...(fullResync ? { fullResync: true as const } : {}) } }
        : { deltaLink: round };
    ctx.log?.("microsoft.mail.delta.page", { entries: entries.length, messages: messages.length, deleted: deleted.length, hasMore: !done });
    yield { batch: { messages, deleted }, checkpoint: toCheckpoint(checkpoint), done, ...(fullResync ? { fullResync: true } : {}) };
    if (done) return;
    next = nextLink as string;
  }
}

async function normalizeAll(ctx: SyncContext, client: GraphApiClient, messages: readonly GraphMessage[]): Promise<NormalizedMailMessage[]> {
  const results = await mapConcurrent(messages, ATTACHMENT_CONCURRENCY, async (raw) => {
    try {
      const attachments = raw.hasAttachments === true ? await fetchAttachments(client, raw.id) : [];
      return normalizeGraphMessage(raw, attachments);
    } catch (error) {
      if (error instanceof ConnectorError && error.code !== "invalid_response") throw error;
      ctx.log?.("microsoft.mail.message.skipped", { id: raw.id, reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });
  return results.filter((m): m is NormalizedMailMessage => m !== null);
}

async function fetchAttachments(client: GraphApiClient, messageId: string): Promise<GraphAttachment[]> {
  const out: GraphAttachment[] = [];
  let next: string | null = graphUrl(`${GRAPH_API}/me/messages/${encodeURIComponent(messageId)}/attachments`, { $select: ATTACHMENT_SELECT });
  while (next) {
    // 404: the message vanished between the delta page and this call; the next delta round will tombstone it.
    const res: { status: number; body: GraphCollection<GraphAttachment> | null } = await client.getJson<GraphCollection<GraphAttachment>>(next, { tolerate: [404] });
    if (res.status === 404) return out;
    out.push(...(res.body?.value ?? []));
    const link = res.body?.["@odata.nextLink"] ?? null;
    next = link && isGraphUrl(link) ? link : null;
  }
  return out;
}
