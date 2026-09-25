-- 0176: the lease renewal bodies referenced a column that does not exist.
--
-- 0084 (and 0174's wrapper, which kept its body) set
-- conversation_turns.updated_at — but the table has never had that column, so
-- even a reachable renewal raised 42703 at the first call. It was never
-- noticed because the 404 (fixed by 0174) failed every call before the body
-- ran. Proven by an impersonated functional test on 2026-08-26. Both bodies
-- now touch only lease_expires_at.

BEGIN;

CREATE OR REPLACE FUNCTION public.renew_albert_turn_lease(
  p_turn_id text,
  p_lease_seconds integer DEFAULT 360
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := extensions.albert_auth_uid();
  selected_tenant text := control_plane.require_current_tenant_id();
  renewed timestamptz;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'conversation turn lease renewal must be between 60 and 900 seconds'
      USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.conversation_turns AS turn
     SET lease_expires_at = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds)
   WHERE turn.tenant_id = selected_tenant
     AND turn.turn_id = p_turn_id
     AND turn.created_by = actor
     AND turn.status = 'running'
     AND turn.lease_expires_at > clock_timestamp()
  RETURNING turn.lease_expires_at INTO renewed;

  RETURN renewed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.renew_albert_turn_lease(
  p_turn_id text,
  p_lease_seconds integer DEFAULT 360
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, control_plane
AS $$
DECLARE
  renewed timestamptz;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'conversation turn lease renewal must be between 60 and 900 seconds'
      USING ERRCODE = '22023';
  END IF;

  UPDATE control_plane.conversation_turns AS turn
     SET lease_expires_at = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds)
   WHERE turn.turn_id = p_turn_id
     AND turn.status = 'running'
     AND turn.lease_expires_at > clock_timestamp()
  RETURNING turn.lease_expires_at INTO renewed;

  RETURN renewed;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
