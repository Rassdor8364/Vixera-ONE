/**
 * Google Calendar sync source.
 *
 * Calendars come from `users/me/calendarList`: every entry the user has
 * selected (`selected !== false`) with more than free/busy access, plus the
 * primary calendar always. Each calendar syncs independently:
 *
 *   initial     events.list singleEvents=true timeMin/timeMax window, paginated;
 *               every page checkpoints its `nextPageToken` (with the window it
 *               belongs to), the calendar's `nextSyncToken` replaces it after
 *               the last page
 *   incremental events.list syncToken=…; status cancelled → deletion
 *   HTTP 410    Google dropped the sync token → that calendar re-lists from
 *               scratch and its pages are marked `fullResync: true`
 *
 * Checkpoint (opaque to the engine, owned by this file):
 *   { calendars: { [calendarId]: { syncToken?: string,
 *                                  page?: { token: string, timeMin?: string, timeMax?: string, fullResync?: true },
 *                                  series?: { [masterEventId]: instanceEventId[] } } } }
 *
 * `page` is present while a listing is in progress and is what makes the
 * engine's deadline harmless: it can stop after any page and the next run
 * resumes that calendar from the same page token, with the same window
 * (Google requires every parameter except `pageToken` to match the request
 * that issued the token). A page token Google no longer accepts (400) makes
 * that one calendar re-list from scratch; the other calendars' tokens are
 * untouched. Pages are idempotent by natural key, so a replay costs nothing.
 *
 * `series` remembers which stored instances belong to which recurring
 * master. `singleEvents=true` stores expanded instances under their own ids,
 * but when the user deletes the whole series Google reports the MASTER id as
 * cancelled; without this map that deletion would match no row and every
 * instance would live on. Instances whose id dates them (Google's
 * `<master>_<YYYYMMDD[THHMMSSZ]>` form) are forgotten once they leave the
 * past window, so the map stays bounded; ids that cannot be dated are kept.
 */
import { ConnectorError, type CalendarSyncBatch, type Checkpoint, type JsonObject, type NormalizedTimeEvent, type SyncContext, type SyncPage } from "@vixera/domain";
import { GoogleApiClient } from "../http.ts";
import type { GoogleOAuthConfig } from "../oauth.ts";
import { normalizeGoogleEvent } from "./normalize.ts";
import type { GoogleCalendarList, GoogleCalendarListEntry, GoogleEvent, GoogleEventList } from "./types.ts";

export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const EVENTS_PAGE_SIZE = 250;
const CALENDAR_LIST_PAGE_SIZE = 250;

export interface CalendarWindow {
  readonly pastDays: number;
  readonly futureDays: number;
}

/** A listing in progress: the next page and the parameters the token is bound to. */
export interface CalendarPageState {
  readonly token: string;
  /** Present for an initial (windowed) listing; absent when paging a sync-token response. */
  readonly timeMin?: string;
  readonly timeMax?: string;
  /** Set when the listing replaces a sync token Google invalidated. */
  readonly fullResync?: true;
}

export interface CalendarCheckpointEntry {
  readonly syncToken?: string;
  readonly page?: CalendarPageState;
  /** Stored instance ids per recurring master id (see the file header). */
  readonly series?: { readonly [masterId: string]: readonly string[] };
}

export interface GoogleCalendarCheckpoint {
  readonly calendars: { readonly [calendarId: string]: CalendarCheckpointEntry };
}

export interface CalendarSyncOptions {
  readonly oauth: GoogleOAuthConfig;
  readonly window: CalendarWindow;
}

export function parseCalendarCheckpoint(checkpoint: Checkpoint | null): GoogleCalendarCheckpoint | null {
  if (!checkpoint) return null;
  const calendars = checkpoint.calendars;
  if (!calendars || typeof calendars !== "object" || Array.isArray(calendars)) return null;
  const out: Record<string, CalendarCheckpointEntry> = {};
  for (const [id, entry] of Object.entries(calendars)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const parsed: { syncToken?: string; page?: CalendarPageState; series?: Record<string, string[]> } = {};
    if (typeof entry.syncToken === "string" && entry.syncToken) parsed.syncToken = entry.syncToken;
    const page = parsePage(entry.page);
    if (page) parsed.page = page;
    const series = parseSeries(entry.series);
    if (series) parsed.series = series;
    if (parsed.syncToken || parsed.page || parsed.series) out[id] = parsed;
  }
  return { calendars: out };
}

function parseSeries(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string[]> = {};
  for (const [master, instances] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(instances)) continue;
    const ids = instances.filter((i): i is string => typeof i === "string" && i.length > 0);
    if (ids.length) out[master] = ids;
  }
  return Object.keys(out).length ? out : null;
}

