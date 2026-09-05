-- Shopify authorization and ingestion are deliberately separate user actions.
-- OAuth may establish and rotate credentials, but no Shopify vendor data may
-- be requested until an owner or manager explicitly starts ingestion for the
-- current connection generation.

BEGIN;

ALTER TABLE control_plane.connections
  ADD COLUMN IF NOT EXISTS ingestion_activated_generation bigint;

ALTER TABLE control_plane.connections
  DROP CONSTRAINT IF EXISTS connections_ingestion_activated_generation_check;
ALTER TABLE control_plane.connections
  ADD CONSTRAINT connections_ingestion_activated_generation_check CHECK (
    ingestion_activated_generation IS NULL
    OR ingestion_activated_generation BETWEEN 1 AND connection_generation
  );

-- Existing ingesting connectors retain their established behaviour. Shopify
-- was authorization-only before this migration, so an existing authorization
-- must still receive an explicit Start ingestion action.
UPDATE control_plane.connections AS connection
   SET ingestion_activated_generation = CASE
         WHEN connection.connector_key = 'shopify' THEN NULL
         WHEN connection.ingestion_activated_at IS NOT NULL
           THEN connection.connection_generation
         ELSE connection.ingestion_activated_generation
       END,
       ingestion_start_mode = CASE
         WHEN connection.connector_key = 'shopify' THEN 'manual'
         ELSE connection.ingestion_start_mode
       END,
       ingestion_activated_at = CASE
         WHEN connection.connector_key = 'shopify' THEN NULL
         ELSE connection.ingestion_activated_at
       END,
       ingestion_activated_by = CASE
         WHEN connection.connector_key = 'shopify' THEN NULL
         ELSE connection.ingestion_activated_by
       END
 WHERE connection.connector_key = 'shopify'
    OR (
      connection.ingestion_activated_at IS NOT NULL
      AND connection.ingestion_activated_generation IS DISTINCT FROM
          connection.connection_generation
    );

COMMENT ON COLUMN control_plane.connections.ingestion_activated_generation IS
  'Latest connection generation explicitly cleared for ingestion. Shopify requires equality with connection_generation; reauthorization therefore requires a new user activation.';

-- 0040 predates the shared connector admission helper. Without this
-- supersession a successful Shopify callback fails while persisting its
-- generation-bound finalization result.
ALTER TABLE control_plane.oauth_sessions
  DROP CONSTRAINT IF EXISTS oauth_sessions_connection_finalization_check;
ALTER TABLE control_plane.oauth_sessions
  ADD CONSTRAINT oauth_sessions_connection_finalization_check CHECK (
    (
      connection_finalization_request_hash IS NULL
      AND connection_finalization_result IS NULL
    ) OR (
      connection_finalization_request_hash ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(connection_finalization_result) = 'object'
      AND connection_finalization_result ?& ARRAY[
        'connectionId','connectionGeneration','provider','externalAccountReference'
      ]
      AND connection_finalization_result
            - 'connectionId' - 'connectionGeneration'
            - 'provider' - 'externalAccountReference' = '{}'::jsonb
      AND control_plane.is_ulid(connection_finalization_result ->> 'connectionId')
      AND (connection_finalization_result ->> 'connectionGeneration') ~ '^[1-9][0-9]*$'
      AND control_plane.is_known_connector(connection_finalization_result ->> 'provider')
      AND length(connection_finalization_result ->> 'externalAccountReference') BETWEEN 1 AND 300
      AND status IN ('exchanging','consumed')
    )
  );

