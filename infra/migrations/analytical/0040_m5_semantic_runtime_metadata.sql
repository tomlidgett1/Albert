BEGIN;

-- Narrow semantic runtime metadata. Analytical SELECTs still execute exclusively
-- as semantic_ro; semantic_meta_rw can mutate only cache and audit/outbox rows.

CREATE TABLE IF NOT EXISTS semantic_internal.tenant_capability (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  capability text NOT NULL CHECK (capability ~ '^[a-z][a-z0-9_.]*$'),
  source_key text NOT NULL,
  connection_id text,
  connector_id text NOT NULL,
  available boolean NOT NULL,
  reason_code text,
  pack_version text NOT NULL,
  source_watermark timestamptz,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,capability,source_key)
);

CREATE TABLE IF NOT EXISTS semantic_internal.result_cache (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[a-f0-9]{64}$'),
  registry_version text NOT NULL,
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,bundle_hash)
);

CREATE INDEX IF NOT EXISTS tenant_capability_tenant_available_idx
  ON semantic_internal.tenant_capability (tenant_id,available,capability);
CREATE INDEX IF NOT EXISTS result_cache_tenant_expiry_idx
  ON semantic_internal.result_cache (tenant_id,expires_at);

ALTER TABLE semantic_internal.tenant_capability ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.tenant_capability FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.result_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.result_cache FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON semantic_internal.tenant_capability
USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id());
CREATE POLICY tenant_isolation ON semantic_internal.result_cache
USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id());

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='semantic_meta_rw') THEN
    RAISE EXCEPTION 'semantic_meta_rw is missing; run the administrative role bootstrap first'
      USING ERRCODE='0A000';
  END IF;
END $$;

REVOKE ALL ON semantic_internal.tenant_capability,semantic_internal.result_cache FROM PUBLIC;
GRANT USAGE ON SCHEMA semantic_internal,core TO semantic_meta_rw;
GRANT SELECT,INSERT,UPDATE,DELETE ON semantic_internal.result_cache TO semantic_meta_rw;
GRANT SELECT,INSERT ON semantic_internal.query_audit,semantic_internal.promotion_candidate_outbox TO semantic_meta_rw;
GRANT SELECT ON semantic_internal.tenant_capability,semantic_internal.source_field_allowlist TO semantic_ro,semantic_meta_rw;
GRANT SELECT,INSERT,UPDATE,DELETE ON semantic_internal.tenant_capability TO transform_rw;
GRANT SELECT ON semantic_internal.tenant_capability,semantic_internal.result_cache TO diagnostic_ro;

COMMIT;
