BEGIN;

-- While InitialBackfill is still open for a connection, scheduled IncrementalSync
-- on the standard queue starves the backfill lane (claim order: high → standard →
-- backfill). Defer incrementals until every stream cursor is backfill_complete
-- and no InitialBackfill jobs remain open for that connection.
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
      AND connection.external_account_reference IS NOT NULL
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

  -- A failed first-page health probe has no stream cursor for the regular loop
  -- above. Reusing InitialBackfill is intentional: while unhealthy it is only a
  -- bounded health probe; once refresh/reconnect succeeds it resumes the exact
  -- recent-first work that was interrupted.
  FOR candidate IN
    SELECT connection.tenant_id, connection.connection_id,
           connection.connector_key, connection.external_account_reference
    FROM control_plane.connections AS connection
    JOIN control_plane.oauth_token_refs AS token
      ON token.tenant_id = connection.tenant_id
     AND token.connection_id = connection.connection_id
    WHERE connection.status IN ('connected', 'degraded')
      AND connection.auth_health IN ('unknown', 'expiring', 'expired', 'revoked', 'error')
      AND connection.external_account_reference IS NOT NULL
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

REVOKE ALL ON FUNCTION control_plane.enqueue_due_incremental_syncs(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION control_plane.enqueue_due_incremental_syncs(timestamptz)
  TO service_role;

COMMIT;