-- This is the authoritative fail-closed publication boundary. Scheduler,
-- webhook, recovery and trusted runtime callers all converge here, so an
-- unactivated Shopify generation cannot be made ingestible by a new producer.
CREATE OR REPLACE FUNCTION control_plane.enqueue_sync_job(
  p_payload jsonb,p_priority text,p_idempotency_key text,p_delay_seconds integer DEFAULT 0
) RETURNS TABLE(job_request_id text,queue_message_id bigint,queue_name text,created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pgmq AS $$
DECLARE
  payload_tenant text:=p_payload->>'tenantId';
  payload_connection text:=p_payload->>'connectionId';
  payload_job_type text:=p_payload->>'type';
  selected_queue text;generated_job_id text;generated_message_id bigint;
  current_generation bigint;supplied_generation bigint;effective_key text;
  activated_generation bigint;
  activated_at timestamptz;blocked_reason text;
BEGIN
  PERFORM control_plane.assert_pgmq_ready();
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
     OR payload_tenant IS NULL OR payload_connection IS NULL
     OR payload_job_type IS NULL
     OR payload_job_type NOT IN ('InitialBackfill','IncrementalSync','ReconciliationSweep')
     OR p_priority IS NULL OR p_priority NOT IN ('high','standard','backfill')
     OR p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8
     OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 0 AND 604800 THEN
    RAISE EXCEPTION 'sync job request is invalid' USING ERRCODE='22023';
  END IF;
  SELECT connection.connection_generation,connection.ingestion_activated_generation,
         connection.ingestion_activated_at,connection.ingestion_blocked_reason
    INTO current_generation,activated_generation,activated_at,blocked_reason
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id=payload_tenant
     AND connection.connection_id=payload_connection
     AND connection.status IN ('connected','degraded')
   FOR SHARE;
  IF current_generation IS NULL THEN
    RAISE EXCEPTION 'active connection was not found' USING ERRCODE='P0002';
  END IF;
  IF activated_at IS NULL OR blocked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'sync job connection ingestion is not active' USING ERRCODE='55000';
  END IF;
  IF activated_generation IS DISTINCT FROM current_generation THEN
    RAISE EXCEPTION 'ingestion has not been activated for this connection generation'
      USING ERRCODE='55000';
  END IF;
  IF p_payload ? 'connectionGeneration' THEN
    BEGIN supplied_generation:=(p_payload->>'connectionGeneration')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'sync job connection generation is invalid' USING ERRCODE='22023';
    END;
    IF supplied_generation<>current_generation THEN
      RAISE EXCEPTION 'sync job connection generation is stale' USING ERRCODE='55000';
    END IF;
  END IF;
  p_payload:=p_payload||jsonb_build_object('connectionGeneration',current_generation);
  IF payload_job_type='InitialBackfill' THEN
    p_payload:=p_payload||jsonb_build_object(
      'replayVersion',coalesce((p_payload->>'replayVersion')::integer,1),
      'planMode',coalesce(p_payload->>'planMode','progressive')
    );
  END IF;
  effective_key:=p_idempotency_key||':g'||current_generation::text;
  IF length(effective_key)>240 THEN
    RAISE EXCEPTION 'sync job idempotency key is too long' USING ERRCODE='22023';
  END IF;

  SELECT request.job_request_id,request.queue_message_id,request.queue_name,false
    INTO job_request_id,queue_message_id,queue_name,created
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id=payload_tenant AND request.idempotency_key=effective_key;
  IF FOUND THEN RETURN NEXT;RETURN; END IF;

  selected_queue:=CASE p_priority WHEN 'high' THEN 'albert_sync_high'
    WHEN 'standard' THEN 'albert_sync_standard' ELSE 'albert_sync_backfill' END;
  generated_job_id:=control_plane.generate_ulid();
  SELECT send INTO generated_message_id FROM pgmq.send(
    selected_queue,p_payload||jsonb_build_object('jobRequestId',generated_job_id),p_delay_seconds
  );
  INSERT INTO control_plane.sync_job_requests(
    tenant_id,job_request_id,connection_id,idempotency_key,job_type,priority,
    queue_name,queue_message_id,payload,status,available_at
  ) VALUES (
    payload_tenant,generated_job_id,payload_connection,effective_key,payload_job_type,
    p_priority,selected_queue,generated_message_id,
    p_payload||jsonb_build_object('jobRequestId',generated_job_id),'queued',
    now()+make_interval(secs=>p_delay_seconds)
  );
  job_request_id:=generated_job_id;queue_message_id:=generated_message_id;
  queue_name:=selected_queue;created:=true;RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  SELECT request.job_request_id,request.queue_message_id,request.queue_name,false
    INTO job_request_id,queue_message_id,queue_name,created
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id=payload_tenant AND request.idempotency_key=effective_key;
  IF FOUND THEN RETURN NEXT;RETURN;END IF;RAISE;
END;
$$;

-- The browser capability both clears the current generation and publishes its
-- coordinator while holding the connection lock. Any publication failure
-- rolls activation back. Repeated clicks return the already accepted run.
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

  SELECT membership.tenant_id, membership.role
    INTO v_tenant_id, v_role
    FROM control_plane.memberships AS membership
    JOIN control_plane.user_active_tenants AS active
      ON active.tenant_id = membership.tenant_id
     AND active.user_id = membership.user_id
   WHERE membership.user_id = v_actor
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

  -- Clear consent only for the generation locked above. Because the enqueue
  -- below is in this transaction, any publication failure rolls this update
  -- (and its audit record) back.
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

  -- The durable request ledger exists before a worker creates sync_runs. Check
  -- it first so a double-click cannot fit into that gap. Activation happens
  -- before this lookup so a queued receipt can never be reported while its
  -- generation remains fenced at claim time.
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

-- Schedulers filter before entering their enqueue loops. Relying only on the
-- central exception would roll back unrelated tenants whenever an authorized
-- but not-yet-activated Shopify connection sorted into a batch.
CREATE OR REPLACE FUNCTION control_plane.enqueue_due_incremental_syncs(
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate record;
  interval_seconds integer;
  bucket bigint;
  enqueued_count integer := 0;
BEGIN
  FOR candidate IN
    SELECT connection.tenant_id, connection.connection_id,
           connection.connector_key, connection.external_account_reference,
           cursor.stream, cursor.cursor_value, cursor.last_successful_sync_at
    FROM control_plane.connections AS connection
    JOIN control_plane.oauth_token_refs AS token
      ON token.tenant_id = connection.tenant_id
     AND token.connection_id = connection.connection_id
    JOIN control_plane.stream_cursors AS cursor
      ON cursor.tenant_id = connection.tenant_id
     AND cursor.connection_id = connection.connection_id
    WHERE connection.status IN ('connected', 'degraded')
      AND connection.ingestion_activated_at IS NOT NULL
      AND connection.ingestion_blocked_reason IS NULL
      AND connection.external_account_reference IS NOT NULL
      AND connection.ingestion_activated_generation = connection.connection_generation
      AND cursor.cursor_value IS NOT NULL
      AND cursor.cursor_value ->> 'value' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM control_plane.stream_cursors AS incomplete
        WHERE incomplete.tenant_id = connection.tenant_id
          AND incomplete.connection_id = connection.connection_id
          AND coalesce(incomplete.backfill_complete, false) = false
      )
      AND NOT EXISTS (
        SELECT 1
        FROM control_plane.sync_job_requests AS request
        WHERE request.tenant_id = connection.tenant_id
          AND request.connection_id = connection.connection_id
          AND request.job_type = 'InitialBackfill'
          AND request.status IN ('queued', 'running', 'retry_wait')
      )
    ORDER BY connection.tenant_id, connection.connection_id, cursor.stream
  LOOP
    interval_seconds := CASE candidate.connector_key
      WHEN 'lightspeed-r' THEN 900
      WHEN 'deputy' THEN 900
      WHEN 'xero' THEN 3600
      ELSE 3600
    END;
    IF candidate.last_successful_sync_at IS NOT NULL
       AND candidate.last_successful_sync_at > p_now - make_interval(secs => interval_seconds) THEN
      CONTINUE;
    END IF;
    bucket := floor(extract(epoch FROM p_now) / interval_seconds)::bigint;
    PERFORM control_plane.enqueue_sync_job(
      jsonb_build_object(
        'schemaVersion', 1,
        'type', 'IncrementalSync',
        'tenantId', candidate.tenant_id,
        'connectionId', candidate.connection_id,
        'connectorId', candidate.connector_key,
        'externalAccountReference', candidate.external_account_reference,
        'syncRunId', control_plane.generate_ulid(),
        'batchId', control_plane.generate_ulid(),
        'requestedAt', p_now,
        'stream', candidate.stream,
        'cursor', candidate.cursor_value,
        'reason', 'schedule'
      ),
      'standard',
      'scheduled:' || candidate.connection_id || ':' || candidate.stream || ':' || bucket::text,
      0
    );
    enqueued_count := enqueued_count + 1;
  END LOOP;

  FOR candidate IN
    SELECT connection.tenant_id, connection.connection_id,
           connection.connector_key, connection.external_account_reference
    FROM control_plane.connections AS connection
    JOIN control_plane.oauth_token_refs AS token
      ON token.tenant_id = connection.tenant_id
     AND token.connection_id = connection.connection_id
    WHERE connection.status IN ('connected', 'degraded')
      AND connection.ingestion_activated_at IS NOT NULL
      AND connection.ingestion_blocked_reason IS NULL
      AND connection.auth_health IN ('unknown', 'expiring', 'expired', 'revoked', 'error')
      AND connection.external_account_reference IS NOT NULL
      AND connection.ingestion_activated_generation = connection.connection_generation
      AND (
        connection.last_checked_at IS NULL
        OR connection.last_checked_at <= p_now - interval '15 minutes'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM control_plane.stream_cursors AS cursor
        WHERE cursor.tenant_id = connection.tenant_id
          AND cursor.connection_id = connection.connection_id
          AND cursor.cursor_value IS NOT NULL
          AND cursor.cursor_value ->> 'value' IS NOT NULL
      )
    ORDER BY connection.tenant_id, connection.connection_id
  LOOP
    bucket := floor(extract(epoch FROM p_now) / 900)::bigint;
    PERFORM control_plane.enqueue_sync_job(
      jsonb_build_object(
        'schemaVersion', 1,
        'type', 'InitialBackfill',
        'tenantId', candidate.tenant_id,
        'connectionId', candidate.connection_id,
        'connectorId', candidate.connector_key,
        'externalAccountReference', candidate.external_account_reference,
        'syncRunId', control_plane.generate_ulid(),
        'batchId', control_plane.generate_ulid(),
        'requestedAt', p_now,
        'range', jsonb_build_object(
          'from', p_now - interval '31 days',
          'to', p_now
        ),
        'phase', 'recent'
      ),
      'backfill',
      'scheduled-auth-recovery:' || candidate.connection_id || ':' || bucket::text,
      0
    );
    enqueued_count := enqueued_count + 1;
  END LOOP;

  RETURN enqueued_count;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.enqueue_nightly_reconciliation_sweeps(
  p_now timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  candidate record;
  enqueued_count integer := 0;
  schedule_date text := to_char(p_now AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  sweep_id text;
BEGIN
  FOR candidate IN
    SELECT connection.tenant_id, connection.connection_id,
           connection.connector_key, connection.external_account_reference
    FROM control_plane.connections AS connection
    WHERE connection.status IN ('connected', 'degraded')
      AND connection.ingestion_activated_at IS NOT NULL
      AND connection.ingestion_blocked_reason IS NULL
      AND connection.external_account_reference IS NOT NULL
      AND connection.ingestion_activated_generation = connection.connection_generation
      AND EXISTS (
        SELECT 1 FROM control_plane.oauth_token_refs AS token
         WHERE token.tenant_id=connection.tenant_id
           AND token.connection_id=connection.connection_id
      )
    ORDER BY connection.tenant_id, connection.connection_id
  LOOP
    sweep_id := control_plane.generate_ulid();
    PERFORM control_plane.enqueue_sync_job(
      jsonb_build_object(
        'schemaVersion', 1,
        'type', 'ReconciliationSweep',
        'tenantId', candidate.tenant_id,
        'connectionId', candidate.connection_id,
        'connectorId', candidate.connector_key,
        'externalAccountReference', candidate.external_account_reference,
        'syncRunId', sweep_id,
        'batchId', control_plane.generate_ulid(),
        'requestedAt', p_now,
        'reconciliationSweepId', sweep_id,
        'phase', 'late_edits',
        'lookbackFrom', p_now - interval '7 days',
        'lookbackTo', p_now
      ),
      'standard',
      'reconcile-coordinator:' || candidate.connection_id || ':' || schedule_date,
      0
    );
    enqueued_count := enqueued_count + 1;
  END LOOP;
  RETURN enqueued_count;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.recover_sync_stream_phases(
  p_now timestamptz DEFAULT now(),p_limit integer DEFAULT 200
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE candidate record; next_replay integer; payload jsonb; receipt record; recovered integer:=0;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'sync phase recovery limit is invalid' USING ERRCODE='22023';
  END IF;
  FOR candidate IN
    SELECT phase_row.*,connection.connector_key,connection.external_account_reference,
           request.status AS request_status
      FROM control_plane.sync_stream_phases AS phase_row
      JOIN control_plane.connections AS connection
        ON connection.tenant_id=phase_row.tenant_id
       AND connection.connection_id=phase_row.connection_id
       AND connection.connection_generation=phase_row.connection_generation
      LEFT JOIN control_plane.sync_job_requests AS request
        ON request.tenant_id=phase_row.tenant_id
       AND request.job_request_id=phase_row.last_job_request_id
     WHERE connection.status IN ('connected','degraded')
       AND connection.ingestion_activated_at IS NOT NULL
       AND connection.ingestion_blocked_reason IS NULL
       AND connection.external_account_reference IS NOT NULL
       AND connection.ingestion_activated_generation = connection.connection_generation
       AND phase_row.available_at<=p_now
       AND (
         (phase_row.status='planned' AND (
           phase_row.predecessor_phase IS NULL OR EXISTS (
             SELECT 1 FROM control_plane.sync_stream_phases predecessor
              WHERE predecessor.tenant_id=phase_row.tenant_id
                AND predecessor.connection_id=phase_row.connection_id
                AND predecessor.connection_generation=phase_row.connection_generation
                AND predecessor.stream=phase_row.stream
                AND predecessor.phase=phase_row.predecessor_phase
                AND predecessor.status='succeeded'
           )
         ))
         OR phase_row.status='failed'
         OR (
           phase_row.status IN ('queued','running')
           AND (
             request.job_request_id IS NULL
             OR request.status IN ('failed','succeeded')
           )
         )
       )
     ORDER BY phase_row.available_at,phase_row.updated_at
     FOR UPDATE OF phase_row SKIP LOCKED
     LIMIT p_limit
  LOOP
    next_replay:=CASE
      WHEN candidate.status='failed' OR candidate.request_status IN ('failed','succeeded')
        THEN candidate.replay_version+1
      ELSE candidate.replay_version
    END;
    payload:=jsonb_build_object(
      'schemaVersion',1,'type','InitialBackfill',
      'tenantId',candidate.tenant_id,'connectionId',candidate.connection_id,
      'connectionGeneration',candidate.connection_generation,
      'connectorId',candidate.connector_key,
      'externalAccountReference',candidate.external_account_reference,
      'syncRunId',control_plane.generate_ulid(),'batchId',control_plane.generate_ulid(),
      'requestedAt',p_now,'stream',candidate.stream,
      'range',jsonb_build_object('from',candidate.range_from,'to',candidate.range_to),
      'phase',candidate.phase,'replayVersion',next_replay,'planMode',candidate.plan_mode
    );
    SELECT * INTO receipt FROM control_plane.enqueue_sync_job(
      payload,'backfill',
      'backfill-phase:'||candidate.connection_id||':g'||candidate.connection_generation::text||
      ':'||candidate.stream||':'||candidate.phase||':v'||next_replay::text,0
    );
    UPDATE control_plane.sync_stream_phases AS phase_row
       SET status='queued',replay_version=next_replay,
           last_job_request_id=receipt.job_request_id,last_error=NULL,available_at=p_now
     WHERE phase_row.tenant_id=candidate.tenant_id
       AND phase_row.connection_id=candidate.connection_id
       AND phase_row.connection_generation=candidate.connection_generation
       AND phase_row.stream=candidate.stream AND phase_row.phase=candidate.phase;
    recovered:=recovered+1;
  END LOOP;
  RETURN recovered;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.enqueue_due_incremental_syncs(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.enqueue_nightly_reconciliation_sweeps(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.recover_sync_stream_phases(timestamptz,integer) FROM PUBLIC;

-- Project only non-secret activation state. The UI must never infer consent
-- from missing cursors or readiness rows because both are also valid during a
-- newly connected automatic connector's first moments.
CREATE OR REPLACE FUNCTION public.albert_connections_workspace()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'tenant_id', tenant.tenant_id,
    'tenant_name', tenant.display_name,
    'connections', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'connection_id', connection.connection_id,
        'connector_key', connection.connector_key,
        'display_name', connection.display_name,
        'status', connection.status,
        'auth_health', connection.auth_health,
        'account_metadata', connection.account_metadata,
        'authorised_at', connection.authorised_at,
        'last_checked_at', connection.last_checked_at,
        'ingestion_start_mode', connection.ingestion_start_mode,
        'ingestion_activated_at', connection.ingestion_activated_at,
        'ingestion_blocked_reason', connection.ingestion_blocked_reason,
        'manual_ingestion_start_required',
          connection.ingestion_start_mode = 'manual'
          AND connection.status IN ('connected','degraded')
          AND connection.ingestion_blocked_reason IS NULL
          AND (
            connection.ingestion_activated_at IS NULL
            OR connection.ingestion_activated_generation IS DISTINCT FROM
               connection.connection_generation
          ),
        'ingestion_state', CASE
          WHEN connection.status = 'disconnected'
               OR connection.ingestion_blocked_reason IS NOT NULL THEN 'inactive'
          WHEN connection.ingestion_start_mode = 'manual'
               AND (
                 connection.ingestion_activated_at IS NULL
                 OR connection.ingestion_activated_generation IS DISTINCT FROM
                    connection.connection_generation
               )
            THEN 'awaiting_manual_start'
          WHEN EXISTS (
            SELECT 1 FROM control_plane.sync_runs AS run
             WHERE run.tenant_id = selected_tenant
               AND run.connection_id = connection.connection_id
               AND run.connection_generation = connection.connection_generation
               AND run.status IN ('running','retry_wait')
          ) THEN 'running'
          WHEN EXISTS (
            SELECT 1 FROM control_plane.sync_job_requests AS request
             WHERE request.tenant_id = selected_tenant
               AND request.connection_id = connection.connection_id
               AND request.payload ->> 'connectionGeneration' =
                   connection.connection_generation::text
               AND request.status IN ('queued','running','retry_wait')
          ) THEN 'queued'
          ELSE 'active'
        END,
        'ingestion_job_active', EXISTS (
          SELECT 1 FROM control_plane.sync_job_requests AS request
           WHERE request.tenant_id = selected_tenant
             AND request.connection_id = connection.connection_id
             AND request.payload ->> 'connectionGeneration' =
                 connection.connection_generation::text
             AND request.job_type = 'InitialBackfill'
             AND request.status IN ('queued','running','retry_wait')
        ),
        'readiness', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'domain', readiness.domain,
            'state', readiness.state,
            'progress', readiness.progress,
            'data_ready_through', readiness.data_ready_through,
            'backfill_complete', readiness.backfill_complete,
            'reason_code', readiness.reason_code
          ) ORDER BY readiness.domain)
          FROM control_plane.readiness AS readiness
          WHERE readiness.tenant_id = selected_tenant
            AND readiness.connection_id = connection.connection_id
        ), '[]'::jsonb)
      ) ORDER BY connection.created_at)
      FROM control_plane.connections AS connection
      WHERE connection.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'dossier', (
      SELECT jsonb_build_object(
        'version', dossier.version,
        'content', dossier.content,
        'provenance', dossier.provenance,
        'published_at', dossier.published_at
      )
      FROM control_plane.dossiers AS dossier
      WHERE dossier.tenant_id = selected_tenant
        AND dossier.status = 'published'
      LIMIT 1
    ),
    'identity_review_tasks', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'task_id', task.identity_review_task_id,
        'entity_type', task.entity_type,
        'status', task.status,
        'confidence_band', task.confidence_band,
        'candidate_links', task.candidate_links,
        'evidence', task.evidence,
        'resolution', task.resolution
      ) ORDER BY task.created_at)
      FROM control_plane.identity_review_tasks AS task
      WHERE task.tenant_id = selected_tenant
    ), '[]'::jsonb),
    'blocking_answers', coalesce((
      SELECT overlay.overlay -> 'blocking_answers'
      FROM control_plane.tenant_overlays AS overlay
      WHERE overlay.tenant_id = selected_tenant
        AND overlay.status = 'published'
      LIMIT 1
    ), '{}'::jsonb),
    'oauth_sessions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'oauth_session_id', session.oauth_session_id,
        'provider', session.provider,
        'status', session.status,
        'discovered_account_choices', session.discovered_account_choices,
        'expires_at', session.expires_at
      ) ORDER BY session.created_at DESC)
      FROM control_plane.oauth_sessions AS session
      WHERE session.tenant_id = selected_tenant
        AND session.initiated_by = extensions.albert_auth_uid()
        AND session.status IN ('pending', 'selecting_account', 'exchanging')
        AND session.expires_at > now()
    ), '[]'::jsonb)
  ) INTO result
  FROM control_plane.tenants AS tenant
  WHERE tenant.tenant_id = selected_tenant;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_connections_workspace() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_connections_workspace() TO authenticated;

COMMIT;
