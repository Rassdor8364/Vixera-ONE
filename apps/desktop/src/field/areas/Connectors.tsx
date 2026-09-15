/**
 * Connect / sync / disconnect accounts. The link itself runs server-side
 * (`connector-link`); this only opens the provider page and waits for the
 * account row. Shown inside NOW's empty state and at the foot of Quiet.
 */
import { useState } from "react";
import type { ConnectorAccount, ConnectorSyncState } from "@vixera/domain";
import { disconnectAccount, isLinkProvider, startLink, type LinkProvider, type PendingLink } from "../../data/link.ts";
import { useConnectorAccounts } from "../../data/hooks.ts";
import { useSpine } from "../../data/spine-provider.tsx";
import { useBusy } from "../field-context.tsx";
import { relativeTime } from "../format.ts";
import { Action, Row, Section, StateMark } from "../components/primitives.tsx";

const PROVIDERS: readonly { id: LinkProvider; label: string }[] = [
  { id: "google", label: "Connect Google mail / calendar" },
  { id: "microsoft", label: "Connect Microsoft mail / calendar" },
  { id: "plaid", label: "Connect bank (read only)" },
];

/** One link in flight (new or repair): what the browser step needs from here. */
function usePendingLink() {
  const spine = useSpine();
  const { busy, error, run } = useBusy();
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const functions = spine.runtime.functions;

  const begin = (provider: LinkProvider, relink: ConnectorAccount | null) =>
    run(async () => {
      if (!functions) return;
      setNotice(null);
      const p = await startLink({ functions, reader: spine.reader }, provider, { relink });
      setPending(p);
      setNotice(relink ? `Re-authenticate ${relink.label} in the browser; Vixera One picks it up here.` : "Finish in the browser; Vixera One picks the account up here.");
      const account = await p.account;
      setPending(null);
      setNotice(account ? (relink ? `Reconnected ${account.label}.` : `Connected ${account.label}.`) : relink ? "The connection did not come back within 3 minutes." : "No new account appeared within 3 minutes.");
      spine.refresh();
    });

  const finish = () =>
    run(async () => {
      const complete = pending?.complete;
      if (!complete) return;
      const account = await complete();
      setPending(null);
      setNotice(`Connected ${account.label}.`);
      spine.refresh();
    });

  const cancel = () => {
    pending?.cancel();
    setPending(null);
  };

  const controls = (
    <>
      {pending?.complete && <Action onClick={() => void finish()}>I finished linking the bank</Action>}
      {pending && <Action onClick={cancel}>Cancel</Action>}
    </>
  );
  return { busy, error, pending, notice, begin, controls, functions };
}

export function ConnectActions() {
  const { busy, error, pending, notice, begin, controls, functions } = usePendingLink();
  if (!functions) return <p className="notice">Dev-fixture mode: the mock account is already connected. Linking real accounts needs the Supabase build.</p>;
  return (
    <div>
      <div className="actions-inline">
        {PROVIDERS.map((p) => (
          <Action key={p.id} primary disabled={busy || pending !== null} onClick={() => void begin(p.id, null)}>
            {p.label}
          </Action>
        ))}
        {controls}
      </div>
      {notice && <p className="notice">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export function ConnectorList() {
  const spine = useSpine();
  const data = useConnectorAccounts();
  const { busy, error, run } = useBusy();
  const relink = usePendingLink();
  const accounts = data.data?.accounts ?? [];
  const states = data.data?.syncStates ?? [];
  return (
    <Section title="Sources" aside={accounts.length ? undefined : "none connected"}>
      {accounts.map((a) => (
        <ConnectorRow
          key={a.id}
          account={a}
          states={states.filter((s) => s.connectorAccountId === a.id)}
          busy={busy || relink.busy || relink.pending !== null}
          onSync={() => void run(async () => { await spine.runtime.services.syncNow(a.id); spine.refresh(); })}
          onDisconnect={spine.runtime.functions ? () => void run(async () => { await disconnectAccount(spine.runtime.functions as NonNullable<typeof spine.runtime.functions>, a.provider, a.id); spine.refresh(); }) : null}
          // A parked account is repaired in place — Plaid through Link update
          // mode on the same Item, OAuth by consenting again onto the same row —
          // never by linking a second copy of it.
          onReconnect={relink.functions && a.status === "needs_reauth" && isLinkProvider(a.provider) ? () => void relink.begin(a.provider as LinkProvider, a) : null}
        />
      ))}
      {(relink.pending || relink.notice || relink.error) && (
        <div>
          <div className="actions-inline">{relink.controls}</div>
          {relink.notice && <p className="notice">{relink.notice}</p>}
          {relink.error && <p className="error">{relink.error}</p>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <ConnectActions />
    </Section>
  );
}

function ConnectorRow({ account, states, busy, onSync, onDisconnect, onReconnect }: { account: ConnectorAccount; states: ConnectorSyncState[]; busy: boolean; onSync: () => void; onDisconnect: (() => void) | null; onReconnect: (() => void) | null }) {
  const lastSuccess = states.map((s) => s.lastSuccessAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
  const errored = states.filter((s) => s.status === "error");
  return (
    <Row
      title={account.label}
      side={
        account.status === "active" ? (
          <StateMark tone={errored.length ? "warn" : "accent"}>{errored.length ? "Sync error" : "Synced"}</StateMark>
        ) : (
          <StateMark tone="warn">{account.status.replace("_", " ")}</StateMark>
        )
      }
      meta={
        <>
          {account.provider} · {account.capabilities.join(", ")}
          {lastSuccess ? ` · last sync ${relativeTime(lastSuccess)}` : " · never synced"}
          {errored[0]?.lastError ? ` · ${errored[0].lastError}` : ""}
        </>
      }
      actions={
        <>
          {onReconnect && <Action primary disabled={busy} onClick={onReconnect}>Reconnect</Action>}
          <Action disabled={busy || account.status === "disconnected"} onClick={onSync}>Sync now</Action>
          {onDisconnect && account.status !== "disconnected" && <Action disabled={busy} onClick={onDisconnect}>Disconnect</Action>}
        </>
      }
    />
  );
}
