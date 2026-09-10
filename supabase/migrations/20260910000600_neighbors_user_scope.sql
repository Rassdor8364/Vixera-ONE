-- Vixera One — migration 6: user-scoped vx_neighbors.
--
-- The service role bypasses RLS, so server-side callers must be able to scope
-- neighbor lookups explicitly. vx_neighbors now takes the user id and returns it.

drop function if exists public.vx_neighbors(public.entity_type, uuid);

create or replace function public.vx_neighbors(p_user_id uuid, p_type public.entity_type, p_id uuid)
returns table (
  relationship_id uuid,
  user_id uuid,
  kind public.relationship_kind,
  direction text,
  neighbor_type public.entity_type,
  neighbor_id uuid,
  confidence numeric,
  source public.relationship_source
)
language sql
stable
set search_path = ''
as $$
  select r.id, r.user_id, r.kind, 'out'::text, r.to_type, r.to_id, r.confidence, r.source
    from public.relationships r
    where r.user_id = p_user_id and r.from_type = p_type and r.from_id = p_id
  union all
  select r.id, r.user_id, r.kind, 'in'::text, r.from_type, r.from_id, r.confidence, r.source
    from public.relationships r
    where r.user_id = p_user_id and r.to_type = p_type and r.to_id = p_id;
$$;
