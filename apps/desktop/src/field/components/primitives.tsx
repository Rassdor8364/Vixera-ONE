/** Small, calm building blocks. No UI kit. */
import type { ReactNode } from "react";

export function StateMark({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "muted" | "warn" }) {
  return <span className={`mark${tone === "muted" ? " mark--muted" : tone === "warn" ? " mark--warn" : ""}`}>{children}</span>;
}

export function Label({ children }: { children: ReactNode }) {
  return <p className="label">{children}</p>;
}

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section__head">
        <p className="label">{title}</p>
        {aside !== undefined && <span className="section__aside">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export interface RowProps {
  readonly title: ReactNode;
  readonly onOpen?: () => void;
  readonly meta?: ReactNode;
  readonly side?: ReactNode;
  readonly actions?: ReactNode;
  readonly focused?: boolean;
}

export function Row({ title, onOpen, meta, side, actions, focused }: RowProps) {
  return (
    <div className={`row${focused ? " row--focus" : ""}`}>
      <div className="row__title">{onOpen ? <button type="button" onClick={onOpen}>{title}</button> : title}</div>
      {side !== undefined && <div className="row__side">{side}</div>}
      {meta !== undefined && meta !== null && <div className="row__meta">{meta}</div>}
      {actions !== undefined && actions !== null && <div className="row__actions">{actions}</div>}
    </div>
  );
}

export function Action({
  children,
  onClick,
  disabled,
  title,
  primary,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  /** "submit" inside a form so the click submits it; default "button". */
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className={`action${primary ? " action--primary" : ""}`} onClick={onClick} disabled={disabled} {...(title ? { title } : {})}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="notice">{children}</p>;
}

export function ErrorLine({ error }: { error: Error | string | null }) {
  if (!error) return null;
  return <p className="error">{typeof error === "string" ? error : error.message}</p>;
}
