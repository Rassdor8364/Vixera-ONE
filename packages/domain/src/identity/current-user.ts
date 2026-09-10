import type { UserId } from "../ids.ts";

/**
 * The ONE source of truth for "who is using Vixera right now".
 *
 * Everything that needs a user identity calls `currentUser()`. Nothing else in
 * the codebase may hard-code an email address, a machine account name, or a
 * UUID. Today the provider returns the development user; later it will read a
 * Supabase session. Call sites do not change.
 */
export interface CurrentUser {
  readonly id: UserId;
  /** Optional, informational only. Never used as a key. */
  readonly displayName?: string;
}

export interface CurrentUserProvider {
  /** Returns the current user or throws `NoCurrentUserError`. */
  get(): CurrentUser;
}

export class NoCurrentUserError extends Error {
  constructor() {
    super("No current user is configured. Call setCurrentUserProvider() at startup.");
    this.name = "NoCurrentUserError";
  }
}

/**
 * Stable development identity. This is a fixed UUID, NOT an email, NOT a
 * machine name, NOT inferred from the environment. It matches supabase/seed.sql.
 */
export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001" as UserId;

export class StaticCurrentUserProvider implements CurrentUserProvider {
  constructor(private readonly user: CurrentUser) {}
  get(): CurrentUser {
    return this.user;
  }
}

export const devUserProvider = new StaticCurrentUserProvider({
  id: DEV_USER_ID,
  displayName: "Development user",
});

let provider: CurrentUserProvider | null = null;

export function setCurrentUserProvider(next: CurrentUserProvider): void {
  provider = next;
}

/** Test/bootstrap helper. */
export function resetCurrentUserProvider(): void {
  provider = null;
}

export function hasCurrentUser(): boolean {
  if (!provider) return false;
  try {
    provider.get();
    return true;
  } catch {
    return false;
  }
}

export function currentUser(): CurrentUser {
  if (!provider) throw new NoCurrentUserError();
  return provider.get();
}

export function currentUserId(): UserId {
  return currentUser().id;
}
