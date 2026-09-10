/**
 * The Field. Context line (area · focus · state mark) on top, a quiet row of
 * area labels, the area itself, One Command at the bottom. No sidebar, no
 * cards, no dashboard. One column at phone width.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFiles, useNow } from "../data/hooks.ts";
import { useSpine, useSpineQuery } from "../data/spine-provider.tsx";
import { isAndroid } from "../platform/tauri.ts";
import { NowArea } from "./areas/Now.tsx";
import { ThreadsArea } from "./areas/Threads.tsx";
import { PeopleArea } from "./areas/People.tsx";
import { TimeArea } from "./areas/Time.tsx";
import { MoneyArea } from "./areas/Money.tsx";
import { FilesArea } from "./areas/Files.tsx";
import { QuietArea } from "./areas/Quiet.tsx";
import { OneCommandBar } from "./command/OneCommandBar.tsx";
import { CaptureEntry } from "./companion/Capture.tsx";
import { useShareIntake } from "./companion/useShareIntake.ts";
import { StateMark } from "./components/primitives.tsx";
import { FieldApiProvider, useField } from "./field-context.tsx";
import { createNeedsMeNotifier } from "./notifications.ts";
import { AREA_LABELS, FIELD_AREAS, LAST_AREA_KEY, readLastArea, type FieldArea } from "./routing.ts";
import { praxionLabel } from "../data/praxion.ts";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window === "undefined" ? false : window.innerWidth < 720));
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 720);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return narrow;
}

export function Field({ onSignOut }: { onSignOut?: (() => Promise<void>) | undefined }) {
  const narrow = useNarrow();
  const initialArea = useMemo(() => (isAndroid() ? "now" : readLastArea(typeof localStorage === "undefined" ? null : localStorage)), []);
  return (
    <FieldApiProvider narrow={narrow} initial={{ area: initialArea, focus: null }}>
      <FieldShell onSignOut={onSignOut} />
    </FieldApiProvider>
  );
}

function FieldShell({ onSignOut }: { onSignOut?: (() => Promise<void>) | undefined }) {
  const spine = useSpine();
  const field = useField();
  const share = useShareIntake();
  const files = useFiles("");
  const focusTitle = useFocusTitle();
  const { area } = field.location;

  useEffect(() => {
    try {
      localStorage.setItem(LAST_AREA_KEY, area);
    } catch {
      // ignore
    }
  }, [area]);

  useEffect(() => {
    void spine.runtime.registerDevice(field.praxionReady).catch(() => {});
  }, [spine.runtime, field.praxionReady]);

  const processing = (files.data?.pendingIngest.length ?? 0) > 0 || share.busy;
  const stateMark = !spine.online || spine.realtime === "offline" ? (
    <StateMark tone="warn">Offline</StateMark>
  ) : processing ? (
    <StateMark>Processing</StateMark>
  ) : spine.mode === "dev-fixtures" ? (
    <StateMark tone="muted">On this device</StateMark>
  ) : spine.realtime === "live" ? (
    <StateMark>Synced</StateMark>
  ) : (
    <StateMark tone="muted">Connecting</StateMark>
  );

  return (
    <div className="field">
      <header className="field__top">
        <div className="context-line">
          <div className="context-line__path">
            <span className="context-line__area">{AREA_LABELS[area]}</span>
            {focusTitle && (
              <>
                <span className="context-line__sep">·</span>
                <span className="context-line__focus">
                  {focusTitle}
                  <button type="button" onClick={() => field.focus(null)} aria-label="Clear focus">×</button>
                </span>
              </>
            )}
          </div>
          <div className="context-line__marks">
            {stateMark}
            {field.praxionReady && <StateMark tone="muted">{praxionLabel(field.praxion)}</StateMark>}
            {onSignOut && (
              <button type="button" className="action" onClick={() => void onSignOut()}>
                Sign out
              </button>
            )}
          </div>
        </div>
        <nav className="areas" aria-label="Areas">
          {FIELD_AREAS.map((a) => (
            <button key={a} type="button" className={`areas__item${a === area ? " areas__item--active" : ""}`} onClick={() => field.go(a)}>
              {AREA_LABELS[a]}
            </button>
          ))}
        </nav>
      </header>
      {!isAndroid() && <NeedsMeWatcher />}
      <main className="field__area">
        {share.notice && <p className="notice">{share.notice}</p>}
        {(isAndroid() || field.narrow) && area === "now" && <CaptureEntry />}
        <AreaView area={area} />
      </main>
      <footer className="field__bottom">
        <OneCommandBar />
      </footer>
    </div>
  );
}

function AreaView({ area }: { area: FieldArea }) {
  switch (area) {
    case "now":
      return <NowArea />;
    case "threads":
      return <ThreadsArea />;
    case "people":
      return <PeopleArea />;
    case "time":
      return <TimeArea />;
    case "money":
      return <MoneyArea />;
    case "files":
      return <FilesArea />;
    case "quiet":
      return <QuietArea />;
  }
}

/**
 * Windows notifications: announces each new "needs me" context event once,
 * whichever area is open. Renders nothing; informational only — actions run
 * from NOW through the server action seam.
 */
function NeedsMeWatcher() {
  const now = useNow();
  const notifier = useRef<ReturnType<typeof createNeedsMeNotifier> | null>(null);
  useEffect(() => {
    if (!now.data) return;
    notifier.current ??= createNeedsMeNotifier();
    void notifier.current.observe(now.data.now.needsMe);
  }, [now.data]);
  return null;
}

/** Title of the focused entity for the context line. */
function useFocusTitle(): string | null {
  const field = useField();
  const focus = field.location.focus;
  const q = useSpineQuery(
    async (reader) => {
      if (!focus) return null;
      switch (focus.type) {
        case "person":
          return (await reader.getPerson(focus.id))?.displayName ?? null;
        case "thread":
          return (await reader.getThread(focus.id))?.title ?? null;
        case "document":
          return (await reader.getDocument(focus.id))?.title ?? null;
        case "time_event":
          return (await reader.getTimeEvent(focus.id))?.title ?? null;
        case "money_transaction": {
          const t = await reader.getMoneyTransaction(focus.id);
          return t ? (t.merchantName ?? t.description) : null;
        }
        case "mail_message":
          return (await reader.getMailMessage(focus.id))?.subject ?? null;
        default:
          return null;
      }
    },
    [focus?.type, focus?.id],
  );
  return q.data ?? null;
}
