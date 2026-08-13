-- Start ingestion and Sync now required a user_active_tenants row, while the
-- rest of the product resolves the current organisation through
-- current_selected_tenant_id() (explicit selection, then JWT, then first
-- membership). A single-organisation workspace therefore showed Connections
-- and still declined with no_active_organisation, with nowhere to "select".
-- Point both capabilities at the same resolver and heal missing selections.

BEGIN;

INSERT INTO control_plane.user_active_tenants (user_id, tenant_id, selected_at)
SELECT DISTINCT ON (membership.user_id)
  membership.user_id,
  membership.tenant_id,
  clock_timestamp()
FROM control_plane.memberships AS membership
JOIN control_plane.tenants AS tenant
  ON tenant.tenant_id = membership.tenant_id
 AND tenant.status = 'active'
WHERE membership.status = 'active'
  AND NOT EXISTS (
    SELECT 1
    FROM control_plane.user_active_tenants AS active
    WHERE active.user_id = membership.user_id
  )
ORDER BY membership.user_id, membership.created_at, membership.tenant_id;

CREATE OR REPLACE FUNCTION control_plane.current_connection_admin_membership()
RETURNS TABLE(tenant_id text, role text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT membership.tenant_id, membership.role
    FROM control_plane.memberships AS membership
   WHERE membership.user_id = extensions.albert_auth_uid()
     AND membership.status = 'active'
     AND membership.tenant_id = control_plane.current_selected_tenant_id()
   LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION control_plane.current_connection_admin_membership()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.albert_start_connection_ingestion_before_shopify_continuity(
  p_connection_id text
)
RETURNS TABLE(
  accepted boolean,
  sync_run_id text,
  job_request_id text,
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
  v_actor uuid := extensions.albert_auth_uid();
  v_connection control_plane.connections%ROWTYPE;
  v_receipt record;
  v_existing record;
  v_existing_found boolean := false;
  v_sync_run_id text;
  v_now timestamptz := clock_timestamp();
  v_effective_key text;
BEGIN
  IF NOT coalesce(control_plane.is_ulid(p_connection_id), false) THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'invalid_connection_id';
    RETURN;
  END IF;

  SELECT admin.tenant_id, admin.role
    INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF v_tenant_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'no_active_organisation';
    RETURN;
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'insufficient_role';
    RETURN;
  END IF;

  SELECT connection.* INTO v_connection
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id = v_tenant_id
     AND connection.connection_id = p_connection_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'connection_not_found';
    RETURN;
  END IF;
  IF v_connection.status NOT IN ('connected', 'degraded') THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'connection_not_connected';
    RETURN;
  END IF;
  IF v_connection.auth_health NOT IN ('healthy', 'expiring') THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'reauthorisation_required';
    RETURN;
  END IF;
  IF v_connection.external_account_reference IS NULL OR NOT EXISTS (
    SELECT 1 FROM control_plane.oauth_token_refs AS token
     WHERE token.tenant_id = v_tenant_id
       AND token.connection_id = p_connection_id
  ) THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'account_not_selected';
    RETURN;
  END IF;
  IF v_connection.ingestion_blocked_reason IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'operator_blocked';
    RETURN;
  END IF;
  IF v_connection.ingestion_start_mode <> 'manual' THEN
    RETURN QUERY SELECT false, NULL::text, NULL::text, 'manual_start_not_required';
    RETURN;
  END IF;

  v_effective_key := 'manual-start:' || p_connection_id || ':g'
    || v_connection.connection_generation::text;
  IF v_connection.ingestion_activated_at IS NOT NULL
     AND v_connection.ingestion_activated_generation = v_connection.connection_generation THEN
    SELECT request.job_request_id,
           request.payload ->> 'syncRunId' AS sync_run_id,
           request.status
      INTO v_existing
      FROM control_plane.sync_job_requests AS request
     WHERE request.tenant_id = v_tenant_id
       AND request.idempotency_key = v_effective_key;
    v_existing_found := FOUND;
    IF v_existing_found AND v_existing.status <> 'failed'
       AND control_plane.is_ulid(v_existing.sync_run_id) THEN
      RETURN QUERY SELECT true, v_existing.sync_run_id, v_existing.job_request_id, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT false, NULL::text, NULL::text,
      CASE WHEN v_existing_found THEN 'initial_start_failed' ELSE 'ingestion_already_started' END;
    RETURN;
  END IF;

  UPDATE control_plane.connections AS connection
     SET ingestion_activated_at = v_now,
         ingestion_activated_by = v_actor,
         ingestion_activated_generation = v_connection.connection_generation
   WHERE connection.tenant_id = v_tenant_id
     AND connection.connection_id = p_connection_id
     AND connection.connection_generation = v_connection.connection_generation;

  v_sync_run_id := control_plane.generate_ulid();
  SELECT * INTO v_receipt
    FROM control_plane.enqueue_sync_job(
      jsonb_build_object(
        'schemaVersion', 1,
        'type', 'InitialBackfill',
        'tenantId', v_tenant_id,
        'connectionId', p_connection_id,
        'connectorId', v_connection.connector_key,
        'externalAccountReference', v_connection.external_account_reference,
        'connectionGeneration', v_connection.connection_generation,
        'syncRunId', v_sync_run_id,
        'batchId', control_plane.generate_ulid(),
        'requestedAt', v_now,
        'range', jsonb_build_object(
          'from', v_now - interval '31 days',
          'to', v_now
        ),
        'phase', 'recent',
        'replayVersion', 1,
        'planMode', 'progressive',
        'reason', 'manual_start'
      ),
      'backfill',
      'manual-start:' || p_connection_id,
      0
    );
  IF v_receipt.job_request_id IS NULL THEN
    RAISE EXCEPTION 'manual ingestion activation did not produce a queue receipt'
      USING ERRCODE = '55000';
  END IF;

  SELECT request.payload ->> 'syncRunId' INTO v_sync_run_id
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id = v_tenant_id
     AND request.job_request_id = v_receipt.job_request_id;
  IF NOT control_plane.is_ulid(v_sync_run_id) THEN
    RAISE EXCEPTION 'manual ingestion activation queue receipt is invalid'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO control_plane.audit_log(
    tenant_id, audit_id, actor_user_id, actor_type,
    action, resource_type, resource_id, audit_metadata
  ) VALUES (
    v_tenant_id, control_plane.generate_ulid(), v_actor, 'user',
    'connection.ingestion_started', 'connection', p_connection_id,
    jsonb_build_object(
      'connectorKey', v_connection.connector_key,
      'connectionGeneration', v_connection.connection_generation,
      'syncRunId', v_sync_run_id,
      'jobRequestId', v_receipt.job_request_id
    )
  );

  RETURN QUERY SELECT true, v_sync_run_id, v_receipt.job_request_id, NULL::text;
END;
$$;

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
  v_actor uuid := extensions.albert_auth_uid();
  v_connection record;
  v_run_id text;
  v_existing_run_id text;
  v_existing_job_request_id text;
  v_bucket bigint;
  v_idempotency_key text;
  v_was_activated boolean;
  v_activating boolean;
  v_receipt record;
BEGIN
  IF NOT coalesce(control_plane.is_ulid(p_connection_id), false) THEN
    RETURN QUERY SELECT false, NULL::text, 'invalid_connection_id';
    RETURN;
  END IF;

  SELECT admin.tenant_id, admin.role
    INTO v_tenant_id, v_role
    FROM control_plane.current_connection_admin_membership() AS admin;

  IF v_tenant_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, 'no_active_organisation';
    RETURN;
  END IF;
  IF v_role NOT IN ('owner', 'manager') THEN
    RETURN QUERY SELECT false, NULL::text, 'insufficient_role';
    RETURN;
  END IF;

  SELECT connection.connection_id,
         connection.connector_key,
         connection.external_account_reference,
         connection.status,
         connection.auth_health,
         connection.connection_generation,
         connection.ingestion_activated_generation,
         connection.ingestion_start_mode,
         connection.ingestion_activated_at,
         connection.ingestion_blocked_reason
    INTO v_connection
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id = v_tenant_id
     AND connection.connection_id = p_connection_id
   FOR UPDATE;

  IF v_connection.connection_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::text, 'connection_not_found';
    RETURN;
  END IF;
  IF v_connection.status NOT IN ('connected', 'degraded') THEN
    RETURN QUERY SELECT false, NULL::text, 'connection_not_connected';
    RETURN;
  END IF;
  IF v_connection.auth_health NOT IN ('healthy', 'expiring') THEN
    RETURN QUERY SELECT false, NULL::text, 'reauthorisation_required';
    RETURN;
  END IF;
  IF v_connection.external_account_reference IS NULL OR NOT EXISTS (
    SELECT 1 FROM control_plane.oauth_token_refs AS token
     WHERE token.tenant_id = v_tenant_id
       AND token.connection_id = p_connection_id
  ) THEN
    RETURN QUERY SELECT false, NULL::text, 'account_not_selected';
    RETURN;
  END IF;
  IF v_connection.ingestion_blocked_reason IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::text, 'ingestion_blocked';
    RETURN;
  END IF;

  v_was_activated := v_connection.ingestion_activated_at IS NOT NULL
    AND v_connection.ingestion_activated_generation IS NOT DISTINCT FROM
        v_connection.connection_generation;
  v_activating := v_connection.ingestion_start_mode = 'manual' AND NOT v_was_activated;

  IF v_activating THEN
    UPDATE control_plane.connections AS connection
       SET ingestion_activated_generation = connection.connection_generation,
           ingestion_activated_at = clock_timestamp(),
           ingestion_activated_by = v_actor
     WHERE connection.tenant_id = v_tenant_id
       AND connection.connection_id = p_connection_id
       AND connection.connection_generation = v_connection.connection_generation;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'manual ingestion activation generation is stale' USING ERRCODE='55000';
    END IF;
  END IF;

  SELECT request.payload ->> 'syncRunId', request.job_request_id
    INTO v_existing_run_id, v_existing_job_request_id
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id = v_tenant_id
     AND request.connection_id = p_connection_id
     AND request.payload ->> 'connectionGeneration' = v_connection.connection_generation::text
     AND request.status IN ('queued', 'running', 'retry_wait')
     AND (NOT v_activating OR request.job_type = 'InitialBackfill')
   ORDER BY request.created_at DESC
   LIMIT 1;
  IF NOT v_activating
     AND NOT coalesce(control_plane.is_ulid(v_existing_run_id), false) THEN
    SELECT run.sync_run_id, NULL::text
      INTO v_existing_run_id, v_existing_job_request_id
      FROM control_plane.sync_runs AS run
     WHERE run.tenant_id = v_tenant_id
       AND run.connection_id = p_connection_id
       AND run.connection_generation = v_connection.connection_generation
       AND run.status IN ('queued', 'running', 'retry_wait')
     ORDER BY run.created_at DESC
     LIMIT 1;
  END IF;

  IF control_plane.is_ulid(v_existing_run_id) THEN
    IF v_activating THEN
      INSERT INTO control_plane.audit_log (
        tenant_id, audit_id, actor_user_id, actor_type,
        action, resource_type, resource_id, audit_metadata
      ) VALUES (
        v_tenant_id, control_plane.generate_ulid(), v_actor, 'user',
        'connection.ingestion_activated', 'connection', p_connection_id,
        jsonb_strip_nulls(jsonb_build_object(
          'syncRunId', v_existing_run_id,
          'jobRequestId', v_existing_job_request_id,
          'connectorKey', v_connection.connector_key,
          'connectionGeneration', v_connection.connection_generation
        ))
      );
    END IF;
    RETURN QUERY SELECT true, v_existing_run_id, NULL::text;
    RETURN;
  END IF;

  v_run_id := control_plane.generate_ulid();
  v_bucket := floor(extract(epoch FROM now()) / 60)::bigint;
  v_idempotency_key := CASE
    WHEN v_activating
      THEN 'manual-activation:' || v_connection.connection_id || ':g' ||
           v_connection.connection_generation::text
    ELSE 'manual:' || v_connection.connection_id || ':' || v_bucket::text
  END;

  SELECT * INTO v_receipt FROM control_plane.enqueue_sync_job(
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
      'range', jsonb_build_object(
        'from', now() - interval '31 days',
        'to', now()
      ),
      'phase', 'recent',
      'replayVersion', 1,
      'planMode', 'progressive',
      'reason', CASE WHEN v_activating
        THEN 'manual_activation' ELSE 'manual' END
    ),
    'backfill',
    v_idempotency_key,
    0
  );

  IF NOT coalesce(v_receipt.created, false) THEN
    SELECT request.payload ->> 'syncRunId'
      INTO v_run_id
      FROM control_plane.sync_job_requests AS request
     WHERE request.tenant_id = v_tenant_id
       AND request.job_request_id = v_receipt.job_request_id;
    IF NOT coalesce(control_plane.is_ulid(v_run_id), false) THEN
      RAISE EXCEPTION 'manual sync idempotency receipt is invalid' USING ERRCODE='55000';
    END IF;
  END IF;

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type,
    action, resource_type, resource_id, audit_metadata
  ) VALUES (
    v_tenant_id, control_plane.generate_ulid(), v_actor, 'user',
    CASE WHEN v_activating
      THEN 'connection.ingestion_activated' ELSE 'connection.manual_sync_requested' END,
    'connection', p_connection_id,
    jsonb_build_object(
      'syncRunId', v_run_id,
      'jobRequestId', v_receipt.job_request_id,
      'connectorKey', v_connection.connector_key,
      'connectionGeneration', v_connection.connection_generation
    )
  );

  RETURN QUERY SELECT true, v_run_id, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_request_manual_sync(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_request_manual_sync(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.albert_request_manual_sync(text) TO authenticated;

COMMIT;
