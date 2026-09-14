-- Vixera One — migration 9: Realtime DELETE events carry no row.
--
-- Supabase Realtime applies RLS to INSERT and UPDATE events but not to DELETE
-- events: every subscriber of a published table receives every delete, and the
-- payload is the old row as far as the table's replica identity exposes it.
-- Migrations 4 and 7 set `replica identity full` on handoffs, context_events
-- and connector_accounts so a user_id filter could match the old row — which
-- meant a deleted row's full content (a handoff's conclusions, a context
-- event's summary, an account's label and status) was broadcast to every
-- authenticated client subscribed to the table, whoever owned it.
--
-- Default identity: a DELETE event carries only the primary key. A client's
-- `user_id=eq.<me>` filter cannot match that, so filtered channels receive no
-- DELETE events at all; a deletion surfaces on the next read (the Field
-- re-reads on every other change and on launch). INSERT and UPDATE events
-- carry the full new row regardless of replica identity, so the filter and
-- RLS keep working for those.
alter table public.handoffs replica identity default;
alter table public.context_events replica identity default;
alter table public.connector_accounts replica identity default;