function parsePage(value: unknown): CalendarPageState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.token !== "string" || !v.token) return null;
  const timeMin = typeof v.timeMin === "string" ? v.timeMin : undefined;
  const timeMax = typeof v.timeMax === "string" ? v.timeMax : undefined;
  if ((timeMin === undefined) !== (timeMax === undefined)) return null;
  return {
    token: v.token,
    ...(timeMin !== undefined && timeMax !== undefined ? { timeMin, timeMax } : {}),
    ...(v.fullResync === true ? { fullResync: true as const } : {}),
  };
}

/** Mutable per-calendar state for one run; serialized into the checkpoint after every page. */
interface CalendarState {
  syncToken: string | null;
  page: CalendarPageState | null;
  series: Map<string, Set<string>>;
}

function loadState(prior: CalendarCheckpointEntry | undefined, pastEdgeMs: number): CalendarState {
  const series = new Map<string, Set<string>>();
  for (const [master, ids] of Object.entries(prior?.series ?? {})) {
    const kept = ids.filter((id) => {
      const startMs = instanceStartMs(id);
      return startMs === null || startMs >= pastEdgeMs;
    });
    if (kept.length) series.set(master, new Set(kept));
  }
  return { syncToken: prior?.syncToken ?? null, page: prior?.page ?? null, series };
}

