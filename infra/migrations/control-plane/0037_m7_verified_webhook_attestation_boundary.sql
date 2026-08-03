BEGIN;

-- A database credential is not evidence that a public webhook passed the
-- vendor verifier. The edge therefore signs the exact normalized disposition
-- with independent key material. Only migration administrators can install
-- verification keys; the webhook login can consume one-use proofs but cannot
-- read or mint them.

CREATE TABLE IF NOT EXISTS control_plane.webhook_attestation_keys (
  key_id text PRIMARY KEY CHECK (key_id ~ '^[a-z][a-z0-9._-]{0,63}$'),
  secret_key bytea NOT NULL CHECK (octet_length(secret_key) = 32),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  CHECK ((active AND retired_at IS NULL) OR (NOT active AND retired_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS control_plane.webhook_attestation_nonces (
  key_id text NOT NULL REFERENCES control_plane.webhook_attestation_keys(key_id),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{22}$'),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9._-]{2,79}$'),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 160),
  used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_id, nonce),
  CHECK (expires_at > used_at)
);

CREATE INDEX IF NOT EXISTS webhook_attestation_nonces_expiry_idx
  ON control_plane.webhook_attestation_nonces(expires_at);

ALTER TABLE control_plane.webhook_attestation_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.webhook_attestation_nonces ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  control_plane.webhook_attestation_keys,
  control_plane.webhook_attestation_nonces
FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
     albert_webhook_control, albert_transform_control, albert_semantic_control,
     albert_operator_diagnostic_control, albert_deletion_control;

