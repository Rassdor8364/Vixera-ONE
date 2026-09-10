/** "Continue on <device>" — creates a Vixera-owned handoff to another device. */
import type { EntityRef } from "@vixera/domain";
import { selectHandoffTargets } from "../../data/handoff.ts";
import { useDevices } from "../../data/hooks.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { useBusy, useField } from "../field-context.tsx";
import { Action } from "./primitives.tsx";

export function ContinueOn({ focus, documentId, threadId }: { focus: EntityRef; documentId?: string | null; threadId?: string | null }) {
  const { device } = useSpine();
  const { handoff } = useField();
  const devices = useDevices();
  const { busy, error, run } = useBusy();
  const targets = selectHandoffTargets(devices.data ?? [], device.deviceId);
  if (targets.length === 0) return <Action disabled title="No other device has Vixera One yet">Continue on…</Action>;
  return (
    <>
      {targets.slice(0, 3).map((d) => (
        <Action key={d.id} disabled={busy} onClick={() => void run(() => handoff({ targetDeviceId: d.id, focus, documentId: documentId ?? null, threadId: threadId ?? null }))}>
          Continue on {d.name}
        </Action>
      ))}
      {error && <span className="error">{error}</span>}
    </>
  );
}
