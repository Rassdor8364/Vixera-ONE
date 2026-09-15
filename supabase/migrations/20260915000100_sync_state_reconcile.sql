-- Vixera One — migration 12: a full resync in progress is remembered.
--
-- When a provider invalidates a checkpoint the engine re-lists from scratch
-- and upserts by natural key; rows the provider removed while the checkpoint
-- was dead were never mentioned again and stayed (ADR-017). The engine now
-- reconciles: it records, per listing unit (a mail window, one calendar inside
-- its window, a whole bank Item), when the from-scratch listing began and what
-- it covers (`[{ since, scope }]`, the connector-declared scope), and when the
-- pass completes it deletes the rows of that capability inside each unit's
-- scope whose updated_at is older than that unit's `since` — every row the
-- listing touched carries a newer one, since the updated_at triggers stamp
-- every upsert. Persisted here so a pass the run budget splits across runs
-- still reconciles.
alter table public.connector_sync_states add column reconcile jsonb;
comment on column public.connector_sync_states.reconcile is 'full resync in progress: [{ since, scope }] per listing unit; cleared when the pass completes';
