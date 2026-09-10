-- Assertions run after migrations + seed on the verification database.
\set ON_ERROR_STOP on

-- 1. Every public table carries user_id (users.id is the user id itself).
do $$
declare bad text;
begin
  select string_agg(t.table_name, ', ') into bad
  from information_schema.tables t
  where t.table_schema = 'public' and t.table_type = 'BASE TABLE' and t.table_name <> 'users'
    and not exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'user_id'
    );
  if bad is not null then raise exception 'tables without user_id: %', bad; end if;
end $$;

-- 2. Every public table has RLS enabled and at least one policy.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and (not c.relrowsecurity or not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname));
  if bad is not null then raise exception 'tables without RLS/policies: %', bad; end if;
end $$;

-- 3. RLS isolates users: the dev user sees seeded rows, another user sees none.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', false);
do $$
declare n int;
begin
  select count(*) into n from public.threads;
  if n < 3 then raise exception 'dev user should see seeded threads, saw %', n; end if;
  select count(*) into n from public.relationships;
  if n < 10 then raise exception 'dev user should see seeded relationships, saw %', n; end if;
end $$;
-- Own writes pass RLS with-check; credential / sync-state / audit columns are server-only.
do $$
declare v_id uuid; n int;
begin
  insert into public.threads (user_id, title) values ('00000000-0000-4000-8000-000000000001', 'own thread') returning id into v_id;
  update public.threads set title = 'own thread (renamed)' where id = v_id;
  select count(*) into n from public.threads where id = v_id and title = 'own thread (renamed)';
  if n <> 1 then raise exception 'dev user could not write own thread'; end if;
  delete from public.threads where id = v_id;
  update public.connector_accounts set label = 'renamed by client' where id = '00000000-0000-4000-8000-0000c0000001';
  update public.connector_sync_states set enabled = false where connector_account_id = '00000000-0000-4000-8000-0000c0000001' and capability = 'calendar';
  update public.connector_sync_states set enabled = true where connector_account_id = '00000000-0000-4000-8000-0000c0000001' and capability = 'calendar';
end $$;
do $$
begin
  update public.connector_accounts set credential_ref = 'planted', credential_location = 'server_vault'
    where id = '00000000-0000-4000-8000-0000c0000001';
  raise exception 'authenticated could write credential_ref';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  insert into public.connector_accounts (user_id, provider, external_account_id, label, credential_ref, credential_location)
    values ('00000000-0000-4000-8000-000000000001', 'mock', 'planted', 'planted', 'planted', 'server_vault');
  raise exception 'authenticated could insert a connector account';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  update public.connector_sync_states set checkpoint = '{"planted":true}'::jsonb
    where connector_account_id = '00000000-0000-4000-8000-0000c0000001' and capability = 'mail';
  raise exception 'authenticated could write a sync checkpoint';
exception when insufficient_privilege then null;
end $$;
do $$
begin
  insert into public.action_requests (user_id, action_type, idempotency_key, status, result)
    values ('00000000-0000-4000-8000-000000000001', 'context_event.dismiss', 'forged', 'done', '{}'::jsonb);
  raise exception 'authenticated could forge an action request';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', false);
do $$
declare n int;
begin
  select count(*) into n from public.threads; if n <> 0 then raise exception 'other user sees % threads', n; end if;
  select count(*) into n from public.people; if n <> 0 then raise exception 'other user sees % people', n; end if;
  select count(*) into n from public.mail_messages; if n <> 0 then raise exception 'other user sees % mail', n; end if;
  select count(*) into n from public.money_transactions; if n <> 0 then raise exception 'other user sees % tx', n; end if;
  select count(*) into n from public.connector_accounts; if n <> 0 then raise exception 'other user sees % accounts', n; end if;
