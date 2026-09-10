-- The live stack grants ALL on every table to the Supabase roles the way the
-- hosted platform's default privileges do; this file re-applies the deliberate
-- revokes from migration 2 so the integration test sees production privileges.
revoke insert, update, delete on public.action_requests from authenticated;
revoke insert, update, delete on public.connector_accounts from authenticated;
grant update (label, status, metadata) on public.connector_accounts to authenticated;
revoke insert, update, delete on public.connector_sync_states from authenticated;
grant update (enabled) on public.connector_sync_states to authenticated;
revoke all on function public.vx_credential_put(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.vx_credential_get(uuid) from public, anon, authenticated;
revoke all on function public.vx_credential_delete(uuid) from public, anon, authenticated;
revoke all on function public.vx_connector_account_disconnect(uuid) from public, anon, authenticated;

-- Live-stack only (never in a migration): public.users.id references
-- auth.users, which the real Supabase auth service owns. The integration test
-- needs to mint users, so expose a helper the service role can call.
create or replace function public.vx_test_create_user(p_id uuid, p_name text default 'Conformance user')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values (p_id, 'authenticated', 'authenticated', p_id::text || '@conformance.local', now(), now())
  on conflict (id) do nothing;
  insert into public.users (id, display_name) values (p_id, p_name) on conflict (id) do nothing;
  return p_id;
end;
$$;
revoke all on function public.vx_test_create_user(uuid, text) from public, anon, authenticated;
grant execute on function public.vx_test_create_user(uuid, text) to service_role;
