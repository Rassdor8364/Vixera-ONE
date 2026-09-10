/**
 * What every area can do: know where the Field is, move it, focus an
 * entity, run a server action, open a document, hand off. One context, no
 * prop drilling; everything durable still goes through `act` (the seam).
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { ActionEnvelope, ActionOutcome, Document, EntityRef } from "@vixera/domain";
import type { PraxionAvailability } from "@vixera/praxion";
import { useSpine } from "../data/spine-provider.tsx";
import { usePraxionAvailability } from "../data/praxion.ts";
import { openDocument, requestArtifactAction, type ArtifactAction, type ArtifactActionResult, type OpenDocumentResult } from "../data/open-document.ts";
import { createHandoff, type CreateHandoffInput } from "../data/handoff.ts";
import { focusEntity, HOME, type FieldArea, type FieldLocation } from "./routing.ts";

export interface FieldApi {
  readonly location: FieldLocation;
  readonly go: (area: FieldArea) => void;
  readonly focus: (ref: EntityRef | null) => void;
  readonly setLocation: (next: FieldLocation) => void;
  readonly act: (envelope: ActionEnvelope) => Promise<ActionOutcome>;
  readonly praxion: PraxionAvailability;
  readonly praxionReady: boolean;
  readonly openDoc: (doc: Document) => Promise<OpenDocumentResult>;
  /** Asks Praxion for an artifact action. Vixera never performs it itself. */
  readonly artifactAction: (doc: Document, action: ArtifactAction) => Promise<ArtifactActionResult>;
  readonly handoff: (input: CreateHandoffInput) => Promise<void>;
  readonly narrow: boolean;
}

const FieldContext = createContext<FieldApi | null>(null);

export function FieldApiProvider({ children, initial = HOME, narrow }: { children: ReactNode; initial?: FieldLocation; narrow: boolean }) {
  const spine = useSpine();
  const [location, setLocation] = useState<FieldLocation>(initial);
  const praxion = usePraxionAvailability(spine.runtime.praxion);
  const go = useCallback((area: FieldArea) => setLocation((l) => (l.area === area ? l : { area, focus: null })), []);
  const focus = useCallback((ref: EntityRef | null) => setLocation((l) => (ref ? focusEntity(l, ref) : { area: l.area, focus: null })), []);
  const artifactAction = useCallback(
    (doc: Document, action: ArtifactAction) =>
      requestArtifactAction({ deviceId: spine.device.deviceId, praxion: spine.runtime.praxion, storage: spine.runtime.storage }, doc, action),
    [spine.device.deviceId, spine.runtime],
  );
  const openDoc = useCallback(
    (doc: Document) => openDocument({ deviceId: spine.device.deviceId, praxion: spine.runtime.praxion, storage: spine.runtime.storage }, doc),
    [spine.device.deviceId, spine.runtime],
  );
  const handoff = useCallback(
    async (input: CreateHandoffInput) => {
      await createHandoff(
        { deviceId: spine.device.deviceId, dispatch: spine.runtime.dispatch, reader: spine.reader, screenContext: spine.runtime.screenContext },
        { ...input, commandHistory: input.commandHistory ?? spine.runtime.command.history.toArray() },
      );
      spine.refresh();
    },
    [spine],
  );
  const value = useMemo<FieldApi>(
    () => ({ location, go, focus, setLocation, act: spine.act, praxion, praxionReady: praxion.state === "available", openDoc, artifactAction, handoff, narrow }),
    [location, go, focus, spine.act, praxion, openDoc, artifactAction, handoff, narrow],
  );
  return <FieldContext.Provider value={value}>{children}</FieldContext.Provider>;
}

export function useField(): FieldApi {
  const ctx = useContext(FieldContext);
  if (!ctx) throw new Error("useField must be used inside <FieldApiProvider>");
  return ctx;
}

/** Runs an async action with pending / error state for a button. */
export function useBusy(): { busy: boolean; error: string | null; run: (fn: () => Promise<unknown>) => Promise<void>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clear: () => setError(null) };
}
