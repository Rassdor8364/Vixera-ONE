/**
 * Windows notifications for new "needs me" items. Informational only: the
 * notification carries no action buttons; actions run from NOW through the
 * server action seam. Shown ids are remembered in localStorage so an item is
 * announced once per device.
 */
import type { NowItem } from "@vixera/domain";
import { notify } from "../platform/notifications.ts";

export const NOTIFIED_KEY = "vixera.notified";
const MAX_REMEMBERED = 500;

/** Items not yet announced. Items without a context event id cannot be tracked and are skipped. */
export function pickNewNeedsMe(items: readonly NowItem[], shown: ReadonlySet<string>): NowItem[] {
  return items.filter((i) => i.contextEventId !== null && !shown.has(i.contextEventId));
}

export function readShownIds(storage: Pick<Storage, "getItem"> | null): Set<string> {
  try {
    const raw = storage?.getItem(NOTIFIED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeShownIds(storage: Pick<Storage, "setItem"> | null, ids: ReadonlySet<string>): void {
  try {
    storage?.setItem(NOTIFIED_KEY, JSON.stringify([...ids].slice(-MAX_REMEMBERED)));
  } catch {
    // Best effort: a missing store only means a repeated notification after restart.
  }
}

export interface NotifierOptions {
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  readonly send?: (title: string, body: string) => Promise<boolean>;
  /** The first batch after launch is not announced (the user is looking at NOW). */
  readonly announceInitial?: boolean;
}

/**
 * Stateful notifier: call `observe(needsMe)` after each refresh. The first
 * observation only records ids; later observations announce new ones.
 */
export function createNeedsMeNotifier(options: NotifierOptions = {}) {
  const storage = options.storage === undefined ? (typeof localStorage === "undefined" ? null : localStorage) : options.storage;
  const send = options.send ?? ((title: string, body: string) => notify({ title, body }));
  const shown = readShownIds(storage);
  let primed = options.announceInitial === true;
  return {
    async observe(needsMe: readonly NowItem[]): Promise<NowItem[]> {
      const fresh = pickNewNeedsMe(needsMe, shown);
      for (const item of fresh) if (item.contextEventId) shown.add(item.contextEventId);
      if (fresh.length) writeShownIds(storage, shown);
      if (!primed) {
        primed = true;
        return [];
      }
      for (const item of fresh) await send(item.title, item.summary ?? "Needs you — open Vixera One").catch(() => false);
      return fresh;
    },
    shown,
  };
}
