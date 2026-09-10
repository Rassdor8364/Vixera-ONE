/** People — normalized across sources; identities, documents, mail, events, money via the graph. */
import { useState } from "react";
import { usePeople, usePerson, usePersonForMail } from "../../data/hooks.ts";
import { useField } from "../field-context.tsx";
import { formatDate, formatMoney, formatTime, relativeTime } from "../format.ts";
import { AttachToThread } from "../components/AttachToThread.tsx";
import { ContinueOn } from "../components/ContinueOn.tsx";
import { Action, Empty, ErrorLine, Row, Section } from "../components/primitives.tsx";

export function PeopleArea() {
  const field = useField();
  const [search, setSearch] = useState("");
  const people = usePeople(search);
  const focus = field.location.focus;
  // A focused mail message resolves to its sender: mail is context inside
  // People, not an area of its own (there is no mail client in Vixera).
  const focusedMailId = focus?.type === "mail_message" ? focus.id : null;
  const senderId = usePersonForMail(focusedMailId);
  const focusedId = focus?.type === "person" ? focus.id : senderId.data;
  const detail = usePerson(focusedId);
  const resolvingMail = focusedMailId !== null && senderId.loading;
  const visible = (people.data ?? []).filter((p) => p.mergedIntoId === null);
  return (
    <div className={`two-col${focusedId ? " two-col--detail" : ""}`}>
      <div className="two-col__list">
        <input className="input" placeholder="Search people" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 16 }} />
        <Section title="People" aside={visible.length || undefined}>
          {people.error && <ErrorLine error={people.error} />}
          {visible.length === 0 && !people.loading && <Empty>{search ? "Nobody matches." : "No people yet — they appear as mail, calendar and money arrive."}</Empty>}
          {visible.map((p) => (
            <Row key={p.id} focused={p.id === focusedId} title={p.displayName} onOpen={() => field.focus({ type: "person", id: p.id })} meta={p.organization ?? p.primaryEmail} />
          ))}
        </Section>
      </div>
      <div>
        {focusedId && detail.data && <PersonDetail data={detail.data} />}
        {focusedId && !detail.data && !detail.loading && <Empty>That person is gone.</Empty>}
        {!focusedId && resolvingMail && <Empty>Finding who that came from…</Empty>}
        {!focusedId && !resolvingMail && focusedMailId && <Empty>That message has no person attached to it yet.</Empty>}
        {!focusedId && !focusedMailId && <Empty>Pick a person to see what connects to them.</Empty>}
      </div>
    </div>
  );
}

function PersonDetail({ data }: { data: NonNullable<ReturnType<typeof usePerson>["data"]> }) {
  const field = useField();
  const { person, identities, neighborhood: n, mail, transactions } = data;
  const personRef = { type: "person" as const, id: person.id };
  return (
    <div>
      <h1 className="greeting">{person.displayName}</h1>
      <p className="lede">{[person.organization, person.primaryEmail].filter(Boolean).join(" · ") || "Person"}</p>
      <div className="actions-inline" style={{ marginBottom: 30 }}>
        <AttachToThread entity={personRef} />
        <ContinueOn focus={personRef} />
      </div>
      <Section title="Identities" aside={identities.length}>
        {identities.map((i) => (
          <Row key={i.id} title={<span className="mono">{i.rawValue}</span>} meta={`${i.kind}${i.provider ? ` · ${i.provider}` : ""}`} />
        ))}
      </Section>
      {n.threads.length > 0 && (
        <Section title="Threads">
          {n.threads.map((t) => (
            <Row key={t.id} title={t.title} onOpen={() => field.focus({ type: "thread", id: t.id })} meta={t.summary} />
          ))}
        </Section>
      )}
      <Section title="Documents" aside={n.documents.length || "none"}>
        {n.documents.map((d) => (
          <Row key={d.id} title={d.title} onOpen={() => field.focus({ type: "document", id: d.id })} meta={`${d.source.replace("_", " ")} · ${formatDate(d.updatedAt)}`} actions={<Action onClick={() => void field.openDoc(d).catch(() => {})}>Open</Action>} />
        ))}
      </Section>
      <Section title="Mail" aside={mail.length || "none"}>
        {mail.slice(0, 30).map((m) => (
          <Row key={m.id} title={m.subject ?? "(no subject)"} side={relativeTime(m.receivedAt)} meta={m.snippet} />
        ))}
      </Section>
      <Section title="Events" aside={n.timeEvents.length || "none"}>
        {n.timeEvents.map((e) => (
          <Row key={e.id} title={e.title} onOpen={() => field.focus({ type: "time_event", id: e.id })} side={`${formatDate(e.startsAt)} ${e.allDay ? "" : formatTime(e.startsAt)}`} />
        ))}
      </Section>
      <Section title="Money" aside={transactions.length || "none"}>
        {transactions.map((t) => (
          <Row key={t.id} title={t.merchantName ?? t.description} onOpen={() => field.focus({ type: "money_transaction", id: t.id })} side={<span className={Number(t.amount) > 0 ? "amount--in" : ""}>{formatMoney(t.amount, t.currency)}</span>} meta={t.postedOn} />
        ))}
      </Section>
    </div>
  );
}