end $$;
-- Child rows cannot reference another user's parents (composite FKs on (user_id, id)).
do $$
declare me uuid := '22222222-2222-4222-8222-222222222222';
begin
  begin
    insert into public.mail_messages (user_id, connector_account_id, external_id, received_at)
      values (me, '00000000-0000-4000-8000-0000c0000001', 'x', now());
    raise exception 'cross-user FK accepted (mail_messages)';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.connector_sync_states (user_id, connector_account_id, capability)
      values (me, '00000000-0000-4000-8000-0000c0000001', 'bank');
    raise exception 'cross-user FK accepted (connector_sync_states)';
  exception when foreign_key_violation or insufficient_privilege then null; end;
  begin
    insert into public.money_transactions (user_id, connector_account_id, money_account_id, external_id, amount, currency, description, posted_on)
      values (me, '00000000-0000-4000-8000-0000c0000002', '00000000-0000-4000-8000-0000a2000001', 'x', 1, 'USD', 'x', current_date);
    raise exception 'cross-user FK accepted (money_transactions)';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.person_identities (user_id, person_id, kind, value, raw_value)
      values (me, '00000000-0000-4000-8000-0000a1000001', 'phone', '+15550000000', '+15550000000');
    raise exception 'cross-user FK accepted (person_identities)';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.handoffs (user_id, source_device_id) values (me, '00000000-0000-4000-8000-0000d0000001');
    raise exception 'cross-user FK accepted (handoffs)';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.context_events (user_id, kind, subject_type, subject_id, title, dedupe_key)
      values (me, 'x', 'person', '00000000-0000-4000-8000-0000a1000001', 'x', 'x');
    raise exception 'cross-user subject accepted (context_events)';
  exception when foreign_key_violation then null; end;
end $$;
-- The other user cannot insert rows for the dev user.
do $$
begin
  insert into public.threads (user_id, title) values ('00000000-0000-4000-8000-000000000001', 'intruder');
  raise exception 'RLS allowed cross-user insert';
exception when insufficient_privilege or check_violation then
  null; -- expected
end $$;
-- Authenticated users cannot call the credential functions.
do $$
begin
  perform public.vx_credential_get(gen_random_uuid());
  raise exception 'authenticated could call vx_credential_get';
exception when insufficient_privilege then null;
end $$;
reset role;
select set_config('request.jwt.claims', '', false);

-- 4. Relationship integrity: dangling targets are rejected, self-edges rejected, dedupe works.
do $$
declare v_uid uuid := '00000000-0000-4000-8000-000000000001';
        v_first uuid; v_second uuid; n int;
begin
  begin
    insert into public.relationships (user_id, from_type, from_id, kind, to_type, to_id)
      values (v_uid, 'person', '00000000-0000-4000-8000-0000a1000001', 'relates_to', 'document', gen_random_uuid());
    raise exception 'dangling relationship accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.relationships (user_id, from_type, from_id, kind, to_type, to_id)
      values (v_uid, 'person', '00000000-0000-4000-8000-0000a1000001', 'relates_to', 'person', '00000000-0000-4000-8000-0000a1000001');
    raise exception 'self relationship accepted';
  exception when check_violation then null;
  end;
  v_first := public.vx_relate(v_uid, 'person', '00000000-0000-4000-8000-0000a1000002', 'relates_to', 'document', '00000000-0000-4000-8000-0000f1000002', 0.5, 'rule');
  v_second := public.vx_relate(v_uid, 'person', '00000000-0000-4000-8000-0000a1000002', 'relates_to', 'document', '00000000-0000-4000-8000-0000f1000002', 0.9, 'rule');
  if v_first <> v_second then raise exception 'vx_relate not idempotent'; end if;
  select count(*) into n from public.vx_neighbors(v_uid, 'thread', '00000000-0000-4000-8000-0000b1000001');
  if n < 2 then raise exception 'expected neighbors of Brand thread, got %', n; end if;
  -- Deleting the document removes its edges and events.
  delete from public.documents where id = '00000000-0000-4000-8000-0000f1000002';
  select count(*) into n from public.relationships where to_type = 'document' and to_id = '00000000-0000-4000-8000-0000f1000002';
  if n <> 0 then raise exception 'edges survived entity delete'; end if;
  select count(*) into n from public.conclusions where subject_type = 'document' and subject_id = '00000000-0000-4000-8000-0000f1000002';
  if n <> 0 then raise exception 'conclusions survived entity delete'; end if;
end $$;

