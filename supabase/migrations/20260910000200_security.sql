-- Vixera One — migration 2: Row Level Security.
--
-- There is one user today. Security still matters: every table is RLS-enabled
-- and every policy is user_id aware. The service role (Edge Functions, cron)
-- bypasses RLS by design and must scope its own queries by user_id.

alter table public.users enable row level security;
alter table public.devices enable row level security;
alter table public.connector_accounts enable row level security;
alter table public.connector_sync_states enable row level security;
alter table public.people enable row level security;
alter table public.person_identities enable row level security;
alter table public.threads enable row level security;
alter table public.documents enable row level security;
alter table public.mail_messages enable row level security;
alter table public.money_accounts enable row level security;
alter table public.money_transactions enable row level security;
alter table public.time_events enable row level security;
alter table public.context_events enable row level security;
alter table public.conclusions enable row level security;
alter table public.ingest_items enable row level security;
alter table public.handoffs enable row level security;
alter table public.action_requests enable row level security;
alter table public.relationships enable row level security;

-- users: a user sees and edits only their own profile row; creation is by trigger.
create policy users_select_own on public.users
  for select to authenticated using (id = (select auth.uid()));
create policy users_update_own on public.users
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Generic owner policies. Written out per table (no dynamic SQL) so that
-- `supabase db diff` and reviewers see exactly what is enforced.
create policy devices_owner on public.devices for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy connector_accounts_owner on public.connector_accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy connector_sync_states_owner on public.connector_sync_states for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy people_owner on public.people for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy person_identities_owner on public.person_identities for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy threads_owner on public.threads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy documents_owner on public.documents for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy mail_messages_owner on public.mail_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy money_accounts_owner on public.money_accounts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy money_transactions_owner on public.money_transactions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy time_events_owner on public.time_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy context_events_owner on public.context_events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy conclusions_owner on public.conclusions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ingest_items_owner on public.ingest_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy handoffs_owner on public.handoffs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy relationships_owner on public.relationships for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- action_requests: clients read their own audit trail. Rows are created and
-- transitioned only by the server (action-dispatch, service role): the client
-- submits an ActionEnvelope over HTTPS, never a row.
create policy action_requests_select_own on public.action_requests
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.action_requests from authenticated;

-- Connector accounts are created and linked by the server (connector-link) and
-- disconnected by the server (vx_connector_account_disconnect). A column-level
-- REVOKE is a no-op while Supabase's table-level default grant stands, so the
-- table-level write privileges are dropped and only the columns a client may
-- edit are granted back. RLS (connector_accounts_owner) still scopes updates.
revoke insert, update, delete on public.connector_accounts from authenticated;
grant update (label, status, metadata) on public.connector_accounts to authenticated;

-- Sync state (cursor, status, errors) is written by the engine only; a client may
-- pause a capability.
revoke insert, update, delete on public.connector_sync_states from authenticated;
grant update (enabled) on public.connector_sync_states to authenticated;

-- Anonymous callers get nothing. (Supabase grants table privileges to anon by
-- default; with no policies for anon, RLS denies every row.)
