/**
 * currentUser() for the Field.
 *
 * Production: `SessionCurrentUserProvider` reads the user id of the Supabase
 * session and throws `NoCurrentUserError` while signed out. The session is
 * tracked through `onAuthStateChange` so `get()` stays synchronous.
 * Dev-fixture mode installs `devUserProvider` (the fixed DEV_USER_ID) instead.
 *
 * Nothing else in the Field resolves identity: stores are bound to
 * `currentUser().id` at construction, and no user id is ever taken from a
 * payload or from provider data.
 */
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { keepSignedIn } from "./session-preference.ts";
import { NoCurrentUserError, StaticCurrentUserProvider, setCurrentUserProvider, type CurrentUser, type CurrentUserProvider, type UserId } from "@vixera/domain";

export type SessionListener = (session: Session | null) => void;

export class SessionCurrentUserProvider implements CurrentUserProvider {
  private session: Session | null = null;
  private readonly listeners = new Set<SessionListener>();

  constructor(private readonly client: SupabaseClient) {}

  /**
   * Loads the persisted session and starts tracking auth changes. A session
   * restored from the keychain is discarded when the user asked not to be kept
   * signed in — that is what makes the checkbox on the door mean something.
   */
  async start(): Promise<Session | null> {
    const { data } = await this.client.auth.getSession();
    if (data.session && !keepSignedIn()) {
      await this.client.auth.signOut();
      this.setSession(null);
    } else {
      this.setSession(data.session ?? null);
    }
    this.client.auth.onAuthStateChange((_event, session) => {
      this.setSession(session);
    });
    return this.session;
  }

  setSession(session: Session | null): void {
    const changed = (this.session?.user.id ?? null) !== (session?.user.id ?? null) || this.session?.access_token !== session?.access_token;
    this.session = session;
    if (changed) for (const l of this.listeners) l(session);
  }

  currentSession(): Session | null {
    return this.session;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(): CurrentUser {
    const user = this.session?.user;
    if (!user) throw new NoCurrentUserError();
    return { id: user.id as UserId };
  }
}

/** Installs the session provider as the app-wide currentUser() source. */
export function installSessionIdentity(client: SupabaseClient): SessionCurrentUserProvider {
  const provider = new SessionCurrentUserProvider(client);
  setCurrentUserProvider(provider);
  return provider;
}

/** DEV ONLY: installs the fixed development identity. */
export function installDevIdentity(devUserId: UserId): CurrentUserProvider {
  const provider = new StaticCurrentUserProvider({ id: devUserId, displayName: "Development user" });
  setCurrentUserProvider(provider);
  return provider;
}
