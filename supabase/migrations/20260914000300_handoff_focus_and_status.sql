-- Vixera One — migration 11: a deleted focus does not strand a handoff;
-- connector_accounts.status is server-owned.
--
-- vx_on_entity_deleted removed a deleted entity's edges, events and conclusions
-- but left handoffs pointing at it, and vx_validate_handoff_focus then refused
-- every later update of such a handoff ("focus does not exist"), so it could be
-- neither accepted nor expired. The trigger now clears the focus: the handoff's
-- conclusions and Praxion location survive as what was handed off, and the Field
-- shows no focus rather than a dead reference.
create or replace function public.vx_on_entity_deleted()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  t public.entity_type := tg_argv[0]::public.entity_type;
begin
  delete from public.relationships
    where user_id = old.user_id
      and ((from_type = t and from_id = old.id) or (to_type = t and to_id = old.id));
  delete from public.context_events where user_id = old.user_id and subject_type = t and subject_id = old.id;
  delete from public.conclusions where user_id = old.user_id and subject_type = t and subject_id = old.id;
  update public.handoffs set focus_type = null, focus_id = null
    where user_id = old.user_id and focus_type = t and focus_id = old.id;
  return old;
end;
$$;

-- Migration 2 granted clients update on (label, status, metadata). status is
-- written by the server only — connector-link on link and disconnect, the sync
-- engine on needs_reauth — and a client could mark an account disconnected
-- while its credential stayed in the Vault, or re-activate one the server took
-- out of rotation. label and metadata remain the client's.
revoke update (status) on public.connector_accounts from authenticated;
