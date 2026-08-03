BEGIN;

CREATE TABLE IF NOT EXISTS semantic_internal.query_audit (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  query_id text NOT NULL CHECK (core.is_ulid(query_id)),
  conversation_id text NOT NULL CHECK (core.is_ulid(conversation_id)),
  turn_id text NOT NULL CHECK (core.is_ulid(turn_id)),
  actor_role text NOT NULL CHECK (actor_role IN ('owner','manager','bookkeeper','internal_operator')),
  route text NOT NULL CHECK (route IN ('semantic','source_exploration')),
  topic text,
  bundle_hash text NOT NULL CHECK (bundle_hash ~ '^[a-f0-9]{64}$'),
  registry_version text NOT NULL,
  ir jsonb NOT NULL CHECK (jsonb_typeof(ir)='object'),
  compiled_sql text NOT NULL,
  parameter_count integer NOT NULL CHECK (parameter_count>=1),
  result_digest text,
  row_count integer CHECK (row_count>=0),
  duration_ms integer CHECK (duration_ms>=0),
  answer_state text NOT NULL CHECK (answer_state IN ('verified','qualified','exploratory','clarification','unavailable')),
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,query_id)
);

CREATE TABLE IF NOT EXISTS semantic_internal.source_field_allowlist (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connector_id text NOT NULL,
  source_schema text NOT NULL CHECK (source_schema ~ '^source_[a-z0-9_]+$'),
  source_table text NOT NULL CHECK (source_table ~ '^[a-z_][a-z0-9_]*$'),
  source_field text NOT NULL CHECK (source_field ~ '^[a-z_][a-z0-9_]*$'),
  field_type text NOT NULL CHECK (field_type IN ('text','integer','decimal','boolean','date','timestamp')),
  disposition text NOT NULL CHECK (disposition='governed_source_extension'),
  pii_class text NOT NULL CHECK (pii_class IN ('none','business','customer_contact','payroll','sensitive_personal')),
  authority_concept text REFERENCES core.authority_concept_lookup(value),
  documented_definition text NOT NULL,
  pack_version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,connection_id,source_table,source_field)
);

CREATE TABLE IF NOT EXISTS semantic_internal.promotion_candidate_outbox (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  candidate_id text NOT NULL CHECK (core.is_ulid(candidate_id)),
  query_id text NOT NULL CHECK (core.is_ulid(query_id)),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  connector_id text NOT NULL,
  source_table text NOT NULL,
  source_fields text[] NOT NULL CHECK (cardinality(source_fields)>0),
  question_digest text NOT NULL CHECK (question_digest ~ '^[a-f0-9]{64}$'),
  requested_metric_concept text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (tenant_id,candidate_id)
);

CREATE INDEX IF NOT EXISTS query_audit_tenant_created_idx ON semantic_internal.query_audit (tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS source_allowlist_tenant_connector_idx ON semantic_internal.source_field_allowlist (tenant_id,connection_id,active);
CREATE INDEX IF NOT EXISTS promotion_outbox_tenant_unpublished_idx ON semantic_internal.promotion_candidate_outbox (tenant_id,created_at) WHERE published_at IS NULL;

ALTER TABLE semantic_internal.query_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.query_audit FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.source_field_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.source_field_allowlist FORCE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.promotion_candidate_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.promotion_candidate_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON semantic_internal.query_audit
USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id());
CREATE POLICY tenant_isolation ON semantic_internal.source_field_allowlist
USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id());
CREATE POLICY tenant_isolation ON semantic_internal.promotion_candidate_outbox
USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id());

CREATE OR REPLACE FUNCTION semantic_internal.reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'semantic audit evidence is append-only' USING ERRCODE='42501'; END $$;

CREATE TRIGGER query_audit_append_only BEFORE UPDATE OR DELETE ON semantic_internal.query_audit
FOR EACH ROW EXECUTE FUNCTION semantic_internal.reject_audit_mutation();

REVOKE ALL ON ALL TABLES IN SCHEMA semantic_internal FROM PUBLIC,semantic_ro;
GRANT USAGE ON SCHEMA semantic_internal TO semantic_ro,transform_rw,diagnostic_ro;
GRANT SELECT ON semantic_internal.source_field_allowlist TO semantic_ro;
GRANT SELECT,INSERT ON semantic_internal.query_audit,semantic_internal.promotion_candidate_outbox TO transform_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA semantic_internal TO diagnostic_ro;

COMMIT;
