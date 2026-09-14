import type { ContextEvent } from "../entities/context-event.ts";
import type { MoneyTransaction } from "../entities/money.ts";
import type { Thread } from "../entities/thread.ts";
import type { TimeEvent } from "../entities/time.ts";
import type { Relationship } from "../graph/relationship.ts";
import { refKey, type EntityRef } from "../graph/relationship.ts";

/**
 * NOW answers: What matters? What changed? What needs me? What can wait?
 * Quiet holds what does not need attention.
 *
 * This is deterministic on purpose. The inputs are the spine's own rows; the
 * output is a ranked partition. A learned attention model can replace the
 * scoring function later without changing the shape of the result.
 */

export type NowBucket = "needs_me" | "changed" | "can_wait" | "quiet";

export interface NowItem {
  readonly bucket: NowBucket;
  readonly score: number;
  readonly title: string;
  readonly summary: string | null;
  readonly subject: EntityRef;
  readonly contextEventId: string | null;
  readonly kind: string;
  readonly occurredAt: string;
  readonly dueAt: string | null;
  readonly threadIds: readonly string[];
  readonly reasons: readonly string[];
}

export interface NowInput {
  readonly contextEvents: readonly ContextEvent[];
  /** Used for `upcoming` and to know when a time.* event has ended. */
  readonly timeEvents: readonly TimeEvent[];
  /** Reserved for money-aware rules (not used by the Phase 1 scoring). */
  readonly moneyTransactions?: readonly MoneyTransaction[];
  readonly threads: readonly Thread[];
  readonly relationships: readonly Relationship[];
  readonly now: Date;
  /** Events older than this (hours) are not "changed" anymore. Default 48. */
  readonly changedWindowHours?: number;
  /**
   * The user's IANA zone. All-day events are stored as UTC midnight of their
   * civil date; their real boundaries are local midnight in this zone. Falls
   * back to the event's own `timezone`, then UTC.
   */
  readonly timeZone?: string;
}

export interface NowResult {
  readonly needsMe: readonly NowItem[];
  readonly changed: readonly NowItem[];
  readonly canWait: readonly NowItem[];
  readonly quiet: readonly NowItem[];
  readonly upcoming: readonly TimeEvent[];
  readonly generatedAt: string;
}

const HOUR = 3600_000;

export const NOW_THRESHOLDS = {
  needsMe: 70,
  changed: 45,
  canWait: 20,
} as const;

