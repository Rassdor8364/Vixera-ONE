/**
 * Quiet — lower-priority context the user or the rules moved aside.
 * Read-only in Phase 1 apart from Dismiss (server action). Moving an item
 * back to "needs attention" has no action type yet (see notes).
 */
import { buildEnvelope } from "../../data/actions.ts";
import { useQuiet } from "../../data/hooks.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { useBusy, useField } from "../field-context.tsx";
import { relativeTime } from "../format.ts";
import { Action, Empty, ErrorLine, Row, Section } from "../components/primitives.tsx";
import { ConnectorList } from "./Connectors.tsx";

export function QuietArea() {
  const field = useField();
  const { device } = useSpine();
  const quiet = useQuiet();
  const { busy, error, run } = useBusy();
  return (
    <div>
      <Section title="Quiet" aside={quiet.data?.length || undefined}>
        {quiet.error && <ErrorLine error={quiet.error} />}
        {quiet.data?.length === 0 && <Empty>Nothing is waiting quietly.</Empty>}
        {quiet.data?.map((e) => (
          <Row
            key={e.id}
            title={e.title}
            onOpen={() => field.focus(e.subject)}
            side={relativeTime(e.occurredAt)}
            meta={e.summary}
            actions={
              <Action disabled={busy} onClick={() => void run(() => field.act(buildEnvelope("context_event.dismiss", { contextEventId: e.id }, { actorDeviceId: device.deviceId })))}>
                Dismiss
              </Action>
            }
          />
        ))}
        {error && <p className="error">{error}</p>}
      </Section>
      <ConnectorList />
    </div>
  );
}
