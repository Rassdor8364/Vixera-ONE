-- Vixera One — migration 5: scheduled connector sync.
--
-- pg_cron calls the `connector-sync` Edge Function through pg_net every ten
-- minutes. The function URL and the shared sync secret are read from Vault so
-- that nothing sensitive is in this file. Set them once per project:
--
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'vixera_functions_url');
--   select vault.create_secret('<random 32+ char secret>', 'vixera_sync_secret');
--   supabase secrets set VIXERA_SYNC_SECRET=<same secret>
--
-- Locally (supabase start) pg_cron and pg_net are available; on a plain
-- Postgres the block below is a no-op.

create or replace function public.vx_trigger_scheduled_sync()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'vixera_functions_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'vixera_sync_secret';
  if v_url is null or v_secret is null then
    raise notice 'vixera: scheduled sync skipped, vault secrets vixera_functions_url / vixera_sync_secret not set';
    return;
  end if;
  perform net.http_post(
    url := v_url || '/connector-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Vixera-Sync-Secret', v_secret),
    body := jsonb_build_object('mode', 'scheduled'),
    timeout_milliseconds := 60000
  );
end;
$$;
revoke all on function public.vx_trigger_scheduled_sync() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    perform cron.schedule('vixera-connector-sync', '*/10 * * * *', $job$ select public.vx_trigger_scheduled_sync(); $job$);
  end if;
end;
$$;
