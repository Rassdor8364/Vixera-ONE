/**
 * Realtime: one channel per signed-in user over `postgres_changes` for the
 * tables the Field reacts to. Every change calls `onChange`; the hooks
 * refresh their reads. RLS applies to subscriptions, and the filter keeps
 * the channel to the user's own rows.
 */
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

export const REALTIME_TABLES = ["context_events", "handoffs", "connector_accounts", "connector_sync_states", "ingest_items", "threads"] as const;
export type RealtimeTable = (typeof REALTIME_TABLES)[number];

export type RealtimeStatus = "connecting" | "live" | "offline";

export interface RealtimeChange {
  readonly table: RealtimeTable;
  readonly event: "INSERT" | "UPDATE" | "DELETE" | string;
  readonly row: Record<string, unknown> | null;
}

export interface RealtimeSubscription {
  readonly unsubscribe: () => Promise<void>;
}

export function subscribeRealtime(
  client: SupabaseClient,
  userId: string,
  onChange: (change: RealtimeChange) => void,
  onStatus: (status: RealtimeStatus) => void = () => {},
): RealtimeSubscription {
  let channel: RealtimeChannel = client.channel(`field:${userId}`);
  for (const table of REALTIME_TABLES) {
    channel = channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table, filter: `user_id=eq.${userId}` },
      (payload: { eventType: string; new: Record<string, unknown> | null; old: Record<string, unknown> | null }) => {
        onChange({ table, event: payload.eventType, row: payload.new && Object.keys(payload.new).length ? payload.new : payload.old });
      },
    );
  }
  onStatus("connecting");
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") onStatus("live");
    else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") onStatus("offline");
  });
  return {
    unsubscribe: async () => {
      await client.removeChannel(channel);
    },
  };
}
