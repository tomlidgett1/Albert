-- Xero becomes a manual-only connector: ingestion runs when a user clicks
-- Start ingestion / Sync now, and never from a scheduler or webhook.
--
-- Three automatic paths existed and all three are closed here:
--   1. enqueue_due_incremental_syncs (pg_cron */5) minted hourly
--      IncrementalSync jobs and pre-cursor auth-recovery InitialBackfills.
--      Both candidate loops now exclude connector_key='xero'.
--   2. enqueue_nightly_reconciliation_sweeps minted a nightly
--      ReconciliationSweep per connection; it now excludes xero.
--   3. enqueue_xero_webhook_incremental minted an IncrementalSync per verified
--      webhook event; it now records the receipt as 'ignored' (manual-only
--      policy) and mints nothing. Restoring webhook-driven sync means
--      re-applying the 0089 definition.
-- recover_sync_stream_phases is deliberately untouched: it only replays
-- phases of a backfill a user already started, which is completion of the
-- manual request, not a new automatic sync.
--
-- Existing xero connections flip to ingestion_start_mode='manual' so the
-- workspace shows the Start ingestion affordance and
-- albert_start_connection_ingestion accepts them; new connections inherit
-- manual from the connector manifest at finalizeConnection.

BEGIN;

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
      AND connection.connector_key <> 'xero'
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
      AND connection.connector_key <> 'xero'
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
      AND connection.connector_key <> 'xero'
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

-- Webhook receipts stay signature-verified, durable and deduplicated, but a
-- manual-only connector mints no job from them. 'ignored' is the lookup value
-- for a verified event that requires no stream routing.
CREATE OR REPLACE FUNCTION control_plane.enqueue_xero_webhook_incremental(
  p_tenant_id text,
  p_connection_id text,
  p_inbox_id text,
  p_webhook_receipt_id text,
  p_stream text,
  p_received_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  connection record;
  receipt record;
BEGIN
  IF p_stream IS NULL
     OR p_received_at IS NULL
     OR p_stream NOT IN ('contacts', 'invoices', 'credit_notes') THEN
    RAISE EXCEPTION 'xero webhook stream is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT item.connector_key, item.external_account_reference
    INTO connection
    FROM control_plane.connections AS item
   WHERE item.tenant_id = p_tenant_id
     AND item.connection_id = p_connection_id
     AND item.connector_key = 'xero'
     AND item.status IN ('connected', 'degraded')
     AND item.external_account_reference IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active xero connection was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT webhook.status, webhook.raw_object_key
    INTO receipt
    FROM control_plane.webhook_receipts AS webhook
   WHERE webhook.tenant_id = p_tenant_id
     AND webhook.connection_id = p_connection_id
     AND webhook.webhook_receipt_id = p_webhook_receipt_id
     AND webhook.connector_key = 'xero'
     AND webhook.dedupe_key = 'xero:' || p_inbox_id || ':' || p_stream
   FOR UPDATE;
  IF NOT FOUND OR receipt.raw_object_key IS NULL THEN
    RAISE EXCEPTION 'xero webhook raw receipt is incomplete' USING ERRCODE = '55000';
  END IF;

  -- Manual-only policy: record the event, mint nothing. The change surfaces
  -- on the user's next manual sync through the modified-since cursor.
  UPDATE control_plane.webhook_receipts AS webhook
     SET status = 'ignored', routed_streams = ARRAY[p_stream]
   WHERE webhook.tenant_id = p_tenant_id
     AND webhook.webhook_receipt_id = p_webhook_receipt_id;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.enqueue_due_incremental_syncs(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.enqueue_nightly_reconciliation_sweeps(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.enqueue_xero_webhook_incremental(text,text,text,text,text,timestamptz) FROM PUBLIC;

UPDATE control_plane.connections
   SET ingestion_start_mode = 'manual'
 WHERE connector_key = 'xero'
   AND ingestion_start_mode <> 'manual';

-- Fail closed: every scheduler loop that can mint a xero job must carry the
-- exclusion, and the webhook router must no longer reference the job queue.
DO $$
BEGIN
  IF (SELECT count(*)
        FROM regexp_matches(
          pg_get_functiondef('control_plane.enqueue_due_incremental_syncs(timestamptz)'::regprocedure),
          'connector_key <> ''xero''', 'g')) <> 2 THEN
    RAISE EXCEPTION 'incremental scheduler is missing a xero exclusion';
  END IF;
  IF pg_get_functiondef('control_plane.enqueue_nightly_reconciliation_sweeps(timestamptz)'::regprocedure)
       !~ 'connector_key <> ''xero''' THEN
    RAISE EXCEPTION 'nightly reconciliation sweep is missing the xero exclusion';
  END IF;
  IF pg_get_functiondef('control_plane.enqueue_xero_webhook_incremental(text,text,text,text,text,timestamptz)'::regprocedure)
       ~ 'enqueue_sync_job' THEN
    RAISE EXCEPTION 'xero webhook router still mints sync jobs';
  END IF;
END $$;

COMMIT;
