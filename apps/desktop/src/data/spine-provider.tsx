/**
 * SpineProvider: the signed-in runtime for the React tree — SpineReader,
 * user id, device identity, mode — plus a refresh bus. Realtime changes and
 * completed actions bump a version; every hook re-reads on it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ActionEnvelope, ActionOutcome, UserId } from "@vixera/domain";
import type { SpineReader } from "@vixera/sync";
import type { AppMode } from "../bootstrap/config.ts";
import type { SessionRuntime } from "../bootstrap/runtime.ts";
import type { DeviceIdentity } from "../platform/device.ts";
import { dispatchOrThrow } from "./actions.ts";
import { subscribeRealtime, type RealtimeChange, type RealtimeStatus } from "./realtime.ts";

export interface SpineContextValue {
  readonly runtime: SessionRuntime;
  readonly reader: SpineReader;
  readonly userId: UserId;
  readonly device: DeviceIdentity;
  readonly mode: AppMode;
  /** Bumps on every realtime change or completed action. */
  readonly version: number;
  readonly refresh: () => void;
  readonly realtime: RealtimeStatus;
  readonly online: boolean;
  /** Dispatch through the action seam and refresh afterwards. */
  readonly act: (envelope: ActionEnvelope) => Promise<ActionOutcome>;
  /** Last realtime change, for notification logic. */
  readonly lastChange: RealtimeChange | null;
}

const SpineContext = createContext<SpineContextValue | null>(null);

export function SpineProvider({ runtime, children }: { runtime: SessionRuntime; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [realtime, setRealtime] = useState<RealtimeStatus>(runtime.mode === "dev-fixtures" ? "live" : "connecting");
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const lastChange = useRef<RealtimeChange | null>(null);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (!runtime.supabase) return;
    const sub = subscribeRealtime(
      runtime.supabase,
      runtime.userId,
      (change) => {
        lastChange.current = change;
        refresh();
      },
      setRealtime,
    );
    return () => void sub.unsubscribe();
  }, [runtime, refresh]);

  const act = useCallback(
    async (envelope: ActionEnvelope) => {
      try {
        return await dispatchOrThrow(runtime.dispatch, envelope);
      } finally {
        refresh();
      }
    },
    [runtime, refresh],
  );

  const value = useMemo<SpineContextValue>(
    () => ({
      runtime,
      reader: runtime.reader,
      userId: runtime.userId,
      device: runtime.device,
      mode: runtime.mode,
      version,
      refresh,
      realtime,
      online,
      act,
      lastChange: lastChange.current,
    }),
    [runtime, version, refresh, realtime, online, act],
  );
  return <SpineContext.Provider value={value}>{children}</SpineContext.Provider>;
}

export function useSpine(): SpineContextValue {
  const ctx = useContext(SpineContext);
  if (!ctx) throw new Error("useSpine must be used inside <SpineProvider>");
  return ctx;
}

export interface QueryState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly refresh: () => void;
}

/** Re-runs `load` whenever the spine version or `deps` change. Stale results are dropped. */
export function useSpineQuery<T>(load: (reader: SpineReader) => Promise<T>, deps: readonly unknown[]): QueryState<T> {
  const { reader, version, refresh } = useSpine();
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: Error | null }>({ data: null, loading: true, error: null });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    loadRef
      .current(reader)
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState((s) => ({ data: s.data, loading: false, error: error instanceof Error ? error : new Error(String(error)) }));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, version, ...deps]);
  return { ...state, refresh };
}
