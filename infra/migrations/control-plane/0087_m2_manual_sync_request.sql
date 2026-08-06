-- Manual sync request path.
--
-- Until now there was no way for an owner to ask for a sync: the Connections
-- page carried a disabled control reading "Manual sync is not available yet".
-- This adds the one missing hop, and does it without widening any existing
-- grant: `control_plane.enqueue_sync_job` stays revoked from every runtime role
-- and is reachable only through this definer, which enforces four things the
-- browser cannot be trusted to enforce.
--
--   1. The caller is an owner or manager OF THAT TENANT. Tenant scope comes
--      from the session, never from the request body.
--   2. The connection belongs to that tenant and is connected.
--   3. The connection generation is captured at enqueue time, so a job cannot
--      outlive a disconnect/reconnect and write under a stale credential.
--   4. Requests are idempotent within a short window, so a double-click or a
--      retried fetch cannot queue two backfills of the same connection.
--
-- The job type is deliberately InitialBackfill: after the analytical wipe there
-- are no cursors, and an IncrementalSync with no cursor would silently sync
-- nothing while reporting success.

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('connection.manual_sync', 6, 3600, true)
ON CONFLICT (action) DO UPDATE SET
  request_limit=EXCLUDED.request_limit,
  window_seconds=EXCLUDED.window_seconds,
  audit_excess=EXCLUDED.audit_excess,
  enabled=true;

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
   WHERE membership.user_id = auth.uid()
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
      'reason', 'manual'
    ),
    'standard',
    'manual:' || v_connection.connection_id || ':' || v_bucket::text,
    0
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type,
    action, resource_type, resource_id, audit_metadata
  )
  VALUES (
    v_tenant_id, control_plane.generate_ulid(), auth.uid(), 'user',
    'connection.manual_sync_requested', 'connection', p_connection_id,
    jsonb_build_object('syncRunId', v_run_id, 'connectorKey', v_connection.connector_key)
  );

  RETURN QUERY SELECT true, v_run_id, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_request_manual_sync(text) FROM PUBLIC;
-- Supabase grants EXECUTE on public functions to `anon` by default and that
-- survives REVOKE ... FROM PUBLIC, so it must be revoked by name. The function
-- declines an anonymous caller anyway (auth.uid() is null), but an
-- unauthenticated role should not reach a sync-enqueue path at all.
REVOKE ALL ON FUNCTION public.albert_request_manual_sync(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.albert_request_manual_sync(text) TO authenticated;
