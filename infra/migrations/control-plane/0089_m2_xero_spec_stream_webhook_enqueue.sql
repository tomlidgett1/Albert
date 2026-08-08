BEGIN;

-- Xero's founding streams were replaced by the spec-driven stream set
-- (tables.json; contacts -> xero_contacts, invoices -> xero_invoices,
-- credit_notes -> xero_credit_notes). Webhook receipts, dedupe keys and
-- attested documents keep the historical category labels — they are webhook
-- vocabulary, not stream ids — and the label is translated to the successor
-- stream at the single point where a sync job is minted, so the worker only
-- ever sees stream ids the connector manifest declares.

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
  sync_stream text;
BEGIN
  IF p_stream IS NULL
     OR p_received_at IS NULL
     OR p_stream NOT IN ('contacts', 'invoices', 'credit_notes') THEN
    RAISE EXCEPTION 'xero webhook stream is invalid' USING ERRCODE = '22023';
  END IF;
  sync_stream := CASE p_stream
    WHEN 'contacts' THEN 'xero_contacts'
    WHEN 'invoices' THEN 'xero_invoices'
    WHEN 'credit_notes' THEN 'xero_credit_notes'
  END;
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

  PERFORM control_plane.enqueue_sync_job(
    jsonb_build_object(
      'schemaVersion', 1,
      'type', 'IncrementalSync',
      'tenantId', p_tenant_id,
      'connectionId', p_connection_id,
      'connectorId', 'xero',
      'externalAccountReference', connection.external_account_reference,
      'syncRunId', control_plane.generate_ulid(),
      'batchId', control_plane.generate_ulid(),
      'requestedAt', p_received_at,
      'stream', sync_stream,
      'reason', 'webhook',
      'webhookReceiptId', p_webhook_receipt_id
    ),
    'high',
    'xero-webhook:' || p_inbox_id || ':' || p_connection_id || ':' || p_stream,
    0
  );
  UPDATE control_plane.webhook_receipts AS webhook
     SET status = 'queued', routed_streams = ARRAY[p_stream],
         queued_at = coalesce(webhook.queued_at, clock_timestamp())
   WHERE webhook.tenant_id = p_tenant_id
     AND webhook.webhook_receipt_id = p_webhook_receipt_id;
  RETURN receipt.status <> 'queued';
END;
$$;

COMMIT;
