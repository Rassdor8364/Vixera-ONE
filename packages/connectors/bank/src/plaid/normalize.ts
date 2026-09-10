/**
 * Plaid → normalized domain objects. This is the only place Plaid field
 * names are interpreted; the output is what the sync engine persists.
 *
 * Sign convention: Plaid reports a positive `amount` for money leaving the
 * account. Vixera's `MoneyTransaction.amount` is negative when money leaves,
 * so every amount is negated — as a string, never as a float.
 */
import type { IsoDateTime, JsonObject, MoneyAccountType, NormalizedMoneyAccount, NormalizedMoneyTransaction } from "@vixera/domain";
import { decimalFromNumber, negateDecimal } from "../decimal.ts";
import type { PlaidAccount, PlaidTransaction } from "./types.ts";

export const DEFAULT_CURRENCY = "USD";

export function mapAccountType(type: string, subtype: string | null | undefined): MoneyAccountType {
  const t = type.toLowerCase();
  const s = (subtype ?? "").toLowerCase();
  switch (t) {
    case "depository":
      if (s === "checking") return "checking";
      if (s === "savings") return "savings";
      return "other";
    case "credit":
      return "credit";
    case "loan":
      return "loan";
    case "investment":
    case "brokerage":
      return "investment";
    default:
      return "other";
  }
}

export function currencyOf(iso: string | null | undefined, unofficial: string | null | undefined): string {
  return iso?.trim() || unofficial?.trim() || DEFAULT_CURRENCY;
}

export interface AccountNormalizationContext {
  readonly institutionName: string | null;
  /** Used as `balanceAsOf` when Plaid does not date the balance itself. */
  readonly asOf: IsoDateTime;
}

export function normalizeAccount(account: PlaidAccount, context: AccountNormalizationContext): NormalizedMoneyAccount {
  const b = account.balances;
  const metadata: JsonObject = { subtype: account.subtype ?? null, institution: context.institutionName };
  if (typeof b.limit === "number") metadata.limit = decimalFromNumber(b.limit);
  return {
    externalId: account.account_id,
    name: account.name,
    officialName: account.official_name ?? null,
    type: mapAccountType(account.type, account.subtype),
    currency: currencyOf(b.iso_currency_code, b.unofficial_currency_code),
    balanceCurrent: typeof b.current === "number" ? decimalFromNumber(b.current) : null,
    balanceAvailable: typeof b.available === "number" ? decimalFromNumber(b.available) : null,
    balanceAsOf: b.last_updated_datetime ?? context.asOf,
    mask: account.mask ?? null,
    metadata,
  };
}

export function normalizeTransaction(txn: PlaidTransaction): NormalizedMoneyTransaction {
  const category: string[] = [];
  const pfc = txn.personal_finance_category;
  if (pfc?.primary) category.push(pfc.primary);
  if (pfc?.detailed) category.push(pfc.detailed);
  return {
    externalId: txn.transaction_id,
    accountExternalId: txn.account_id,
    amount: negateDecimal(decimalFromNumber(txn.amount)),
    currency: currencyOf(txn.iso_currency_code, txn.unofficial_currency_code),
    description: txn.name,
    merchantName: txn.merchant_name ?? null,
    postedOn: txn.date,
    authorizedAt: txn.authorized_datetime ?? (txn.authorized_date ? `${txn.authorized_date}T00:00:00.000Z` : null),
    pending: txn.pending,
    category,
    metadata: {
      payment_channel: txn.payment_channel ?? null,
      pending_transaction_id: txn.pending_transaction_id ?? null,
    },
  };
}
