BEGIN;

-- Section 19 operator projections. These functions expose bounded operational
-- metadata from the control plane only. They deliberately do not accept SQL,
-- expose credential references, or open a browser path to the analytical cell.

CREATE OR REPLACE FUNCTION public.albert_operator_fleet()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id, actor_user_id, action, request_metadata
  ) VALUES (
    control_plane.generate_ulid(), actor, 'operator.fleet_read', '{}'::jsonb
  );

  SELECT jsonb_build_object(
    'generated_at', clock_timestamp(),
    'queues', coalesce((
      SELECT jsonb_agg(to_jsonb(metric) ORDER BY metric.queue_name)
        FROM pgmq.metrics_all() AS metric
       WHERE metric.queue_name LIKE 'albert_sync_%'
    ), '[]'::jsonb),
    'workers', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'worker_id', worker.worker_id,
        'service_version', worker.service_version,
        'deployment_id', worker.deployment_id,
        'started_at', worker.started_at,
        'last_seen_at', worker.last_seen_at,
        'active_job_count', worker.active_job_count,
        'healthy', worker.last_seen_at > now() - interval '2 minutes'
      ) ORDER BY worker.worker_id)
        FROM control_plane.worker_heartbeats AS worker
    ), '[]'::jsonb),
    'connections', coalesce((
      SELECT jsonb_agg(connection_view.payload ORDER BY connection_view.attention_rank,
        connection_view.tenant_name, connection_view.connector_key)
      FROM (
        SELECT
          tenant.display_name AS tenant_name,
          connection.connector_key,
          CASE
            WHEN connection.status = 'blocked'
              OR connection.auth_health IN ('expired', 'revoked', 'error')
              OR readiness.has_blocked
              OR quality.has_blocked THEN 0
            WHEN connection.status = 'degraded'
              OR connection.auth_health IN ('unknown', 'expiring')
              OR readiness.has_degraded
              OR quarantine.open_count > 0
              OR quality.has_warning
              OR webhook.gap_status = 'gap_detected' THEN 1
            ELSE 2
          END AS attention_rank,
          jsonb_build_object(
            'tenant_id', tenant.tenant_id,
            'tenant_name', tenant.display_name,
            'connection_id', connection.connection_id,
            'connector_key', connection.connector_key,
            'display_name', connection.display_name,
            'status', connection.status,
            'auth_health', connection.auth_health,
            'last_checked_at', connection.last_checked_at,
            'token_expires_at', token.token_expires_at,
            'last_rotated_at', token.last_rotated_at,
            'granted_scope_count', token.granted_scope_count,
            'last_successful_sync_at', streams.last_successful_sync_at,
            'streams', streams.items,
            'backfill_progress', streams.backfill_progress,
            'readiness', readiness.items,
            'open_quarantine_count', quarantine.open_count,
            'webhook', jsonb_build_object(
              'last_received_at', webhook.last_received_at,
              'latest_status', webhook.latest_status,
              'failed_count_24h', webhook.failed_count_24h,
              'gap_recovery_status', webhook.gap_status
            ),
            'quality_failures', quality.failures,
            'vendor_budgets', budgets.items
          ) AS payload
        FROM control_plane.connections AS connection
        JOIN control_plane.tenants AS tenant
          ON tenant.tenant_id = connection.tenant_id
        LEFT JOIN LATERAL (
          SELECT
            max(token_ref.token_expires_at) AS token_expires_at,
            max(token_ref.last_rotated_at) AS last_rotated_at,
            coalesce(max(cardinality(token_ref.granted_scopes)), 0) AS granted_scope_count
          FROM control_plane.oauth_token_refs AS token_ref
          WHERE token_ref.tenant_id = connection.tenant_id
            AND token_ref.connection_id = connection.connection_id
        ) AS token ON true
        LEFT JOIN LATERAL (
          SELECT
            coalesce(jsonb_agg(jsonb_build_object(
              'stream', cursor.stream,
              'last_successful_sync_at', cursor.last_successful_sync_at,
              'source_watermark', cursor.source_watermark,
              'backfill_complete', cursor.backfill_complete
            ) ORDER BY cursor.stream), '[]'::jsonb) AS items,
            max(cursor.last_successful_sync_at) AS last_successful_sync_at,
            coalesce(avg(CASE WHEN cursor.backfill_complete THEN 1.0 ELSE 0.0 END), 0) AS backfill_progress
          FROM control_plane.stream_cursors AS cursor
          WHERE cursor.tenant_id = connection.tenant_id
            AND cursor.connection_id = connection.connection_id
        ) AS streams ON true
        LEFT JOIN LATERAL (
          SELECT
            coalesce(jsonb_object_agg(domain_state.domain, jsonb_build_object(
              'state', domain_state.state,
              'progress', domain_state.progress,
              'ready_through', domain_state.data_ready_through,
              'backfill_complete', domain_state.backfill_complete,
              'reason_code', domain_state.reason_code
            )), '{}'::jsonb) AS items,
            coalesce(bool_or(domain_state.state = 'blocked'), false) AS has_blocked,
            coalesce(bool_or(domain_state.state = 'degraded'), false) AS has_degraded
          FROM control_plane.readiness AS domain_state
          WHERE domain_state.tenant_id = connection.tenant_id
            AND domain_state.connection_id = connection.connection_id
        ) AS readiness ON true
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE item.status = 'open') AS open_count
          FROM control_plane.quarantine_items AS item
          WHERE item.tenant_id = connection.tenant_id
            AND item.connection_id = connection.connection_id
        ) AS quarantine ON true
        LEFT JOIN LATERAL (
          SELECT
            receipt_summary.last_received_at,
            receipt_summary.latest_status,
            receipt_summary.failed_count_24h,
            CASE
              WHEN receipt_summary.last_received_at IS NULL THEN 'not_observed'
              WHEN receipt_summary.last_failed_at IS NULL THEN 'clear'
              WHEN EXISTS (
                SELECT 1
                  FROM control_plane.sync_runs AS recovery
                 WHERE recovery.tenant_id = connection.tenant_id
                   AND recovery.connection_id = connection.connection_id
                   AND recovery.job_type = 'ReconciliationSweep'
                   AND recovery.status = 'succeeded'
                   AND recovery.finished_at > receipt_summary.last_failed_at
              ) THEN 'recovered'
              ELSE 'gap_detected'
            END AS gap_status
          FROM (
            SELECT
              max(receipt.received_at) AS last_received_at,
              (array_agg(receipt.status ORDER BY receipt.received_at DESC))[1] AS latest_status,
              count(*) FILTER (
                WHERE receipt.status = 'failed'
                  AND receipt.received_at >= now() - interval '24 hours'
              ) AS failed_count_24h,
              max(receipt.received_at) FILTER (WHERE receipt.status = 'failed') AS last_failed_at
            FROM control_plane.webhook_receipts AS receipt
            WHERE receipt.tenant_id = connection.tenant_id
              AND receipt.connection_id = connection.connection_id
          ) AS receipt_summary
        ) AS webhook ON true
        LEFT JOIN LATERAL (
          SELECT
            coalesce(jsonb_agg(jsonb_build_object(
              'check_id', check_state.key,
              'status', check_state.value
            ) ORDER BY check_state.key) FILTER (
              WHERE check_state.value IN ('warning', 'failed', 'blocked')
            ), '[]'::jsonb) AS failures,
            coalesce(bool_or(check_state.value IN ('failed', 'blocked')), false) AS has_blocked,
            coalesce(bool_or(check_state.value = 'warning'), false) AS has_warning
          FROM jsonb_each_text(coalesce((
            SELECT stat.invariant_status
              FROM control_plane.pipeline_stats AS stat
             WHERE stat.tenant_id = connection.tenant_id
             ORDER BY stat.snapshot_at DESC, stat.schema_name, stat.table_name
             LIMIT 1
          ), '{}'::jsonb)) AS check_state
        ) AS quality ON true
        LEFT JOIN LATERAL (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'budget_key', latest.budget_key,
            'request_limit', latest.request_limit,
            'requests_used', latest.requests_used,
            'remaining', latest.remaining,
            'window_ends_at', latest.window_ends_at,
            'vendor_reset_at', latest.vendor_reset_at,
            'blocked_until', latest.blocked_until
          ) ORDER BY latest.budget_key), '[]'::jsonb) AS items
          FROM (
            SELECT DISTINCT ON (budget.budget_key)
              budget.budget_key, budget.request_limit, budget.requests_used,
              budget.remaining, budget.window_ends_at, budget.vendor_reset_at,
              budget.blocked_until
            FROM control_plane.vendor_rate_budgets AS budget
            WHERE budget.tenant_id = connection.tenant_id
              AND budget.connection_id = connection.connection_id
            ORDER BY budget.budget_key, budget.updated_at DESC, budget.window_started_at DESC
          ) AS latest
        ) AS budgets ON true
        WHERE tenant.status <> 'deleted'
      ) AS connection_view
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_operator_pipeline(p_tenant_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.tenants AS tenant WHERE tenant.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id, actor_user_id, action, target_tenant_id, request_metadata
  ) VALUES (
    control_plane.generate_ulid(), actor, 'operator.pipeline_read', p_tenant_id, '{}'::jsonb
  );

  SELECT jsonb_build_object(
    'generated_at', clock_timestamp(),
    'tenant', jsonb_build_object(
      'tenant_id', tenant.tenant_id,
      'name', tenant.display_name,
      'status', tenant.status,
      'timezone', coalesce((
        SELECT overlay.overlay->>'timezone'
        FROM control_plane.tenant_overlays AS overlay
        WHERE overlay.tenant_id = tenant.tenant_id
          AND overlay.status = 'published'
        ORDER BY overlay.version DESC LIMIT 1
      ), 'Australia/Melbourne')
    ),
    'health', CASE
      WHEN EXISTS (
        SELECT 1 FROM control_plane.connections AS connection
        WHERE connection.tenant_id = p_tenant_id AND connection.status = 'blocked'
      ) OR EXISTS (
        SELECT 1 FROM control_plane.readiness AS readiness
        WHERE readiness.tenant_id = p_tenant_id AND readiness.state = 'blocked'
      ) OR EXISTS (
        SELECT 1
        FROM jsonb_each_text(coalesce((
          SELECT stat.invariant_status FROM control_plane.pipeline_stats AS stat
          WHERE stat.tenant_id = p_tenant_id
          ORDER BY stat.snapshot_at DESC, stat.schema_name, stat.table_name LIMIT 1
        ), '{}'::jsonb)) AS check_state
        WHERE check_state.value IN ('failed', 'blocked')
      ) THEN 'blocked'
      WHEN EXISTS (
        SELECT 1 FROM control_plane.connections AS connection
        WHERE connection.tenant_id = p_tenant_id AND connection.status = 'degraded'
      ) OR EXISTS (
        SELECT 1 FROM control_plane.readiness AS readiness
        WHERE readiness.tenant_id = p_tenant_id AND readiness.state = 'degraded'
      ) OR EXISTS (
        SELECT 1 FROM control_plane.quarantine_items AS item
        WHERE item.tenant_id = p_tenant_id AND item.status = 'open'
      ) OR EXISTS (
        SELECT 1
        FROM jsonb_each_text(coalesce((
          SELECT stat.invariant_status FROM control_plane.pipeline_stats AS stat
          WHERE stat.tenant_id = p_tenant_id
          ORDER BY stat.snapshot_at DESC, stat.schema_name, stat.table_name LIMIT 1
        ), '{}'::jsonb)) AS check_state
        WHERE check_state.value = 'warning'
      ) THEN 'degraded'
      ELSE 'healthy'
    END,
    'latest_pipeline_snapshot_at', (
      SELECT max(stat.snapshot_at) FROM control_plane.pipeline_stats AS stat
      WHERE stat.tenant_id = p_tenant_id
    ),
    'stage_counts', jsonb_build_object(
      'connections', (SELECT count(*) FROM control_plane.connections AS item WHERE item.tenant_id = p_tenant_id),
      'streams', (SELECT count(*) FROM control_plane.stream_cursors AS item WHERE item.tenant_id = p_tenant_id),
      'raw', (SELECT count(*) FROM control_plane.raw_batch_manifests AS item WHERE item.tenant_id = p_tenant_id),
      'staging', (SELECT count(*) FROM (
        SELECT DISTINCT ON (stat.schema_name, stat.table_name) stat.schema_name, stat.table_name
        FROM control_plane.pipeline_stats AS stat
        WHERE stat.tenant_id = p_tenant_id AND stat.schema_name LIKE 'source\_%' ESCAPE '\'
        ORDER BY stat.schema_name, stat.table_name, stat.snapshot_at DESC
      ) AS latest),
      'canonical', (SELECT count(*) FROM (
        SELECT DISTINCT ON (stat.table_name) stat.table_name
        FROM control_plane.pipeline_stats AS stat
        WHERE stat.tenant_id = p_tenant_id AND stat.schema_name = 'core'
        ORDER BY stat.table_name, stat.snapshot_at DESC
      ) AS latest),
      'marts', (SELECT count(*) FROM (
        SELECT DISTINCT ON (stat.table_name) stat.table_name
        FROM control_plane.pipeline_stats AS stat
        WHERE stat.tenant_id = p_tenant_id AND stat.schema_name = 'mart'
        ORDER BY stat.table_name, stat.snapshot_at DESC
      ) AS latest),
      'quality', (SELECT count(*) FROM jsonb_each_text(coalesce((
        SELECT stat.invariant_status FROM control_plane.pipeline_stats AS stat
        WHERE stat.tenant_id = p_tenant_id
        ORDER BY stat.snapshot_at DESC, stat.schema_name, stat.table_name LIMIT 1
      ), '{}'::jsonb))),
      'readiness', (SELECT count(*) FROM control_plane.readiness AS item WHERE item.tenant_id = p_tenant_id)
    ),
    'operation_counts', jsonb_build_object(
      'runs', (SELECT count(*) FROM control_plane.sync_runs AS item WHERE item.tenant_id = p_tenant_id),
      'jobs', (SELECT count(*) FROM control_plane.sync_job_requests AS item WHERE item.tenant_id = p_tenant_id),
      'attempts', (SELECT count(*) FROM control_plane.sync_job_attempts AS item WHERE item.tenant_id = p_tenant_id),
      'quarantine', (SELECT count(*) FROM control_plane.quarantine_items AS item WHERE item.tenant_id = p_tenant_id AND item.status = 'open'),
      'budgets', (SELECT count(DISTINCT item.budget_key) FROM control_plane.vendor_rate_budgets AS item WHERE item.tenant_id = p_tenant_id),
      'ready_domains', (SELECT count(*) FROM control_plane.readiness AS item
        WHERE item.tenant_id = p_tenant_id AND item.state IN ('ready_partial', 'ready_complete'))
    )
  ) INTO result
  FROM control_plane.tenants AS tenant
  WHERE tenant.tenant_id = p_tenant_id;

  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.albert_operator_pipeline_stage(
  p_tenant_id text,
  p_stage text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  actor uuid := auth.uid();
  result jsonb;
  selected_schema text;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.tenants AS tenant WHERE tenant.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_stage IS NULL OR p_stage <> ALL (ARRAY[
    'connections', 'streams', 'raw', 'staging', 'canonical', 'marts',
    'quality', 'readiness', 'runs', 'jobs', 'quarantine', 'budgets'
  ]::text[]) THEN
    RAISE EXCEPTION 'operator pipeline stage is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id, actor_user_id, action, target_tenant_id, request_metadata
  ) VALUES (
    control_plane.generate_ulid(), actor, 'operator.pipeline_drilldown',
    p_tenant_id, jsonb_build_object('stage', p_stage)
  );

  IF p_stage = 'connections' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(
        jsonb_build_object(
          'id', 'connections',
          'label', 'Source connections',
          'description', 'Authorisation, account identity and credential lifecycle metadata.',
          'rows', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'connection_id', connection.connection_id,
              'connector_key', connection.connector_key,
              'display_name', connection.display_name,
              'external_account_reference', connection.external_account_reference,
              'status', connection.status,
              'auth_health', connection.auth_health,
              'authorised_at', connection.authorised_at,
              'last_checked_at', connection.last_checked_at,
              'token_expires_at', token.token_expires_at,
              'last_rotated_at', token.last_rotated_at,
              'granted_scope_count', coalesce(cardinality(token.granted_scopes), 0),
              'disconnected_at', connection.disconnected_at
            ) ORDER BY connection.connector_key, connection.display_name)
            FROM control_plane.connections AS connection
            LEFT JOIN control_plane.oauth_token_refs AS token
              ON token.tenant_id = connection.tenant_id
             AND token.connection_id = connection.connection_id
            WHERE connection.tenant_id = p_tenant_id
          ), '[]'::jsonb)
        ),
        jsonb_build_object(
          'id', 'webhooks',
          'label', 'Webhook receipts',
          'description', 'Verified delivery metadata only; payloads and signature material are never exposed.',
          'rows', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'webhook_receipt_id', receipt.webhook_receipt_id,
              'connection_id', receipt.connection_id,
              'connector_key', receipt.connector_key,
              'status', receipt.status,
              'routed_streams', receipt.routed_streams,
              'received_at', receipt.received_at,
              'queued_at', receipt.queued_at,
              'updated_at', receipt.updated_at
            ) ORDER BY receipt.received_at DESC)
            FROM (
              SELECT * FROM control_plane.webhook_receipts
              WHERE tenant_id = p_tenant_id
              ORDER BY received_at DESC LIMIT 200
            ) AS receipt
          ), '[]'::jsonb)
        )
      )
    ) INTO result;
  ELSIF p_stage = 'streams' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', 'streams',
        'label', 'Durable stream cursors',
        'description', 'Cursor positions, source watermarks and the latest landed delta per stream.',
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'connection_id', cursor.connection_id,
            'connector_key', connection.connector_key,
            'stream', cursor.stream,
            'cursor_value', cursor.cursor_value,
            'cursor_requested_at', cursor.cursor_requested_at,
            'source_watermark', cursor.source_watermark,
            'last_successful_sync_at', cursor.last_successful_sync_at,
            'backfill_complete', cursor.backfill_complete,
            'last_delta_records', last_run.record_count,
            'last_delta_quarantine', last_run.quarantine_count,
            'last_delta_finished_at', last_run.finished_at
          ) ORDER BY connection.connector_key, cursor.stream)
          FROM control_plane.stream_cursors AS cursor
          JOIN control_plane.connections AS connection
            ON connection.tenant_id = cursor.tenant_id
           AND connection.connection_id = cursor.connection_id
          LEFT JOIN LATERAL (
            SELECT run.record_count, run.quarantine_count, run.finished_at
            FROM control_plane.sync_runs AS run
            WHERE run.tenant_id = cursor.tenant_id
              AND run.connection_id = cursor.connection_id
              AND run.stream = cursor.stream
              AND run.status = 'succeeded'
            ORDER BY run.finished_at DESC NULLS LAST, run.created_at DESC LIMIT 1
          ) AS last_run ON true
          WHERE cursor.tenant_id = p_tenant_id
        ), '[]'::jsonb)
      ))
    ) INTO result;
  ELSIF p_stage = 'raw' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', 'manifests',
        'label', 'Immutable batch manifests',
        'description', 'The raw-to-landing lineage trail, bounded to the 200 newest batches.',
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'batch_id', manifest.batch_id,
            'sync_run_id', manifest.sync_run_id,
            'connection_id', manifest.connection_id,
            'connector_key', manifest.connector_key,
            'connector_version', manifest.connector_version,
            'api_version', manifest.api_version,
            'stream', manifest.stream,
            'extracted_at', manifest.extracted_at,
            'cursor_start', manifest.cursor_start,
            'cursor_end', manifest.cursor_end,
            'content_hash', manifest.content_hash,
            'schema_fingerprint', manifest.schema_fingerprint,
            'record_count', manifest.record_count,
            'compressed_bytes', manifest.compressed_bytes,
            'object_keys', manifest.object_keys,
            'landing_status', landing.status,
            'staged_record_count', landing.staged_record_count,
            'quarantine_count', landing.quarantine_count,
            'landing_attempt_count', landing.attempt_count,
            'analytical_committed_at', landing.analytical_committed_at,
            'landing_error_code', landing.last_error->>'code'
          ) ORDER BY manifest.extracted_at DESC)
          FROM (
            SELECT * FROM control_plane.raw_batch_manifests
            WHERE tenant_id = p_tenant_id
            ORDER BY extracted_at DESC LIMIT 200
          ) AS manifest
          JOIN control_plane.raw_batch_landings AS landing
            ON landing.tenant_id = manifest.tenant_id
           AND landing.batch_id = manifest.batch_id
        ), '[]'::jsonb)
      ))
    ) INTO result;
  ELSIF p_stage IN ('staging', 'canonical', 'marts') THEN
    selected_schema := CASE p_stage
      WHEN 'staging' THEN 'source_%'
      WHEN 'canonical' THEN 'core'
      ELSE 'mart'
    END;
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', p_stage,
        'label', CASE p_stage
          WHEN 'staging' THEN 'Typed staging snapshots'
          WHEN 'canonical' THEN 'Canonical tables and bridges'
          ELSE 'Governed marts'
        END,
        'description', 'Hourly and post-sync snapshots; the console never runs count(*) against the analytical cell.',
        'rows', coalesce((
          SELECT jsonb_agg(to_jsonb(latest) ORDER BY latest.schema_name, latest.table_name)
          FROM (
            SELECT DISTINCT ON (stat.schema_name, stat.table_name)
              stat.schema_name, stat.table_name, stat.row_count,
              stat.max_event_at, stat.max_ingested_at, stat.snapshot_at,
              stat.invariant_status
            FROM control_plane.pipeline_stats AS stat
            WHERE stat.tenant_id = p_tenant_id
              AND (
                (p_stage = 'staging' AND stat.schema_name LIKE selected_schema)
                OR (p_stage = 'canonical' AND stat.schema_name = selected_schema)
                OR (p_stage = 'marts' AND stat.schema_name = selected_schema)
              )
            ORDER BY stat.schema_name, stat.table_name, stat.snapshot_at DESC
          ) AS latest
        ), '[]'::jsonb)
      ))
    ) INTO result;
  ELSIF p_stage = 'quality' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', 'quality',
        'label', 'Named quality checks',
        'description', 'Latest projected invariant states; missing checks remain visible through readiness as blocked.',
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'check_id', check_state.key,
            'status', check_state.value,
            'snapshot_at', latest.snapshot_at
          ) ORDER BY
            CASE check_state.value WHEN 'blocked' THEN 0 WHEN 'failed' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
            check_state.key)
          FROM (
            SELECT stat.snapshot_at, stat.invariant_status
            FROM control_plane.pipeline_stats AS stat
            WHERE stat.tenant_id = p_tenant_id
            ORDER BY stat.snapshot_at DESC, stat.schema_name, stat.table_name LIMIT 1
          ) AS latest
          CROSS JOIN LATERAL jsonb_each_text(latest.invariant_status) AS check_state
        ), '[]'::jsonb)
      ))
    ) INTO result;
  ELSIF p_stage = 'readiness' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', 'readiness',
        'label', 'Per-domain readiness',
        'description', 'The exact state injected into governed answer context.',
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'connection_id', readiness.connection_id,
            'connector_key', connection.connector_key,
            'domain', readiness.domain,
            'state', readiness.state,
            'progress', readiness.progress,
            'data_ready_through', readiness.data_ready_through,
            'backfill_complete', readiness.backfill_complete,
            'reason_code', readiness.reason_code,
            'reason_detail', readiness.reason_detail,
            'evaluated_at', readiness.evaluated_at,
            'updated_at', readiness.updated_at
          ) ORDER BY
            CASE readiness.state WHEN 'blocked' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,
            connection.connector_key, readiness.domain)
          FROM control_plane.readiness AS readiness
          JOIN control_plane.connections AS connection
            ON connection.tenant_id = readiness.tenant_id
           AND connection.connection_id = readiness.connection_id
          WHERE readiness.tenant_id = p_tenant_id
        ), '[]'::jsonb)
      ))
    ) INTO result;
  ELSIF p_stage = 'runs' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', 'runs',
        'label', 'Recent sync ledger',
        'description', 'The 200 newest extraction and reconciliation runs.',
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'sync_run_id', run.sync_run_id,
            'connection_id', run.connection_id,
            'connector_key', connection.connector_key,
            'job_type', run.job_type,
            'stream', run.stream,
            'status', run.status,
            'attempt_number', run.attempt_number,
            'record_count', run.record_count,
            'quarantine_count', run.quarantine_count,
            'error_code', run.error_code,
            'scheduled_at', run.scheduled_at,
            'started_at', run.started_at,
            'finished_at', run.finished_at,
            'created_at', run.created_at
          ) ORDER BY run.created_at DESC)
          FROM (
            SELECT * FROM control_plane.sync_runs
            WHERE tenant_id = p_tenant_id
            ORDER BY created_at DESC LIMIT 200
          ) AS run
          JOIN control_plane.connections AS connection
            ON connection.tenant_id = run.tenant_id
           AND connection.connection_id = run.connection_id
        ), '[]'::jsonb)
      ))
    ) INTO result;
  ELSIF p_stage = 'jobs' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(
        jsonb_build_object(
          'id', 'sync_jobs',
          'label', 'Sync jobs',
          'description', 'Durable queue requests without job payloads or unrestricted error bodies.',
          'rows', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'job_request_id', job.job_request_id,
              'connection_id', job.connection_id,
              'connector_key', connection.connector_key,
              'job_type', job.job_type,
              'priority', job.priority,
              'queue_name', job.queue_name,
              'status', job.status,
              'available_at', job.available_at,
              'last_claimed_at', job.last_claimed_at,
              'completed_at', job.completed_at,
              'attempt_count', (
                SELECT count(*) FROM control_plane.sync_job_attempts AS attempt
                WHERE attempt.tenant_id = job.tenant_id
                  AND attempt.job_request_id = job.job_request_id
              ),
              'last_error_code', job.last_error->>'code',
              'created_at', job.created_at,
              'updated_at', job.updated_at
            ) ORDER BY job.created_at DESC)
            FROM (
              SELECT * FROM control_plane.sync_job_requests
              WHERE tenant_id = p_tenant_id
              ORDER BY created_at DESC LIMIT 200
            ) AS job
            JOIN control_plane.connections AS connection
              ON connection.tenant_id = job.tenant_id
             AND connection.connection_id = job.connection_id
          ), '[]'::jsonb)
        ),
        jsonb_build_object(
          'id', 'job_attempts',
          'label', 'Attempt history',
          'description', 'Append-only worker attempts and terminal outcomes.',
          'rows', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'job_attempt_id', attempt.job_attempt_id,
              'job_request_id', attempt.job_request_id,
              'attempt_number', attempt.attempt_number,
              'worker_id', attempt.worker_id,
              'visibility_deadline', attempt.visibility_deadline,
              'outcome', coalesce(outcome.outcome, attempt.outcome, 'running'),
              'error_code', coalesce(outcome.error_metadata->>'code', attempt.error_metadata->>'code'),
              'started_at', attempt.started_at,
              'finished_at', coalesce(outcome.finished_at, attempt.finished_at)
            ) ORDER BY attempt.started_at DESC)
            FROM (
              SELECT * FROM control_plane.sync_job_attempts
              WHERE tenant_id = p_tenant_id
              ORDER BY started_at DESC LIMIT 300
            ) AS attempt
            LEFT JOIN control_plane.sync_job_attempt_outcomes AS outcome
              ON outcome.tenant_id = attempt.tenant_id
             AND outcome.job_attempt_id = attempt.job_attempt_id
          ), '[]'::jsonb)
        ),
        jsonb_build_object(
          'id', 'transform_jobs',
          'label', 'Canonical transform jobs',
          'description', 'Typed staging to canonical, quality and mart projection attempts.',
          'rows', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
              'transform_job_id', job.transform_job_id,
              'batch_id', job.batch_id,
              'sync_run_id', job.sync_run_id,
              'connection_id', job.connection_id,
              'connector_key', job.connector_id,
              'stream', job.stream,
              'domains', job.domains,
              'mapping_version', job.mapping_version,
              'backfill_complete', job.backfill_complete,
              'status', job.status,
              'attempt_count', job.attempt_count,
              'available_at', job.available_at,
              'lease_expires_at', job.lease_expires_at,
              'last_error_code', job.last_error->>'code',
              'started_at', job.started_at,
              'completed_at', job.completed_at,
              'created_at', job.created_at
            ) ORDER BY job.created_at DESC)
            FROM (
              SELECT * FROM control_plane.canonical_transform_jobs
              WHERE tenant_id = p_tenant_id
              ORDER BY created_at DESC LIMIT 200
            ) AS job
          ), '[]'::jsonb)
        )
      )
    ) INTO result;
  ELSIF p_stage = 'quarantine' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', 'quarantine',
        'label', 'Quarantine ledger',
        'description', 'Validation failures and replay state, bounded to the 300 newest records.',
        'rows', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'quarantine_item_id', item.quarantine_item_id,
            'batch_id', item.batch_id,
            'sync_run_id', item.sync_run_id,
            'connection_id', item.connection_id,
            'connector_key', connection.connector_key,
            'stream', item.stream,
            'source_object_type', item.source_object_type,
            'source_record_id', item.source_record_id,
            'error_code', item.error_code,
            'error_path', item.error_path,
            'error_summary', item.error_summary,
            'status', item.status,
            'replayed_in_sync_run_id', item.replayed_in_sync_run_id,
            'resolution_reason', item.resolution_reason,
            'created_at', item.created_at,
            'resolved_at', item.resolved_at
          ) ORDER BY item.created_at DESC)
          FROM (
            SELECT * FROM control_plane.quarantine_items
            WHERE tenant_id = p_tenant_id
            ORDER BY created_at DESC LIMIT 300
          ) AS item
          JOIN control_plane.connections AS connection
            ON connection.tenant_id = item.tenant_id
           AND connection.connection_id = item.connection_id
        ), '[]'::jsonb)
      ))
    ) INTO result;
  ELSIF p_stage = 'budgets' THEN
    SELECT jsonb_build_object(
      'stage', p_stage,
      'generated_at', clock_timestamp(),
      'groups', jsonb_build_array(jsonb_build_object(
        'id', 'budgets',
        'label', 'Vendor rate budgets',
        'description', 'Latest durable budget state per connection and policy window.',
        'rows', coalesce((
          SELECT jsonb_agg(to_jsonb(latest) ORDER BY latest.connector_key, latest.budget_key)
          FROM (
            SELECT DISTINCT ON (budget.connection_id, budget.budget_key)
              budget.connection_id, connection.connector_key, budget.budget_key,
              budget.window_started_at, budget.window_ends_at,
              budget.request_limit, budget.requests_used, budget.remaining,
              budget.vendor_reset_at, budget.emission_interval_ms,
              budget.burst_capacity, budget.blocked_until, budget.updated_at
            FROM control_plane.vendor_rate_budgets AS budget
            JOIN control_plane.connections AS connection
              ON connection.tenant_id = budget.tenant_id
             AND connection.connection_id = budget.connection_id
            WHERE budget.tenant_id = p_tenant_id
            ORDER BY budget.connection_id, budget.budget_key,
              budget.updated_at DESC, budget.window_started_at DESC
          ) AS latest
        ), '[]'::jsonb)
      ))
    ) INTO result;
  END IF;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.albert_operator_fleet() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_operator_pipeline(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_operator_pipeline_stage(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_operator_fleet() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_operator_pipeline(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_operator_pipeline_stage(text, text) TO authenticated;

COMMIT;
