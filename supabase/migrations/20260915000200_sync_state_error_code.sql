-- Vixera One — migration 13: the sync state remembers what kind of failure it holds.
--
-- The engine backs a failed capability off exponentially from 10 minutes. A
-- failure the connector marks non-retryable (a declined scope, a body the
-- normalizer cannot read, a checkpoint rejected twice) repeats identically on
-- every probe, so the engine now holds such a state for the full backoff cap
-- at once instead of probing it every ten minutes; that needs the
-- retryability persisted next to the message. The code is stored with it so
-- the Field can name the failure without parsing text. Both are null after a
-- success; a row written before this migration reads as retryable.
alter table public.connector_sync_states
  add column last_error_code text,
  add column last_error_retryable boolean;
comment on column public.connector_sync_states.last_error_code is 'code of the failure last_error describes; null after a success';
comment on column public.connector_sync_states.last_error_retryable is 'false when that failure repeats until something changes (held for the backoff cap at once); null after a success';
