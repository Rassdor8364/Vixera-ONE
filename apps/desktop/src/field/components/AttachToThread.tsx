/** "Attach…" — thread.attach through the action seam, choosing among the user's threads. */
import { useState } from "react";
import type { EntityRef } from "@vixera/domain";
import { useThreads } from "../../data/hooks.ts";
import { buildEnvelope } from "../../data/actions.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { useBusy, useField } from "../field-context.tsx";
import { Action } from "./primitives.tsx";

export function AttachToThread({ entity, label = "Add to thread" }: { entity: EntityRef; label?: string }) {
  const { act } = useField();
  const { device } = useSpine();
  const threads = useThreads();
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useBusy();
  const candidates = (threads.data ?? []).filter((t) => t.status !== "archived");
  if (!open) return <Action onClick={() => setOpen(true)}>{label}…</Action>;
  return (
    <span className="chips">
      {candidates.length === 0 && <span className="muted small">No threads yet</span>}
      {candidates.slice(0, 8).map((t) => (
        <Action
          key={t.id}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await act(buildEnvelope("thread.attach", { threadId: t.id, entityType: entity.type, entityId: entity.id }, { actorDeviceId: device.deviceId }));
              setOpen(false);
            })
          }
        >
          → {t.title}
        </Action>
      ))}
      <Action onClick={() => setOpen(false)}>Cancel</Action>
      {error && <span className="error">{error}</span>}
    </span>
  );
}
