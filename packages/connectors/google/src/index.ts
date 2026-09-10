/**
 * @vixera/connector-google — Gmail + Google Calendar behind the domain
 * `Connector` interface. Provider schemas stop here; consumers only see
 * normalized domain objects and opaque checkpoints.
 */
export { GoogleConnector, GOOGLE_USERINFO_ENDPOINT, type GoogleConnectorOptions } from "./connector.ts";
export {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type AuthorizationUrlOptions,
  type GoogleOAuthConfig,
} from "./oauth.ts";
export { GoogleApiClient, type ApiContext, type ApiResponse } from "./http.ts";
export { normalizeGmailMessage, decodeBase64Url, htmlToText, parseRfc2822Date, GMAIL_UNREAD_LABEL, MAX_BODY_CHARS } from "./gmail/normalize.ts";
export { syncMail, parseGmailCheckpoint, GMAIL_API, type GmailCheckpoint, type GmailBackfillState, type GmailSyncOptions } from "./gmail/sync.ts";
export { normalizeGoogleEvent, UNTITLED_EVENT } from "./calendar/normalize.ts";
export {
  syncCalendar,
  parseCalendarCheckpoint,
  selectCalendars,
  CALENDAR_API,
  type CalendarWindow,
  type CalendarSyncOptions,
  type GoogleCalendarCheckpoint,
} from "./calendar/sync.ts";
