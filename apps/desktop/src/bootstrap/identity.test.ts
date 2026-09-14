/**
 * The identity source of truth. These pin the behaviour that keeps a person
 * from ever being in the Field as the wrong user: the session is tracked from
 * the auth events, subscribers fire when the identity or token changes,
 * signed-out `get()` throws instead of guessing, and the keep-signed-in
 * choice actually discards a restored session on the next launch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoCurrentUserError } from "@vixera/domain";
import { SessionCurrentUserProvider } from "./identity.ts";
import { setKeepSignedIn } from "./session-preference.ts";

type AuthChangeCb = (event: string, session: unknown) => void;

/** The slice of supabase.auth the provider touches, scriptable per test. */
function fakeClient(initial: unknown = null) {
  let stored = initial;
  const listeners: AuthChangeCb[] = [];
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: stored } })),
    signOut: vi.fn(async () => {
      stored = null;
      for (const l of listeners) l("SIGNED_OUT", null);
      return { error: null };
    }),
    onAuthStateChange: vi.fn((cb: AuthChangeCb) => {
      listeners.push(cb);
      return { data: { subscription: { unsubscribe() {} } } };
    }),
  };
  const emit = (event: string, session: unknown) => {
    stored = session;
    for (const l of listeners) l(event, session);
  };
  return { client: { auth } as never, auth, emit };
}

const sessionFor = (id: string, token = `tok-${id}`, expiresInS = 3600) => ({
  user: { id },
  access_token: token,
  expires_at: Math.floor(Date.now() / 1000) + expiresInS,
});

afterEach(() => localStorage.clear());

describe("SessionCurrentUserProvider", () => {
  it("throws NoCurrentUserError while signed out, and never invents an id", async () => {
    const { client } = fakeClient(null);
    const provider = new SessionCurrentUserProvider(client);
    await provider.start();
    expect(() => provider.get()).toThrow(NoCurrentUserError);
    expect(provider.currentSession()).toBeNull();
  });

  it("resolves the id of the restored session when keep-signed-in is on (the default)", async () => {
    const { client } = fakeClient(sessionFor("user-a"));
    const provider = new SessionCurrentUserProvider(client);
    await provider.start();
    expect(provider.get().id).toBe("user-a");
  });

  it("discards a restored session when keep-signed-in is off, so the next launch is signed out", async () => {
    setKeepSignedIn(false);
    const { client, auth } = fakeClient(sessionFor("user-a"));
    const provider = new SessionCurrentUserProvider(client);
    await provider.start();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledWith({ scope: "local" }); // this device, not every device
    expect(() => provider.get()).toThrow(NoCurrentUserError);
  });

  it("follows the auth stream: sign in, refresh, sign out", async () => {
    const { client, emit } = fakeClient(null);
    const provider = new SessionCurrentUserProvider(client);
    await provider.start();
    emit("SIGNED_IN", sessionFor("user-a", "tok-1"));
    expect(provider.get().id).toBe("user-a");
    emit("TOKEN_REFRESHED", sessionFor("user-a", "tok-2"));
    expect(provider.currentSession()?.access_token).toBe("tok-2");
    emit("SIGNED_OUT", null);
    expect(() => provider.get()).toThrow(NoCurrentUserError);
  });

  it("notifies subscribers when the identity changes — the signal App uses to rebuild the runtime", async () => {
    const { client, emit } = fakeClient(null);
    const provider = new SessionCurrentUserProvider(client);
    await provider.start();
    const seen: (string | null)[] = [];
    provider.subscribe((s) => seen.push((s?.user.id as string | undefined) ?? null));

    emit("SIGNED_IN", sessionFor("user-a"));
    emit("SIGNED_OUT", null);
    emit("SIGNED_IN", sessionFor("user-b"));
    expect(seen).toEqual(["user-a", null, "user-b"]);
  });

  it("notifies on a token refresh (the access token changed) but not on an identical repeat", async () => {
    const { client, emit } = fakeClient(sessionFor("user-a", "tok-1"));
    const provider = new SessionCurrentUserProvider(client);
    await provider.start();
    const seen: string[] = [];
    provider.subscribe((s) => seen.push((s as { access_token?: string } | null)?.access_token ?? "null"));

    emit("TOKEN_REFRESHED", sessionFor("user-a", "tok-2"));
    emit("USER_UPDATED", sessionFor("user-a", "tok-2")); // same id, same token → no notification
    expect(seen).toEqual(["tok-2"]);
  });

  it("switching accounts A → B surfaces B, never a mix", async () => {
    const { client, emit } = fakeClient(sessionFor("user-a"));
    const provider = new SessionCurrentUserProvider(client);
    await provider.start();
    expect(provider.get().id).toBe("user-a");
    emit("SIGNED_OUT", null);
    emit("SIGNED_IN", sessionFor("user-b"));
    expect(provider.get().id).toBe("user-b");
  });
});
