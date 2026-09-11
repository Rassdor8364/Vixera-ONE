/**
 * The Vixera One door: sign in, create an account, recover a password.
 *
 * Two panels on a wide screen — the brand on the left, the form on the right —
 * collapsing to the form alone on a phone. Everything talks to Supabase Auth
 * directly; there is no Vixera-side account system.
 */
import { useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setKeepSignedIn } from "../bootstrap/session-preference.ts";

type Mode = "signin" | "register" | "forgot";

export function Auth({ client, defaultEmail }: { client: SupabaseClient; defaultEmail: string | null }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [password, setPassword] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepSigned, setKeepSigned] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the next step is out in the world: a confirmation or reset email. */
  const [sent, setSent] = useState<{ kind: "confirm" | "reset"; address: string } | null>(null);

  const copy = COPY[mode];
  const strength = useMemo(() => passwordStrength(password), [password]);

  function go(next: Mode) {
    setMode(next);
    setError(null);
    setSent(null);
    setPassword("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const address = email.trim();
    try {
      if (mode === "signin") {
        const { error: err } = await client.auth.signInWithPassword({ email: address, password });
        if (err) throw err;
        setKeepSignedIn(keepSigned);
        return; // the session listener swaps this screen for the Field
      }
      if (mode === "register") {
        if (!agreed) throw new Error("Please accept the terms to continue.");
        if (password.length < 8) throw new Error("Use at least 8 characters.");
        const name = [first.trim(), last.trim()].filter(Boolean).join(" ");
        const { data, error: err } = await client.auth.signUp({
          email: address,
          password,
          options: { data: { display_name: name || null, first_name: first.trim() || null, last_name: last.trim() || null } },
        });
        if (err) throw err;
        setKeepSignedIn(keepSigned);
        // With email confirmation on, signUp returns a user but no session.
        if (!data.session) setSent({ kind: "confirm", address });
        return;
      }
      const { error: err } = await client.auth.resetPasswordForEmail(address);
      if (err) throw err;
      setSent({ kind: "reset", address });
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Shell>
        <Header kicker="CHECK YOUR EMAIL" heading={sent.kind === "confirm" ? "Confirm your address" : "Reset link sent"} />
        <p className="auth__sub">
          {sent.kind === "confirm"
            ? "We sent a confirmation link to "
            : "If an account exists for "}
          <strong className="auth__strong">{sent.address}</strong>
          {sent.kind === "confirm"
            ? ". Open it, then come back and sign in."
            : ", a reset link is on its way."}
        </p>
        <button type="button" className="auth__primary" onClick={() => go("signin")}>
          Back to sign in
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <Header kicker={copy.kicker} heading={copy.heading} sub={copy.sub} />
      <form className="auth__form" onSubmit={submit}>
        {mode === "register" && (
          <div className="auth__row">
            <Field2 label="FIRST NAME">
              <input className="auth__input" value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Daniel" autoComplete="given-name" />
            </Field2>
            <Field2 label="LAST NAME">
              <input className="auth__input" value={last} onChange={(e) => setLast(e.target.value)} placeholder="Vaszary" autoComplete="family-name" />
            </Field2>
          </div>
        )}

        <Field2 label="EMAIL">
          <input
            className="auth__input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="daniel@vixera.ai"
            autoComplete="username"
            required
            autoFocus={mode !== "register"}
          />
        </Field2>

        {mode !== "forgot" && (
          <Field2
            label="PASSWORD"
            aside={
              mode === "signin" ? (
                <button type="button" className="auth__link auth__link--small" onClick={() => go("forgot")}>
                  FORGOT?
                </button>
              ) : undefined
            }
          >
            <span className="auth__password">
              <input
                className="auth__input"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "register" ? "At least 8 characters" : "••••••••"}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                required
                minLength={mode === "register" ? 8 : undefined}
              />
              <button type="button" className="auth__reveal" onClick={() => setShowPassword((v) => !v)}>
                {showPassword ? "HIDE" : "SHOW"}
              </button>
            </span>
            {mode === "register" && password.length > 0 && (
              <span className="auth__strength">
                <span className="auth__strength-track">
                  <span className="auth__strength-fill" style={{ width: `${strength.score * 25}%`, background: strength.color }} />
                </span>
                <span className="auth__strength-label">{strength.label}</span>
              </span>
            )}
          </Field2>
        )}

        {mode === "signin" && (
          <Check checked={keepSigned} onChange={setKeepSigned}>
            Keep me signed in
          </Check>
        )}

        {mode === "register" && (
          <Check checked={agreed} onChange={setAgreed}>
            I agree to the Vixera terms. Vixera keeps my context in my own Vixera workspace, and Praxion documents stay on my devices.
          </Check>
        )}

        {error && <span className="auth__error">{error}</span>}

        <button type="submit" className="auth__primary" disabled={busy}>
          {busy ? copy.busyLabel : copy.primaryLabel}
        </button>
      </form>

      <p className="auth__switch">
        {mode === "signin" ? (
          <>
            New to Vixera?{" "}
            <button type="button" className="auth__link" onClick={() => go("register")}>
              Create account
            </button>
          </>
        ) : (
          <>
            Already have access?{" "}
            <button type="button" className="auth__link" onClick={() => go("signin")}>
              Sign in
            </button>
          </>
        )}
      </p>
    </Shell>
  );
}

