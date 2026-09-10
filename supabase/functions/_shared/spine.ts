/**
 * Spine access for Edge Functions.
 *
 * The service-role client bypasses RLS, so it is NEVER handed to application
 * code directly: every read and write goes through a `SupabaseSpineStore`
 * bound to the request's verified user id (see auth.ts). The only raw
 * queries here are the two the functions need across users (the scheduled
 * sync's user list and the credential-ref lookup), both explicit about scope.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid, type UserId } from "@vixera/domain";
import { SupabaseSpineStore, createSpineClient } from "@vixera/sync";
import { requireSupabase, type FunctionEnv } from "./env.ts";

export function serviceClient(env: FunctionEnv): SupabaseClient {
  const { url, serviceRoleKey } = requireSupabase(env);
  return createSpineClient(url, serviceRoleKey, { headers: { "x-vixera-client": "edge-function" } });
}

export function anonClient(env: FunctionEnv): SupabaseClient {
  const { url, anonKey } = requireSupabase(env);
  return createSpineClient(url, anonKey);
}

/** A store that can only see and write rows of `userId`. */
export function spineForUser(client: SupabaseClient, userId: UserId): SupabaseSpineStore {
  return new SupabaseSpineStore(client, userId);
}

/** Distinct owners of syncable connector accounts (active, or in error and due for a retry). */
export async function listActiveConnectorUserIds(client: SupabaseClient): Promise<UserId[]> {
  const { data, error } = await client.from("connector_accounts").select("user_id").in("status", ["active", "error"]);
  if (error) throw new Error(`connector_accounts: ${error.message}`);
  const ids = new Set<string>();
  for (const row of (data ?? []) as { user_id?: string }[]) {
    if (typeof row.user_id === "string" && isUuid(row.user_id)) ids.add(row.user_id);
  }
  return [...ids] as UserId[];
}
