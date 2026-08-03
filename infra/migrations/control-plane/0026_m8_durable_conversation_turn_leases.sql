BEGIN;

-- A web process may disappear after opening a turn and before its catch block
-- can call fail_albert_turn. Persist a server-owned deadline so that crash
-- recovery does not depend on that process surviving.
ALTER TABLE control_plane.conversation_turns
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

UPDATE control_plane.conversation_turns
   SET lease_expires_at = created_at + interval '6 minutes'
 WHERE status = 'running' AND lease_expires_at IS NULL;

ALTER TABLE control_plane.conversation_turns
  ALTER COLUMN lease_expires_at SET DEFAULT (now() + interval '6 minutes');

ALTER TABLE control_plane.conversation_turns
  DROP CONSTRAINT IF EXISTS conversation_turns_running_lease_required;
ALTER TABLE control_plane.conversation_turns
  ADD CONSTRAINT conversation_turns_running_lease_required
  CHECK (status <> 'running' OR lease_expires_at IS NOT NULL);

COMMENT ON COLUMN control_plane.conversation_turns.lease_expires_at IS
  'Server-owned crash-recovery deadline. The HTTP turn timeout is at most five minutes; this six-minute lease leaves a bounded finalization margin.';

CREATE OR REPLACE FUNCTION control_plane.reap_expired_conversation_turns(
  p_tenant_id text DEFAULT NULL,
  p_conversation_id text DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  reaped_count integer;
BEGIN
  IF p_conversation_id IS NOT NULL AND p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'conversation reaping requires a tenant' USING ERRCODE = '22023';
  END IF;

  WITH reaped AS (
    UPDATE control_plane.conversation_turns AS turn
       SET status = 'failed',
           result_digest = 'turn_lease_expired',
           completed_at = clock_timestamp()
     WHERE turn.status = 'running'
       AND turn.lease_expires_at <= clock_timestamp()
       AND (p_tenant_id IS NULL OR turn.tenant_id = p_tenant_id)
       AND (p_conversation_id IS NULL OR turn.conversation_id = p_conversation_id)
    RETURNING turn.tenant_id, turn.turn_id, turn.conversation_id,
              turn.created_by, turn.lease_expires_at
  ), audited AS (
    INSERT INTO control_plane.audit_log (
      tenant_id, audit_id, actor_user_id, actor_type, action,
      resource_type, resource_id, audit_metadata
    )
    SELECT reaped.tenant_id, control_plane.generate_ulid(), reaped.created_by,
           'service', 'conversation.turn_lease_expired', 'conversation_turn',
           reaped.turn_id, jsonb_build_object(
             'conversation_id', reaped.conversation_id,
             'lease_expires_at', reaped.lease_expires_at,
             'recovered_by', CASE WHEN p_tenant_id IS NULL
               THEN 'scheduled_reaper' ELSE 'begin_turn' END
           )
      FROM reaped
    RETURNING 1
  )
  SELECT count(*)::integer INTO reaped_count FROM audited;

  RETURN reaped_count;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.reap_expired_conversation_turns(text,text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the fully reviewed confirmation/idempotency core from migration
-- 0023, but wrap it with a same-transaction stale-turn reap. The advisory lock
-- is re-entrant for the transaction, so the core retains its concurrency fence.
ALTER FUNCTION public.begin_albert_turn(text,text,text,jsonb,text,text)
  RENAME TO begin_albert_turn_core_v1;
REVOKE ALL ON FUNCTION public.begin_albert_turn_core_v1(text,text,text,jsonb,text,text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.begin_albert_turn(
  p_conversation_id text,
  p_turn_id text,
  p_user_message text,
  p_runtime_profile jsonb,
  p_confirmation_turn_id text DEFAULT NULL,
  p_confirmation_option_id text DEFAULT NULL
)
RETURNS TABLE (
  conversation_id text,
  previous_response_id text,
  confirmed_option_id text,
  confirmed_preference text,
  confirmed_value text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
BEGIN
  IF p_conversation_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('conversation:' || selected_tenant || ':' || p_conversation_id, 0)
    );
    PERFORM control_plane.reap_expired_conversation_turns(
      selected_tenant,
      p_conversation_id
    );
  END IF;

  RETURN QUERY
  SELECT core.conversation_id, core.previous_response_id,
         core.confirmed_option_id, core.confirmed_preference,
         core.confirmed_value
    FROM public.begin_albert_turn_core_v1(
      p_conversation_id,
      p_turn_id,
      p_user_message,
      p_runtime_profile,
      p_confirmation_turn_id,
      p_confirmation_option_id
    ) AS core;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_albert_turn(text,text,text,jsonb,text,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.begin_albert_turn(text,text,text,jsonb,text,text)
  TO authenticated;

SELECT extensions.albert_install_conversation_reaper_cron_job();

COMMIT;
