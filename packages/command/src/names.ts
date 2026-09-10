import type { EntityRef, Person, Thread } from "@vixera/domain";
import type { CommandReader } from "./reader.ts";

/**
 * Name resolution over the user's own people and threads. Exact display
 * name / title wins; then an exact first-name (or any name token) match;
 * then whatever the reader's substring search returned. Ambiguity is a
 * result, not an error: callers list the candidates instead of guessing.
 */
export type Resolution<T> =
  | { readonly status: "one"; readonly match: T }
  | { readonly status: "many"; readonly candidates: readonly T[] }
  | { readonly status: "none" };

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * How well the best row matches: 3 exact name, 2 a whole name token ("eric"
 * in "Eric Lindqvist"), 1 name prefix, 0 only the reader's substring search
 * (organization, email, thread summary...), -1 nothing.
 */
export type MatchQuality = -1 | 0 | 1 | 2 | 3;

export interface Ranked<T> {
  readonly rows: T[];
  readonly quality: MatchQuality;
}

function rank<T>(rows: readonly T[], query: string, nameOf: (row: T) => string): Ranked<T> {
  const q = norm(query);
  if (!q || !rows.length) return { rows: [], quality: -1 };
  const exact = rows.filter((r) => norm(nameOf(r)) === q);
  if (exact.length) return { rows: exact, quality: 3 };
  const tokens = rows.filter((r) => norm(nameOf(r)).split(" ").includes(q));
  if (tokens.length) return { rows: tokens, quality: 2 };
  const first = rows.filter((r) => norm(nameOf(r)).startsWith(q));
  if (first.length) return { rows: first, quality: 1 };
  return { rows: [...rows], quality: 0 };
}

function toResolution<T>(ranked: readonly T[]): Resolution<T> {
  if (ranked.length === 1) return { status: "one", match: ranked[0] as T };
  if (ranked.length === 0) return { status: "none" };
  return { status: "many", candidates: ranked };
}

export async function searchPeople(reader: CommandReader, query: string): Promise<Ranked<Person>> {
  const q = norm(query);
  if (!q) return { rows: [], quality: -1 };
  const rows = await reader.listPeople({ search: q });
  return rank(
    rows.filter((p) => p.mergedIntoId === null),
    q,
    (p) => p.displayName,
  );
}

export async function searchThreads(reader: CommandReader, query: string): Promise<Ranked<Thread>> {
  const q = norm(query);
  if (!q) return { rows: [], quality: -1 };
  const rows = await reader.listThreads({ search: q });
  return rank(rows, q, (t) => t.title);
}

/**
 * Resolves a person query. When the Field has a person in focus whose name
 * is the query (the router puts the focus name into scoped intents), the
 * focused person wins even if someone else shares the name.
 */
export async function resolvePerson(reader: CommandReader, query: string, focus?: EntityRef | null): Promise<Resolution<Person>> {
  if (focus?.type === "person") {
    const focused = await reader.getPerson(focus.id);
    if (focused && norm(focused.displayName) === norm(query)) return { status: "one", match: focused };
  }
  return toResolution((await searchPeople(reader, query)).rows);
}

export async function resolveThread(reader: CommandReader, query: string, focus?: EntityRef | null): Promise<Resolution<Thread>> {
  if (focus?.type === "thread") {
    const focused = await reader.getThread(focus.id);
    if (focused && norm(focused.title) === norm(query)) return { status: "one", match: focused };
  }
  return toResolution((await searchThreads(reader, query)).rows);
}
