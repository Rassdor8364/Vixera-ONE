-- Vixera One — migration 3: per-account credential storage in Supabase Vault.
--
-- Connector tokens never sit in source, .env, plain JSON or unencrypted rows.
-- Server-side credentials live in Vault (encrypted at rest); the account row
-- keeps only an opaque `credential_ref`. Only the service role can call these
-- functions. Devices keep their own secrets in the platform keychain
-- (docs/credentials.md).

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    create extension if not exists supabase_vault;
  end if;
end;
$$;

-- Stores (or replaces) the credential for a connector account. Returns the Vault id.
create or replace function public.vx_credential_put(p_account_id uuid, p_secret jsonb, p_ref uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_ref uuid;
  v_name text;
begin
  select user_id into v_user_id from public.connector_accounts where id = p_account_id;
  if v_user_id is null then
    raise exception 'connector account % not found', p_account_id using errcode = 'no_data_found';
  end if;
  v_name := 'vixera:connector_account:' || p_account_id::text;

  if p_ref is null then
    select id into v_ref from vault.secrets where name = v_name;
    if v_ref is null then
      v_ref := vault.create_secret(p_secret::text, v_name, 'Vixera One connector credential');
    else
      perform vault.update_secret(v_ref, p_secret::text, v_name, 'Vixera One connector credential');
    end if;
  else
    -- An explicit ref must already be the ref of THIS account; never rename
    -- another account's secret.
    if not exists (select 1 from public.connector_accounts where id = p_account_id and credential_ref = p_ref::text) then
      raise exception 'credential ref % does not belong to connector account %', p_ref, p_account_id
        using errcode = 'invalid_parameter_value';
    end if;
    v_ref := p_ref;
    perform vault.update_secret(v_ref, p_secret::text, v_name, 'Vixera One connector credential');
  end if;

  update public.connector_accounts
    set credential_ref = v_ref::text, credential_location = 'server_vault'
    where id = p_account_id;
  return v_ref;
end;
$$;

create or replace function public.vx_credential_get(p_ref uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret text;
begin
  -- Only secrets bound to a connector account can be read through this door.
  if not exists (select 1 from public.connector_accounts where credential_ref = p_ref::text) then
    return null;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets
    where id = p_ref and name like 'vixera:connector_account:%';
  if v_secret is null then
    return null;
  end if;
  return v_secret::jsonb;
end;
$$;

create or replace function public.vx_credential_delete(p_ref uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.connector_accounts where credential_ref = p_ref::text) then
    return;
  end if;
  delete from vault.secrets where id = p_ref and name like 'vixera:connector_account:%';
  update public.connector_accounts
    set credential_ref = null, credential_location = 'none'
    where credential_ref = p_ref::text;
end;
$$;

revoke all on function public.vx_credential_put(uuid, jsonb, uuid) from public, anon, authenticated;
revoke all on function public.vx_credential_get(uuid) from public, anon, authenticated;
revoke all on function public.vx_credential_delete(uuid) from public, anon, authenticated;
grant execute on function public.vx_credential_put(uuid, jsonb, uuid) to service_role;
grant execute on function public.vx_credential_get(uuid) to service_role;
grant execute on function public.vx_credential_delete(uuid) to service_role;

-- Server-only maintenance helper: disconnect an account and drop its credential.
create or replace function public.vx_connector_account_disconnect(p_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref text;
begin
  select credential_ref into v_ref from public.connector_accounts where id = p_account_id;
  if v_ref is not null then
    perform public.vx_credential_delete(v_ref::uuid);
  end if;
  update public.connector_accounts set status = 'disconnected' where id = p_account_id;
  update public.connector_sync_states set enabled = false where connector_account_id = p_account_id;
end;
$$;
revoke all on function public.vx_connector_account_disconnect(uuid) from public, anon, authenticated;
grant execute on function public.vx_connector_account_disconnect(uuid) to service_role;
