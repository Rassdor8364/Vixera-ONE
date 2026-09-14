/**
 * App: shell → (Auth | Field). The Field mounts only with a current user,
 * so every store and every query is bound to that user id from the start.
 */
import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { UserId } from "@vixera/domain";
import type { AppShell } from "../bootstrap/runtime.ts";
import { createSessionRuntime } from "../bootstrap/runtime.ts";
import { SpineProvider } from "../data/spine-provider.tsx";
import { Field } from "../field/Field.tsx";
import { Auth } from "./Auth.tsx";
import "./auth.css";

export function App({ shell }: { shell: AppShell }) {
  const [session, setSession] = useState<Session | null>(() => shell.session?.currentSession() ?? null);
  useEffect(() => shell.session?.subscribe(setSession), [shell.session]);

  const userId: UserId | null = shell.mode === "dev-fixtures" ? shell.config.devUserId : ((session?.user.id as UserId | undefined) ?? null);
  const runtime = useMemo(() => (userId ? createSessionRuntime(shell, userId) : null), [shell, userId]);

  if (!runtime) {
    if (!shell.supabase) return <p className="notice">No session and no Supabase client.</p>;
    return <Auth client={shell.supabase} defaultEmail={shell.config.devUserEmail} />;
  }
  // Local scope: signing out here must not revoke the phone's session too. If
  // the server call fails (offline), the local session is still dropped, and the
  // provider is told so the Field never stays open after "Sign out".
  const signOut = shell.supabase
    ? async () => {
        try {
          const { error } = await shell.supabase!.auth.signOut({ scope: "local" });
          if (error) console.warn("sign out: server call failed, local session dropped", error.message);
        } catch (error) {
          console.warn("sign out: failed, dropping the local session", error instanceof Error ? error.message : String(error));
        } finally {
          shell.session?.setSession(null);
        }
      }
    : undefined;
  return (
    <SpineProvider key={runtime.userId} runtime={runtime}>
      <Field onSignOut={signOut} />
    </SpineProvider>
  );
}
