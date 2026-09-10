/**
 * Microsoft Graph mail sync source: delta query over the inbox.
 *
 *   initial      GET /me/mailFolders/inbox/messages/delta?$select=…&$filter=receivedDateTime ge <now − backfillDays>
 *   incremental  GET <deltaLink>
 *   paging       every `@odata.nextLink` page is one `SyncPage`; the final page
 *                carries the new `@odata.deltaLink`
 *   HTTP 410     Graph dropped the delta token → restart from the initial
 *                backfill with every page marked `fullResync: true`
 *
 * Checkpoint (opaque to the engine, owned by this file):
 *   { deltaLink: string }
 *
 * Intermediate pages keep the *previous* checkpoint (or null on a first run):
 * a nextLink is not durable enough to persist, so a crash mid-run simply
 * replays from the last complete delta round. Every page is idempotent for the
 * store (natural key = message id). Tombstones (`@removed`) become deletions.
 *
 * Bodies are requested as text (`Prefer: outlook.body-content-type="text"`);
 * page size goes through `Prefer: odata.maxpagesize` because message delta
 * ignores `$top`. Messages with `hasAttachments` get one extra request for
 * attachment metadata (non-inline file attachments only).
 */
import { ConnectorError, type Checkpoint, type MailSyncBatch, type NormalizedDeletion, type NormalizedMailMessage, type SyncContext, type SyncPage } from "@vixera/domain";
import { GRAPH_API, GraphApiClient, graphUrl, mapConcurrent } from "../http.ts";
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

export interface MailCheckpoint {
  readonly deltaLink: string;
}

export interface MailSyncOptions {
  readonly oauth: MicrosoftOAuthConfig;
  readonly backfillDays: number;
  readonly pageSize: number;
}

export function parseMailCheckpoint(checkpoint: Checkpoint | null): MailCheckpoint | null {
  if (!checkpoint) return null;
  const deltaLink = checkpoint.deltaLink;
  if (typeof deltaLink !== "string" || !deltaLink) return null;
  if (!isGraphUrl(deltaLink)) return null;
  return { deltaLink };
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
  yield* run(ctx, client, options, parsed, false);
}

async function* run(
  ctx: SyncContext,
  client: GraphApiClient,
  options: MailSyncOptions,
  previous: MailCheckpoint | null,
  fullResync: boolean,
): AsyncIterable<SyncPage<MailSyncBatch>> {
  const prefer = `odata.maxpagesize=${options.pageSize}, outlook.body-content-type="text"`;
  let next: string = previous?.deltaLink ?? initialMailDeltaUrl(ctx.now(), options.backfillDays);
  ctx.log?.(previous ? "microsoft.mail.delta.start" : "microsoft.mail.backfill.start", { fullResync, backfillDays: options.backfillDays });

  for (;;) {
    const res = await client.getJson<GraphDeltaPage<GraphMessageDeltaEntry>>(next, { tolerate: [410], headers: { prefer } });
    if (res.status === 410) {
      if (!previous) throw new ConnectorError("checkpoint_invalid", "Microsoft Graph returned 410 for a fresh mail delta query", false);
      ctx.log?.("microsoft.mail.delta.expired");
      yield* run(ctx, client, options, null, true);
      return;
    }
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
    const checkpoint: Checkpoint | null = done ? { deltaLink: deltaLink as string } : previous ? { deltaLink: previous.deltaLink } : null;
    ctx.log?.("microsoft.mail.delta.page", { entries: entries.length, messages: messages.length, deleted: deleted.length, hasMore: !done });
    yield { batch: { messages, deleted }, checkpoint, done, ...(fullResync ? { fullResync: true } : {}) };
    if (done) return;
    if (!isGraphUrl(nextLink as string)) throw new ConnectorError("invalid_response", "Microsoft Graph nextLink points outside Graph", false);
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
