/**
 * `GoogleConnector`: one Google account = Gmail (mail) + Google Calendar
 * (calendar). Stateless across accounts; every call gets a `SyncContext`
 * carrying the account and its credential, so one instance serves any number
 * of linked Google accounts.
 *
 * All HTTP goes through `ctx.fetch`; the OAuth client secret lives only in
 * the `oauth` config passed at construction (server configuration) and is
 * never persisted or logged.
 */
import type { CalendarSyncBatch, Checkpoint, Connector, ConnectorCapability, ConnectorCredential, DiscoveredAccount, MailSyncBatch, ProviderId, SyncContext, SyncPage } from "@vixera/domain";
import { ConnectorError } from "@vixera/domain";
import { syncCalendar, type CalendarWindow } from "./calendar/sync.ts";
import { syncMail } from "./gmail/sync.ts";
import { GoogleApiClient, type ApiContext } from "./http.ts";
import { refreshAccessToken, type GoogleOAuthConfig } from "./oauth.ts";

export const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

export interface GoogleConnectorOptions {
  readonly oauth: GoogleOAuthConfig;
  /** Initial mail backfill window in days. Default 30. */
  readonly backfillDays?: number;
  /** Initial calendar window. Default 30 days back, 90 days ahead. */
  readonly calendarWindow?: CalendarWindow;
  /** Parallel message fetches during mail sync. Default 4. */
  readonly concurrency?: number;
}

/** OpenID userinfo response (provider schema, stays here). */
interface GoogleUserInfo {
  readonly sub?: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly picture?: string;
  readonly hd?: string;
}

/**
 * Which capabilities a set of granted scopes covers. Google's consent screen
 * lets the user untick individual scopes, so the grant can be narrower than
 * `GOOGLE_SCOPES`; broader scopes (full mail, read/write calendar) count too.
 * Returns null when the credential carries no scope information at all.
 */
export function capabilitiesForScopes(scopes: readonly string[]): ConnectorCapability[] | null {
  if (scopes.length === 0) return null;
  const out: ConnectorCapability[] = [];
  if (scopes.some((s) => /^https:\/\/mail\.google\.com\/?$/.test(s) || /\/auth\/gmail\.(readonly|modify|metadata)$/.test(s))) out.push("mail");
  if (scopes.some((s) => /\/auth\/calendar(\.readonly|\.events|\.events\.readonly)?$/.test(s))) out.push("calendar");
  return out;
}

export class GoogleConnector implements Connector {
  readonly provider: ProviderId = "google";
  readonly capabilities: readonly ConnectorCapability[] = ["mail", "calendar"];

  private readonly oauth: GoogleOAuthConfig;
  private readonly backfillDays: number;
  private readonly calendarWindow: CalendarWindow;
  private readonly concurrency: number;

  constructor(options: GoogleConnectorOptions) {
    this.oauth = options.oauth;
    this.backfillDays = options.backfillDays ?? 30;
    this.calendarWindow = options.calendarWindow ?? { pastDays: 30, futureDays: 90 };
    this.concurrency = options.concurrency ?? 4;
  }

  async discoverAccount(ctx: ApiContext): Promise<DiscoveredAccount> {
    const client = new GoogleApiClient(ctx, this.oauth);
    const res = await client.getJson<GoogleUserInfo>(GOOGLE_USERINFO_ENDPOINT);
    const info = res.body;
    if (!info?.sub) throw new ConnectorError("invalid_response", "Google userinfo returned no subject", false);
    const email = info.email?.trim().toLowerCase() ?? null;
    const metadata: Record<string, string | boolean> = {};
    if (info.name) metadata.name = info.name;
    if (info.hd) metadata.hostedDomain = info.hd;
    if (typeof info.email_verified === "boolean") metadata.emailVerified = info.email_verified;
    // The account feeds exactly what the user granted. Claiming mail on a
    // calendar-only grant made the first Gmail call fail and the engine mark
    // the whole account needs_reauth, which also stopped the valid calendar.
    // A credential without scope information (Google omits `scope` on some
    // responses) cannot narrow the set, so it keeps the connector's full one.
    const granted = client.credential.kind === "oauth2" ? capabilitiesForScopes(client.credential.scopes) : null;
    const capabilities = granted === null ? this.capabilities : this.capabilities.filter((c) => granted.includes(c));
    if (capabilities.length === 0) {
      throw new ConnectorError("unsupported", "Google grant includes neither Gmail nor Calendar access; re-link and allow at least one", false);
    }
    return {
      externalAccountId: info.sub,
      label: email ?? info.name ?? `google:${info.sub}`,
      address: email,
      capabilities,
      metadata,
    };
  }

  refreshCredential(ctx: ApiContext): Promise<ConnectorCredential> {
    return refreshAccessToken(ctx.fetch, this.oauth, ctx.credential, ctx.now);
  }

  syncMail(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<MailSyncBatch>> {
    return syncMail(ctx, checkpoint, { oauth: this.oauth, backfillDays: this.backfillDays, concurrency: this.concurrency });
  }

  syncCalendar(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<CalendarSyncBatch>> {
    return syncCalendar(ctx, checkpoint, { oauth: this.oauth, window: this.calendarWindow });
  }
}
