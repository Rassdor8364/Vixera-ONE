/**
 * Microsoft Graph calendar sync source: calendarView delta over the default
 * calendar.
 *
 *   initial      GET /me/calendarView/delta?startDateTime=<now − pastDays>&endDateTime=<now + futureDays>
 *   incremental  GET <deltaLink>  (Graph keeps tracking the same window)
 *   paging       every `@odata.nextLink` page is one `SyncPage`; the final page
 *                carries the new `@odata.deltaLink`
 *   HTTP 410     Graph dropped the delta token → re-open a fresh window with
 *                every page marked `fullResync: true`
 *   stale window a delta link only tracks the window it was opened with; once
 *                the stored window is more than 7 days older than the window a
 *                fresh run would open, the source re-opens a new one
 *                (`fullResync: true`) so upcoming events keep flowing in
 *
 * Checkpoint (opaque to the engine, owned by this file):
 *   { deltaLink: string, window: { start: IsoDateTime, end: IsoDateTime } }
 *
 * Intermediate pages keep the previous checkpoint (or null on a first run).
 * Every page is idempotent for the store (natural key = event id).
 * `@removed` tombstones and `isCancelled` events become deletions.
 * Times are requested in UTC (`Prefer: outlook.timezone="UTC"`).
 */
import { ConnectorError, type CalendarSyncBatch, type Checkpoint, type NormalizedDeletion, type NormalizedTimeEvent, type SyncContext, type SyncPage } from "@vixera/domain";
import { GRAPH_API, GraphApiClient, graphUrl } from "../http.ts";
import type { GraphDeltaPage } from "../mail/types.ts";
import type { MicrosoftOAuthConfig } from "../oauth.ts";
import { normalizeGraphEvent } from "./normalize.ts";
import type { GraphEvent, GraphEventDeltaEntry } from "./types.ts";

export const CALENDAR_DELTA_SELECT = [
  "id",
  "subject",
  "bodyPreview",
  "start",
  "end",
  "isAllDay",
  "isCancelled",
  "showAs",
  "location",
  "organizer",
  "attendees",
  "responseStatus",
  "webLink",
  "lastModifiedDateTime",
  "type",
  "seriesMasterId",
  "originalStartTimeZone",
  "onlineMeetingUrl",
].join(",");

/** A stored window older than this (relative to a fresh one) is re-opened. */
export const WINDOW_MAX_AGE_DAYS = 7;

export interface CalendarWindow {
  readonly pastDays: number;
  readonly futureDays: number;
}

export interface CalendarCheckpoint {
  readonly deltaLink: string;
  readonly window: { readonly start: string; readonly end: string };
}

export interface CalendarSyncOptions {
  readonly oauth: MicrosoftOAuthConfig;
  readonly window: CalendarWindow;
  readonly pageSize: number;
}

export function parseCalendarCheckpoint(checkpoint: Checkpoint | null): CalendarCheckpoint | null {
  if (!checkpoint) return null;
  const deltaLink = checkpoint.deltaLink;
  const window = checkpoint.window;
  if (typeof deltaLink !== "string" || !deltaLink || !isGraphUrl(deltaLink)) return null;
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  const { start, end } = window;
  if (typeof start !== "string" || typeof end !== "string") return null;
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return null;
  return { deltaLink, window: { start, end } };
}

function isGraphUrl(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "graph.microsoft.com";
  } catch {
    return false;
  }
}

export function openWindow(now: Date, window: CalendarWindow): { start: string; end: string } {
  return {
    start: new Date(now.getTime() - window.pastDays * 86_400_000).toISOString(),
    end: new Date(now.getTime() + window.futureDays * 86_400_000).toISOString(),
  };
}

/** True when the stored window's start lags a freshly opened one by more than `WINDOW_MAX_AGE_DAYS`. */
export function isWindowStale(stored: { start: string }, now: Date, window: CalendarWindow): boolean {
  const freshStart = now.getTime() - window.pastDays * 86_400_000;
  return freshStart - Date.parse(stored.start) > WINDOW_MAX_AGE_DAYS * 86_400_000;
}

