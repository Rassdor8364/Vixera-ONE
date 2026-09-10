/**
 * Google Calendar sync source.
 *
 * Calendars come from `users/me/calendarList`: every entry the user has
 * selected (`selected !== false`) with more than free/busy access, plus the
 * primary calendar always. Each calendar syncs independently:
 *
 *   initial     events.list singleEvents=true timeMin/timeMax window, paginated;
 *               the calendar's `nextSyncToken` is stored after its last page
 *   incremental events.list syncToken=…; status cancelled → deletion
 *   HTTP 410    Google dropped the sync token → that calendar re-lists from
 *               scratch and its pages are marked `fullResync: true`
 *
 * Checkpoint (opaque to the engine, owned by this file):
 *   { calendars: { [calendarId]: { syncToken: string } } }
 *
 * A calendar's token is only written once its listing completed, so a crash
 * mid-calendar re-lists that calendar next run (idempotent by natural key)
 * without disturbing the tokens of calendars that already finished.
 */
import { type CalendarSyncBatch, type Checkpoint, type JsonObject, type NormalizedTimeEvent, type SyncContext, type SyncPage } from "@vixera/domain";
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

export interface GoogleCalendarCheckpoint {
  readonly calendars: { readonly [calendarId: string]: { readonly syncToken: string } };
}

export interface CalendarSyncOptions {
  readonly oauth: GoogleOAuthConfig;
  readonly window: CalendarWindow;
}

export function parseCalendarCheckpoint(checkpoint: Checkpoint | null): GoogleCalendarCheckpoint | null {
  if (!checkpoint) return null;
  const calendars = checkpoint.calendars;
  if (!calendars || typeof calendars !== "object" || Array.isArray(calendars)) return null;
  const out: Record<string, { syncToken: string }> = {};
  for (const [id, entry] of Object.entries(calendars)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const token = entry.syncToken;
    if (typeof token === "string" && token) out[id] = { syncToken: token };
  }
  return { calendars: out };
}

function toCheckpoint(tokens: ReadonlyMap<string, string>): Checkpoint {
  const calendars: JsonObject = {};
  for (const [id, syncToken] of tokens) calendars[id] = { syncToken };
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

  const calendars = selectCalendars(await listCalendars(client));
  // Tokens carried forward: only for calendars that still exist for this account.
  const tokens = new Map<string, string>();
  for (const c of calendars) {
    const prior = parsed?.calendars[c.id]?.syncToken;
    if (prior) tokens.set(c.id, prior);
  }
  ctx.log?.("calendar.sync.start", { calendars: calendars.length, withSyncToken: tokens.size });

  if (calendars.length === 0) {
    yield { batch: { events: [], deleted: [] }, checkpoint: toCheckpoint(tokens), done: true };
    return;
  }

  const now = ctx.now();
  const timeMin = new Date(now.getTime() - options.window.pastDays * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + options.window.futureDays * 86_400_000).toISOString();

  for (let i = 0; i < calendars.length; i++) {
    const calendar = calendars[i] as GoogleCalendarListEntry;
    const isLastCalendar = i === calendars.length - 1;
    let syncToken: string | null = tokens.get(calendar.id) ?? null;
    let pageToken: string | null = null;
    let fullResync = false;

    for (;;) {
      const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(calendar.id)}/events`);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("showDeleted", "true");
      url.searchParams.set("maxResults", String(EVENTS_PAGE_SIZE));
      if (syncToken) url.searchParams.set("syncToken", syncToken);
      else {
        url.searchParams.set("timeMin", timeMin);
        url.searchParams.set("timeMax", timeMax);
      }
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      // 410 only means "sync token expired" when we sent one; otherwise it is a real error
      // (tolerating it here would re-issue the identical request forever).
      const res = await client.getJson<GoogleEventList>(url, { tolerate: syncToken ? [410] : [] });
      if (res.status === 410) {
        ctx.log?.("calendar.syncToken.expired", { calendarId: calendar.id });
        tokens.delete(calendar.id);
        syncToken = null;
        pageToken = null;
        fullResync = true;
        continue;
      }

      const { events, deleted } = fold(ctx, calendar.id, res.body?.items ?? []);
      const nextPage = res.body?.nextPageToken ?? null;
      const nextSync = res.body?.nextSyncToken ?? null;
      if (!nextPage && nextSync) tokens.set(calendar.id, nextSync);
      ctx.log?.("calendar.page", { calendarId: calendar.id, events: events.length, deleted: deleted.length, hasMore: nextPage !== null, fullResync });

      yield {
        batch: { events, deleted },
        checkpoint: toCheckpoint(tokens),
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

function fold(ctx: SyncContext, calendarId: string, items: readonly GoogleEvent[]): CalendarSyncBatch {
  const events: NormalizedTimeEvent[] = [];
  const deleted: { externalId: string; externalCalendarId: string }[] = [];
  for (const raw of items) {
    if (!raw?.id) continue;
    if (raw.status === "cancelled") {
      deleted.push({ externalId: raw.id, externalCalendarId: calendarId });
      continue;
    }
    try {
      events.push(normalizeGoogleEvent(calendarId, raw));
    } catch (error) {
      ctx.log?.("calendar.event.skipped", { calendarId, id: raw.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { events, deleted };
}
