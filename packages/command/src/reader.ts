import type { SpineReader } from "@vixera/sync";

/**
 * The slice of `SpineReader` One Command needs. A full `SpineReader`
 * (Supabase or in-memory store) satisfies it; tests use a small fake.
 *
 * Every reader is bound to one user at construction: no method here takes
 * a user id, so no command can be phrased to reach another user's rows.
 */
export type CommandReader = Pick<
  SpineReader,
  | "userId"
  | "listPeople"
  | "getPerson"
  | "listThreads"
  | "getThread"
  | "listDocuments"
  | "getDocument"
  | "listMailMessages"
  | "getMailMessage"
  | "listMoneyTransactions"
  | "getMoneyTransaction"
  | "listTimeEvents"
  | "getTimeEvent"
  | "neighbors"
>;
