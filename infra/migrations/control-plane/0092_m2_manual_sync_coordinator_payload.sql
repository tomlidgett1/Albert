-- Manual sync must enqueue a payload the queue contract accepts.
--
-- The 0087 definer predates the hardened sync-queue contract, which requires
-- an InitialBackfill to carry its backfill window (range), phase,
-- replayVersion and planMode. Without them the enqueued message throws inside
-- the worker's claim, after pgmq has already read it: a poison pill that
-- burns visibility windows forever while the worker reports healthily idle.
-- The payload now matches the OAuth-completion enqueue exactly — a 31-day
-- recent window under the progressive plan — and rides the backfill queue,
-- where every other InitialBackfill lives.

BEGIN;

CREATE OR REPLACE FUNCTION public.albert_request_manual_sync(p_connection_id text)
RETURNS TABLE (
  accepted boolean,
  sync_run_id text,
  reason text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant_id text;
  v_role text;
  v_connection record;
  v_run_id text;
  v_bucket bigint;
BEGIN
  SELECT membership.tenant_id, membership.role
    INTO v_tenant_id, v_role
    FROM control_plane.memberships AS membership
    JOIN control_plane.user_active_tenants AS active
      ON active.tenant_id = membership.tenant_id
     AND active.user_id = membership.user_id
   WHERE membership.user_id = extensions.albert_auth_uid()
     AND membership.status = 'active'
   LIMIT 1;

  IF v_tenant_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, 'no_active_organisation';
    RETURN;
  END IF;

  IF v_role NOT IN ('owner', 'manager') THEN
    RETURN QUERY SELECT false, NULL::text, 'insufficient_role';
    RETURN;
  END IF;

  -- Scope the connection to the session's tenant. A connection id from another
  -- tenant must read as absent, not as forbidden.
  SELECT connection.connection_id,
         connection.connector_key,
         connection.external_account_reference,
         connection.status,
         connection.connection_generation
    INTO v_connection
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id = v_tenant_id
     AND connection.connection_id = p_connection_id;

  IF v_connection.connection_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, 'connection_not_found';
    RETURN;
  END IF;

  IF v_connection.status NOT IN ('connected', 'degraded') THEN
    RETURN QUERY SELECT false, NULL::text, 'connection_not_connected';
    RETURN;
  END IF;

  IF v_connection.external_account_reference IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, 'account_not_selected';
    RETURN;
  END IF;

  -- A backfill already in flight is not an error: report it rather than
  -- queueing a second walk of the same account.
  IF EXISTS (
    SELECT 1 FROM control_plane.sync_runs AS run
     WHERE run.tenant_id = v_tenant_id
       AND run.connection_id = p_connection_id
       AND run.status IN ('queued', 'running', 'retry_wait')
  ) THEN
    RETURN QUERY SELECT false, NULL::text, 'sync_already_running';
    RETURN;
  END IF;

  v_run_id := control_plane.generate_ulid();
  -- One accepted manual request per connection per minute. A double-click or a
  -- retried fetch collapses onto the same idempotency key.
  v_bucket := floor(extract(epoch FROM now()) / 60)::bigint;

  PERFORM control_plane.enqueue_sync_job(
    jsonb_build_object(
      'schemaVersion', 1,
      'type', 'InitialBackfill',
      'tenantId', v_tenant_id,
      'connectionId', v_connection.connection_id,
      'connectorId', v_connection.connector_key,
      'externalAccountReference', v_connection.external_account_reference,
      'connectionGeneration', v_connection.connection_generation,
      'syncRunId', v_run_id,
      'batchId', control_plane.generate_ulid(),
      'requestedAt', now(),
      -- The queue contract requires the coordinator to carry its own recent
      -- window and plan lifecycle, exactly as the OAuth-completion enqueue
      -- does; deeper history is the progressive plan's own business.
      'range', jsonb_build_object(
        'from', to_char(now() - interval '31 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'to', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'phase', 'recent',
      'replayVersion', 1,
      'planMode', 'progressive',
      'reason', 'manual'
    ),
    'backfill',
    'manual:' || v_connection.connection_id || ':' || v_bucket::text,
    0
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type,
    action, resource_type, resource_id, audit_metadata
  )
  VALUES (
    v_tenant_id, control_plane.generate_ulid(), extensions.albert_auth_uid(), 'user',
    'connection.manual_sync_requested', 'connection', p_connection_id,
    jsonb_build_object('syncRunId', v_run_id, 'connectorKey', v_connection.connector_key)
  );

  RETURN QUERY SELECT true, v_run_id, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_request_manual_sync(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_request_manual_sync(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.albert_request_manual_sync(text) TO authenticated;

COMMIT;
