-- OAuth authorization and ingestion activation are distinct lifecycle events.
-- Square requires an explicit owner/manager action before any source request;
-- automatic connectors preserve the established recent-first behaviour.

BEGIN;

ALTER TABLE control_plane.connections
  ADD COLUMN IF NOT EXISTS ingestion_start_mode text NOT NULL DEFAULT 'automatic',
  ADD COLUMN IF NOT EXISTS ingestion_activated_at timestamptz,
  -- New application migrations must not depend directly on Supabase's
  -- administrator-owned auth schema. Actors are obtained through the fixed
  -- extensions.albert_auth_uid() compatibility boundary.
  ADD COLUMN IF NOT EXISTS ingestion_activated_by uuid,
  ADD COLUMN IF NOT EXISTS ingestion_activated_generation bigint,
  ADD COLUMN IF NOT EXISTS ingestion_blocked_reason text;

ALTER TABLE control_plane.connections
  DROP CONSTRAINT IF EXISTS connections_ingestion_start_mode_check;
ALTER TABLE control_plane.connections
  ADD CONSTRAINT connections_ingestion_start_mode_check
  CHECK (ingestion_start_mode IN ('automatic', 'manual'));

ALTER TABLE control_plane.connections
  DROP CONSTRAINT IF EXISTS connections_ingestion_activated_generation_check;
ALTER TABLE control_plane.connections
  ADD CONSTRAINT connections_ingestion_activated_generation_check CHECK (
    ingestion_activated_generation IS NULL
    OR ingestion_activated_generation BETWEEN 1 AND connection_generation
  );

ALTER TABLE control_plane.connections
  DROP CONSTRAINT IF EXISTS connections_ingestion_blocked_reason_check;
ALTER TABLE control_plane.connections
  ADD CONSTRAINT connections_ingestion_blocked_reason_check CHECK (
    ingestion_blocked_reason IS NULL
    OR ingestion_blocked_reason ~ '^[a-z][a-z0-9_]{2,119}$'
  );

-- All pre-existing ingesting connectors were already live before this policy
-- existed. Authorization-only packs carry no implied consent to read vendor
-- data, so they must be classified as manual in this first committed migration
-- rather than repaired by a later migration after automatic producers can see
-- them. Existing activation values are preserved on reapplication after an
-- explicit start.
UPDATE control_plane.connections
SET ingestion_start_mode = CASE
      WHEN connector_key IN ('square','shopify','lightspeed-x','momence') THEN 'manual'
      ELSE 'automatic'
    END,
    ingestion_activated_at = CASE
      WHEN connector_key IN ('square','shopify','lightspeed-x','momence')
        THEN ingestion_activated_at
      ELSE coalesce(ingestion_activated_at, authorised_at, created_at, clock_timestamp())
    END,
    ingestion_activated_by = CASE
      WHEN connector_key IN ('square','shopify','lightspeed-x','momence')
        THEN ingestion_activated_by
      ELSE coalesce(ingestion_activated_by, authorised_by)
    END,
    ingestion_activated_generation = CASE
      WHEN connector_key IN ('square','shopify','lightspeed-x','momence')
        THEN ingestion_activated_generation
      ELSE connection_generation
    END
WHERE ingestion_start_mode IS DISTINCT FROM
        CASE
          WHEN connector_key IN ('square','shopify','lightspeed-x','momence') THEN 'manual'
          ELSE 'automatic'
        END
   OR (connector_key NOT IN ('square','shopify','lightspeed-x','momence')
       AND ingestion_activated_at IS NULL)
   OR (connector_key NOT IN ('square','shopify','lightspeed-x','momence')
       AND ingestion_activated_generation IS DISTINCT FROM connection_generation);

CREATE INDEX IF NOT EXISTS connections_ingestion_active_idx
  ON control_plane.connections (tenant_id, connection_id, connection_generation)
  WHERE ingestion_activated_at IS NOT NULL
    AND ingestion_activated_generation = connection_generation
    AND ingestion_blocked_reason IS NULL
    AND status IN ('connected', 'degraded');

