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
    const ageMs = now - occurred;
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
    const endsAt = timeEvent ? Date.parse(timeEvent.endsAt) : ev.kind.startsWith("time.") && ev.dueAt ? Date.parse(ev.dueAt) + HOUR : null;
    const isTimeLike = ev.subject.type === "time_event" || ev.kind.startsWith("time.");

    if (isTimeLike && endsAt !== null && now > endsAt) {
      score -= 20;
      reasons.push("already happened");
    } else if (isTimeLike && ev.dueAt && Date.parse(ev.dueAt) <= now) {
      score += 20;
      reasons.push("happening now");
    } else if (ev.dueAt) {
      const untilDue = Date.parse(ev.dueAt) - now;
      if (untilDue <= 0) {
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
    } else if (ageMs > windowMs) {
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
      const start = Date.parse(t.startsAt);
      const end = Date.parse(t.endsAt);
      return end >= now && start <= now + 24 * HOUR;
    })
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));

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

function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
