import type { CommandContext, EventRange, TransactionRange } from "./intent.ts";

/**
 * Calendar ranges for One Command, computed from `context.now`. Days are
 * taken in `context.timezone` (IANA name) when given, in UTC otherwise;
 * only web-standard `Intl` is used so this runs in Deno, browsers and Node.
 *
 * Ranges are half-open `[from, to)` instants as ISO strings.
 */
export interface Range {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;

export function eventRange(range: EventRange, context: Pick<CommandContext, "now" | "timezone">): Range {
  if (typeof range === "object") return { from: iso(range.from), to: iso(range.to) };
  const tz = validTimezone(context.timezone);
  const today = startOfDay(context.now, tz);
  switch (range) {
    case "today":
      return { from: today.toISOString(), to: addDays(today, 1, tz).toISOString() };
    case "tomorrow": {
      const start = addDays(today, 1, tz);
      return { from: start.toISOString(), to: addDays(start, 1, tz).toISOString() };
    }
    case "week": {
      // Calendar week, Monday to Sunday, containing "now".
      const dow = weekday(context.now, tz);
      const monday = addDays(today, -((dow + 6) % 7), tz);
      return { from: monday.toISOString(), to: addDays(monday, 7, tz).toISOString() };
    }
  }
}

/** Posted-date range (YYYY-MM-DD, inclusive) for transactions; null = unbounded. */
export function transactionRange(
  range: TransactionRange | undefined,
  context: Pick<CommandContext, "now" | "timezone">,
): { readonly from: string; readonly to: string } | null {
  if (!range || range === "all") return null;
  const tz = validTimezone(context.timezone);
  const today = startOfDay(context.now, tz);
  const to = localDate(context.now, tz);
  if (range === "week") return { from: localDate(addDays(today, -6, tz), tz), to };
  const { year, month } = ymd(context.now, tz);
  return { from: `${year}-${pad(month)}-01`, to };
}

/** YYYY-MM-DD of an instant in the given timezone (UTC when omitted). */
export function localDate(at: Date, tz?: string): string {
  const { year, month, day } = ymd(at, tz);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Midnight of the local day containing `at`, as an instant. */
export function startOfDay(at: Date, tz?: string): Date {
  const { year, month, day } = ymd(at, tz);
  const utcMidnight = Date.UTC(year, month - 1, day);
  if (!tz) return new Date(utcMidnight);
  // Two passes so the offset in force AT midnight is used (DST edges).
  let guess = new Date(utcMidnight - offsetMs(at, tz));
  const second = new Date(utcMidnight - offsetMs(guess, tz));
  if (second.getTime() !== guess.getTime()) guess = second;
  return guess;
}

function addDays(dayStart: Date, days: number, tz?: string): Date {
  // Step by whole days then re-anchor to midnight, so DST transitions do not drift.
  const rough = new Date(dayStart.getTime() + days * DAY_MS + (tz ? DAY_MS / 2 : 0));
  return tz ? startOfDay(rough, tz) : rough;
}

function weekday(at: Date, tz?: string): number {
  if (!tz) return at.getUTCDay();
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(at);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

function ymd(at: Date, tz?: string): { year: number; month: number; day: number } {
  if (!tz) return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** UTC offset of `tz` at instant `at`, in milliseconds (positive east of UTC). */
function offsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** An unknown IANA name must not crash a command: fall back to UTC instead of letting `Intl` throw. */
function validTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

function iso(value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`Invalid date: ${value}`);
  return new Date(t).toISOString();
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
