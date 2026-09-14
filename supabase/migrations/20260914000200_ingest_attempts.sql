-- Vixera One — migration 10: ingest items count their processing runs.
--
-- The pipeline used to mark an item `failed` on any error, so a PostgREST
-- hiccup during processing became a permanent failure the person had to
-- re-share to get past. A transient failure now leaves the item `received`
-- (retried by the next ingest-process run) and increments this counter; after
-- MAX_INGEST_ATTEMPTS (see supabase/functions/_shared/ingest.ts) it is failed
-- for real, so a persistently failing item cannot be retried forever.
alter table public.ingest_items
  add column attempts integer not null default 0 check (attempts >= 0);
comment on column public.ingest_items.attempts is 'processing runs so far; bounded by the pipeline, never by a client';