export function deriveNow(input: NowInput): NowResult {
  const now = input.now.getTime();
  const windowMs = (input.changedWindowHours ?? 48) * HOUR;
  const threadIndex = buildThreadIndex(input.relationships, input.threads);
  const timeById = new Map(input.timeEvents.map((t) => [t.id as string, t]));

  const items: NowItem[] = [];

  for (const ev of input.contextEvents) {
    const occurred = Date.parse(ev.occurredAt);
    // An unparseable timestamp must not read as "just now": NaN compares false
    // with everything, which used to skip both the recency bonus and the age
    // penalty. Treat it as older than any window.
    const ageMs = Number.isNaN(occurred) ? Number.POSITIVE_INFINITY : now - occurred;
    const threadIds = threadIndex.get(refKey(ev.subject)) ?? [];
    const reasons: string[] = [];
    let score = clamp(ev.importance, 0, 100);
    reasons.push(`importance ${ev.importance}`);

    if (ev.attention === "dismissed") {
      continue;
    }

    // A snoozed item (context_event.snooze → attention quiet + metadata.snoozedUntil)
    // stays quiet until the time passes, then competes for attention again.
    const snoozedUntil = parseIso(ev.metadata["snoozedUntil"]);
    const snoozeActive = ev.attention === "quiet" && snoozedUntil !== null && snoozedUntil > now;
    const snoozeElapsed = ev.attention === "quiet" && snoozedUntil !== null && snoozedUntil <= now;
    if (snoozeElapsed) reasons.push("snooze elapsed");

    // Time events are appointments, not deadlines: once they end they are over.
    const timeEvent = ev.subject.type === "time_event" ? timeById.get(ev.subject.id) : undefined;
    const bounds = timeEvent ? eventBounds(timeEvent, input.timeZone) : null;
    const endsAt = bounds ? bounds.end : ev.kind.startsWith("time.") && ev.dueAt ? Date.parse(ev.dueAt) + HOUR : null;
    const startsAt = bounds ? bounds.start : ev.dueAt ? Date.parse(ev.dueAt) : null;
    const isTimeLike = ev.subject.type === "time_event" || ev.kind.startsWith("time.");
    const over = isTimeLike && endsAt !== null && now > endsAt;
    let overdue = false;

    if (over) {
      score -= 20;
      reasons.push("already happened");
    } else if (isTimeLike && startsAt !== null && startsAt <= now) {
      score += 20;
      reasons.push("happening now");
    } else if (startsAt !== null) {
      // For an appointment the "due" instant is its effective start (local
      // midnight for all-day events), never the raw stored UTC midnight.
      const untilDue = startsAt - now;
      if (untilDue <= 0) {
        overdue = true;
        score += 30;
        reasons.push("overdue");
      } else if (untilDue <= 24 * HOUR) {
        score += 25;
        reasons.push("due within 24h");
      } else if (untilDue <= 48 * HOUR) {
        score += 15;
        reasons.push("due within 48h");
      } else if (untilDue <= 7 * 24 * HOUR) {
        score += 5;
        reasons.push("due this week");
      }
    }

    if (ageMs >= 0 && ageMs <= 6 * HOUR) {
      score += 10;
      reasons.push("recent");
    } else if (ageMs > windowMs && !overdue) {
      // Age is not a reason to forget something that is past due: the longer an
      // invoice is overdue the MORE it deserves attention, not less.
      score -= 15;
      reasons.push("older than window");
    }

    if (threadIds.length) {
      score += 8;
      reasons.push("attached to a thread");
    }

    let bucket: NowBucket;
    if (snoozeActive) {
      bucket = "quiet";
      reasons.push("snoozed");
    } else if (ev.attention === "quiet" && !snoozeElapsed) {
      bucket = "quiet";
      reasons.push("user marked quiet");
    } else if (over) {
      // An appointment that has ended is over, whatever its importance: it can
      // sort high inside Quiet but never competes with what is still ahead.
      bucket = "quiet";
    } else if (score >= NOW_THRESHOLDS.needsMe) {
      bucket = "needs_me";
    } else if (score >= NOW_THRESHOLDS.changed && ageMs <= windowMs) {
      bucket = "changed";
    } else if (score >= NOW_THRESHOLDS.canWait) {
      bucket = "can_wait";
    } else {
      bucket = "quiet";
    }

    items.push({
      bucket,
      score: Math.round(score),
      title: ev.title,
      summary: ev.summary,
      subject: ev.subject,
      contextEventId: ev.id,
      kind: ev.kind,
      occurredAt: ev.occurredAt,
      dueAt: ev.dueAt,
      threadIds,
      reasons,
    });
  }

  // Upcoming time: the next 24h of confirmed events, independent of context events.
  const upcoming = input.timeEvents
    .filter((t) => t.status !== "cancelled")
    .filter((t) => {
      const { start, end } = eventBounds(t, input.timeZone);
      return end >= now && start <= now + 24 * HOUR;
    })
    .sort((a, b) => eventBounds(a, input.timeZone).start - eventBounds(b, input.timeZone).start);

  const byScore = (a: NowItem, b: NowItem) => b.score - a.score || Date.parse(b.occurredAt) - Date.parse(a.occurredAt);

  return {
    needsMe: items.filter((i) => i.bucket === "needs_me").sort(byScore),
    changed: items.filter((i) => i.bucket === "changed").sort(byScore),
    canWait: items.filter((i) => i.bucket === "can_wait").sort(byScore),
    quiet: items.filter((i) => i.bucket === "quiet").sort(byScore),
    upcoming,
    generatedAt: input.now.toISOString(),
  };
}

/** entity key → thread ids it belongs to / is attached to. */
function buildThreadIndex(relationships: readonly Relationship[], threads: readonly Thread[]): Map<string, string[]> {
  const threadIds = new Set(threads.map((t) => t.id as string));
  const index = new Map<string, string[]>();
  const add = (entity: EntityRef, threadId: string) => {
    if (!threadIds.has(threadId)) return;
    const k = refKey(entity);
    const arr = index.get(k) ?? [];
    if (!arr.includes(threadId)) arr.push(threadId);
    index.set(k, arr);
  };
  for (const r of relationships) {
    if (r.to.type === "thread" && r.from.type !== "thread") add(r.from, r.to.id);
    if (r.from.type === "thread" && r.to.type !== "thread") add(r.to, r.from.id);
  }
  return index;
}

/**
 * When an event really starts and ends, as instants. Timed events are what
 * they say. All-day events are stored as UTC midnight of their civil dates
 * (exclusive end), so their true boundaries are local midnight in the user's
 * zone: an all-day offsite on the 10th is "happening now" from 00:00 local on
 * the 10th, not from 17:00 the evening before for someone in Los Angeles.
 */
export function eventBounds(event: TimeEvent, timeZone: string | undefined): { readonly start: number; readonly end: number } {
  if (!event.allDay) return { start: Date.parse(event.startsAt), end: Date.parse(event.endsAt) };
  const zone = timeZone ?? event.timezone ?? "UTC";
  return { start: zonedMidnight(event.startsAt.slice(0, 10), zone), end: zonedMidnight(event.endsAt.slice(0, 10), zone) };
}

/** The instant of 00:00 on `ymd` in `zone`; `Intl` only, DST-safe by iterating once. */
export function zonedMidnight(ymd: string, zone: string): number {
  const utcMidnight = Date.parse(`${ymd}T00:00:00Z`);
  if (Number.isNaN(utcMidnight)) return Number.NaN;
  let guess = utcMidnight;
  for (let i = 0; i < 2; i++) guess = utcMidnight - zoneOffsetMs(guess, zone);
  return guess;
}

function zoneOffsetMs(instant: number, zone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  } catch {
    return 0; // unknown zone: behave as UTC rather than throw inside NOW
  }
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second")) - instant;
}

function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
