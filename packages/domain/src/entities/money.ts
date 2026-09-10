import type { ConnectorAccountId, MoneyAccountId, MoneyTransactionId, PersonId, UserId } from "../ids.ts";
import type { IsoDate, IsoDateTime, JsonObject, Timestamped, UserScoped } from "./common.ts";

export type MoneyAccountType = "checking" | "savings" | "credit" | "loan" | "investment" | "other";

export interface MoneyAccount extends UserScoped, Timestamped {
  readonly id: MoneyAccountId;
  readonly userId: UserId;
  readonly connectorAccountId: ConnectorAccountId;
  readonly externalId: string;
  readonly name: string;
  readonly officialName: string | null;
  readonly type: MoneyAccountType;
  /** ISO 4217. */
  readonly currency: string;
  /** Balances are optional: some providers do not expose them. Amounts are decimal strings. */
  readonly balanceCurrent: string | null;
  readonly balanceAvailable: string | null;
  readonly balanceAsOf: IsoDateTime | null;
  /** Last 2–4 digits, display only. */
  readonly mask: string | null;
  readonly metadata: JsonObject;
}

/**
 * A money transaction. `amount` is a signed decimal string in the account's
 * currency: negative = money leaving the account, positive = money arriving.
 * (Provider sign conventions are normalized by the connector.)
 */
export interface MoneyTransaction extends UserScoped, Timestamped {
  readonly id: MoneyTransactionId;
  readonly userId: UserId;
  readonly connectorAccountId: ConnectorAccountId;
  readonly moneyAccountId: MoneyAccountId;
  readonly externalId: string;
  readonly amount: string;
  readonly currency: string;
  readonly description: string;
  readonly merchantName: string | null;
  readonly postedOn: IsoDate;
  readonly authorizedAt: IsoDateTime | null;
  readonly pending: boolean;
  readonly category: readonly string[];
  /** Resolved by the ContextLinker when a counterparty is known. */
  readonly counterpartyPersonId: PersonId | null;
  readonly metadata: JsonObject;
}
