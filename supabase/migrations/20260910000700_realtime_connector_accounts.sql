-- Vixera One — migration 7: devices watch their connector accounts.
-- The Field waits for an OAuth / Plaid link completed in the system browser by
-- subscribing to connector_accounts changes (RLS applies to the subscription).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.connector_accounts;
  end if;
end;
$$;
alter table public.connector_accounts replica identity full;
