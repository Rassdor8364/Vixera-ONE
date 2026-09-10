/** Time — today and the next seven days, grouped by day; participants link to people. */
import { useMemo } from "react";
import type { TimeEvent } from "@vixera/domain";
import { useTime } from "../../data/hooks.ts";
import { useField } from "../field-context.tsx";
import { dayKey, formatDay, formatTime } from "../format.ts";
import { ContinueOn } from "../components/ContinueOn.tsx";
import { AttachToThread } from "../components/AttachToThread.tsx";
import { Empty, ErrorLine, Row, Section } from "../components/primitives.tsx";

const DAY = 86_400_000;

export function TimeArea() {
  const field = useField();
  const range = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to: new Date(start.getTime() + 8 * DAY).toISOString() };
  }, []);
  const events = useTime(range);
  const focusedId = field.location.focus?.type === "time_event" ? field.location.focus.id : null;
  const byDay = useMemo(() => {
    const map = new Map<string, TimeEvent[]>();
    for (const e of events.data ?? []) {
      const k = dayKey(e.startsAt);
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events.data]);

  if (events.error) return <ErrorLine error={events.error} />;
  if (events.data && events.data.length === 0) return <Empty>Nothing on the calendar for the next seven days.</Empty>;
  return (
    <div>
      {byDay.map(([key, list]) => (
        <Section key={key} title={formatDay(list[0]?.startsAt ?? key)} aside={list.length}>
          {list.map((e) => (
            <Row
              key={e.id}
              focused={e.id === focusedId}
              title={e.title}
              onOpen={() => field.focus({ type: "time_event", id: e.id })}
              side={e.allDay ? "All day" : `${formatTime(e.startsAt)} – ${formatTime(e.endsAt)}`}
              meta={
                <>
                  {e.participants
                    .filter((p) => !p.isSelf)
                    .map((p, i) => (
                      <span key={`${p.email ?? p.name ?? i}`}>
                        {i > 0 ? ", " : ""}
                        {p.personId ? (
                          <button type="button" className="linkish" onClick={() => field.focus({ type: "person", id: p.personId as string })}>
                            {p.name ?? p.email}
                          </button>
                        ) : (
                          (p.name ?? p.email)
                        )}
                      </span>
                    ))}
                  {e.location ? <span className="faint"> · {e.location}</span> : null}
                </>
              }
              actions={
                e.id === focusedId ? (
                  <>
                    <AttachToThread entity={{ type: "time_event", id: e.id }} />
                    <ContinueOn focus={{ type: "time_event", id: e.id }} />
                  </>
                ) : undefined
              }
            />
          ))}
        </Section>
      ))}
    </div>
  );
}
