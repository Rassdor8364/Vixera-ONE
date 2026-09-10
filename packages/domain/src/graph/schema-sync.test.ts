import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_TYPES, RELATIONSHIP_KINDS } from "./relationship.ts";

/**
 * Seam guard: the TypeScript enums and the PostgreSQL enums must be identical.
 * Reads the first migration and compares every `create type ... as enum (...)`.
 */
const MIGRATION = resolve(__dirname, "../../../../supabase/migrations/20260910000100_spine.sql");

function sqlEnum(name: string): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(new RegExp(`create type public\\.${name} as enum \\(([^;]*)\\);`, "s"));
  if (!m) throw new Error(`enum ${name} not found in migration`);
  return [...(m[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}

describe("domain enums mirror SQL enums", () => {
  it("entity_type", () => {
    expect(sqlEnum("entity_type")).toEqual([...ENTITY_TYPES]);
  });
  it("relationship_kind", () => {
    expect(sqlEnum("relationship_kind")).toEqual([...RELATIONSHIP_KINDS]);
  });
  it("provider_id / capability / status enums cover the TS unions", () => {
    expect(sqlEnum("provider_id")).toEqual(["google", "microsoft", "plaid", "praxion", "mock"]);
    expect(sqlEnum("connector_capability")).toEqual(["mail", "calendar", "bank", "document"]);
    expect(sqlEnum("connector_account_status")).toEqual(["active", "paused", "needs_reauth", "error", "disconnected"]);
    expect(sqlEnum("credential_location")).toEqual(["server_vault", "device", "none"]);
    expect(sqlEnum("attention")).toEqual(["needs_attention", "quiet", "dismissed"]);
    expect(sqlEnum("handoff_state")).toEqual(["pending", "delivered", "accepted", "expired", "cancelled"]);
    expect(sqlEnum("ingest_kind")).toEqual(["file", "image", "url", "text"]);
    expect(sqlEnum("ingest_source")).toEqual(["share", "capture", "drop", "clipboard", "command"]);
    expect(sqlEnum("document_source")).toEqual(["mail_attachment", "share", "capture", "drop", "praxion", "filesystem", "handoff", "connector"]);
    expect(sqlEnum("money_account_type")).toEqual(["checking", "savings", "credit", "loan", "investment", "other"]);
    expect(sqlEnum("time_event_status")).toEqual(["confirmed", "tentative", "cancelled"]);
    expect(sqlEnum("thread_status")).toEqual(["active", "quiet", "archived"]);
    expect(sqlEnum("action_request_status")).toEqual(["queued", "running", "done", "failed"]);
    expect(sqlEnum("platform")).toEqual(["windows", "android", "macos", "ios", "ipados", "web", "server"]);
  });
});
