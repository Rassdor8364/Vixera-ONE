/**
 * @vixera/connector-microsoft — Microsoft Graph mail + calendar connector.
 *
 * Public surface:
 *   - `MicrosoftConnector` (implements `Connector`; provider "microsoft",
 *     capabilities mail + calendar)
 *   - OAuth helpers for the link flow (`buildAuthorizationUrl`,
 *     `exchangeAuthorizationCode`, `refreshAccessToken`, `MICROSOFT_SCOPES`)
 *   - normalizers and checkpoint parsers for tests and tooling
 *
 * Everything else (Graph resource shapes, HTTP client) is internal: provider
 * schemas stop at this package boundary.
 */
export { MicrosoftConnector, GRAPH_ME_ENDPOINT, type MicrosoftConnectorOptions } from "./connector.ts";
export {
  MICROSOFT_SCOPES,
  MICROSOFT_LOGIN_HOST,
  DEFAULT_TENANT,
  authorizationEndpoint,
  tokenEndpoint,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type MicrosoftOAuthConfig,
  type AuthorizationUrlOptions,
} from "./oauth.ts";
export { GRAPH_API, GraphRateLimitedError, graphUrl, parseRetryAfter } from "./http.ts";
export { normalizeGraphMessage, normalizeAttachments, MAX_BODY_CHARS } from "./mail/normalize.ts";
export { parseMailCheckpoint, initialMailDeltaUrl, MAIL_DELTA_SELECT, type MailCheckpoint } from "./mail/sync.ts";
export { normalizeGraphEvent, toInstant, toResponse, toStatus, PRIMARY_CALENDAR_ID, UNTITLED_EVENT, type NormalizeEventOptions } from "./calendar/normalize.ts";
export {
  parseCalendarCheckpoint,
  initialCalendarDeltaUrl,
  isWindowStale,
  openWindow,
  CALENDAR_DELTA_SELECT,
  WINDOW_MAX_AGE_DAYS,
  type CalendarCheckpoint,
  type CalendarWindow,
} from "./calendar/sync.ts";
export { htmlToText, decodeEntities } from "./html.ts";
