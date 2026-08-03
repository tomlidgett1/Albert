BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'albert_sync_control')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'albert_webhook_control') THEN
    RAISE EXCEPTION 'Run the control-plane role bootstrap before Deputy webhook security migrations.'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS control_plane.deputy_webhook_setup_status_lookup (
  status text PRIMARY KEY CHECK (status ~ '^[a-z][a-z0-9_]*$')
);
INSERT INTO control_plane.deputy_webhook_setup_status_lookup(status) VALUES
  ('pending'), ('provisioning'), ('active'), ('blocked_permission'),
  ('blocked_vendor_approval'), ('retry_wait'), ('retired')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS control_plane.deputy_webhook_material (
  tenant_id text NOT NULL,
  connection_id text NOT NULL,
  material_id text NOT NULL CHECK (control_plane.is_ulid(material_id)),
  material_version integer NOT NULL DEFAULT 1 CHECK (material_version = 1),
  verification_mode text NOT NULL DEFAULT 'custom_header'
    CHECK (verification_mode IN ('custom_header', 'custom_header_and_enterprise_hmac')),
  envelope_version integer NOT NULL DEFAULT 1 CHECK (envelope_version = 1),
  algorithm text NOT NULL DEFAULT 'A256GCM' CHECK (algorithm = 'A256GCM'),
  key_id text NOT NULL CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  iv text NOT NULL CHECK (iv ~ '^[A-Za-z0-9_-]{16}$'),
  ciphertext text NOT NULL CHECK (
    length(ciphertext) BETWEEN 64 AND 8192
    AND ciphertext ~ '^[A-Za-z0-9_-]+$'
  ),
  callback_url text NOT NULL CHECK (
    callback_url ~ '^https://[^[:space:]]+$'
    AND length(callback_url) <= 2000
  ),
  setup_status text NOT NULL DEFAULT 'pending'
    REFERENCES control_plane.deputy_webhook_setup_status_lookup(status),
  required_topics text[] NOT NULL CHECK (cardinality(required_topics) BETWEEN 1 AND 100),
  provisioned_topics text[] NOT NULL DEFAULT ARRAY[]::text[],
  vendor_webhook_ids jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(vendor_webhook_ids) = 'object'),
  last_error_code text CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{1,99}$'
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempted_at timestamptz,
  provisioned_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  UNIQUE (material_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  CHECK (
    (setup_status = 'active' AND provisioned_at IS NOT NULL AND retired_at IS NULL)
    OR (setup_status = 'retired' AND retired_at IS NOT NULL)
    OR setup_status NOT IN ('active', 'retired')
  )
);

COMMENT ON TABLE control_plane.deputy_webhook_material IS
  'One encrypted, independently keyed webhook verifier per Deputy connection. OAuth token and webhook verifier trust zones never share keys or tables.';
COMMENT ON COLUMN control_plane.deputy_webhook_material.vendor_webhook_ids IS
  'Non-secret Deputy Webhook resource identifiers keyed by the exact provisioned topic.';

CREATE INDEX IF NOT EXISTS deputy_webhook_material_status_idx
  ON control_plane.deputy_webhook_material(tenant_id, setup_status, updated_at DESC);

DROP TRIGGER IF EXISTS deputy_webhook_material_touch_updated_at
  ON control_plane.deputy_webhook_material;
CREATE TRIGGER deputy_webhook_material_touch_updated_at
  BEFORE UPDATE ON control_plane.deputy_webhook_material
  FOR EACH ROW EXECUTE FUNCTION control_plane.touch_updated_at();

ALTER TABLE control_plane.deputy_webhook_material ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE control_plane.deputy_webhook_setup_status_lookup
  FROM PUBLIC, anon, authenticated, service_role, albert_webhook_control;

DROP POLICY IF EXISTS sync_runtime_access ON control_plane.deputy_webhook_material;
CREATE POLICY sync_runtime_access ON control_plane.deputy_webhook_material
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE control_plane.deputy_webhook_material
  FROM PUBLIC, anon, authenticated, service_role, albert_webhook_control;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE control_plane.deputy_webhook_material
  TO albert_sync_control;