-- 5. Idempotent upserts by natural key (what the sync engine relies on).
do $$
declare n int;
begin
  insert into public.mail_messages (user_id, connector_account_id, external_id, received_at, subject)
    values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000c0000001', 'mock-msg-1', now(), 'dup')
    on conflict (user_id, connector_account_id, external_id) do update set subject = excluded.subject;
  select count(*) into n from public.mail_messages where external_id = 'mock-msg-1';
  if n <> 1 then raise exception 'mail upsert duplicated rows'; end if;
  insert into public.context_events (user_id, kind, subject_type, subject_id, title, dedupe_key)
    values ('00000000-0000-4000-8000-000000000001', 'mail.received', 'mail_message', '00000000-0000-4000-8000-0000e1000001', 'again', 'seed:mail-1')
    on conflict (user_id, dedupe_key) do nothing;
  select count(*) into n from public.context_events where dedupe_key = 'seed:mail-1';
  if n <> 1 then raise exception 'context event dedupe failed'; end if;
end $$;

-- 6. Polymorphic subjects are validated (context_events, conclusions, handoffs.focus).
do $$
declare v_uid uuid := '00000000-0000-4000-8000-000000000001';
begin
  begin
    insert into public.context_events (user_id, kind, subject_type, subject_id, title, dedupe_key)
      values (v_uid, 'x', 'document', gen_random_uuid(), 'dangling', 'verify:dangling-ce');
    raise exception 'dangling context_event subject accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.conclusions (user_id, subject_type, subject_id, text, produced_by)
      values (v_uid, 'thread', gen_random_uuid(), 'dangling', 'rule:verify');
    raise exception 'dangling conclusion subject accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.handoffs (user_id, source_device_id, focus_type, focus_id)
      values (v_uid, '00000000-0000-4000-8000-0000d0000001', 'document', gen_random_uuid());
    raise exception 'dangling handoff focus accepted';
  exception when foreign_key_violation then null; end;
  insert into public.handoffs (user_id, source_device_id, focus_type, focus_id)
    values (v_uid, '00000000-0000-4000-8000-0000d0000001', 'document', '00000000-0000-4000-8000-0000f1000001');
end $$;

-- 7. Credential functions execute for the service role and are bound to accounts.
set role service_role;
do $$
declare v_ref uuid; v_other uuid; v_json jsonb; v_row_ref text;
begin
  v_ref := public.vx_credential_put('00000000-0000-4000-8000-0000c0000001', '{"kind":"api_key","apiKey":"verify-only"}'::jsonb);
  select credential_ref into v_row_ref from public.connector_accounts where id = '00000000-0000-4000-8000-0000c0000001';
  if v_row_ref is distinct from v_ref::text then raise exception 'credential_ref not set on account'; end if;
  v_json := public.vx_credential_get(v_ref);
  if v_json ->> 'apiKey' <> 'verify-only' then raise exception 'credential round-trip failed'; end if;
  if public.vx_credential_get(gen_random_uuid()) is not null then raise exception 'unbound ref readable'; end if;
  v_other := public.vx_credential_put('00000000-0000-4000-8000-0000c0000002', '{"kind":"api_key","apiKey":"other"}'::jsonb);
  begin
    perform public.vx_credential_put('00000000-0000-4000-8000-0000c0000001', '{"kind":"api_key","apiKey":"steal"}'::jsonb, v_other);
    raise exception 'put accepted a ref of another account';
  exception when invalid_parameter_value then null; end;
  if (public.vx_credential_get(v_other) ->> 'apiKey') <> 'other' then raise exception 'other account secret was altered'; end if;
  perform public.vx_credential_put('00000000-0000-4000-8000-0000c0000001', '{"kind":"api_key","apiKey":"rotated"}'::jsonb, v_ref);
  if (public.vx_credential_get(v_ref) ->> 'apiKey') <> 'rotated' then raise exception 'rotation failed'; end if;
  perform public.vx_connector_account_disconnect('00000000-0000-4000-8000-0000c0000001');
  if public.vx_credential_get(v_ref) is not null then raise exception 'secret survived disconnect'; end if;
  select credential_ref into v_row_ref from public.connector_accounts where id = '00000000-0000-4000-8000-0000c0000001';
  if v_row_ref is not null then raise exception 'credential_ref survived disconnect'; end if;
  perform public.vx_credential_delete(v_other);
end $$;
reset role;

select 'verify.sql: all assertions passed' as result;