export function initialCalendarDeltaUrl(window: { start: string; end: string }): string {
  return graphUrl(`${GRAPH_API}/me/calendarView/delta`, { startDateTime: window.start, endDateTime: window.end, $select: CALENDAR_DELTA_SELECT });
}

export async function* syncCalendar(
  ctx: SyncContext,
  checkpoint: Checkpoint | null,
  options: CalendarSyncOptions,
): AsyncIterable<SyncPage<CalendarSyncBatch>> {
  const client = new GraphApiClient(ctx, options.oauth);
  const parsed = parseCalendarCheckpoint(checkpoint);
  if (checkpoint && !parsed) {
    ctx.log?.("microsoft.calendar.checkpoint.invalid", { keys: Object.keys(checkpoint) });
    yield* run(ctx, client, options, null, true);
    return;
  }
  if (parsed && isWindowStale(parsed.window, ctx.now(), options.window)) {
    ctx.log?.("microsoft.calendar.window.stale", { start: parsed.window.start, end: parsed.window.end });
    yield* run(ctx, client, options, null, true);
    return;
  }
  yield* run(ctx, client, options, parsed, false);
}

async function* run(
  ctx: SyncContext,
  client: GraphApiClient,
  options: CalendarSyncOptions,
  previous: CalendarCheckpoint | null,
  fullResync: boolean,
): AsyncIterable<SyncPage<CalendarSyncBatch>> {
  const prefer = `odata.maxpagesize=${options.pageSize}, outlook.timezone="UTC"`;
  const window = previous?.window ?? openWindow(ctx.now(), options.window);
  let next: string = previous?.deltaLink ?? initialCalendarDeltaUrl(window);
  ctx.log?.(previous ? "microsoft.calendar.delta.start" : "microsoft.calendar.window.open", { fullResync, start: window.start, end: window.end });

  for (;;) {
    const res = await client.getJson<GraphDeltaPage<GraphEventDeltaEntry>>(next, { tolerate: [410], headers: { prefer } });
    if (res.status === 410) {
      if (!previous) throw new ConnectorError("checkpoint_invalid", "Microsoft Graph returned 410 for a fresh calendarView delta query", false);
      ctx.log?.("microsoft.calendar.delta.expired");
      yield* run(ctx, client, options, null, true);
      return;
    }
    const entries = res.body?.value ?? [];
    const deleted: NormalizedDeletion[] = [];
    const events: NormalizedTimeEvent[] = [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== "string" || !entry.id) continue;
      if (entry["@removed"] || entry.isCancelled === true) {
        deleted.push({ externalId: entry.id });
        continue;
      }
      try {
        events.push(normalizeGraphEvent(entry as GraphEvent, { selfAddress: ctx.account.address }));
      } catch (error) {
        if (error instanceof ConnectorError && error.code !== "invalid_response") throw error;
        ctx.log?.("microsoft.calendar.event.skipped", { id: entry.id, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const nextLink = res.body?.["@odata.nextLink"] ?? null;
    const deltaLink = res.body?.["@odata.deltaLink"] ?? null;
    if (!nextLink && !deltaLink) {
      throw new ConnectorError("invalid_response", "Microsoft Graph calendarView delta page has neither nextLink nor deltaLink", false);
    }
    const done = nextLink === null;
    const checkpoint: Checkpoint | null = done
      ? { deltaLink: deltaLink as string, window: { start: window.start, end: window.end } }
      : previous
        ? { deltaLink: previous.deltaLink, window: { start: previous.window.start, end: previous.window.end } }
        : null;
    ctx.log?.("microsoft.calendar.delta.page", { entries: entries.length, events: events.length, deleted: deleted.length, hasMore: !done });
    yield { batch: { events, deleted }, checkpoint, done, ...(fullResync ? { fullResync: true } : {}) };
    if (done) return;
    if (!isGraphUrl(nextLink as string)) throw new ConnectorError("invalid_response", "Microsoft Graph nextLink points outside Graph", false);
    next = nextLink as string;
  }
}
