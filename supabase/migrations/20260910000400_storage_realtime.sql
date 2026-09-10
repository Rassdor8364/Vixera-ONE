-- Vixera One — migration 4: Storage bucket for synchronized artifacts and
-- Realtime publication for the tables devices subscribe to.
--
-- Storage is used only where Vixera itself needs synchronized payloads
-- (handoff artifacts, ingested files). Praxion's own persistence is not here.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('artifacts', 'artifacts', false, 104857600)
    on conflict (id) do nothing;

    -- Objects live under <user_id>/... ; a user can only touch their own folder.
    execute $p$
      create policy artifacts_owner_select on storage.objects for select to authenticated
        using (bucket_id = 'artifacts' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
    execute $p$
      create policy artifacts_owner_insert on storage.objects for insert to authenticated
        with check (bucket_id = 'artifacts' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
    execute $p$
      create policy artifacts_owner_update on storage.objects for update to authenticated
        using (bucket_id = 'artifacts' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
    execute $p$
      create policy artifacts_owner_delete on storage.objects for delete to authenticated
        using (bucket_id = 'artifacts' and (storage.foldername(name))[1] = (select auth.uid())::text)
    $p$;
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.context_events,
      public.handoffs,
      public.threads,
      public.ingest_items,
      public.connector_sync_states,
      public.action_requests;
  end if;
end;
$$;

-- Realtime respects RLS; make sure updates carry enough columns for filters.
alter table public.handoffs replica identity full;
alter table public.context_events replica identity full;
