import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENTITY_TYPES, RELATIONSHIP_KINDS, RELATIONSHIP_SOURCES } from "./relationship.ts";
import {
  ACTION_REQUEST_STATUSES,
  ATTENTIONS,
  CONNECTOR_ACCOUNT_STATUSES,
  CONNECTOR_CAPABILITIES,
  CREDENTIAL_LOCATIONS,
  DOCUMENT_SOURCES,
  HANDOFF_STATES,
  INGEST_KINDS,
  INGEST_SOURCES,
  INGEST_STATUSES,
  MONEY_ACCOUNT_TYPES,
  PERSON_IDENTITY_KINDS,
  PLATFORMS,
  PROVIDER_IDS,
  SYNC_STATUSES,
  THREAD_STATUSES,
  TIME_EVENT_STATUSES,
} from "../entities/index.ts";

/**
 * Seam guard: every PostgreSQL enum in the spine migration must equal the
 * runtime constant that defines the matching TypeScript union. Adding a value
 * on either side without the other fails here.
 */
const MIGRATION = resolve(__dirname, "../../../../supabase/migrations/20260910000100_spine.sql");
const sql = readFileSync(MIGRATION, "utf8");

function sqlEnum(name: string): string[] {
  const m = sql.match(new RegExp(`create type public\\.${name} as enum \\(([^;]*)\\);`, "s"));
  if (!m) throw new Error(`enum ${name} not found in migration`);
  return [...(m[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}

const MIRRORS: Record<string, readonly string[]> = {
  entity_type: ENTITY_TYPES,
  relationship_kind: RELATIONSHIP_KINDS,
  relationship_source: RELATIONSHIP_SOURCES,
  platform: PLATFORMS,
  provider_id: PROVIDER_IDS,
  connector_capability: CONNECTOR_CAPABILITIES,
  connector_account_status: CONNECTOR_ACCOUNT_STATUSES,
  credential_location: CREDENTIAL_LOCATIONS,
  sync_status: SYNC_STATUSES,
  person_identity_kind: PERSON_IDENTITY_KINDS,
  thread_status: THREAD_STATUSES,
  document_source: DOCUMENT_SOURCES,
  money_account_type: MONEY_ACCOUNT_TYPES,
  time_event_status: TIME_EVENT_STATUSES,
  attention: ATTENTIONS,
  handoff_state: HANDOFF_STATES,
  ingest_kind: INGEST_KINDS,
  ingest_source: INGEST_SOURCES,
  ingest_status: INGEST_STATUSES,
  action_request_status: ACTION_REQUEST_STATUSES,
};

describe("domain enums mirror SQL enums", () => {
  for (const [name, values] of Object.entries(MIRRORS)) {
    it(name, () => {
      expect(sqlEnum(name)).toEqual([...values]);
    });
  }
  it("every SQL enum has a mirror", () => {
    const declared = [...sql.matchAll(/create type public\.(\w+) as enum/g)].map((m) => m[1]);
    expect(declared.sort()).toEqual(Object.keys(MIRRORS).sort());
  });
});
