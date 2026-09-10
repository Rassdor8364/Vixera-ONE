/**
 * `MicrosoftConnector`: one Microsoft account (personal or work/school) =
 * Outlook mail (mail) + Outlook calendar (calendar) through Microsoft Graph.
 * Stateless across accounts; every call gets a `SyncContext` carrying the
 * account and its credential, so one instance serves any number of linked
 * Microsoft accounts.
 *
 * All HTTP goes through `ctx.fetch`; the OAuth client secret lives only in the
 * `oauth` config passed at construction (server configuration) and is never
 * persisted or logged.
 *
 * Error policy (shared by every request via `GraphApiClient`):
 *   401 → refresh the credential once and retry; still 401 → `unauthorized`
 *   429 → `rate_limited` (Retry-After exposed as metadata, never slept on)
 *   5xx → `provider_unavailable`
 */
import type { CalendarSyncBatch, Checkpoint, Connector, ConnectorCapability, ConnectorCredential, DiscoveredAccount, JsonObject, MailSyncBatch, ProviderId, SyncContext, SyncPage } from "@vixera/domain";
import { ConnectorError, normalizeEmail } from "@vixera/domain";
import { syncCalendar, type CalendarWindow } from "./calendar/sync.ts";
import { GRAPH_API, GraphApiClient, graphUrl, type ApiContext } from "./http.ts";
import { syncMail } from "./mail/sync.ts";
import { refreshAccessToken, type MicrosoftOAuthConfig } from "./oauth.ts";

export const GRAPH_ME_ENDPOINT = graphUrl(`${GRAPH_API}/me`, { $select: "id,mail,userPrincipalName,displayName" });

export interface MicrosoftConnectorOptions {
  readonly oauth: MicrosoftOAuthConfig;
  /** Initial mail backfill window in days. Default 30. */
  readonly backfillDays?: number;
  /** Calendar window around "now". Default 30 days back, 90 days ahead. */
  readonly calendarWindow?: CalendarWindow;
  /** Delta page size (`Prefer: odata.maxpagesize`). Default 50. */
  readonly pageSize?: number;
}

/** Graph `user` resource, only the fields we select (provider schema, stays here). */
interface GraphUser {
  readonly id?: string;
  readonly mail?: string | null;
  readonly userPrincipalName?: string | null;
  readonly displayName?: string | null;
}

export class MicrosoftConnector implements Connector {
  readonly provider: ProviderId = "microsoft";
  readonly capabilities: readonly ConnectorCapability[] = ["mail", "calendar"];

  private readonly oauth: MicrosoftOAuthConfig;
  private readonly backfillDays: number;
  private readonly calendarWindow: CalendarWindow;
  private readonly pageSize: number;

  constructor(options: MicrosoftConnectorOptions) {
    this.oauth = options.oauth;
    this.backfillDays = options.backfillDays ?? 30;
    this.calendarWindow = options.calendarWindow ?? { pastDays: 30, futureDays: 90 };
    this.pageSize = options.pageSize ?? 50;
  }

  async discoverAccount(ctx: ApiContext): Promise<DiscoveredAccount> {
    const client = new GraphApiClient(ctx, this.oauth);
    const res = await client.getJson<GraphUser>(GRAPH_ME_ENDPOINT);
    const user = res.body;
    if (!user?.id) throw new ConnectorError("invalid_response", "Microsoft Graph /me returned no user id", false);
    const rawAddress = user.mail?.trim() || user.userPrincipalName?.trim() || null;
    const address = rawAddress ? (normalizeEmail(rawAddress) ?? rawAddress.toLowerCase()) : null;
    const displayName = user.displayName?.trim() || null;
    const label = displayName && address ? `${displayName} (${address})` : (displayName ?? address ?? `microsoft:${user.id}`);
    const metadata: JsonObject = {};
    if (displayName) metadata.displayName = displayName;
    if (user.userPrincipalName) metadata.userPrincipalName = user.userPrincipalName;
    if (this.oauth.tenant) metadata.tenant = this.oauth.tenant;
    return { externalAccountId: user.id, label, address, capabilities: this.capabilities, metadata };
  }

  refreshCredential(ctx: ApiContext): Promise<ConnectorCredential> {
    return refreshAccessToken(ctx.fetch, this.oauth, ctx.credential, ctx.now);
  }

  syncMail(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<MailSyncBatch>> {
    return syncMail(ctx, checkpoint, { oauth: this.oauth, backfillDays: this.backfillDays, pageSize: this.pageSize });
  }

  syncCalendar(ctx: SyncContext, checkpoint: Checkpoint | null): AsyncIterable<SyncPage<CalendarSyncBatch>> {
    return syncCalendar(ctx, checkpoint, { oauth: this.oauth, window: this.calendarWindow, pageSize: this.pageSize });
  }
}
