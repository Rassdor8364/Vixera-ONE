/**
 * Capture — the Android companion's explicit entry: pick a file or paste
 * text / a URL. Same ingestion pipeline as drop and share. No screen
 * reading, no overlays.
 */
import { useState } from "react";
import { ingestFiles, ingestText } from "../../data/ingest.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { pickFiles } from "../../platform/files.ts";
import { isTauri } from "../../platform/tauri.ts";
import { useIngestDeps } from "../areas/Files.tsx";
import { useBusy } from "../field-context.tsx";
import { Action } from "../components/primitives.tsx";

export function CaptureEntry() {
  const spine = useSpine();
  const { deps } = useIngestDeps("capture");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useBusy();

  const after = async (added: number) => {
    setNotice(added ? `${added} added to your context` : "Nothing added");
    if (added && spine.mode === "supabase") await spine.runtime.services.processIngest(null).catch(() => null);
    spine.refresh();
  };

  if (!open) {
    return (
      <div className="actions-inline">
        <Action onClick={() => setOpen(true)}>Capture</Action>
      </div>
    );
  }
  return (
    <div className="form" style={{ marginBottom: 24 }}>
      <p className="label">Capture</p>
      <textarea className="input" placeholder="Paste text or a link" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="actions-inline">
        <Action
          primary
          disabled={busy || !text.trim()}
          onClick={() =>
            void run(async () => {
              await ingestText(deps, text, "capture");
              setText("");
              await after(1);
            })
          }
        >
          Add text
        </Action>
        <Action
          disabled={busy || !isTauri()}
          onClick={() =>
            void run(async () => {
              const paths = await pickFiles({ title: "Capture to Vixera One" });
              if (!paths.length) return;
              const r = await ingestFiles(deps, paths, "capture");
              await after(r.submitted.length);
            })
          }
        >
          Pick file
        </Action>
        <Action onClick={() => setOpen(false)}>Close</Action>
      </div>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