CREATE OR REPLACE FUNCTION control_plane.install_webhook_attestation_key(
  p_key_id text,
  p_secret bytea
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  existing bytea;
BEGIN
  IF p_key_id IS NULL
     OR p_key_id !~ '^[a-z][a-z0-9._-]{0,63}$'
     OR p_secret IS NULL
     OR octet_length(p_secret) <> 32 THEN
    RAISE EXCEPTION 'webhook attestation key is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT key.secret_key INTO existing
    FROM control_plane.webhook_attestation_keys AS key
   WHERE key.key_id = p_key_id
   FOR UPDATE;
  IF FOUND AND existing IS DISTINCT FROM p_secret THEN
    RAISE EXCEPTION 'webhook attestation key id already has different material'
      USING ERRCODE = '22000';
  END IF;
  INSERT INTO control_plane.webhook_attestation_keys(key_id, secret_key, active)
  VALUES (p_key_id, p_secret, true)
  ON CONFLICT (key_id) DO UPDATE
    SET active = true,
        retired_at = NULL;
  IF (SELECT count(*) FROM control_plane.webhook_attestation_keys WHERE active) > 3 THEN
    RAISE EXCEPTION 'at most three webhook attestation keys may be active'
      USING ERRCODE = '54000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retire_webhook_attestation_key(p_key_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE control_plane.webhook_attestation_keys
     SET active = false,
         retired_at = clock_timestamp()
   WHERE key_id = p_key_id
     AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active webhook attestation key was not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM control_plane.webhook_attestation_keys WHERE active) THEN
    RAISE EXCEPTION 'at least one webhook attestation key must remain active'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.consume_webhook_attestation(
  p_operation text,
  p_subject text,
  p_document text,
  p_issued_at bigint,
  p_nonce text,
  p_key_id text,
  p_signature text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  secret bytea;
  current_epoch bigint := floor(extract(epoch FROM clock_timestamp()))::bigint;
  document_digest text;
  expected_signature text;
  parsed jsonb;
BEGIN
  IF p_operation IS NULL OR p_operation !~ '^[a-z][a-z0-9._-]{2,79}$'
     OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 160
     OR p_subject ~ '[[:cntrl:]]'
     OR p_document IS NULL OR octet_length(p_document) NOT BETWEEN 2 AND 2097152
     OR p_issued_at IS NULL OR p_issued_at < current_epoch - 300
     OR p_issued_at > current_epoch + 30
     OR p_nonce IS NULL OR p_nonce !~ '^[A-Za-z0-9_-]{22}$'
     OR p_key_id IS NULL OR p_key_id !~ '^[a-z][a-z0-9._-]{0,63}$'
     OR p_signature IS NULL OR p_signature !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'webhook attestation is invalid' USING ERRCODE = '42501';
  END IF;

  SELECT key.secret_key INTO secret
    FROM control_plane.webhook_attestation_keys AS key
   WHERE key.key_id = p_key_id
     AND key.active;
  IF secret IS NULL THEN
    RAISE EXCEPTION 'webhook attestation key is unavailable' USING ERRCODE = '42501';
  END IF;

  document_digest := encode(
    extensions.digest(convert_to(p_document, 'UTF8'), 'sha256'),
    'hex'
  );
  expected_signature := encode(
    extensions.hmac(
      convert_to(
        concat_ws(E'\n',
          'albert:webhook-attestation:v1', p_operation, p_subject,
          document_digest, p_issued_at::text, p_nonce
        ),
        'UTF8'
      ),
      secret,
      'sha256'
    ),
    'hex'
  );
  IF expected_signature IS DISTINCT FROM p_signature THEN
    RAISE EXCEPTION 'webhook attestation signature is invalid' USING ERRCODE = '42501';
  END IF;

  BEGIN
    parsed := p_document::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'webhook attestation document is invalid' USING ERRCODE = '22023';
  END;
  IF jsonb_typeof(parsed) <> 'object' THEN
    RAISE EXCEPTION 'webhook attestation document is invalid' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO control_plane.webhook_attestation_nonces(
      key_id, nonce, operation, subject, expires_at
    ) VALUES (
      p_key_id, p_nonce, p_operation, p_subject,
      to_timestamp(p_issued_at) + interval '10 minutes'
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'webhook attestation was already consumed' USING ERRCODE = '42501';
  END;

  -- Keep replay state bounded without making expiry dependent on the edge.
  DELETE FROM control_plane.webhook_attestation_nonces AS nonce
   WHERE nonce.ctid IN (
     SELECT expired.ctid
       FROM control_plane.webhook_attestation_nonces AS expired
      WHERE expired.expires_at <= clock_timestamp()
      ORDER BY expired.expires_at
      LIMIT 100
      FOR UPDATE SKIP LOCKED
   );
  RETURN parsed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_webhook_attestation_ready(p_key_id text)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_key_id IS NULL OR p_key_id !~ '^[a-z][a-z0-9._-]{0,63}$'
     OR NOT EXISTS (
       SELECT 1
         FROM control_plane.webhook_attestation_keys AS key
        WHERE key.key_id = p_key_id
          AND key.active
          AND octet_length(key.secret_key) = 32
     ) THEN
    RAISE EXCEPTION 'webhook attestation key is not provisioned' USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.resolve_xero_webhook_connections(
  p_external_account_references text[]
)
RETURNS TABLE (
  tenant_id text,
  connection_id text,
  connector_key text,
  external_account_reference text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_external_account_references IS NULL
     OR cardinality(p_external_account_references) NOT BETWEEN 1 AND 1000
     OR EXISTS (
       SELECT 1 FROM unnest(p_external_account_references) AS reference(value)
        WHERE reference.value IS NULL
           OR length(reference.value) NOT BETWEEN 1 AND 300
           OR reference.value ~ '[[:cntrl:]]'
     ) THEN
    RAISE EXCEPTION 'xero webhook references are invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT connection.tenant_id, connection.connection_id,
         connection.connector_key, connection.external_account_reference
    FROM control_plane.connections AS connection
   WHERE connection.connector_key = 'xero'
     AND connection.external_account_reference = ANY(p_external_account_references)
     AND connection.status IN ('connected', 'degraded')
   ORDER BY connection.tenant_id, connection.connection_id;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.reserve_attested_webhook_receipt(
  p_document text,
  p_issued_at bigint,
  p_nonce text,
  p_key_id text,
  p_signature text,
  p_receipt_id text
)
RETURNS TABLE (
  webhook_receipt_id text,
  status text,
  raw_object_key text,
  duplicate boolean,
  received_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb;
  inserted_id text;
  existing record;
  received_at timestamptz;
BEGIN
  document := control_plane.consume_webhook_attestation(
    'receipt.reserve', p_receipt_id, p_document, p_issued_at,
    p_nonce, p_key_id, p_signature
  );
  IF (SELECT count(*) FROM jsonb_object_keys(document)) <> 12
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(document) AS key(name)
        WHERE key.name NOT IN (
          'version', 'operation', 'tenantId', 'connectionId', 'connectorKey',
          'verificationReference', 'receiptId', 'dedupeKey', 'vendorEventId',
          'bodySha256', 'safeHeaders', 'receivedAt'
        )
     )
     OR document ->> 'version' <> '1'
     OR document ->> 'operation' <> 'receipt.reserve'
     OR document ->> 'receiptId' <> p_receipt_id
     OR NOT control_plane.is_ulid(document ->> 'tenantId')
     OR NOT control_plane.is_ulid(document ->> 'connectionId')
     OR NOT control_plane.is_ulid(document ->> 'receiptId')
     OR NOT control_plane.is_ulid(document ->> 'verificationReference')
     OR document ->> 'connectorKey' NOT IN ('deputy', 'xero')
     OR length(btrim(coalesce(document ->> 'dedupeKey', ''))) NOT BETWEEN 1 AND 1000
     OR coalesce(document ->> 'dedupeKey', '') ~ '[[:cntrl:]]'
     OR document ->> 'bodySha256' !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(document -> 'safeHeaders') <> 'object'
     OR octet_length((document -> 'safeHeaders')::text) > 4096
     OR jsonb_typeof(document -> 'vendorEventId') NOT IN ('string', 'null')
     OR length(coalesce(document ->> 'vendorEventId', '')) > 300 THEN
    RAISE EXCEPTION 'webhook receipt attestation document is invalid' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(document -> 'safeHeaders') AS header(name, value)
     WHERE header.name NOT IN (
       'content-type', 'user-agent', 'x-request-id', 'x-deputy-generation-time',
       'source_body_sha256', 'inbox_key_id'
     )
        OR jsonb_typeof(header.value) <> 'string'
        OR length(header.value #>> '{}') > 300
        OR (header.value #>> '{}') ~ '[[:cntrl:]]'
  ) THEN
    RAISE EXCEPTION 'webhook receipt safe headers are invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    received_at := (document ->> 'receivedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'webhook receipt time is invalid' USING ERRCODE = '22023';
  END;
  IF received_at < clock_timestamp() - interval '7 days'
     OR received_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'webhook receipt time is invalid' USING ERRCODE = '22023';
  END IF;

  IF document ->> 'connectorKey' = 'deputy' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM control_plane.connections AS connection
        JOIN control_plane.deputy_webhook_material AS material
          ON material.tenant_id = connection.tenant_id
         AND material.connection_id = connection.connection_id
       WHERE connection.tenant_id = document ->> 'tenantId'
         AND connection.connection_id = document ->> 'connectionId'
         AND connection.connector_key = 'deputy'
         AND connection.status IN ('connected', 'degraded')
         AND material.material_id = document ->> 'verificationReference'
         AND material.retired_at IS NULL
    ) THEN
      RAISE EXCEPTION 'active Deputy verifier was not found' USING ERRCODE = 'P0002';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM control_plane.connections AS connection
        JOIN control_plane.xero_webhook_inbox AS inbox
          ON inbox.inbox_id = document ->> 'verificationReference'
       WHERE connection.tenant_id = document ->> 'tenantId'
         AND connection.connection_id = document ->> 'connectionId'
         AND connection.connector_key = 'xero'
         AND connection.status IN ('connected', 'degraded')
         AND inbox.status = 'processing'
         AND document -> 'safeHeaders' ->> 'source_body_sha256' = inbox.body_sha256
    ) THEN
      RAISE EXCEPTION 'active Xero inbox routing lease was not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  INSERT INTO control_plane.webhook_receipts (
    tenant_id, webhook_receipt_id, connection_id, connector_key,
    vendor_event_id, dedupe_key, body_sha256, signature_verified,
    safe_headers, status, received_at
  ) VALUES (
    document ->> 'tenantId', p_receipt_id, document ->> 'connectionId',
    document ->> 'connectorKey', nullif(document ->> 'vendorEventId', ''),
    document ->> 'dedupeKey', document ->> 'bodySha256', true,
    document -> 'safeHeaders', 'received', received_at
  )
  ON CONFLICT (tenant_id, connection_id, dedupe_key) DO NOTHING
  RETURNING control_plane.webhook_receipts.webhook_receipt_id INTO inserted_id;

  SELECT receipt.webhook_receipt_id, receipt.body_sha256, receipt.status,
         receipt.raw_object_key, receipt.connector_key, receipt.received_at
    INTO existing
    FROM control_plane.webhook_receipts AS receipt
   WHERE receipt.tenant_id = document ->> 'tenantId'
     AND receipt.connection_id = document ->> 'connectionId'
     AND receipt.dedupe_key = document ->> 'dedupeKey'
   FOR UPDATE;
  IF NOT FOUND
     OR existing.body_sha256 <> document ->> 'bodySha256'
     OR existing.connector_key <> document ->> 'connectorKey' THEN
    RAISE EXCEPTION 'webhook receipt dedupe collision' USING ERRCODE = '22000';
  END IF;

  RETURN QUERY SELECT existing.webhook_receipt_id, existing.status,
                      existing.raw_object_key, inserted_id IS NULL,
                      existing.received_at;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.attach_attested_webhook_raw(
  p_tenant_id text,
  p_connection_id text,
  p_receipt_id text,
  p_object_key text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  receipt record;
  expected_key text;
BEGIN
  SELECT item.connector_key, item.received_at, item.raw_object_key INTO receipt
    FROM control_plane.webhook_receipts AS item
   WHERE item.tenant_id = p_tenant_id
     AND item.connection_id = p_connection_id
     AND item.webhook_receipt_id = p_receipt_id
     AND item.signature_verified
     AND item.status IN ('received', 'failed')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attested webhook receipt was not found' USING ERRCODE = 'P0002';
  END IF;
  expected_key := concat_ws('/',
    'tenant', p_tenant_id, 'connection', p_connection_id, 'stream',
    'webhook_' || receipt.connector_key, 'date',
    to_char(receipt.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
    'batch-' || p_receipt_id || '.json.gz'
  );
  IF p_object_key IS DISTINCT FROM expected_key
     OR (receipt.raw_object_key IS NOT NULL AND receipt.raw_object_key <> p_object_key) THEN
    RAISE EXCEPTION 'webhook raw object binding is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.webhook_receipts
     SET raw_object_key = coalesce(raw_object_key, p_object_key)
   WHERE tenant_id = p_tenant_id
     AND webhook_receipt_id = p_receipt_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.finalize_attested_deputy_webhook(
  p_document text,
  p_issued_at bigint,
  p_nonce text,
  p_key_id text,
  p_signature text,
  p_receipt_id text
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  document jsonb;
  receipt control_plane.webhook_receipts%ROWTYPE;
  stream text;
  streams text[];
  signals jsonb;
  accepted boolean;
BEGIN
  document := control_plane.consume_webhook_attestation(
    'receipt.finalize', p_receipt_id, p_document, p_issued_at,
    p_nonce, p_key_id, p_signature
  );
  IF (SELECT count(*) FROM jsonb_object_keys(document)) <> 9
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(document) AS key(name)
        WHERE key.name NOT IN (
          'version', 'operation', 'tenantId', 'connectionId', 'receiptId',
          'accepted', 'streams', 'reconciliationSignals', 'receivedAt'
        )
     )
     OR document ->> 'version' <> '1'
     OR document ->> 'operation' <> 'receipt.finalize'
     OR document ->> 'receiptId' <> p_receipt_id
     OR NOT control_plane.is_ulid(document ->> 'tenantId')
     OR NOT control_plane.is_ulid(document ->> 'connectionId')
     OR NOT control_plane.is_ulid(document ->> 'receiptId')
     OR jsonb_typeof(document -> 'accepted') <> 'boolean'
     OR jsonb_typeof(document -> 'streams') <> 'array'
     OR jsonb_array_length(document -> 'streams') > 7
     OR jsonb_typeof(document -> 'reconciliationSignals') <> 'array'
     OR jsonb_array_length(document -> 'reconciliationSignals') > 5000 THEN
    RAISE EXCEPTION 'Deputy disposition attestation is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(value ORDER BY value), ARRAY[]::text[])
    INTO streams
    FROM jsonb_array_elements_text(document -> 'streams') AS item(value);
  IF EXISTS (
    SELECT 1 FROM unnest(streams) AS item(value)
     WHERE item.value NOT IN (
       'companies', 'operational_units', 'employees', 'rosters',
       'timesheets', 'leave', 'contacts'
     )
  ) OR cardinality(streams) <> (SELECT count(DISTINCT value) FROM unnest(streams) AS item(value)) THEN
    RAISE EXCEPTION 'Deputy disposition streams are invalid' USING ERRCODE = '22023';
  END IF;
  signals := document -> 'reconciliationSignals';
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(signals) AS item(signal)
     WHERE jsonb_typeof(item.signal) <> 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(item.signal)) <> 5
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(item.signal) AS key(name)
           WHERE key.name NOT IN (
             'kind', 'stream', 'sourceObjectType', 'sourceRecordId', 'observedAt'
           )
        )
        OR coalesce(item.signal ->> 'kind', '') <> 'tombstone'
        OR coalesce(item.signal ->> 'stream', '') <> ALL(streams)
        OR coalesce(item.signal ->> 'stream', '') NOT IN (
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
    RAISE EXCEPTION 'Deputy reconciliation signal is invalid' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(signals) <> (
    SELECT count(DISTINCT concat_ws(':',
      item.signal ->> 'stream', item.signal ->> 'sourceObjectType',
      item.signal ->> 'sourceRecordId'
    )) FROM jsonb_array_elements(signals) AS item(signal)
  ) THEN
    RAISE EXCEPTION 'Deputy reconciliation signal is duplicated' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO receipt
    FROM control_plane.webhook_receipts AS item
   WHERE item.tenant_id = document ->> 'tenantId'
     AND item.connection_id = document ->> 'connectionId'
     AND item.webhook_receipt_id = p_receipt_id
     AND item.connector_key = 'deputy'
     AND item.signature_verified
   FOR UPDATE;
  IF NOT FOUND OR receipt.raw_object_key IS NULL THEN
    RAISE EXCEPTION 'attested Deputy raw receipt is incomplete' USING ERRCODE = '55000';
  END IF;
  IF receipt.status IN ('queued', 'ignored') THEN RETURN 0; END IF;
  IF receipt.received_at IS DISTINCT FROM (document ->> 'receivedAt')::timestamptz THEN
    RAISE EXCEPTION 'Deputy receipt time binding is invalid' USING ERRCODE = '22023';
  END IF;

  accepted := (document ->> 'accepted')::boolean;
  UPDATE control_plane.webhook_receipts
     SET reconciliation_signals = signals
   WHERE tenant_id = receipt.tenant_id
     AND webhook_receipt_id = receipt.webhook_receipt_id;
  IF NOT accepted OR cardinality(streams) = 0 THEN
    UPDATE control_plane.webhook_receipts
       SET status = 'ignored', routed_streams = streams
     WHERE tenant_id = receipt.tenant_id
       AND webhook_receipt_id = receipt.webhook_receipt_id;
    RETURN 0;
  END IF;
  FOREACH stream IN ARRAY streams LOOP
    PERFORM control_plane.enqueue_deputy_webhook_sync(
      receipt.tenant_id, receipt.connection_id, receipt.webhook_receipt_id,
      stream, receipt.received_at
    );
  END LOOP;
  UPDATE control_plane.webhook_receipts
     SET status = 'queued', routed_streams = streams, queued_at = clock_timestamp()
   WHERE tenant_id = receipt.tenant_id
     AND webhook_receipt_id = receipt.webhook_receipt_id;
  RETURN cardinality(streams);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.fail_attested_webhook_receipt(
  p_tenant_id text,
  p_connection_id text,
  p_receipt_id text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE control_plane.webhook_receipts
     SET status = 'failed'
   WHERE tenant_id = p_tenant_id
     AND connection_id = p_connection_id
     AND webhook_receipt_id = p_receipt_id
     AND signature_verified
     AND status NOT IN ('queued', 'ignored');
END;
$$;

-- Remove generic table authority and the public-edge ability to self-assert a
-- verified receipt. Every remaining edge mutation is a fixed SECURITY DEFINER
-- procedure over an attested receipt or an already leased Xero inbox item.
REVOKE ALL ON TABLE control_plane.connections, control_plane.webhook_receipts
  FROM albert_webhook_control;
DROP POLICY IF EXISTS webhook_runtime_read ON control_plane.connections;
DROP POLICY IF EXISTS webhook_runtime_access ON control_plane.webhook_receipts;
REVOKE EXECUTE ON FUNCTION control_plane.enqueue_deputy_webhook_sync(
  text, text, text, text, timestamptz
) FROM albert_webhook_control;

REVOKE ALL ON FUNCTION control_plane.install_webhook_attestation_key(text, bytea)
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
       albert_webhook_control, albert_transform_control, albert_semantic_control,
       albert_operator_diagnostic_control, albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.retire_webhook_attestation_key(text)
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
       albert_webhook_control, albert_transform_control, albert_semantic_control,
       albert_operator_diagnostic_control, albert_deletion_control;
GRANT EXECUTE ON FUNCTION control_plane.install_webhook_attestation_key(text, bytea)
  TO albert_control_migration_owner;
GRANT EXECUTE ON FUNCTION control_plane.retire_webhook_attestation_key(text)
  TO albert_control_migration_owner;

REVOKE ALL ON FUNCTION control_plane.consume_webhook_attestation(
  text, text, text, bigint, text, text, text
) FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
       albert_webhook_control, albert_transform_control, albert_semantic_control,
       albert_operator_diagnostic_control, albert_deletion_control;

REVOKE ALL ON FUNCTION control_plane.assert_webhook_attestation_ready(text),
  control_plane.resolve_xero_webhook_connections(text[]),
  control_plane.reserve_attested_webhook_receipt(text,bigint,text,text,text,text),
  control_plane.attach_attested_webhook_raw(text,text,text,text),
  control_plane.finalize_attested_deputy_webhook(text,bigint,text,text,text,text),
  control_plane.fail_attested_webhook_receipt(text,text,text)
FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
     albert_webhook_control, albert_transform_control, albert_semantic_control,
     albert_operator_diagnostic_control, albert_deletion_control;

GRANT EXECUTE ON FUNCTION control_plane.assert_webhook_attestation_ready(text),
  control_plane.resolve_xero_webhook_connections(text[]),
  control_plane.reserve_attested_webhook_receipt(text,bigint,text,text,text,text),
  control_plane.attach_attested_webhook_raw(text,text,text,text),
  control_plane.finalize_attested_deputy_webhook(text,bigint,text,text,text,text),
  control_plane.fail_attested_webhook_receipt(text,text,text)
TO albert_webhook_control;

COMMIT;
