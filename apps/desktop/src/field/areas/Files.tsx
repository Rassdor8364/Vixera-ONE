/**
 * Files — document context (never rendering state). Drop / pick feeds the
 * one ingestion pipeline; Open uses Praxion when present, else the OS;
 * Praxion-only actions stay visible but disabled with the reason.
 */
import { useEffect, useRef, useState } from "react";
import type { Document } from "@vixera/domain";
import { ingestFiles, type IngestDeps } from "../../data/ingest.ts";
import { useFiles } from "../../data/hooks.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { pickFiles } from "../../platform/files.ts";
import { isTauri } from "../../platform/tauri.ts";
import { useBusy, useField } from "../field-context.tsx";
import { praxionLabel } from "../../data/praxion.ts";
import { formatDate, relativeTime } from "../format.ts";
import { AttachToThread } from "../components/AttachToThread.tsx";
import { ContinueOn } from "../components/ContinueOn.tsx";
import { Action, Empty, ErrorLine, Row, Section, StateMark } from "../components/primitives.tsx";

export function useIngestDeps(source: "drop" | "capture" | "share" | "command" | "clipboard"): { deps: IngestDeps; source: typeof source } {
  const spine = useSpine();
  return { deps: { userId: spine.userId, deviceId: spine.device.deviceId, reader: spine.reader, storage: spine.runtime.storage, dispatch: spine.runtime.dispatch }, source };
}

export function FilesArea() {
  const field = useField();
  const spine = useSpine();
  const [search, setSearch] = useState("");
  const files = useFiles(search);
  const focusedId = field.location.focus?.type === "document" ? field.location.focus.id : null;
  const { deps } = useIngestDeps("drop");
  const { busy, error, run } = useBusy();
  const [notice, setNotice] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const ingest = (inputs: Parameters<typeof ingestFiles>[1], source: "drop" | "capture") =>
    run(async () => {
      const result = await ingestFiles(deps, inputs, source);
      setNotice(
        [result.submitted.length ? `${result.submitted.length} added` : null, result.failed.length ? `${result.failed.length} failed: ${result.failed[0]?.error.message ?? ""}` : null].filter(Boolean).join(" · ") ||
          "Nothing to add",
      );
      if (result.submitted.length && spine.mode === "supabase") await spine.runtime.services.processIngest(null).catch(() => null);
      spine.refresh();
    });

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setHover(true);
          else if (p.type === "leave") setHover(false);
          else if (p.type === "drop") {
            setHover(false);
            if (p.paths.length) void ingest(p.paths, "drop");
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = () =>
    run(async () => {
      if (isTauri()) {
        const paths = await pickFiles({ title: "Add to Vixera One" });
        if (paths.length) await ingest(paths, "capture");
      } else inputRef.current?.click();
    });

  const docs = files.data?.documents ?? [];
  const pending = files.data?.pendingIngest ?? [];
  return (
    <div>
      <div
        className={`dropzone${hover ? " dropzone--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setHover(true);
        }}
        onDragLeave={() => setHover(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHover(false);
          const list = [...e.dataTransfer.files];
          if (list.length && !isTauri()) void ingest(list, "drop");
        }}
      >
        Drop files here to add them to your context
        <div className="actions-inline">
          <Action primary disabled={busy} onClick={() => void pick()}>Pick files</Action>
        </div>
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; if (list.length) void ingest(list, "capture"); }} />
        {notice && <p className="notice">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </div>
      {pending.length > 0 && (
        <Section title="Arriving" aside={<StateMark>Processing</StateMark>}>
          {pending.map((i) => (
            <Row key={i.id} title={i.title ?? i.url ?? "Shared item"} meta={`${i.kind} · ${i.source} · ${relativeTime(i.createdAt)}`} />
          ))}
        </Section>
      )}
      <input className="input" placeholder="Search documents" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 16 }} />
      <Section title="Recent" aside={<StateMark tone={field.praxionReady ? "accent" : "muted"}>{praxionLabel(field.praxion)}</StateMark>}>
        {files.error && <ErrorLine error={files.error} />}
        {docs.length === 0 && !files.loading && <Empty>{search ? "No document matches." : "No documents yet. Drop a file, share from Android, or connect mail for attachments."}</Empty>}
        {docs.map((d) => (
          <DocumentRow key={d.id} doc={d} focused={d.id === focusedId} />
        ))}
      </Section>
    </div>
  );
}

function DocumentRow({ doc, focused }: { doc: Document; focused: boolean }) {
  const field = useField();
  const { device } = useSpine();
  const { busy, error, run } = useBusy();
  const [opened, setOpened] = useState<string | null>(null);
  const onThisDevice = doc.location.kind === "device_path" && doc.location.deviceId === device.deviceId;
  const praxionReason = field.praxionReady ? undefined : field.praxion.state === "incompatible" ? "Praxion is installed but its contract version is incompatible" : "Needs Praxion on this device";
  return (
    <Row
      focused={focused}
      title={doc.title}
      onOpen={() => field.focus({ type: "document", id: doc.id })}
      side={
        onThisDevice ? <StateMark tone="muted">On this device</StateMark> : doc.location.kind === "storage" ? <StateMark>Synced</StateMark> : doc.location.kind === "provider" ? <StateMark tone="muted">At source</StateMark> : null
      }
      meta={`${doc.source.replace("_", " ")}${doc.mimeType ? ` · ${doc.mimeType}` : ""} · ${formatDate(doc.updatedAt)}${opened ? ` · ${opened}` : ""}`}
      actions={
        <>
          <Action primary disabled={busy} onClick={() => void run(async () => setOpened(`opened with ${(await field.openDoc(doc)).openedWith}`))}>
            Open
          </Action>
          <AttachToThread entity={{ type: "document", id: doc.id }} />
          <ContinueOn focus={{ type: "document", id: doc.id }} documentId={doc.id} />
          <Action
            disabled={busy || !field.praxionReady}
            {...(praxionReason ? { title: praxionReason } : {})}
            onClick={() => void run(async () => setOpened(describeArtifactAction("Compare", await field.artifactAction(doc, "compare"))))}
          >
            Compare
          </Action>
          <Action
            disabled={busy || !field.praxionReady}
            {...(praxionReason ? { title: praxionReason } : {})}
            onClick={() => void run(async () => setOpened(describeArtifactAction("Annotate", await field.artifactAction(doc, "annotate"))))}
          >
            Annotate
          </Action>
          {praxionReason && <span className="faint small">{praxionReason}</span>}
          {error && <span className="error">{error}</span>}
        </>
      }
    />
  );
}

/** One line of feedback for an artifact action Praxion answered. */
export function describeArtifactAction(label: string, result: { supported: boolean; accepted: boolean; message: string | null }): string {
  if (!result.supported) return result.message ?? `Praxion does not offer ${label.toLowerCase()}`;
  if (!result.accepted) return result.message ?? `${label} was declined`;
  return result.message ?? `${label} opened in Praxion`;
}
