/**
 * Request identity for Edge Functions.
 *
 * This is the server-side realization of the `currentUser()` seam
 * (packages/domain/src/identity/current-user.ts). On a device there is one
 * user per process, so `setCurrentUserProvider()` is called once at startup.
 * An Edge Function isolate serves many concurrent requests for potentially
 * different users, so a process-global provider would be a data-boundary bug.
 * Instead identity is resolved PER REQUEST from the verified Bearer token
 * (`auth.getUser(token)` against the anon client — the token is validated by
 * Supabase Auth, never decoded locally) and threaded explicitly:
 *
 *   const { userId } = await authenticate(req, authClient);
 *   const store = spineForUser(client, userId);   // every row this request touches
 *
 * The service-role client is only used for data access AFTER identity is
 * established, and only through stores bound to that user id. A user id is
 * never accepted from a request body, a query string or provider data.
 */
import type { UserId } from "@vixera/domain";
import { isUuid } from "@vixera/domain";
import { HttpError } from "./http.ts";

export interface RequestIdentity {
  readonly userId: UserId;
}

/** The slice of supabase-js `auth` used here, so tests can pass a fake. */
export interface AuthClient {
  getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>;
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = m?.[1]?.trim();
  return token ? token : null;
}

export async function authenticate(req: Request, auth: AuthClient): Promise<RequestIdentity> {
  const token = bearerToken(req);
  if (!token) throw new HttpError(401, "unauthorized", "Missing Bearer token");
  let result: Awaited<ReturnType<AuthClient["getUser"]>>;
  try {
    result = await auth.getUser(token);
  } catch {
    throw new HttpError(401, "unauthorized", "Could not verify the session");
  }
  const id = result.data.user?.id;
  if (result.error || !id || !isUuid(id)) throw new HttpError(401, "unauthorized", "Invalid or expired session");
  return { userId: id as UserId };
}
