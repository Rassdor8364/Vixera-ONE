/**
 * Where the Field is: one area (NOW, Threads, People, Time, Money, Files,
 * Quiet) and at most one focused entity. Pure functions; the React shell
 * holds the state.
 */
import type { EntityRef, EntityType } from "@vixera/domain";
import { FIELD_AREAS, isFieldArea, type CommandResult, type FieldArea, type ResultItem } from "@vixera/command";

export type { FieldArea };
export { FIELD_AREAS };

export interface FieldLocation {
  readonly area: FieldArea;
  readonly focus: EntityRef | null;
}

export const HOME: FieldLocation = { area: "now", focus: null };

export const AREA_LABELS: Readonly<Record<FieldArea, string>> = {
  now: "Now",
  threads: "Threads",
  people: "People",
  time: "Time",
  money: "Money",
  files: "Files",
  quiet: "Quiet",
};

/** The area that shows an entity type in detail. */
export function areaForEntity(type: EntityType): FieldArea {
  switch (type) {
    case "person":
      return "people";
    case "thread":
      return "threads";
    case "document":
    case "ingest_item":
      return "files";
    case "mail_message":
      return "people";
    case "time_event":
      return "time";
    case "money_account":
    case "money_transaction":
      return "money";
    case "context_event":
    case "handoff":
    case "device":
    case "conclusion":
      return "now";
  }
}

/** Location for a One Command result item click. */
export function locationForItem(item: ResultItem): FieldLocation {
  switch (item.type) {
    case "person":
      return { area: "people", focus: { type: "person", id: item.person.id } };
    case "thread":
      return { area: "threads", focus: { type: "thread", id: item.thread.id } };
    case "document":
      return { area: "files", focus: { type: "document", id: item.document.id } };
    case "mail":
      return item.message.from?.personId
        ? { area: "people", focus: { type: "person", id: item.message.from.personId } }
        : { area: "people", focus: { type: "mail_message", id: item.message.id } };
    case "time_event":
      return { area: "time", focus: { type: "time_event", id: item.event.id } };
    case "transaction":
      return { area: "money", focus: { type: "money_transaction", id: item.transaction.id } };
  }
}

/** Where a command result should take the Field: navigate results move, others stay unless they resolved one entity. */
export function locationForResult(result: CommandResult, current: FieldLocation): FieldLocation | null {
  if (result.kind === "navigate" && result.area && isFieldArea(result.area)) {
    return { area: result.area, focus: result.focus ?? null };
  }
  if (result.kind === "results" && result.focus && result.area && isFieldArea(result.area) && result.items.length === 1) {
    return { area: result.area, focus: result.focus };
  }
  return result.focus && result.area && isFieldArea(result.area) && result.area !== current.area ? { area: result.area, focus: result.focus } : null;
}

export function focusEntity(current: FieldLocation, focus: EntityRef): FieldLocation {
  return { area: areaForEntity(focus.type), focus };
}

export type ShortcutAction = "open-command" | "close" | null;

export interface KeyLike {
  readonly key: string;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
}

/** Alt+Space or Ctrl+K (⌘K) open One Command; Escape closes results. */
export function parseShortcut(e: KeyLike): ShortcutAction {
  const key = e.key.toLowerCase();
  if (key === "escape") return "close";
  if (e.altKey && (key === " " || key === "space" || key === "spacebar")) return "open-command";
  if ((e.ctrlKey || e.metaKey) && !e.altKey && key === "k") return "open-command";
  return null;
}

/** Persisted area between launches (a convenience, never context state). */
export const LAST_AREA_KEY = "vixera.field.area";

export function readLastArea(storage: Pick<Storage, "getItem"> | null): FieldArea {
  try {
    const raw = storage?.getItem(LAST_AREA_KEY);
    return raw && isFieldArea(raw) ? raw : "now";
  } catch {
    return "now";
  }
}
