/**
 * NOW — what matters, what changed, what needs me, what can wait. Derived
 * from the spine (`deriveNow`), never from hard-coded data. Item actions are
 * server actions; the empty state offers connecting mail / calendar / bank.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NowItem } from "@vixera/domain";
import { buildEnvelope } from "../../data/actions.ts";
import { acceptHandoff, describeHandoff } from "../../data/handoff.ts";
import { useConnectorAccounts, useHandoffs, useNow, useThreadIndex } from "../../data/hooks.ts";
import { useScreenContext } from "../../data/screen-context.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { useBusy, useField } from "../field-context.tsx";
import { formatTime, greeting, plural, relativeTime } from "../format.ts";
import { Action, Empty, ErrorLine, Row, Section } from "../components/primitives.tsx";
import { ConnectActions } from "./Connectors.tsx";

const LAST_LOOK_KEY = "vixera.field.lastLook";

function readLastLook(): number | null {
  try {
    const raw = localStorage.getItem(LAST_LOOK_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

export function NowArea() {
  const spine = useSpine();
  const field = useField();
  const now = useNow();
  const connectors = useConnectorAccounts();
  const handoffs = useHandoffs();
  const threads = useThreadIndex();
  const onScreen = useScreenContext(spine.runtime.screenContext, field.praxionReady);
  const lastLook = useRef<number | null>(readLastLook());

  useEffect(() => {
    const stamp = () => {
      try {
        localStorage.setItem(LAST_LOOK_KEY, String(Date.now()));
      } catch {
        // ignore
      }
    };
    return stamp;
  }, []);

  const changedSince = useMemo(() => {
    if (!now.data || lastLook.current === null) return null;
    const since = lastLook.current;
    return now.data.contextEvents.filter((e) => Date.parse(e.occurredAt) > since && e.attention === "needs_attention").length;
  }, [now.data]);

  if (now.error) return <ErrorLine error={now.error} />;
  if (!now.data) return <p className="notice">Reading your context…</p>;
  const { needsMe, changed, canWait, upcoming } = now.data.now;
  const noConnectors = (connectors.data?.accounts.filter((a) => a.status !== "disconnected").length ?? 0) === 0;
  const empty = needsMe.length + changed.length + canWait.length === 0;

  return (
    <div>
      <h1 className="greeting">{greeting()}.</h1>
      <p className="lede">
        {changedSince === null ? (empty ? "Nothing needs you right now." : `${plural(needsMe.length, "thing")} need${needsMe.length === 1 ? "s" : ""} you.`) : `${plural(changedSince, "thing")} changed since you last looked.`}
      </p>

      {onScreen?.document && (
        <div className="onscreen">
          <p className="label">On screen now</p>
          <div className="onscreen__title">{onScreen.document.title}</div>
          <div className="muted small">
            {onScreen.location?.page ? `Page ${onScreen.location.page}` : "Open in Praxion"}
            {onScreen.selection ? ` · “${onScreen.selection.slice(0, 80)}”` : ""}
          </div>
          <div className="faint small">Vixera has no conclusion about this document yet.</div>
        </div>
      )}

      {(handoffs.data?.pending.length ?? 0) > 0 && (
        <Section title="Left on another device">
          {handoffs.data?.pending.map((h) => (
            <HandoffRow key={h.id} description={describeHandoff(h, handoffs.data?.devices ?? [])} handoff={h} />
          ))}
        </Section>
      )}

      {empty && noConnectors && (
        <Section title="Start here">
          <p className="para">
            Vixera One reads the context you already have — mail, calendar, bank — and shows what needs you, what changed, and what can wait. Nothing here is a feed; connect one source and NOW fills itself.
          </p>
          <ConnectActions />
        </Section>
      )}
      {empty && !noConnectors && <Empty>Quiet for now. Your sources are connected; new context appears here as it arrives.</Empty>}

      {needsMe.length > 0 && (
        <Section title="Needs you" aside={plural(needsMe.length, "item")}>
          {needsMe.map((i) => (
            <NowRow key={i.contextEventId ?? i.title} item={i} threads={threads} />
          ))}
        </Section>
      )}
      {changed.length > 0 && (
        <Section title="Changed" aside={plural(changed.length, "item")}>
          {changed.map((i) => (
            <NowRow key={i.contextEventId ?? i.title} item={i} threads={threads} />
          ))}
        </Section>
      )}
      {upcoming.length > 0 && (
        <Section title="Next 24 hours">
          {upcoming.map((e) => (
            <Row
              key={e.id}
              title={e.title}
              onOpen={() => field.focus({ type: "time_event", id: e.id })}
              side={e.allDay ? "All day" : formatTime(e.startsAt)}
              meta={e.participants.filter((p) => !p.isSelf).map((p) => p.name ?? p.email).filter(Boolean).join(", ") || e.location || null}
            />
          ))}
        </Section>
      )}
      {canWait.length > 0 && (
        <Section title="Can wait" aside={plural(canWait.length, "item")}>
          {canWait.map((i) => (
            <NowRow key={i.contextEventId ?? i.title} item={i} threads={threads} />
          ))}
        </Section>
      )}
    </div>
  );
}

function NowRow({ item, threads }: { item: NowItem; threads: Map<string, { id: string; title: string }> }) {
  const field = useField();
  const { device, reader } = useSpine();
  const { busy, error, run } = useBusy();
  const thread = item.threadIds.map((id) => threads.get(id)).find((t) => t !== undefined);
  const openSubject = async () => {
    if (item.subject.type === "document") {
      const doc = await reader.getDocument(item.subject.id);
      if (doc) {
        await field.openDoc(doc);
        return;
      }
    }
    field.focus(item.subject);
  };
  return (
    <Row
      title={item.title}
      onOpen={() => field.focus(item.subject)}
      side={relativeTime(item.occurredAt)}
      meta={
        <>
          {item.summary ? <span>{item.summary} </span> : null}
          {item.dueAt ? <span className="faint">· due {relativeTime(item.dueAt)}</span> : null}
          {thread ? <span className="faint"> · {thread.title}</span> : null}
        </>
      }
      actions={
        <>
          {thread && <Action onClick={() => field.focus({ type: "thread", id: thread.id })}>Open thread</Action>}
          {item.subject.type === "document" && <Action onClick={() => void run(openSubject)}>Open document</Action>}
          {item.contextEventId && (
            <>
              <Action disabled={busy} onClick={() => void run(() => field.act(buildEnvelope("context_event.quiet", { contextEventId: item.contextEventId as string }, { actorDeviceId: device.deviceId })))}>
                Later
              </Action>
              <Action disabled={busy} onClick={() => void run(() => field.act(buildEnvelope("context_event.dismiss", { contextEventId: item.contextEventId as string }, { actorDeviceId: device.deviceId })))}>
                Dismiss
              </Action>
            </>
          )}
          {error && <span className="error">{error}</span>}
        </>
      }
    />
  );
}

function HandoffRow({ handoff, description }: { handoff: Parameters<typeof acceptHandoff>[1]; description: string }) {
  const spine = useSpine();
  const field = useField();
  const { busy, error, run } = useBusy();
  const [opened, setOpened] = useState<string | null>(null);
  const title = handoff.focus ? `${handoff.focus.type.replace("_", " ")} ${handoff.threadId ? "in a thread" : ""}`.trim() : "Context";
  return (
    <Row
      title={<HandoffTitle handoff={handoff} fallback={title} />}
      meta={description}
      side={opened ?? undefined}
      actions={
        <>
          <Action
            primary
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await acceptHandoff({ deviceId: spine.device.deviceId, praxion: spine.runtime.praxion, storage: spine.runtime.storage, reader: spine.reader, dispatch: spine.runtime.dispatch }, handoff);
                spine.refresh();
                // The context has arrived either way; say plainly when the
                // artifact itself could not be opened on this device.
                setOpened(result.opened ? `opened with ${result.opened.openedWith}` : result.openError ? `context here · ${result.openError}` : "accepted");
                if (handoff.focus) field.focus(handoff.focus);
              })
            }
          >
            Continue
          </Action>
          {error && <span className="error">{error}</span>}
        </>
      }
    />
  );
}

function HandoffTitle({ handoff, fallback }: { handoff: Parameters<typeof acceptHandoff>[1]; fallback: string }) {
  const { reader } = useSpine();
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (handoff.documentId) return (await reader.getDocument(handoff.documentId))?.title ?? null;
      if (handoff.threadId) return (await reader.getThread(handoff.threadId))?.title ?? null;
      if (handoff.focus?.type === "person") return (await reader.getPerson(handoff.focus.id))?.displayName ?? null;
      return null;
    };
    load().then((t) => !cancelled && setTitle(t)).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [handoff, reader]);
  return <>{title ?? fallback}</>;
}