COMMENT ON COLUMN control_plane.connections.ingestion_start_mode IS
  'Connector-manifest policy captured at OAuth finalization: automatic starts recent-first ingestion; manual requires an explicit owner/manager activation.';
COMMENT ON COLUMN control_plane.connections.ingestion_activated_at IS
  'Durable user-consent boundary for ingestion. NULL means no sync producer may enqueue or claim work for this connection.';
COMMENT ON COLUMN control_plane.connections.ingestion_activated_generation IS
  'Connection generation cleared for ingestion. Equality with connection_generation prevents a new OAuth grant from inheriting stale activation.';
COMMENT ON COLUMN control_plane.connections.ingestion_blocked_reason IS
  'Optional operator safety block. Even an activated connection cannot enqueue or claim sync work while populated.';

-- OAuth workers cannot update connections directly. This exact capability is
-- bound to the finalized session result and records the connector-owned policy
-- before the same transaction attempts its optional initial enqueue.
CREATE OR REPLACE FUNCTION control_plane.configure_connection_ingestion_policy(
  p_tenant_id text,
  p_oauth_session_id text,
  p_connection_generation bigint,
  p_provider text,
  p_initial_start text,
  p_operator_suppressed boolean
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  session_row control_plane.oauth_sessions%ROWTYPE;
  finalized jsonb;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_oauth_session_id)
     OR p_connection_generation < 1
     OR NOT control_plane.is_known_connector(p_provider)
     OR p_initial_start NOT IN ('automatic', 'manual')
     OR p_operator_suppressed IS NULL THEN
    RAISE EXCEPTION 'connection ingestion policy input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT session.* INTO session_row
    FROM control_plane.oauth_sessions AS session
   WHERE session.tenant_id = p_tenant_id
     AND session.oauth_session_id = p_oauth_session_id
     AND session.provider = p_provider
     AND session.status = 'exchanging'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OAuth session cannot configure connection ingestion' USING ERRCODE = '42501';
  END IF;

  finalized := session_row.connection_finalization_result;
  IF finalized IS NULL
     OR NOT control_plane.is_ulid(finalized ->> 'connectionId')
     OR finalized ->> 'provider' IS DISTINCT FROM p_provider
     OR finalized ->> 'connectionGeneration' IS DISTINCT FROM p_connection_generation::text THEN
    RAISE EXCEPTION 'connection ingestion policy is not bound to the finalized OAuth identity'
      USING ERRCODE = '42501';
  END IF;

  UPDATE control_plane.connections AS connection
     SET ingestion_start_mode = p_initial_start,
         ingestion_activated_at = CASE
           WHEN p_initial_start = 'automatic'
             THEN coalesce(connection.ingestion_activated_at, clock_timestamp())
           ELSE NULL
         END,
         ingestion_activated_by = CASE
           WHEN p_initial_start = 'automatic'
             THEN coalesce(connection.ingestion_activated_by, session_row.initiated_by)
           ELSE NULL
         END,
         ingestion_activated_generation = CASE
           WHEN p_initial_start = 'automatic' THEN p_connection_generation
           ELSE NULL
         END,
         ingestion_blocked_reason = CASE
           WHEN p_operator_suppressed THEN 'operator_initial_backfill_suppressed'
           ELSE NULL
         END
   WHERE connection.tenant_id = p_tenant_id
     AND connection.connection_id = finalized ->> 'connectionId'
     AND connection.connection_generation = p_connection_generation
     AND connection.connector_key = p_provider
     AND connection.status IN ('connected', 'degraded');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalized connection cannot configure ingestion' USING ERRCODE = '55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.configure_connection_ingestion_policy(
  text, text, bigint, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
       albert_webhook_control, albert_transform_control, albert_semantic_control,
       albert_operator_diagnostic_control, albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.configure_connection_ingestion_policy(
  text, text, bigint, text, text, boolean
) TO albert_sync_control;

-- Central publication fence. Every producer, including a future one that
-- forgets its own candidate filter, fails before a pgmq message is created.
CREATE OR REPLACE FUNCTION control_plane.enqueue_sync_job(
  p_payload jsonb,
  p_priority text,
  p_idempotency_key text,
  p_delay_seconds integer DEFAULT 0
) RETURNS TABLE(job_request_id text, queue_message_id bigint, queue_name text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  payload_tenant text := p_payload ->> 'tenantId';
  payload_connection text := p_payload ->> 'connectionId';
  payload_job_type text := p_payload ->> 'type';
  selected_queue text;
  generated_job_id text;
  generated_message_id bigint;
  current_generation bigint;
  supplied_generation bigint;
  effective_key text;
  activated_at timestamptz;
  activated_generation bigint;
  blocked_reason text;
BEGIN
  PERFORM control_plane.assert_pgmq_ready();
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR payload_tenant IS NULL OR payload_connection IS NULL
     OR payload_job_type NOT IN ('InitialBackfill', 'IncrementalSync', 'ReconciliationSweep')
     OR p_priority NOT IN ('high', 'standard', 'backfill')
     OR length(btrim(p_idempotency_key)) < 8
     OR p_delay_seconds NOT BETWEEN 0 AND 604800 THEN
    RAISE EXCEPTION 'sync job request is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT connection.connection_generation,
         connection.ingestion_activated_at,
         connection.ingestion_activated_generation,
         connection.ingestion_blocked_reason
    INTO current_generation, activated_at, activated_generation, blocked_reason
    FROM control_plane.connections AS connection
   WHERE connection.tenant_id = payload_tenant
     AND connection.connection_id = payload_connection
     AND connection.status <> 'disconnected'
   FOR SHARE;
  IF current_generation IS NULL THEN
    RAISE EXCEPTION 'active connection was not found' USING ERRCODE = 'P0002';
  END IF;
  IF activated_at IS NULL
     OR activated_generation IS DISTINCT FROM current_generation
     OR blocked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'sync job connection ingestion is not active' USING ERRCODE = '55000';
  END IF;

  IF p_payload ? 'connectionGeneration' THEN
    BEGIN
      supplied_generation := (p_payload ->> 'connectionGeneration')::bigint;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'sync job connection generation is invalid' USING ERRCODE = '22023';
    END;
    IF supplied_generation <> current_generation THEN
      RAISE EXCEPTION 'sync job connection generation is stale' USING ERRCODE = '55000';
    END IF;
  END IF;

  p_payload := p_payload || jsonb_build_object('connectionGeneration', current_generation);
  IF payload_job_type = 'InitialBackfill' THEN
    p_payload := p_payload || jsonb_build_object(
      'replayVersion', coalesce((p_payload ->> 'replayVersion')::integer, 1),
      'planMode', coalesce(p_payload ->> 'planMode', 'progressive')
    );
  END IF;
  effective_key := p_idempotency_key || ':g' || current_generation::text;
  IF length(effective_key) > 240 THEN
    RAISE EXCEPTION 'sync job idempotency key is too long' USING ERRCODE = '22023';
  END IF;

  SELECT request.job_request_id, request.queue_message_id, request.queue_name, false
    INTO job_request_id, queue_message_id, queue_name, created
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id = payload_tenant
     AND request.idempotency_key = effective_key;
  IF FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;

  selected_queue := CASE p_priority
    WHEN 'high' THEN 'albert_sync_high'
    WHEN 'standard' THEN 'albert_sync_standard'
    ELSE 'albert_sync_backfill'
  END;
  generated_job_id := control_plane.generate_ulid();
  SELECT send INTO generated_message_id
    FROM pgmq.send(
      selected_queue,
      p_payload || jsonb_build_object('jobRequestId', generated_job_id),
      p_delay_seconds
    );
  INSERT INTO control_plane.sync_job_requests(
    tenant_id, job_request_id, connection_id, idempotency_key, job_type, priority,
    queue_name, queue_message_id, payload, status, available_at
  ) VALUES (
    payload_tenant, generated_job_id, payload_connection, effective_key, payload_job_type,
    p_priority, selected_queue, generated_message_id,
    p_payload || jsonb_build_object('jobRequestId', generated_job_id), 'queued',
    now() + make_interval(secs => p_delay_seconds)
  );
  job_request_id := generated_job_id;
  queue_message_id := generated_message_id;
  queue_name := selected_queue;
  created := true;
  RETURN NEXT;
EXCEPTION WHEN unique_violation THEN
  SELECT request.job_request_id, request.queue_message_id, request.queue_name, false
    INTO job_request_id, queue_message_id, queue_name, created
    FROM control_plane.sync_job_requests AS request
   WHERE request.tenant_id = payload_tenant
     AND request.idempotency_key = effective_key;
  IF FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;
  RAISE;
END;
$$;

-- Claim-time defence archives any message published before this migration or
-- before an operator block. No worker receives source credentials for it.
CREATE OR REPLACE FUNCTION control_plane.claim_sync_jobs(
  p_queue_name text,
  p_worker_id text,
  p_visibility_timeout_seconds integer DEFAULT 300,
  p_quantity integer DEFAULT 1
) RETURNS TABLE(
  message_id bigint,
  read_count bigint,
  enqueued_at timestamptz,
  visibility_deadline timestamptz,
  payload jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  message record;
  request_tenant text;
  request_connection text;
  request_id text;
  ingestion_active boolean;
BEGIN
  PERFORM control_plane.assert_pgmq_ready();
  IF p_queue_name NOT IN ('albert_sync_high', 'albert_sync_standard', 'albert_sync_backfill')
     OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_visibility_timeout_seconds NOT BETWEEN 30 AND 3600
     OR p_quantity NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'queue claim request is invalid' USING ERRCODE = '22023';
  END IF;

  FOR message IN
    SELECT * FROM pgmq.read(p_queue_name, p_visibility_timeout_seconds, p_quantity)
  LOOP
    request_id := message.message ->> 'jobRequestId';
    SELECT request.tenant_id,
           request.connection_id,
           connection.status IN ('connected', 'degraded')
             AND connection.ingestion_activated_at IS NOT NULL
             AND connection.ingestion_activated_generation = connection.connection_generation
             AND connection.ingestion_blocked_reason IS NULL
             AND request.payload ->> 'connectionGeneration' = connection.connection_generation::text
      INTO request_tenant, request_connection, ingestion_active
      FROM control_plane.sync_job_requests AS request
      JOIN control_plane.connections AS connection
        ON connection.tenant_id = request.tenant_id
       AND connection.connection_id = request.connection_id
     WHERE request.queue_name = p_queue_name
       AND request.queue_message_id = message.msg_id
       AND request.job_request_id = request_id
     FOR UPDATE OF request;

    IF request_tenant IS NULL THEN
      PERFORM pgmq.archive(p_queue_name, message.msg_id);
      PERFORM pgmq.send(
        'albert_sync_deadletter',
        jsonb_build_object(
          'reason', 'orphaned_queue_message',
          'sourceQueue', p_queue_name,
          'sourceMessageId', message.msg_id,
          'payload', message.message
        )
      );
      CONTINUE;
    END IF;

    IF ingestion_active IS DISTINCT FROM true THEN
      PERFORM pgmq.archive(p_queue_name, message.msg_id);
      UPDATE control_plane.sync_job_requests
         SET status = 'failed',
             completed_at = clock_timestamp(),
             last_error = jsonb_build_object(
               'code', 'connection_ingestion_not_active',
               'retryable', false
             )
       WHERE tenant_id = request_tenant
         AND job_request_id = request_id;
      CONTINUE;
    END IF;

    UPDATE control_plane.sync_job_requests
       SET status = 'running', last_claimed_at = now(), last_error = NULL
     WHERE tenant_id = request_tenant AND job_request_id = request_id;

    INSERT INTO control_plane.sync_job_attempts(
      tenant_id, job_attempt_id, job_request_id, attempt_number,
      worker_id, visibility_deadline
    ) VALUES (
      request_tenant, control_plane.generate_ulid(), request_id,
      message.read_ct::integer, p_worker_id, message.vt
    );

    message_id := message.msg_id;
    read_count := message.read_ct;
    enqueued_at := message.enqueued_at;
    visibility_deadline := message.vt;
    payload := message.message;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Avoid one manual connection aborting a whole cron batch at the central
-- fence; only activated candidates reach enqueue_sync_job.
CREATE OR REPLACE FUNCTION control_plane.enqueue_due_incremental_syncs(
  p_now timestamptz DEFAULT now()
) RETURNS integer
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
       AND connection.ingestion_activated_generation = connection.connection_generation
       AND connection.ingestion_blocked_reason IS NULL
       AND connection.external_account_reference IS NOT NULL
       AND cursor.cursor_value IS NOT NULL
       AND cursor.cursor_value ->> 'value' IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM control_plane.stream_cursors AS incomplete
          WHERE incomplete.tenant_id = connection.tenant_id
            AND incomplete.connection_id = connection.connection_id
            AND coalesce(incomplete.backfill_complete, false) = false
       )
       AND NOT EXISTS (
         SELECT 1 FROM control_plane.sync_job_requests AS request
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
       AND connection.ingestion_activated_generation = connection.connection_generation
       AND connection.ingestion_blocked_reason IS NULL
       AND connection.auth_health IN ('unknown', 'expiring', 'expired', 'revoked', 'error')
       AND connection.external_account_reference IS NOT NULL
       AND (
         connection.last_checked_at IS NULL
         OR connection.last_checked_at <= p_now - interval '15 minutes'
       )
       AND NOT EXISTS (
         SELECT 1 FROM control_plane.stream_cursors AS cursor
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
        'range', jsonb_build_object('from', p_now - interval '31 days', 'to', p_now),
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
) RETURNS integer
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
       AND connection.ingestion_activated_generation = connection.connection_generation
       AND connection.ingestion_blocked_reason IS NULL
       AND connection.external_account_reference IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM control_plane.oauth_token_refs AS token
          WHERE token.tenant_id = connection.tenant_id
            AND token.connection_id = connection.connection_id
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

INSERT INTO control_plane.rate_limit_policies (
  action, request_limit, window_seconds, audit_excess
) VALUES
  ('connection.start_ingestion', 6, 3600, true)
ON CONFLICT (action) DO UPDATE SET
  request_limit=EXCLUDED.request_limit,
  window_seconds=EXCLUDED.window_seconds,
  audit_excess=EXCLUDED.audit_excess,
  enabled=true;

-- Idempotent first-start capability. The row lock serializes concurrent clicks;
-- enqueue and activation commit atomically, and replays return the real ledger
-- identifiers rather than inventing a second syncRunId.
CREATE OR REPLACE FUNCTION public.albert_start_connection_ingestion(p_connection_id text)
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

REVOKE ALL ON FUNCTION public.albert_start_connection_ingestion(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.albert_start_connection_ingestion(text) TO authenticated;

-- Project durable activation without exposing actor ids or operator internals.
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
          AND (
            connection.ingestion_activated_at IS NULL
            OR connection.ingestion_activated_generation IS DISTINCT FROM
               connection.connection_generation
          )
          AND connection.ingestion_blocked_reason IS NULL,
        'ingestion_state', CASE
          WHEN connection.ingestion_blocked_reason IS NOT NULL THEN 'inactive'
          WHEN connection.ingestion_start_mode = 'manual'
               AND (
                 connection.ingestion_activated_at IS NULL
                 OR connection.ingestion_activated_generation IS DISTINCT FROM
                    connection.connection_generation
               ) THEN 'awaiting_manual_start'
          WHEN EXISTS (
            SELECT 1 FROM control_plane.sync_job_requests AS running_request
             WHERE running_request.tenant_id = selected_tenant
               AND running_request.connection_id = connection.connection_id
               AND running_request.payload ->> 'connectionGeneration' =
                   connection.connection_generation::text
               AND running_request.job_type = 'InitialBackfill'
               AND running_request.status = 'running'
          ) THEN 'running'
          WHEN EXISTS (
            SELECT 1 FROM control_plane.sync_job_requests AS queued_request
             WHERE queued_request.tenant_id = selected_tenant
               AND queued_request.connection_id = connection.connection_id
               AND queued_request.payload ->> 'connectionGeneration' =
                   connection.connection_generation::text
               AND queued_request.job_type = 'InitialBackfill'
               AND queued_request.status IN ('queued', 'retry_wait')
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
             AND request.status IN ('queued', 'running', 'retry_wait')
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
