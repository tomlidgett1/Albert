BEGIN;

-- Provider-neutral analytical-cell walking skeleton for M0-M2. This migration
-- must run as albert_migration_owner after infra/bootstrap/analytical_roles.sql.
-- It deliberately creates no canonical facts; M4 owns core/mart/quality.

DO $$
DECLARE
  required_role text;
BEGIN
  FOREACH required_role IN ARRAY ARRAY[
    'ingest_rw', 'transform_rw', 'semantic_ro', 'semantic_meta_rw', 'diagnostic_ro'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = required_role
    ) THEN
      RAISE EXCEPTION 'required analytical role % is missing; run the role bootstrap first', required_role
        USING ERRCODE = '0A000';
    END IF;
  END LOOP;
END;
$$;

CREATE SCHEMA IF NOT EXISTS ingestion;
CREATE SCHEMA IF NOT EXISTS source_lightspeed;
CREATE SCHEMA IF NOT EXISTS source_xero;
CREATE SCHEMA IF NOT EXISTS source_deputy;

COMMENT ON SCHEMA ingestion IS
  'Immutable batch lineage plus vendor-neutral M2 staging/replay metadata.';
COMMENT ON SCHEMA source_lightspeed IS 'Typed Lightspeed R-Series staging; populated by the pack migration stream.';
COMMENT ON SCHEMA source_xero IS 'Typed Xero staging; populated by the pack migration stream.';
COMMENT ON SCHEMA source_deputy IS 'Typed Deputy staging; populated by the pack migration stream.';

CREATE OR REPLACE FUNCTION ingestion.is_ulid(candidate text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT candidate ~ '^[0-9A-HJKMNP-TV-Z]{26}$';
$$;

CREATE OR REPLACE FUNCTION ingestion.current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT nullif(current_setting('albert.tenant_id', true), '');
$$;

COMMENT ON FUNCTION ingestion.current_tenant_id() IS
  'Trusted services SET LOCAL albert.tenant_id inside every analytical transaction. Connector pack code never receives a database handle.';

CREATE TABLE IF NOT EXISTS ingestion.landing_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion.quarantine_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO ingestion.landing_status_lookup (status, description) VALUES
  ('committed', 'Manifest and all valid staging projections committed atomically'),
  ('replayed', 'A prior batch was replayed under a newer mapping version')
ON CONFLICT (status) DO NOTHING;

INSERT INTO ingestion.quarantine_status_lookup (status, description) VALUES
  ('open', 'Projection failed and awaits a mapping or schema correction'),
  ('replayed', 'A later replay landed this source record'),
  ('dismissed', 'An operator dismissed the record with an audited reason')
ON CONFLICT (status) DO NOTHING;

CREATE TABLE IF NOT EXISTS ingestion.batch_manifests (
  tenant_id text NOT NULL,
  batch_id text NOT NULL CHECK (ingestion.is_ulid(batch_id)),
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_-]*$'),
  connector_version text NOT NULL CHECK (length(btrim(connector_version)) > 0),
  api_version text NOT NULL CHECK (length(btrim(api_version)) > 0),
  stream text NOT NULL CHECK (length(btrim(stream)) > 0),
  external_account_reference text NOT NULL CHECK (length(btrim(external_account_reference)) > 0),
  extracted_at timestamptz NOT NULL,
  cursor_start jsonb,
  cursor_end jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  schema_fingerprint text NOT NULL CHECK (schema_fingerprint ~ '^[0-9a-f]{64}$'),
  record_count bigint NOT NULL CHECK (record_count >= 0),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes >= 0),
  object_keys text[] NOT NULL CHECK (cardinality(object_keys) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_id)
);

COMMENT ON TABLE ingestion.batch_manifests IS
  'Immutable analytical lineage anchor matching the control-plane batch_id and the raw-payloads object key.';

CREATE TABLE IF NOT EXISTS ingestion.source_records (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  connector_key text NOT NULL CHECK (connector_key ~ '^[a-z][a-z0-9_-]*$'),
  stream text NOT NULL,
  source_object_type text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  normalized_schema_version text NOT NULL,
  normalized_payload jsonb NOT NULL,
  tombstone boolean NOT NULL DEFAULT false,
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(normalized_payload) = 'object'),
  CHECK (length(btrim(source_object_type)) > 0),
  CHECK (length(btrim(source_record_id)) > 0)
);

COMMENT ON TABLE ingestion.source_records IS
  'Vendor-neutral M2 landing seam. Packs additionally land typed projections in source_* tables; exact payloads remain only in immutable raw storage.';

