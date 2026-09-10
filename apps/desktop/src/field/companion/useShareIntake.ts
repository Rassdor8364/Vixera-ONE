/**
 * Android: on mount read the pending share queue, subscribe to new shares,
 * ingest each item (including shares that arrive mid-batch), and clear the
 * queue only after every dispatch succeeded.
 */
import { useEffect, useRef, useState } from "react";
import { clearPendingShares, getPendingShares, onShare, type PendingShares } from "../../platform/share.ts";
import { isAndroid } from "../../platform/tauri.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import type { IngestDeps } from "../../data/ingest.ts";
import { drainShares } from "./share-intake.ts";

export function useShareIntake(): { busy: boolean; notice: string | null } {
  const spine = useSpine();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!isAndroid()) return;
    const deps: IngestDeps = { userId: spine.userId, deviceId: spine.device.deviceId, reader: spine.reader, storage: spine.runtime.storage, dispatch: spine.runtime.dispatch };
    const handle = async (pending: PendingShares) => {
      if (inFlight.current || pending.items.length === 0) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const result = await drainShares(deps, { getPending: getPendingShares, clear: clearPendingShares }, pending.items);
        setNotice(result.failed.length ? `${result.submitted.length} shared, ${result.failed.length} failed` : `${result.submitted.length} shared to Vixera`);
        if (result.submitted.length && spine.mode === "supabase") await spine.runtime.services.processIngest(null).catch(() => null);
        spine.refresh();
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    };
    let unsubscribe: (() => Promise<void>) | null = null;
    getPendingShares().then(handle).catch(() => {});
    onShare((p) => void handle(p)).then((u) => (unsubscribe = u)).catch(() => {});
    return () => {
      void unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spine.runtime]);
  return { busy, notice };
}
