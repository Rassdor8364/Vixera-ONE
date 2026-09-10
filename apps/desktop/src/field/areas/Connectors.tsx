/**
 * Connect / sync / disconnect accounts. The link itself runs server-side
 * (`connector-link`); this only opens the provider page and waits for the
 * account row. Shown inside NOW's empty state and at the foot of Quiet.
 */
import { useState } from "react";
import type { ConnectorAccount, ConnectorSyncState } from "@vixera/domain";
import { disconnectAccount, startLink, type LinkProvider, type PendingLink } from "../../data/link.ts";
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

export function ConnectActions() {
  const spine = useSpine();
  const { busy, error, run } = useBusy();
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const functions = spine.runtime.functions;

  if (!functions) return <p className="notice">Dev-fixture mode: the mock account is already connected. Linking real accounts needs the Supabase build.</p>;

  const link = (provider: LinkProvider) =>
    run(async () => {
      setNotice(null);
      const p = await startLink({ functions, reader: spine.reader }, provider);
      setPending(p);
      setNotice("Finish in the browser; Vixera One picks the account up here.");
      const account = await p.account;
      setPending(null);
      setNotice(account ? `Connected ${account.label}.` : "No new account appeared within 3 minutes.");
      spine.refresh();
    });

  return (
    <div>
      <div className="actions-inline">
        {PROVIDERS.map((p) => (
          <Action key={p.id} primary disabled={busy || pending !== null} onClick={() => void link(p.id)}>
            {p.label}
          </Action>
        ))}
        {pending?.complete && (
          <Action
            onClick={() =>
              void run(async () => {
                const complete = pending.complete;
                if (!complete) return;
                const account = await complete();
                setPending(null);
                setNotice(`Connected ${account.label}.`);
                spine.refresh();
              })
            }
          >
            I finished linking the bank
          </Action>
        )}
        {pending && <Action onClick={() => { pending.cancel(); setPending(null); }}>Cancel</Action>}
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
  const accounts = data.data?.accounts ?? [];
  const states = data.data?.syncStates ?? [];
  return (
    <Section title="Sources" aside={accounts.length ? undefined : "none connected"}>
      {accounts.map((a) => (
        <ConnectorRow
          key={a.id}
          account={a}
          states={states.filter((s) => s.connectorAccountId === a.id)}
          busy={busy}
          onSync={() => void run(async () => { await spine.runtime.services.syncNow(a.id); spine.refresh(); })}
          onDisconnect={spine.runtime.functions ? () => void run(async () => { await disconnectAccount(spine.runtime.functions as NonNullable<typeof spine.runtime.functions>, a.provider, a.id); spine.refresh(); }) : null}
        />
      ))}
      {error && <p className="error">{error}</p>}
      <ConnectActions />
    </Section>
  );
}

function ConnectorRow({ account, states, busy, onSync, onDisconnect }: { account: ConnectorAccount; states: ConnectorSyncState[]; busy: boolean; onSync: () => void; onDisconnect: (() => void) | null }) {
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
          <Action disabled={busy || account.status === "disconnected"} onClick={onSync}>Sync now</Action>
          {onDisconnect && account.status !== "disconnected" && <Action disabled={busy} onClick={onDisconnect}>Disconnect</Action>}
        </>
      }
    />
  );
}
