-- 0174: conversation turn lease renewal is reachable again (ADR 0084's intent).
--
-- 0084 created control_plane.renew_albert_turn_lease and the web runtime calls
-- it as supabase.rpc("renew_albert_turn_lease") — but PostgREST resolves RPCs
-- in the exposed `public` schema only, and no public wrapper was ever created.
-- Every renewal since 0084 has therefore 404'd (observed as 23 consecutive
-- POST 404s during one production swarm run on 2026-08-25), the renewal helper
-- swallows the error, and any live turn longer than the 360-second initial
-- lease loses its lease mid-analysis: the semantic layer then rejects every
-- later governed query ("semantic turn lease is not active") and the turn dies
-- with the generic hard-failure message. Long analytical turns — swarm
-- children at max effort, Pro reasoning runs — always exceeded it.
--
-- conversation_turns carries no authenticated RLS policy (every public turn
-- RPC is a SECURITY DEFINER function scoped by tenant and actor), so the
-- wrapper follows fail_albert_turn's exact scoping instead of delegating as
-- invoker: same bounds check, same tenant + created_by ownership predicate,
-- and the status/lease predicates still refuse to revive a settled, failed,
-- or already-reaped turn.

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
     SET lease_expires_at = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   WHERE turn.tenant_id = selected_tenant
     AND turn.turn_id = p_turn_id
     AND turn.created_by = actor
     AND turn.status = 'running'
     AND turn.lease_expires_at > clock_timestamp()
  RETURNING turn.lease_expires_at INTO renewed;

  RETURN renewed;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_albert_turn_lease(text, integer)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.renew_albert_turn_lease(text, integer)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