// ---------------------------------------------------------------------------

const COPY: Record<Mode, { kicker: string; heading: string; sub?: string; primaryLabel: string; busyLabel: string }> = {
  signin: { kicker: "WELCOME BACK", heading: "Sign in", sub: "Your context is where you left it.", primaryLabel: "Sign in", busyLabel: "Signing in…" },
  register: { kicker: "GET STARTED", heading: "Create your account", sub: "One workspace for everything that connects.", primaryLabel: "Create account", busyLabel: "Creating…" },
  forgot: { kicker: "RECOVER", heading: "Reset your password", sub: "We will email you a link to set a new one.", primaryLabel: "Send reset link", busyLabel: "Sending…" },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth__brand">
        <span className="auth__glow" aria-hidden="true" />
        <div className="auth__wordmark">
          <Mark size={26} />
          <span>VIXERA ONE</span>
        </div>
        <div className="auth__pitch">
          <Mark size={120} className="auth__logo" />
          <h1 className="auth__headline">New era of automation</h1>
          <p className="auth__tagline">Every app. Every device. One intelligence.</p>
        </div>
        <div className="auth__values">
          <span>CLARITY</span>
          <span>DISCIPLINE</span>
          <span>FREEDOM</span>
        </div>
      </aside>
      <main className="auth__panel">
        <div className="auth__card">{children}</div>
      </main>
    </div>
  );
}

function Header({ kicker, heading, sub }: { kicker: string; heading: string; sub?: string | undefined }) {
  return (
    <div className="auth__header">
      <span className="auth__kicker">{kicker}</span>
      <h2 className="auth__heading">{heading}</h2>
      {sub && <p className="auth__sub">{sub}</p>}
    </div>
  );
}

function Field2({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="auth__field">
      <span className="auth__label">
        {label}
        {aside}
      </span>
      {children}
    </label>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button type="button" className="auth__check" onClick={() => onChange(!checked)} aria-pressed={checked}>
      <span className={`auth__tick${checked ? " auth__tick--on" : ""}`} aria-hidden="true">
        <span />
      </span>
      <span className="auth__check-text">{children}</span>
    </button>
  );
}

/** The Vixera V, the same two strokes as the app icon. */
function Mark({ size, className }: { size: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true">
      <path d="M10 10 H28 L66 90 H48 Z" fill="#F4EEE2" />
      <path d="M74 10 H92 L60 62 H42 Z" fill="#D8C3A0" />
    </svg>
  );
}

function passwordStrength(pw: string): { score: number; label: string; color: string } {
  if (!pw) return { score: 0, label: "", color: "transparent" };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^\w\s]/.test(pw)) score++;
  const steps = [
    { label: "Too short", color: "#E0A06A" },
    { label: "Weak", color: "#E0A06A" },
    { label: "Fair", color: "#D8C3A0" },
    { label: "Good", color: "#D8C3A0" },
    { label: "Strong", color: "#9FD8A0" },
  ];
  const step = steps[score] ?? steps[0]!;
  return { score, label: step.label, color: step.color };
}

/** Supabase's messages are decent; these are the few worth softening. */
function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/invalid login credentials/i.test(message)) return "That email and password do not match an account.";
  if (/email address .* is invalid/i.test(message)) return "That email address was rejected. Check the domain and try again.";
  if (/user already registered/i.test(message)) return "An account already exists for that email. Try signing in.";
  if (/for security purposes/i.test(message)) return "Too many attempts just now. Wait a minute and try again.";
  if (/email not confirmed/i.test(message)) return "Confirm your email address first — check your inbox for the link.";
  // The project's mail quota, not anything this person did. Worth naming the way
  // out, since on a single-user project the person reading this owns the project.
  if (/email rate limit|over_email_send_rate_limit/i.test(message))
    return "This Supabase project has sent as many emails as its hourly limit allows. Wait an hour, or turn off email confirmation in the project's Auth settings and try again.";
  if (/over_request_rate_limit|too many requests/i.test(message))
    return "Too many requests to this project just now. Wait a minute and try again.";
  return message;
}
