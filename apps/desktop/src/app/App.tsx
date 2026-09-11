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
  const signOut = shell.supabase ? async () => { await shell.supabase?.auth.signOut(); } : undefined;
  return (
    <SpineProvider key={runtime.userId} runtime={runtime}>
      <Field onSignOut={signOut} />
    </SpineProvider>
  );
}
