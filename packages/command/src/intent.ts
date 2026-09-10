import type { EntityRef } from "@vixera/domain";

/**
 * One Command intents. The router turns free text into one of these; the
 * executor turns one of these into a `CommandResult`. Intents carry the
 * user's words (query strings), never resolved ids: name resolution happens
 * in the executor so an ambiguous "Marta" can be answered with candidates
 * instead of a wrong pick.
 */

/** The areas of the Field. Nothing more (brief). */
export const FIELD_AREAS = ["now", "threads", "people", "time", "money", "files", "quiet"] as const;
export type FieldArea = (typeof FIELD_AREAS)[number];

export function isFieldArea(value: string): value is FieldArea {
  return (FIELD_AREAS as readonly string[]).includes(value);
}

export type EventRange = "today" | "tomorrow" | "week" | "next7" | { readonly from: string; readonly to: string };
export type DocumentKind = "invoice" | "contract" | "agreement" | "pdf" | "image" | "any";
export type TransactionRange = "month" | "week" | "all";

export interface TransactionScope {
  readonly threadQuery?: string;
  readonly personQuery?: string;
}

export type Intent =
  | { readonly type: "find_person"; readonly query: string }
  | { readonly type: "show_person_documents"; readonly personQuery: string }
  | { readonly type: "show_person_mail"; readonly personQuery: string }
  | { readonly type: "show_events"; readonly range: EventRange }
  | { readonly type: "find_document"; readonly query?: string; readonly fromPersonQuery?: string; readonly kind?: DocumentKind }
  | { readonly type: "show_recent_files"; readonly limit: number }
  | { readonly type: "show_transactions"; readonly scope?: TransactionScope; readonly range?: TransactionRange }
  | { readonly type: "show_thread"; readonly query: string }
  | { readonly type: "open_area"; readonly area: FieldArea }
  | { readonly type: "unknown"; readonly text: string };

export type IntentType = Intent["type"];

/**
 * What the Field knows when the user types: the area on screen, the entity
 * in focus (a person, a thread, a document...), the clock and the user's
 * timezone. "today" is computed in `timezone` when given, else in UTC.
 */
export interface CommandContext {
  readonly area: FieldArea;
  readonly focus?: EntityRef | null;
  readonly now: Date;
  readonly timezone?: string;
}
