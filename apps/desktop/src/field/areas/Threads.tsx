/** Threads — something happening in the user's life or work, and everything it gathers. */
import { useState } from "react";
import type { Thread } from "@vixera/domain";
import { buildEnvelope } from "../../data/actions.ts";
import { useThread, useThreads } from "../../data/hooks.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { useBusy, useField } from "../field-context.tsx";
import { formatDate, formatMoney, formatTime, relativeTime } from "../format.ts";
import { AttachToThread } from "../components/AttachToThread.tsx";
import { ContinueOn } from "../components/ContinueOn.tsx";
import { Action, Empty, ErrorLine, Row, Section, StateMark } from "../components/primitives.tsx";

export function ThreadsArea() {
  const field = useField();
  const threads = useThreads();
  const focusedId = field.location.focus?.type === "thread" ? field.location.focus.id : null;
  const detail = useThread(focusedId);
  return (
    <div className={`two-col${focusedId ? " two-col--detail" : ""}`}>
      <div className="two-col__list">
        <Section title="Threads" aside={<NewThread />}>
          {threads.error && <ErrorLine error={threads.error} />}
          {threads.data?.length === 0 && <Empty>No threads yet. Start one from a document, a person, or “New thread”.</Empty>}
          {threads.data?.map((t) => (
            <Row
              key={t.id}
              focused={t.id === focusedId}
              title={t.title}
              onOpen={() => field.focus({ type: "thread", id: t.id })}
              side={t.status === "active" ? null : <StateMark tone="muted">{t.status}</StateMark>}
              meta={t.summary ?? t.kind}
            />
          ))}
        </Section>
      </div>
      <div>
        {focusedId && detail.data && <ThreadDetail data={detail.data} />}
        {focusedId && !detail.data && !detail.loading && <Empty>That thread is gone.</Empty>}
        {!focusedId && <Empty>Pick a thread to see its people, documents, mail, time and money together.</Empty>}
      </div>
    </div>
  );
}

function NewThread() {
  const { act } = useField();
  const { device } = useSpine();
  const field = useField();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const { busy, error, run } = useBusy();
  if (!open) return <Action onClick={() => setOpen(true)}>New thread</Action>;
  return (
    <form
      className="actions-inline"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        void run(async () => {
          const attach = field.location.focus && field.location.focus.type !== "thread" ? [{ entityType: field.location.focus.type, entityId: field.location.focus.id }] : [];
          const outcome = await act(buildEnvelope("thread.create", { title: title.trim(), attach }, { actorDeviceId: device.deviceId }));
          const id = outcome.result?.["threadId"];
          setOpen(false);
          setTitle("");
          if (typeof id === "string") field.focus({ type: "thread", id });
        });
      }}
    >
      <input className="input" autoFocus placeholder="What is happening?" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: 220 }} />
      <Action primary type="submit" disabled={busy}>Create</Action>
      <Action onClick={() => setOpen(false)}>Cancel</Action>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function ThreadDetail({ data }: { data: NonNullable<ReturnType<typeof useThread>["data"]> }) {
  const field = useField();
  const { thread, neighborhood: n } = data;
  const threadRef = { type: "thread" as const, id: thread.id };
  return (
    <div>
      <h1 className="greeting">{thread.title}</h1>
      <p className="lede">
        {thread.summary ?? thread.kind ?? "Thread"} · updated {relativeTime(thread.updatedAt)}
      </p>
      <div className="actions-inline" style={{ marginBottom: 30 }}>
        <ContinueOn focus={threadRef} threadId={thread.id} />
      </div>
      {n.conclusions.length > 0 && (
        <Section title="Vixera concluded">
          {n.conclusions.map((c) => (
            <Row key={c.id} title={c.text} meta={`${c.producedBy} · ${Math.round(c.confidence * 100)}%`} />
          ))}
        </Section>
      )}
      <Section title="People" aside={n.people.length || "none"}>
        {n.people.map((p) => (
          <Row key={p.id} title={p.displayName} onOpen={() => field.focus({ type: "person", id: p.id })} meta={p.organization ?? p.primaryEmail} />
        ))}
      </Section>
      <Section title="Documents" aside={n.documents.length || "none"}>
        {n.documents.map((d) => (
          <Row key={d.id} title={d.title} onOpen={() => field.focus({ type: "document", id: d.id })} meta={`${d.source.replace("_", " ")} · ${formatDate(d.updatedAt)}`} actions={<Action onClick={() => void field.openDoc(d).catch(() => {})}>Open</Action>} />
        ))}
      </Section>
      <Section title="Mail" aside={n.mail.length || "none"}>
        {n.mail.map((m) => (
          <Row key={m.id} title={m.subject ?? "(no subject)"} side={relativeTime(m.receivedAt)} meta={`${m.from?.name ?? m.from?.email ?? "unknown"}${m.snippet ? ` — ${m.snippet}` : ""}`} />
        ))}
      </Section>
      <Section title="Time" aside={n.timeEvents.length || "none"}>
        {n.timeEvents.map((e) => (
          <Row key={e.id} title={e.title} onOpen={() => field.focus({ type: "time_event", id: e.id })} side={`${formatDate(e.startsAt)} ${e.allDay ? "" : formatTime(e.startsAt)}`} />
        ))}
      </Section>
      <Section title="Money" aside={n.transactions.length || "none"}>
        {n.transactions.map((t) => (
          <Row key={t.id} title={t.merchantName ?? t.description} onOpen={() => field.focus({ type: "money_transaction", id: t.id })} side={<span className={Number(t.amount) > 0 ? "amount--in" : ""}>{formatMoney(t.amount, t.currency)}</span>} meta={t.postedOn} />
        ))}
      </Section>
      <AttachHint thread={thread} />
    </div>
  );
}

function AttachHint({ thread }: { thread: Thread }) {
  const field = useField();
  const { act } = field;
  const { device } = useSpine();
  const { busy, error, run } = useBusy();
  const [entityType, setEntityType] = useState<"person" | "document">("person");
  const [id, setId] = useState("");
  return (
    <Section title="Attach">
      <p className="notice">Attach from any area: open a person or document and use “Add to thread”. Or attach by id here.</p>
      <form
        className="actions-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (!id.trim()) return;
          void run(async () => {
            await act(buildEnvelope("thread.attach", { threadId: thread.id, entityType, entityId: id.trim() }, { actorDeviceId: device.deviceId }));
            setId("");
          });
        }}
      >
        <select className="select" value={entityType} onChange={(e) => setEntityType(e.target.value as "person" | "document")}>
          <option value="person">person</option>
          <option value="document">document</option>
        </select>
        <input className="input" placeholder="entity id" value={id} onChange={(e) => setId(e.target.value)} style={{ width: 260 }} />
        <Action primary type="submit" disabled={busy}>Attach…</Action>
        {error && <span className="error">{error}</span>}
      </form>
      <div className="actions-inline">
        {field.location.focus && field.location.focus.type !== "thread" && <AttachToThread entity={field.location.focus} label="Attach focused entity" />}
      </div>
    </Section>
  );
}
