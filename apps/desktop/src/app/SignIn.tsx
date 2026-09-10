/** The only onboarding: email + password into an existing Supabase user. No sign-up. */
import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

export function SignIn({ client, defaultEmail }: { client: SupabaseClient; defaultEmail: string | null }) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="signin">
      <form
        className="signin__box form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          client.auth
            .signInWithPassword({ email: email.trim(), password })
            .then(({ error: err }) => {
              if (err) setError(err.message);
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="signin__brand">Vixera One</div>
        <label className="label" htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="label" htmlFor="password">Password</label>
        <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit" className="button" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}
