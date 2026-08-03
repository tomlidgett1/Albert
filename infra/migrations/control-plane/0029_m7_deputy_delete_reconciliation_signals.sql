BEGIN;

-- A Deputy DELETE can remove the Resource before the accelerated query runs.
-- Preserve the verified source identity on the receipt and carry it into the
-- read-only sync job so ingestion can materialise an explicit tombstone.
ALTER TABLE control_plane.webhook_receipts
  ADD COLUMN IF NOT EXISTS reconciliation_signals jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE control_plane.webhook_receipts
  DROP CONSTRAINT IF EXISTS webhook_receipts_reconciliation_signals_valid;
ALTER TABLE control_plane.webhook_receipts
  ADD CONSTRAINT webhook_receipts_reconciliation_signals_valid CHECK (
    jsonb_typeof(reconciliation_signals) = 'array'
    AND jsonb_array_length(reconciliation_signals) <= 5000
  );

COMMENT ON COLUMN control_plane.webhook_receipts.reconciliation_signals IS
  'Verified source-owned identities requiring tombstone reconciliation. Exact vendor bytes remain in raw_object_key; these bounded non-secret signals retain deletion identity.';

CREATE OR REPLACE FUNCTION control_plane.enqueue_deputy_webhook_sync(
  p_tenant_id text,
  p_connection_id text,
  p_webhook_receipt_id text,
  p_stream text,
  p_received_at timestamptz
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  receipt control_plane.webhook_receipts%ROWTYPE;
  account_reference text;
  connection_generation bigint;
  payload jsonb;
  request_id text;
  stream_signals jsonb := '[]'::jsonb;
BEGIN
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_webhook_receipt_id)
     OR p_stream NOT IN (
       'companies', 'operational_units', 'employees', 'rosters',
       'timesheets', 'leave', 'contacts'
     )
     OR p_received_at IS NULL
     OR p_received_at < now() - interval '1 day'
     OR p_received_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Deputy webhook enqueue input is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT webhook.* INTO receipt
    FROM control_plane.webhook_receipts AS webhook
   WHERE webhook.tenant_id = p_tenant_id
     AND webhook.connection_id = p_connection_id
     AND webhook.webhook_receipt_id = p_webhook_receipt_id
     AND webhook.connector_key = 'deputy'
     AND webhook.signature_verified
     AND webhook.raw_object_key IS NOT NULL
     AND webhook.received_at = p_received_at
     AND webhook.status IN ('received', 'failed')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verified Deputy webhook receipt was not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(receipt.reconciliation_signals) AS item(signal)
     WHERE jsonb_typeof(item.signal) <> 'object'
        OR item.signal ->> 'kind' <> 'tombstone'
        OR item.signal ->> 'stream' NOT IN (
          'operational_units', 'employees', 'rosters', 'timesheets', 'leave'
        )
        OR item.signal ->> 'sourceObjectType' <> CASE item.signal ->> 'stream'
          WHEN 'operational_units' THEN 'OperationalUnit'
          WHEN 'employees' THEN 'Employee'
          WHEN 'rosters' THEN 'Roster'
          WHEN 'timesheets' THEN 'Timesheet'
          WHEN 'leave' THEN 'Leave'
          ELSE ''
        END
        OR length(btrim(coalesce(item.signal ->> 'sourceRecordId', ''))) NOT BETWEEN 1 AND 300
        OR coalesce(item.signal ->> 'sourceRecordId', '') ~ '[[:cntrl:]]'
        OR coalesce(item.signal ->> 'observedAt', '') !~
          '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$'
  ) THEN
    RAISE EXCEPTION 'Deputy webhook reconciliation signal is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(item.signal ORDER BY
           item.signal ->> 'sourceObjectType', item.signal ->> 'sourceRecordId'), '[]'::jsonb)
    INTO stream_signals
    FROM jsonb_array_elements(receipt.reconciliation_signals) AS item(signal)
   WHERE item.signal ->> 'stream' = p_stream;

  IF jsonb_array_length(stream_signals) <> (
    SELECT count(DISTINCT concat_ws(
      ':', item.signal ->> 'sourceObjectType', item.signal ->> 'sourceRecordId'
    ))
      FROM jsonb_array_elements(stream_signals) AS item(signal)
  ) THEN
    RAISE EXCEPTION 'Deputy webhook reconciliation signal is duplicated' USING ERRCODE = '22023';
  END IF;

  SELECT connection.external_account_reference, connection.connection_generation
    INTO account_reference, connection_generation
    FROM control_plane.connections AS connection
    JOIN control_plane.deputy_webhook_material AS material
      ON material.tenant_id = connection.tenant_id
     AND material.connection_id = connection.connection_id
     AND material.retired_at IS NULL
   WHERE connection.tenant_id = p_tenant_id
     AND connection.connection_id = p_connection_id
     AND connection.connector_key = 'deputy'
     AND connection.status IN ('connected', 'degraded')
   FOR SHARE OF connection, material;
  IF account_reference IS NULL OR connection_generation IS NULL THEN
    RAISE EXCEPTION 'Active Deputy webhook connection was not found' USING ERRCODE = 'P0002';
  END IF;

  payload := jsonb_build_object(
    'schemaVersion', 1,
    'type', 'IncrementalSync',
    'tenantId', p_tenant_id,
    'connectionId', p_connection_id,
    'connectionGeneration', connection_generation,
    'connectorId', 'deputy',
    'externalAccountReference', account_reference,
    'syncRunId', control_plane.generate_ulid(),
    'batchId', control_plane.generate_ulid(),
    'requestedAt', p_received_at,
    'stream', p_stream,
    'reason', 'webhook',
    'webhookReceiptId', p_webhook_receipt_id
  ) || CASE WHEN jsonb_array_length(stream_signals) > 0
    THEN jsonb_build_object('webhookTombstones', stream_signals)
    ELSE '{}'::jsonb
  END;

  SELECT queued.job_request_id INTO request_id
    FROM control_plane.enqueue_sync_job(
      payload,
      'high',
      'webhook:' || p_webhook_receipt_id || ':' || p_stream,
      0
    ) AS queued;
  IF request_id IS NULL THEN
    RAISE EXCEPTION 'Deputy webhook enqueue did not return a request id' USING ERRCODE = '55000';
  END IF;
  RETURN request_id;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.enqueue_deputy_webhook_sync(text, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control, albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.enqueue_deputy_webhook_sync(text, text, text, text, timestamptz)
  TO albert_webhook_control;

COMMIT;
