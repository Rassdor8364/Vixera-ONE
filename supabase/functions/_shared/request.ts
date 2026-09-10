/**
 * Per-request wiring shared by the functions: verify the Bearer token with
 * the anon client, then hand back a service-role client and a store bound to
 * that user. Nothing here is cached across requests (see auth.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserId } from "@vixera/domain";
import type { SupabaseSpineStore } from "@vixera/sync";
import { authenticate } from "./auth.ts";
import type { FunctionEnv } from "./env.ts";
import { anonClient, serviceClient, spineForUser } from "./spine.ts";

export interface UserRequest {
  readonly userId: UserId;
  readonly client: SupabaseClient;
  readonly store: SupabaseSpineStore;
}

export async function userRequest(req: Request, env: FunctionEnv): Promise<UserRequest> {
  const { userId } = await authenticate(req, anonClient(env).auth);
  const client = serviceClient(env);
  return { userId, client, store: spineForUser(client, userId) };
}
