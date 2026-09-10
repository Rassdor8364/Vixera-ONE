/**
 * @vixera/connector-bank — READ-ONLY bank connector.
 *
 * `BankConnector` implements the domain `Connector` (capability "bank") over
 * a provider-neutral `BankProvider`; `PlaidBankProvider` is the Phase 1
 * aggregator adapter and `MockBankProvider` serves development and tests.
 * Provider schemas stop inside `src/plaid/`; consumers only see normalized
 * domain objects and an opaque `{ cursor }` checkpoint. Nothing exported here
 * can move money.
 */
export type { BankItemDescription, BankProvider, BankProviderContext, BankProviderId, BankTransactionsPage } from "./provider.ts";
export { BankPaginationMutationError, toProviderContext } from "./provider.ts";
export { BANK_CAPABILITIES, BankConnector, readBankCheckpoint, type BankCheckpoint, type BankConnectorOptions } from "./connector.ts";
export {
  DEFAULT_TRANSACTIONS_PAGE_SIZE,
  PLAID_READ_ENDPOINTS,
  PlaidClient,
  PlaidMutationDuringPaginationError,
  mapPlaidError,
  type CreateLinkTokenInput,
  type ExchangedToken,
  type LinkToken,
  type PlaidConfig,
  type PlaidEnvironment,
  type PlaidReadEndpoint,
} from "./plaid/client.ts";
export { PlaidBankProvider, type PlaidBankProviderOptions } from "./plaid/provider.ts";
export { mapAccountType } from "./plaid/normalize.ts";
export {
  MOCK_ACCOUNTS,
  MOCK_CHECKING_ACCOUNT_ID,
  MOCK_INSTITUTION_NAME,
  MOCK_ITEM_ID,
  MOCK_TRANSACTIONS,
  MockBankProvider,
  type MockBankProviderOptions,
  type MockFailure,
} from "./mock/provider.ts";
export {
  BANK_LINK_CLIENT_NAME,
  bankLinkFlow,
  beginBankLink,
  completeBankLink,
  createPlaidBankConnector,
  type BankLinkFlow,
  type BeginBankLinkInput,
  type CompleteBankLinkDeps,
  type CompleteBankLinkInput,
  type CompletedBankLink,
} from "./link.ts";
export { canonicalDecimal, decimalFromNumber, negateDecimal } from "./decimal.ts";
