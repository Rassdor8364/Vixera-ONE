/**
 * Plaid API shapes used by the adapter. Provider schema: nothing outside
 * `src/plaid/` may import this file. Fields are the subset Vixera reads;
 * Plaid sends more and we ignore it.
 */

export interface PlaidErrorBody {
  readonly error_type?: string;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly display_message?: string | null;
  readonly request_id?: string;
}

export interface PlaidLinkTokenCreateResponse {
  readonly link_token: string;
  readonly expiration: string;
  readonly request_id?: string;
}

export interface PlaidPublicTokenExchangeResponse {
  readonly access_token: string;
  readonly item_id: string;
  readonly request_id?: string;
}

export interface PlaidItem {
  readonly item_id: string;
  readonly institution_id?: string | null;
  readonly institution_name?: string | null;
  readonly available_products?: readonly string[];
  readonly billed_products?: readonly string[];
  readonly error?: PlaidErrorBody | null;
}

export interface PlaidItemGetResponse {
  readonly item: PlaidItem;
  readonly request_id?: string;
}

export interface PlaidBalances {
  readonly available?: number | null;
  readonly current?: number | null;
  readonly limit?: number | null;
  readonly iso_currency_code?: string | null;
  readonly unofficial_currency_code?: string | null;
  readonly last_updated_datetime?: string | null;
}

export interface PlaidAccount {
  readonly account_id: string;
  readonly name: string;
  readonly official_name?: string | null;
  readonly mask?: string | null;
  readonly type: string;
  readonly subtype?: string | null;
  readonly balances: PlaidBalances;
}

export interface PlaidAccountsGetResponse {
  readonly accounts: readonly PlaidAccount[];
  readonly item?: PlaidItem;
  readonly request_id?: string;
}

export interface PlaidPersonalFinanceCategory {
  readonly primary?: string | null;
  readonly detailed?: string | null;
  readonly confidence_level?: string | null;
}

export interface PlaidTransaction {
  readonly transaction_id: string;
  readonly account_id: string;
  /** Plaid convention: positive = money leaving the account. */
  readonly amount: number;
  readonly iso_currency_code?: string | null;
  readonly unofficial_currency_code?: string | null;
  readonly date: string;
  readonly authorized_date?: string | null;
  readonly authorized_datetime?: string | null;
  readonly datetime?: string | null;
  readonly name: string;
  readonly merchant_name?: string | null;
  readonly pending: boolean;
  readonly pending_transaction_id?: string | null;
  readonly payment_channel?: string | null;
  readonly personal_finance_category?: PlaidPersonalFinanceCategory | null;
  readonly category?: readonly string[] | null;
}

export interface PlaidRemovedTransaction {
  readonly transaction_id: string;
  readonly account_id?: string | null;
}

export interface PlaidTransactionsSyncResponse {
  readonly added: readonly PlaidTransaction[];
  readonly modified: readonly PlaidTransaction[];
  readonly removed: readonly PlaidRemovedTransaction[];
  readonly next_cursor: string;
  readonly has_more: boolean;
  readonly accounts?: readonly PlaidAccount[];
  readonly request_id?: string;
}
