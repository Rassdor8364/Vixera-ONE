/**
 * Gmail sync source: initial backfill over `messages.list`, then incremental
 * sync over `history.list`.
 *
 * Checkpoint (opaque to the engine, owned by this file):
 *   { historyId: string, backfill?: { pageToken: string | null, since: string, fullResync?: true } }
 *
 *   - `historyId` is captured from `users/me/profile` when a backfill starts
 *     and advanced by every history page afterwards. Advancing it to the last
 *     history record id of a page (instead of the mailbox historyId) keeps
 *     multi-page history runs restartable: a crash between pages loses nothing.
 *   - `backfill` is present while a backfill is in progress; each yielded page
 *     carries the token for the next page so the engine can persist and resume.
 *
 * Every page is idempotent for the store (natural key = message id).
 * HTTP 404 on `history.list` means Gmail no longer holds history back to our
 * id; the source then yields a fresh backfill with `fullResync: true`.
 *
 * Label semantics (both paths agree, so a mailbox yields the same rows
 * whichever path ran): messages in Spam, Trash, Drafts or Chats
 * (`GMAIL_HIDDEN_LABELS`) never reach the spine. The backfill query excludes
 * drafts and chats (`messages.list` already omits Spam/Trash), history skips
 * arrivals born hidden, a stored message that gains TRASH/SPAM becomes a
 * deletion without a fetch, one that loses them is fetched again, and any
 * fetched message that turns out hidden is emitted as a deletion. Sent mail
 * is kept (see `normalize.ts`: no sender, `metadata.direction = "sent"`).
 */
import { ConnectorError, type Checkpoint, type MailSyncBatch, type NormalizedMailMessage, type SyncContext, type SyncPage } from "@vixera/domain";
import { GoogleApiClient, mapConcurrent } from "../http.ts";
import type { GoogleOAuthConfig } from "../oauth.ts";
import { GMAIL_UNREAD_LABEL, isHiddenGmailMessage, normalizeGmailMessage } from "./normalize.ts";
import type { GmailHistoryList, GmailHistoryRecord, GmailMessage, GmailMessageList, GmailProfile } from "./types.ts";

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const LIST_PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 500;

export interface GmailBackfillState {
  readonly pageToken: string | null;
  /** ISO timestamp of the start of the backfill window (informational). */
  readonly since: string;
  /** Set when the backfill replaces a checkpoint Gmail invalidated. */
  readonly fullResync?: true;
}

export interface GmailCheckpoint {
  readonly historyId: string;
  readonly backfill?: GmailBackfillState;
}

export interface GmailSyncOptions {
  readonly oauth: GoogleOAuthConfig;
  readonly backfillDays: number;
  readonly concurrency: number;
}

export function parseGmailCheckpoint(checkpoint: Checkpoint | null): GmailCheckpoint | null {
  if (!checkpoint) return null;
  const historyId = checkpoint.historyId;
  if (typeof historyId !== "string" || !historyId) return null;
  const backfill = checkpoint.backfill;
  if (backfill === undefined || backfill === null) return { historyId };
  if (typeof backfill !== "object" || Array.isArray(backfill)) return null;
  const pageToken = backfill.pageToken;
  const since = backfill.since;
  if ((pageToken !== null && typeof pageToken !== "string") || typeof since !== "string") return null;
  return {
    historyId,
    backfill: { pageToken: pageToken ?? null, since, ...(backfill.fullResync === true ? { fullResync: true as const } : {}) },
  };
}

function toCheckpoint(cp: GmailCheckpoint): Checkpoint {
  const out: Checkpoint = { historyId: cp.historyId };
  if (cp.backfill) {
    out.backfill = {
      pageToken: cp.backfill.pageToken,
      since: cp.backfill.since,
      ...(cp.backfill.fullResync ? { fullResync: true } : {}),
    };
  }
  return out;
}