-- Migration 0007 temporarily let the edge prove that an OAuth reference
-- existed. Connection state is sufficient; the public edge must never have a
-- token-table read, even when the token itself is envelope encrypted.
REVOKE ALL ON TABLE control_plane.oauth_token_refs FROM albert_webhook_control;
DROP POLICY IF EXISTS webhook_runtime_read ON control_plane.oauth_token_refs;

CREATE OR REPLACE FUNCTION control_plane.resolve_deputy_webhook_material(
  p_connection_id text,
  p_material_id text
)
RETURNS TABLE (
  tenant_id text,
  connection_id text,
  connector_key text,
  external_account_reference text,
  material_id text,
  material_version integer,
  verification_mode text,
  envelope_version integer,
  algorithm text,
  key_id text,
  iv text,
  ciphertext text,
  callback_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT control_plane.is_ulid(p_connection_id)
     OR NOT control_plane.is_ulid(p_material_id) THEN
    RAISE EXCEPTION 'Deputy webhook identity is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT connection.tenant_id,
         connection.connection_id,
         connection.connector_key,
         connection.external_account_reference,
         material.material_id,
         material.material_version,
         material.verification_mode,
         material.envelope_version,
         material.algorithm,
         material.key_id,
         material.iv,
         material.ciphertext,
         material.callback_url
    FROM control_plane.connections AS connection
    JOIN control_plane.deputy_webhook_material AS material
      ON material.tenant_id = connection.tenant_id
     AND material.connection_id = connection.connection_id
   WHERE connection.connection_id = p_connection_id
     AND connection.connector_key = 'deputy'
     AND connection.status IN ('connected', 'degraded')
     AND connection.external_account_reference IS NOT NULL
     AND material.material_id = p_material_id
     AND material.retired_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.resolve_deputy_webhook_material(text, text)
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control, albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.resolve_deputy_webhook_material(text, text)
  TO albert_webhook_control;

CREATE OR REPLACE FUNCTION control_plane.assert_deputy_webhook_gateway_ready(
  p_key_ids text[]
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_key_ids IS NULL
     OR cardinality(p_key_ids) NOT BETWEEN 1 AND 5
     OR EXISTS (
       SELECT 1 FROM unnest(p_key_ids) AS key_id(value)
        WHERE key_id.value IS NULL
           OR key_id.value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     )
     OR (SELECT count(DISTINCT key_id.value) FROM unnest(p_key_ids) AS key_id(value))
        <> cardinality(p_key_ids) THEN
    RAISE EXCEPTION 'Deputy webhook key ids are invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM control_plane.deputy_webhook_setup_status_lookup LIMIT 1;
  IF EXISTS (
    SELECT 1 FROM control_plane.deputy_webhook_material AS material
     WHERE material.retired_at IS NULL
       AND NOT (material.key_id = ANY(p_key_ids))
  ) THEN
    RAISE EXCEPTION 'Deputy webhook key version is unavailable'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.assert_deputy_webhook_gateway_ready(text[])
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control, albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.assert_deputy_webhook_gateway_ready(text[])
  TO albert_webhook_control;

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
  payload jsonb;
  request_id text;
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

  SELECT connection.external_account_reference INTO account_reference
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
  IF account_reference IS NULL THEN
    RAISE EXCEPTION 'Active Deputy webhook connection was not found' USING ERRCODE = 'P0002';
  END IF;

  payload := jsonb_build_object(
    'schemaVersion', 1,
    'type', 'IncrementalSync',
    'tenantId', p_tenant_id,
    'connectionId', p_connection_id,
    'connectorId', 'deputy',
    'externalAccountReference', account_reference,
    'syncRunId', control_plane.generate_ulid(),
    'batchId', control_plane.generate_ulid(),
    'requestedAt', p_received_at,
    'stream', p_stream,
    'reason', 'webhook',
    'webhookReceiptId', p_webhook_receipt_id
  );
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
