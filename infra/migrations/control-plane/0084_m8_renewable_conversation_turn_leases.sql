BEGIN;

-- An analytical turn has no fixed duration: a thorough multi-query answer can
-- legitimately outrun any wall clock, and cutting it off destroys the work
-- rather than bounding it. The 6-minute lease exists to reap turns whose runner
-- died, not to cap how long a live runner may think, so a still-streaming turn
-- renews its own lease instead. A runner that dies stops renewing and is reaped
-- on the usual schedule, which is the property the lease was always for.
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

  -- RLS on conversation_turns scopes this to the caller's own tenant, and the
  -- status predicate means a completed, failed or already-reaped turn can never
  -- be revived by a late renewal.
  UPDATE control_plane.conversation_turns AS turn
     SET lease_expires_at = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   WHERE turn.turn_id = p_turn_id
     AND turn.status = 'running'
     AND turn.lease_expires_at > clock_timestamp()
  RETURNING turn.lease_expires_at INTO renewed;

  RETURN renewed;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.renew_albert_turn_lease(text,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION control_plane.renew_albert_turn_lease(text,integer)
  TO authenticated, service_role;

COMMIT;
