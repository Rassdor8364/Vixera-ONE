/**
 * "Keep me signed in".
 *
 * The Supabase session itself lives in the OS keychain, which is what makes a
 * restored session possible at all. This flag decides whether that restored
 * session is honoured on the NEXT launch: unchecked means the app signs out
 * when it starts again, so the choice is a real one rather than a decorative
 * checkbox.
 */
const KEY = "vixera.keepSignedIn";

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // private mode, or storage blocked
  }
}

export function setKeepSignedIn(keep: boolean): void {
  try {
    store()?.setItem(KEY, keep ? "1" : "0");
  } catch {
    /* a lost preference only means the default applies */
  }
}

/** Defaults to true: a session that was persisted is honoured unless told otherwise. */
export function keepSignedIn(): boolean {
  try {
    return store()?.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}
