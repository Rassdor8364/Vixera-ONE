-- Vixera One — migration 8: close the door the Supabase database linter found
-- on the deployed project.
--
-- `vx_handle_new_auth_user` is a TRIGGER function and must never be callable as
-- an RPC. Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- PostgREST exposes everything in `public`, so `anon` could reach a
-- SECURITY DEFINER function over HTTP at /rest/v1/rpc/. Calling it outside a
-- trigger context errors out, but the door should not exist at all. (The
-- credential functions in migration 3 were already revoked; this one was
-- missed, and `scripts/sql/verify.sql` did not cover trigger functions.)
--
-- Not fixed here, deliberately: the linter also reports `pg_net` as living in
-- `public` (migration 5 creates it without a schema). pg_net does not support
-- `ALTER EXTENSION ... SET SCHEMA`, and all twelve of its functions live in the
-- `net` schema, which `config.toml` does not expose through the API — so
-- nothing is reachable and the finding is cosmetic. Moving it would mean
-- dropping and recreating the extension, which would invalidate the cron job.

revoke all on function public.vx_handle_new_auth_user() from public, anon, authenticated;

-- The trigger fires as the table owner, so it needs no grant of its own. This
-- keeps the server able to call it deliberately (e.g. backfilling a profile row).
grant execute on function public.vx_handle_new_auth_user() to service_role;
