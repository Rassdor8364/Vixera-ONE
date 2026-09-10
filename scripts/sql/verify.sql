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
  select count(*) into n from public.vx_neighbors('thread', '00000000-0000-4000-8000-0000b1000001');
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

select 'verify.sql: all assertions passed' as result;