CREATE TABLE IF NOT EXISTS ingestion.quarantine_records (
  tenant_id text NOT NULL,
  quarantine_id text NOT NULL CHECK (ingestion.is_ulid(quarantine_id)),
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  payload_batch_id text NOT NULL,
  stream text NOT NULL,
  source_object_type text NOT NULL,
  source_record_id text,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  raw_object_key text NOT NULL,
  error_code text NOT NULL CHECK (error_code ~ '^[a-z][a-z0-9_.-]*$'),
  error_path text,
  error_summary text NOT NULL,
  mapping_version text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    REFERENCES ingestion.quarantine_status_lookup(status),
  replayed_in_sync_run_id text,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (tenant_id, quarantine_id),
  UNIQUE NULLS NOT DISTINCT (
    tenant_id, payload_batch_id, source_object_type, source_record_id, error_code, error_path
  ),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT,
  CHECK (length(btrim(error_summary)) > 0),
  CHECK ((status = 'open' AND resolved_at IS NULL) OR (status <> 'open' AND resolved_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ingestion.landing_commits (
  tenant_id text NOT NULL,
  landing_commit_id text NOT NULL CHECK (ingestion.is_ulid(landing_commit_id)),
  batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  status text NOT NULL REFERENCES ingestion.landing_status_lookup(status),
  staged_record_count bigint NOT NULL CHECK (staged_record_count >= 0),
  quarantine_count bigint NOT NULL CHECK (quarantine_count >= 0),
  mapping_version text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, landing_commit_id),
  UNIQUE (tenant_id, batch_id, mapping_version),
  FOREIGN KEY (tenant_id, batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS batch_manifests_tenant_connection_idx
  ON ingestion.batch_manifests (tenant_id, connection_id, stream, extracted_at DESC);
CREATE INDEX IF NOT EXISTS source_records_tenant_stream_watermark_idx
  ON ingestion.source_records (tenant_id, connector_key, stream, source_updated_at DESC);
CREATE INDEX IF NOT EXISTS source_records_tenant_batch_idx
  ON ingestion.source_records (tenant_id, payload_batch_id);
CREATE INDEX IF NOT EXISTS quarantine_records_tenant_status_idx
  ON ingestion.quarantine_records (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS landing_commits_tenant_batch_idx
  ON ingestion.landing_commits (tenant_id, batch_id, committed_at DESC);

CREATE OR REPLACE FUNCTION ingestion.reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS batch_manifests_reject_mutation ON ingestion.batch_manifests;
CREATE TRIGGER batch_manifests_reject_mutation
  BEFORE UPDATE OR DELETE ON ingestion.batch_manifests
  FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_mutation();

DROP TRIGGER IF EXISTS landing_commits_reject_mutation ON ingestion.landing_commits;
CREATE TRIGGER landing_commits_reject_mutation
  BEFORE UPDATE OR DELETE ON ingestion.landing_commits
  FOR EACH ROW EXECUTE FUNCTION ingestion.reject_immutable_mutation();

ALTER TABLE ingestion.batch_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.batch_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.source_records FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.quarantine_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.quarantine_records FORCE ROW LEVEL SECURITY;
ALTER TABLE ingestion.landing_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.landing_commits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope ON ingestion.batch_manifests;
CREATE POLICY tenant_scope ON ingestion.batch_manifests
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());
DROP POLICY IF EXISTS tenant_scope ON ingestion.source_records;
CREATE POLICY tenant_scope ON ingestion.source_records
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());
DROP POLICY IF EXISTS tenant_scope ON ingestion.quarantine_records;
CREATE POLICY tenant_scope ON ingestion.quarantine_records
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());
DROP POLICY IF EXISTS tenant_scope ON ingestion.landing_commits;
CREATE POLICY tenant_scope ON ingestion.landing_commits
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

REVOKE ALL ON SCHEMA ingestion, source_lightspeed, source_xero, source_deputy FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ingestion FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ingestion FROM PUBLIC;

GRANT USAGE ON SCHEMA ingestion, source_lightspeed, source_xero, source_deputy
  TO ingest_rw, transform_rw, diagnostic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO diagnostic_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO transform_rw;
GRANT SELECT, INSERT ON ingestion.batch_manifests, ingestion.landing_commits TO ingest_rw;
GRANT SELECT, INSERT, UPDATE ON ingestion.source_records, ingestion.quarantine_records TO ingest_rw;
GRANT EXECUTE ON FUNCTION ingestion.is_ulid(text), ingestion.current_tenant_id()
  TO ingest_rw, transform_rw, diagnostic_ro;

-- Pack migrations inherit these least-privilege defaults when the migration
-- owner creates typed source tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA source_lightspeed
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA source_xero
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA source_deputy
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA source_lightspeed
  GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA source_xero
  GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA source_deputy
  GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro;

-- semantic_ro receives no M2 grants. The M5 allowlist migration grants only
-- approved core/mart objects and documented source-extension fields.

COMMIT;