export async function* syncMail(
  ctx: SyncContext,
  checkpoint: Checkpoint | null,
  options: GmailSyncOptions,
): AsyncIterable<SyncPage<MailSyncBatch>> {
  const client = new GoogleApiClient(ctx, options.oauth);
  const parsed = parseGmailCheckpoint(checkpoint);
  if (checkpoint && !parsed) {
    ctx.log?.("gmail.checkpoint.invalid", { keys: Object.keys(checkpoint) });
    yield* backfill(ctx, client, options, null, true);
    return;
  }
  if (!parsed || parsed.backfill) {
    yield* backfill(ctx, client, options, parsed, parsed?.backfill?.fullResync === true);
    return;
  }
  yield* incremental(ctx, client, options, parsed.historyId);
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------
async function* backfill(
  ctx: SyncContext,
  client: GoogleApiClient,
  options: GmailSyncOptions,
  resume: GmailCheckpoint | null,
  fullResync: boolean,
): AsyncIterable<SyncPage<MailSyncBatch>> {
  let historyId: string;
  let since: string;
  let pageToken: string | null;
  if (resume?.backfill) {
    historyId = resume.historyId;
    since = resume.backfill.since;
    pageToken = resume.backfill.pageToken;
  } else {
    const profile = await client.getJson<GmailProfile>(`${GMAIL_API}/profile`);
    if (!profile.body?.historyId) throw new ConnectorError("invalid_response", "Gmail profile without historyId", false);
    historyId = profile.body.historyId;
    since = new Date(ctx.now().getTime() - options.backfillDays * 86_400_000).toISOString();
    pageToken = null;
  }
  ctx.log?.("gmail.backfill.start", { resumed: pageToken !== null, fullResync, backfillDays: options.backfillDays });

  for (;;) {
    const url = new URL(`${GMAIL_API}/messages`);
    // messages.list leaves out SPAM/TRASH unless asked; drafts and chats we leave out ourselves.
    url.searchParams.set("q", `newer_than:${options.backfillDays}d -in:drafts -in:chats`);
    url.searchParams.set("maxResults", String(LIST_PAGE_SIZE));
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    let list;
    try {
      list = await client.getJson<GmailMessageList>(url);
    } catch (error) {
      // Gmail rejects a stale page token with 400. That token came out of OUR
      // checkpoint, so say so in the code the engine understands: it clears the
      // checkpoint and restarts the backfill once, instead of failing forever.
      if (pageToken && error instanceof ConnectorError && /HTTP 400|API error 400/.test(error.message)) {
        throw new ConnectorError("checkpoint_invalid", `Gmail rejected the stored page token (${error.message})`, false, { cause: error });
      }
      throw error;
    }
    const refs = list.body?.messages ?? [];
    // A message trashed between list and get comes back hidden: it may be stored from an earlier run.
    const { messages, hidden } = await fetchMessages(ctx, client, options, refs.map((r) => r.id));
    const nextToken = list.body?.nextPageToken ?? null;
    const next: GmailCheckpoint = nextToken
      ? { historyId, backfill: { pageToken: nextToken, since, ...(fullResync ? { fullResync: true as const } : {}) } }
      : { historyId };
    ctx.log?.("gmail.backfill.page", { listed: refs.length, normalized: messages.length, hidden: hidden.length, hasMore: nextToken !== null });
    yield {
      batch: { messages, deleted: hidden.map((externalId) => ({ externalId })) },
      checkpoint: toCheckpoint(next),
      done: nextToken === null,
      ...(fullResync ? { fullResync: true } : {}),
    };
    if (!nextToken) return;
    pageToken = nextToken;
  }
}

// ---------------------------------------------------------------------------
// Incremental (history)
// ---------------------------------------------------------------------------
async function* incremental(
  ctx: SyncContext,
  client: GoogleApiClient,
  options: GmailSyncOptions,
  startHistoryId: string,
): AsyncIterable<SyncPage<MailSyncBatch>> {
  let pageToken: string | null = null;
  // `cursor` is the last history id we checkpointed (advanced per page so a
  // restart loses nothing), but the request keeps `startHistoryId` fixed within
  // one run: Google requires every parameter except `pageToken` to match the
  // request that issued the token.
  let cursor = startHistoryId;
  for (;;) {
    const url = new URL(`${GMAIL_API}/history`);
    url.searchParams.set("startHistoryId", startHistoryId);
    url.searchParams.set("maxResults", String(HISTORY_PAGE_SIZE));
    for (const type of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"]) url.searchParams.append("historyTypes", type);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await client.getJson<GmailHistoryList>(url, { tolerate: [404] });
    if (res.status === 404) {
      ctx.log?.("gmail.history.expired", { startHistoryId });
      yield* backfill(ctx, client, options, null, true);
      return;
    }
    const records = res.body?.history ?? [];
    const { toFetch, deleted } = planHistory(records);
    const { messages, missing, hidden } = await fetchMessages(ctx, client, options, [...toFetch]);
    for (const id of missing) deleted.add(id);
    for (const id of hidden) deleted.add(id);

    const nextToken = res.body?.nextPageToken ?? null;
    const lastRecordId = records.length ? records[records.length - 1]?.id : undefined;
    const nextHistoryId = nextToken ? (lastRecordId ?? cursor) : (res.body?.historyId ?? lastRecordId ?? cursor);
    ctx.log?.("gmail.history.page", { records: records.length, fetched: messages.length, deleted: deleted.size, hasMore: nextToken !== null });
    yield {
      batch: { messages, deleted: [...deleted].map((externalId) => ({ externalId })) },
      checkpoint: toCheckpoint({ historyId: nextHistoryId }),
      done: nextToken === null,
    };
    if (!nextToken) return;
    pageToken = nextToken;
    cursor = nextHistoryId;
  }
}

/**
 * Folds a page of history records into "fetch these" and "delete these".
 * Records are in mailbox order, so for Trash/Spam moves the last move wins
 * (trashed then restored within one page is a fetch, not a deletion); a
 * `messagesDeleted` purge always wins. Gmail's `messagesDeleted` means
 * purged, NOT trashed: trashing arrives as `labelsAdded: ["TRASH"]`.
 */
export function planHistory(records: readonly GmailHistoryRecord[]): { toFetch: Set<string>; deleted: Set<string> } {
  const toFetch = new Set<string>();
  const deleted = new Set<string>();
  const purged = new Set<string>();
  for (const record of records) {
    for (const a of record.messagesAdded ?? []) {
      // Born hidden (spam, draft, chat): never stored, nothing to fetch or delete.
      // Should it leave those labels later, `labelsRemoved` fetches it then.
      if (!isHiddenGmailMessage(a.message.labelIds)) toFetch.add(a.message.id);
    }
    for (const l of record.labelsAdded ?? []) {
      if (isHiddenGmailMessage(l.labelIds)) {
        deleted.add(l.message.id);
        toFetch.delete(l.message.id);
      } else if ((l.labelIds ?? []).includes(GMAIL_UNREAD_LABEL)) toFetch.add(l.message.id);
    }
    for (const l of record.labelsRemoved ?? []) {
      if (isHiddenGmailMessage(l.labelIds)) {
        deleted.delete(l.message.id);
        toFetch.add(l.message.id);
      } else if ((l.labelIds ?? []).includes(GMAIL_UNREAD_LABEL)) toFetch.add(l.message.id);
    }
    for (const d of record.messagesDeleted ?? []) purged.add(d.message.id);
  }
  for (const id of purged) {
    deleted.add(id);
    toFetch.delete(id);
  }
  return { toFetch, deleted };
}

/**
 * Fetches and normalizes `ids`. `missing` are ids Gmail answered 404 for;
 * `hidden` are messages whose current labels keep them out of the spine
 * (callers emit both as deletions).
 */
async function fetchMessages(
  ctx: SyncContext,
  client: GoogleApiClient,
  options: GmailSyncOptions,
  ids: readonly string[],
): Promise<{ messages: NormalizedMailMessage[]; missing: string[]; hidden: string[] }> {
  const missing: string[] = [];
  const hidden: string[] = [];
  const results = await mapConcurrent(ids, options.concurrency, async (id) => {
    const res = await client.getJson<GmailMessage>(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`, { tolerate: [404] });
    if (res.status === 404) {
      // Gmail's not-found always carries its JSON error body; a 404 without one
      // (an HTML page from a proxy, an empty body) is not Gmail saying the
      // message is gone, and must not delete the stored row.
      if ((res.body as { error?: { code?: number } } | null)?.error?.code === 404) {
        missing.push(id);
        return null;
      }
      throw new ConnectorError("invalid_response", `Gmail returned HTTP 404 without its error body for message ${id}`, true);
    }
    // Only a 404 means "gone". A 2xx whose body did not parse (empty, truncated,
    // an HTML error page from a proxy) is a failed fetch: reporting it as
    // missing would delete the stored message and everything linked to it,
    // and the advanced history checkpoint would never fetch it again.
    if (!res.body) {
      throw new ConnectorError("invalid_response", `Gmail returned HTTP ${res.status} without a JSON body for message ${id}`, true);
    }
    if (isHiddenGmailMessage(res.body.labelIds)) {
      hidden.push(id);
      return null;
    }
    try {
      return normalizeGmailMessage(res.body);
    } catch (error) {
      ctx.log?.("gmail.message.skipped", { id, reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  });
  return { messages: results.filter((m): m is NormalizedMailMessage => m !== null), missing, hidden };
}
