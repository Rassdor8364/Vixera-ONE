/** Money — READ only: accounts with balances, recent transactions, related thread / person when linked. */
import { useState } from "react";
import { ref, type MoneyTransaction } from "@vixera/domain";
import { useMoney } from "../../data/hooks.ts";
import { useSpineQuery } from "../../data/spine-provider.tsx";
import { useField } from "../field-context.tsx";
import { formatMoney, relativeTime } from "../format.ts";
import { AttachToThread } from "../components/AttachToThread.tsx";
import { Empty, ErrorLine, Row, Section } from "../components/primitives.tsx";

export function MoneyArea() {
  const field = useField();
  const [search, setSearch] = useState("");
  const money = useMoney(search);
  const focusedId = field.location.focus?.type === "money_transaction" ? field.location.focus.id : null;
  if (money.error) return <ErrorLine error={money.error} />;
  const accounts = money.data?.accounts ?? [];
  const transactions = money.data?.transactions ?? [];
  return (
    <div>
      <Section title="Accounts" aside={accounts.length || "none"}>
        {accounts.length === 0 && !money.loading && <Empty>No bank connected. Money is read-only context: balances and transactions, never payments.</Empty>}
        {accounts.map((a) => (
          <Row
            key={a.id}
            title={a.name}
            side={<span className="balance">{a.balanceCurrent !== null ? formatMoney(a.balanceCurrent, a.currency) : "—"}</span>}
            meta={`${a.type}${a.mask ? ` ···${a.mask}` : ""}${a.balanceAsOf ? ` · as of ${relativeTime(a.balanceAsOf)}` : ""}`}
          />
        ))}
      </Section>
      <input className="input" placeholder="Search transactions" value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 16 }} />
      <Section title="Transactions" aside={transactions.length || undefined}>
        {transactions.length === 0 && !money.loading && <Empty>{search ? "No transaction matches." : "No transactions in the spine yet."}</Empty>}
        {transactions.map((t) => (
          <TransactionRow key={t.id} tx={t} focused={t.id === focusedId} />
        ))}
      </Section>
    </div>
  );
}

function TransactionRow({ tx, focused }: { tx: MoneyTransaction; focused: boolean }) {
  const field = useField();
  const links = useSpineQuery(
    async (reader) => {
      if (!focused) return null;
      const rows = await reader.neighbors(ref("money_transaction", tx.id));
      const threads = (await Promise.all(rows.filter((r) => r.ref.type === "thread").map((r) => reader.getThread(r.ref.id)))).filter((t) => t !== null);
      const person = tx.counterpartyPersonId ? await reader.getPerson(tx.counterpartyPersonId) : null;
      return { threads, person };
    },
    [tx.id, focused],
  );
  return (
    <Row
      focused={focused}
      title={tx.merchantName ?? tx.description}
      onOpen={() => field.focus({ type: "money_transaction", id: tx.id })}
      side={<span className={Number(tx.amount) > 0 ? "amount--in" : ""}>{formatMoney(tx.amount, tx.currency)}</span>}
      meta={
        <>
          {tx.postedOn}
          {tx.pending ? " · pending" : ""}
          {tx.category.length ? ` · ${tx.category.join(" / ")}` : ""}
          {links.data?.person && (
            <>
              {" · "}
              <button type="button" className="linkish" onClick={() => field.focus({ type: "person", id: links.data?.person?.id as string })}>
                {links.data.person.displayName}
              </button>
            </>
          )}
          {links.data?.threads.map((t) => (
            <span key={t.id}>
              {" · "}
              <button type="button" className="linkish" onClick={() => field.focus({ type: "thread", id: t.id })}>
                {t.title}
              </button>
            </span>
          ))}
        </>
      }
      actions={focused ? <AttachToThread entity={{ type: "money_transaction", id: tx.id }} /> : undefined}
    />
  );
}
