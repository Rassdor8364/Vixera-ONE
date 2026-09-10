/**
 * One Command — one input line at the bottom of the Field. Alt+Space or
 * Ctrl+K focuses it; Esc closes results. Results render inline above the
 * bar; navigate results move the Field; unknown → a quiet line.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandResult, ResultItem } from "@vixera/command";
import { useSpine } from "../../data/spine-provider.tsx";
import { useField } from "../field-context.tsx";
import { formatDate, formatMoney, localTimezone } from "../format.ts";
import { locationForItem, locationForResult, parseShortcut } from "../routing.ts";

export function OneCommandBar() {
  const spine = useSpine();
  const field = useField();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [result, setResult] = useState<CommandResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = parseShortcut(e);
      if (action === "open-command") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (action === "close") {
        setResult(null);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = useCallback(async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      const { result: r } = await spine.runtime.command.run(t, { area: field.location.area, focus: field.location.focus, now: new Date(), timezone: localTimezone() });
      setResult(r);
      const next = locationForResult(r, field.location);
      if (next) field.setLocation(next);
      if (r.kind === "navigate") setText("");
    } finally {
      setBusy(false);
    }
  }, [text, spine.runtime.command, field]);

  return (
    <div className="command">
      {result && (
        <div className="command__results" role="listbox">
          <div className="command__results-title">{result.title}</div>
          {result.items.map((item, i) => (
            <button
              key={`${item.type}-${i}`}
              type="button"
              className="command__result"
              onClick={() => {
                field.setLocation(locationForItem(item));
                setResult(null);
              }}
            >
              {itemLabel(item)}
            </button>
          ))}
          {result.items.length === 0 && <div className="command__message">{result.kind === "unknown" ? "I don't know that yet." : (result.message ?? "Nothing found.")}</div>}
          {result.items.length > 0 && result.message && <div className="command__message">{result.message}</div>}
        </div>
      )}
      <form
        className="command__bar"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Say or type an intent…" aria-label="One Command" disabled={busy} autoComplete="off" spellCheck={false} />
        <span className="command__hint">{field.narrow ? "" : "Alt Space · Ctrl K"}</span>
      </form>
    </div>
  );
}

function itemLabel(item: ResultItem) {
  switch (item.type) {
    case "person":
      return (
        <>
          {item.person.displayName}
          <span>{item.person.organization ?? item.person.primaryEmail ?? "person"}</span>
        </>
      );
    case "thread":
      return (
        <>
          {item.thread.title}
          <span>thread</span>
        </>
      );
    case "document":
      return (
        <>
          {item.document.title}
          <span>{item.document.mimeType ?? "document"} · {formatDate(item.document.updatedAt)}</span>
        </>
      );
    case "mail":
      return (
        <>
          {item.message.subject ?? "(no subject)"}
          <span>{item.message.from?.name ?? item.message.from?.email ?? "mail"} · {formatDate(item.message.receivedAt)}</span>
        </>
      );
    case "time_event":
      return (
        <>
          {item.event.title}
          <span>{formatDate(item.event.startsAt)}</span>
        </>
      );
    case "transaction":
      return (
        <>
          {item.transaction.merchantName ?? item.transaction.description}
          <span>{formatMoney(item.transaction.amount, item.transaction.currency)} · {item.transaction.postedOn}</span>
        </>
      );
  }
}
