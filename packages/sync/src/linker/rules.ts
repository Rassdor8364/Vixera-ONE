import type { Attention, NormalizedMailMessage, NormalizedMoneyTransaction, NormalizedTimeEvent } from "@vixera/domain";

/**
 * Importance and attention rules of the ContextLinker. Deterministic on
 * purpose (brief: "deterministic logic first"); `deriveNow()` adds time
 * sensitivity and recency on top of the importance chosen here, so these
 * numbers are the baseline of what a kind of event is worth, 0–100.
 *
 * Every constant is exported so the Field and tests can name the rule they
 * rely on instead of repeating a magic number.
 */

// --- Mail ------------------------------------------------------------------
/** Unread mail from a person Vixera already knew, carrying an attachment ("Eric's invoice"). */
export const MAIL_UNREAD_KNOWN_WITH_ATTACHMENT = 60;
/** Any other unread mail. */
export const MAIL_UNREAD = 45;
/** Mail the user has already read: context, not attention. */
export const MAIL_READ = 25;
/** Mail older than this many days at first sight is filed as quiet, never as "needs me". */
export const MAIL_QUIET_AFTER_DAYS = 14;

// --- Time ------------------------------------------------------------------
/** A confirmed / tentative event starting within this many hours. */
export const TIME_SOON_HOURS = 48;
export const TIME_EVENT_SOON = 55;
export const TIME_EVENT_LATER = 35;
/** A cancellation is always worth a look. */
export const TIME_EVENT_CANCELLED = 50;

// --- Money -----------------------------------------------------------------
/** Absolute amount (account currency units) from which a transaction is notable. */
export const MONEY_LARGE_ABS_AMOUNT = 1000;
export const MONEY_TRANSACTION_LARGE = 50;
export const MONEY_TRANSACTION_SMALL = 30;

// --- Context event kinds ---------------------------------------------------
export const KIND_MAIL_RECEIVED = "mail.received";
export const KIND_TIME_EVENT_CREATED = "time.event.created";
export const KIND_TIME_EVENT_CHANGED = "time.event.changed";
export const KIND_TIME_EVENT_CANCELLED = "time.event.cancelled";
export const KIND_MONEY_TRANSACTION_POSTED = "money.transaction.posted";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface MailRuleInput {
  readonly message: NormalizedMailMessage;
  /** True when the sender resolved to a Person that existed before this batch. */
  readonly senderKnown: boolean;
}

export function mailImportance({ message, senderKnown }: MailRuleInput): number {
  if (!message.isUnread) return MAIL_READ;
  if (senderKnown && message.attachments.length > 0) return MAIL_UNREAD_KNOWN_WITH_ATTACHMENT;
  return MAIL_UNREAD;
}

export function mailAttention(message: NormalizedMailMessage, now: Date): Attention {
  const age = now.getTime() - Date.parse(message.receivedAt);
  return age > MAIL_QUIET_AFTER_DAYS * DAY ? "quiet" : "needs_attention";
}

export function timeImportance(event: NormalizedTimeEvent, now: Date): number {
  if (event.status === "cancelled") return TIME_EVENT_CANCELLED;
  const untilStart = Date.parse(event.startsAt) - now.getTime();
  const stillRelevant = Date.parse(event.endsAt) >= now.getTime();
  return stillRelevant && untilStart <= TIME_SOON_HOURS * HOUR ? TIME_EVENT_SOON : TIME_EVENT_LATER;
}

/** Events that already ended are context, not attention. Cancellations of past events too. */
export function timeAttention(event: NormalizedTimeEvent, now: Date): Attention {
  return Date.parse(event.endsAt) < now.getTime() ? "quiet" : "needs_attention";
}

export function timeEventKind(event: NormalizedTimeEvent, firstSight: boolean): string {
  if (event.status === "cancelled") return KIND_TIME_EVENT_CANCELLED;
  return firstSight ? KIND_TIME_EVENT_CREATED : KIND_TIME_EVENT_CHANGED;
}

export function moneyImportance(tx: NormalizedMoneyTransaction): number {
  const abs = Math.abs(Number(tx.amount));
  return Number.isFinite(abs) && abs >= MONEY_LARGE_ABS_AMOUNT ? MONEY_TRANSACTION_LARGE : MONEY_TRANSACTION_SMALL;
}

export function moneyAttention(_tx: NormalizedMoneyTransaction): Attention {
  return "needs_attention";
}