/** Start instant encoded in a Google instance id (`<master>_20260911T120000Z` or `<master>_20260911`), or null. */
function instanceStartMs(id: string): number | null {
  const m = /_(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/.exec(id);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  return Number.isFinite(ms) ? ms : null;
}

function toCheckpoint(states: ReadonlyMap<string, CalendarState>): Checkpoint {
  const calendars: JsonObject = {};
  for (const [id, state] of states) {
    const entry: JsonObject = {};
    if (state.syncToken) entry.syncToken = state.syncToken;
    if (state.page) {
      entry.page = {
        token: state.page.token,
        ...(state.page.timeMin !== undefined && state.page.timeMax !== undefined ? { timeMin: state.page.timeMin, timeMax: state.page.timeMax } : {}),
        ...(state.page.fullResync ? { fullResync: true } : {}),
      };
    }
    if (state.series.size) {
      const series: JsonObject = {};
      for (const [master, instances] of state.series) series[master] = [...instances];
      entry.series = series;
    }
    if (Object.keys(entry).length) calendars[id] = entry;
  }
  return { calendars };
}

/** Which calendars feed context. Always includes primary. */
export function selectCalendars(entries: readonly GoogleCalendarListEntry[]): GoogleCalendarListEntry[] {
  return entries.filter((c) => {
    if (!c.id || c.deleted === true) return false;
    if (c.primary === true) return true;
    if (c.selected === false) return false;
    return c.accessRole !== "freeBusyReader";
  });
}

export async function* syncCalendar(
  ctx: SyncContext,
  checkpoint: Checkpoint | null,
  options: CalendarSyncOptions,
): AsyncIterable<SyncPage<CalendarSyncBatch>> {
  const client = new GoogleApiClient(ctx, options.oauth);
  const parsed = parseCalendarCheckpoint(checkpoint);
  if (checkpoint && !parsed) ctx.log?.("calendar.checkpoint.invalid", { keys: Object.keys(checkpoint) });

  const now = ctx.now();
  const pastEdgeMs = now.getTime() - options.window.pastDays * 86_400_000;
  const freshWindow = {
    timeMin: new Date(pastEdgeMs).toISOString(),
    timeMax: new Date(now.getTime() + options.window.futureDays * 86_400_000).toISOString(),
  };

  const calendars = selectCalendars(await listCalendars(client));
  // State carried forward: only for calendars that still exist for this account.
  const states = new Map<string, CalendarState>();
  for (const c of calendars) states.set(c.id, loadState(parsed?.calendars[c.id], pastEdgeMs));
  ctx.log?.("calendar.sync.start", {
    calendars: calendars.length,
    withSyncToken: [...states.values()].filter((s) => s.syncToken !== null).length,
    resuming: [...states.values()].filter((s) => s.page !== null).length,
  });

  if (calendars.length === 0) {
    yield { batch: { events: [], deleted: [] }, checkpoint: toCheckpoint(states), done: true };
    return;
  }

  for (let i = 0; i < calendars.length; i++) {
    const calendar = calendars[i] as GoogleCalendarListEntry;
    const isLastCalendar = i === calendars.length - 1;
    const state = states.get(calendar.id) as CalendarState;
    // A resumed page keeps the window its token was issued for; a fresh listing gets a fresh one.
    let window = state.page?.timeMin !== undefined && state.page.timeMax !== undefined ? { timeMin: state.page.timeMin, timeMax: state.page.timeMax } : freshWindow;
    let pageToken: string | null = state.page?.token ?? null;
    let fullResync = state.page?.fullResync === true;
    let resumed = pageToken !== null;

    for (;;) {
      const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendar.id)}/events`);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("showDeleted", "true");
      url.searchParams.set("maxResults", String(EVENTS_PAGE_SIZE));
      if (state.syncToken) url.searchParams.set("syncToken", state.syncToken);
      else {
        url.searchParams.set("timeMin", window.timeMin);
        url.searchParams.set("timeMax", window.timeMax);
      }
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      // 410 only means "sync token expired" when we sent one; otherwise it is a real error
      // (tolerating it here would re-issue the identical request forever).
      let res;
      try {
        res = await client.getJson<GoogleEventList>(url, { tolerate: state.syncToken ? [410] : [] });
      } catch (error) {
        // Google rejects a stale page token with 400. It came out of OUR checkpoint
        // for THIS calendar, so start this calendar over (the pages already applied
        // are idempotent) instead of failing the run or clearing every calendar's token.
        if (resumed && pageToken && error instanceof ConnectorError && /HTTP 400|API error 400/.test(error.message)) {
          ctx.log?.("calendar.pageToken.rejected", { calendarId: calendar.id });
          state.page = null;
          pageToken = null;
          resumed = false;
          window = freshWindow;
          continue;
        }
        throw error;
      }
      // Only the token we resumed with gets that treatment; a 400 later in the run is a real error.
      resumed = false;
      if (res.status === 410) {
        ctx.log?.("calendar.syncToken.expired", { calendarId: calendar.id });
        state.syncToken = null;
        state.page = null;
        pageToken = null;
        resumed = false;
        window = freshWindow;
        fullResync = true;
        continue;
      }

      const { events, deleted } = fold(ctx, calendar.id, res.body?.items ?? [], state.series);
      const nextPage = res.body?.nextPageToken ?? null;
      const nextSync = res.body?.nextSyncToken ?? null;
      if (nextPage) {
        state.page = {
          token: nextPage,
          ...(state.syncToken ? {} : window),
          ...(fullResync ? { fullResync: true as const } : {}),
        };
      } else {
        state.page = null;
        if (nextSync) state.syncToken = nextSync;
      }
      ctx.log?.("calendar.page", { calendarId: calendar.id, events: events.length, deleted: deleted.length, hasMore: nextPage !== null, fullResync });

      yield {
        batch: { events, deleted },
        checkpoint: toCheckpoint(states),
        done: isLastCalendar && nextPage === null,
        ...(fullResync ? { fullResync: true } : {}),
      };
      if (!nextPage) break;
      pageToken = nextPage;
    }
  }
}

async function listCalendars(client: GoogleApiClient): Promise<GoogleCalendarListEntry[]> {
  const out: GoogleCalendarListEntry[] = [];
  let pageToken: string | null = null;
  for (;;) {
    const url = new URL(`${CALENDAR_API}/users/me/calendarList`);
    url.searchParams.set("maxResults", String(CALENDAR_LIST_PAGE_SIZE));
    url.searchParams.set("minAccessRole", "reader");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await client.getJson<GoogleCalendarList>(url);
    out.push(...(res.body?.items ?? []));
    pageToken = res.body?.nextPageToken ?? null;
    if (!pageToken) return out;
  }
}

/**
 * Normalizes a page. Cancelled items become deletions; a cancelled id that is
 * a known recurring master fans out to every instance stored under it.
 * `series` is updated in place (instances registered, cancelled ones and
 * cancelled masters forgotten) so the checkpoint written after this page
 * reflects it.
 */
function fold(ctx: SyncContext, calendarId: string, items: readonly GoogleEvent[], series: Map<string, Set<string>>): CalendarSyncBatch {
  const events: NormalizedTimeEvent[] = [];
  const deletedIds = new Set<string>();
  for (const raw of items) {
    if (!raw?.id) continue;
    if (raw.status === "cancelled") {
      deletedIds.add(raw.id);
      if (raw.recurringEventId) {
        const siblings = series.get(raw.recurringEventId);
        siblings?.delete(raw.id);
        if (siblings?.size === 0) series.delete(raw.recurringEventId);
      } else {
        const instances = series.get(raw.id);
        if (instances) {
          for (const id of instances) deletedIds.add(id);
          series.delete(raw.id);
          ctx.log?.("calendar.series.cancelled", { calendarId, id: raw.id, instances: instances.size });
        }
      }
      continue;
    }
    try {
      events.push(normalizeGoogleEvent(calendarId, raw));
    } catch (error) {
      ctx.log?.("calendar.event.skipped", { calendarId, id: raw.id, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (raw.recurringEventId) {
      const instances = series.get(raw.recurringEventId) ?? new Set<string>();
      instances.add(raw.id);
      series.set(raw.recurringEventId, instances);
    }
  }
  return { events, deleted: [...deletedIds].map((externalId) => ({ externalId, externalCalendarId: calendarId })) };
}
