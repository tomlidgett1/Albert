BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_sync_control')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_control_migration_owner') THEN
    RAISE EXCEPTION 'Run the control-plane role bootstrap before Shopify Admin read-plane migration.'
      USING ERRCODE='55000';
  END IF;
  IF to_regclass('control_plane.shopify_protected_data_approvals') IS NULL THEN
    RAISE EXCEPTION 'Apply migration 0133 before the Shopify Admin read-plane migration.'
      USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE TABLE control_plane.shopify_admin_query_execution_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.shopify_admin_query_execution_status_lookup (
  status,description
) VALUES
  ('reserved','The one-use request is authorized and reserved but not yet completed'),
  ('succeeded','Admin GraphQL returned a bounded response that passed validation'),
  ('failed','Execution terminated with a governed code-only failure'),
  ('response_rejected','Shopify returned a response that exceeded or violated the governed result contract');

CREATE TABLE control_plane.shopify_admin_catalogue_searches (
  tenant_id text NOT NULL REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  request_id text NOT NULL UNIQUE CHECK (control_plane.is_ulid(request_id)),
  actor_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('owner','manager')),
  conversation_id text NOT NULL CHECK (control_plane.is_ulid(conversation_id)),
  turn_id text NOT NULL CHECK (control_plane.is_ulid(turn_id)),
  search_digest text NOT NULL CHECK (search_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,request_id)
);

CREATE INDEX shopify_admin_catalogue_turn_limit_idx
  ON control_plane.shopify_admin_catalogue_searches(tenant_id,conversation_id,turn_id,occurred_at);

COMMENT ON TABLE control_plane.shopify_admin_catalogue_searches IS
  'One-use actor-authorized searches over the public committed Admin GraphQL 2026-07 registry. Search terms are retained only by digest.';

CREATE TABLE control_plane.shopify_admin_query_executions (
  tenant_id text NOT NULL,
  request_id text NOT NULL UNIQUE CHECK (control_plane.is_ulid(request_id)),
  actor_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('owner','manager')),
  conversation_id text NOT NULL CHECK (control_plane.is_ulid(conversation_id)),
  turn_id text NOT NULL CHECK (control_plane.is_ulid(turn_id)),
  connection_id text NOT NULL,
  connection_generation bigint NOT NULL CHECK (connection_generation > 0),
  api_version text NOT NULL CHECK (api_version='2026-07'),
  registry_sha256 text NOT NULL CHECK (registry_sha256 ~ '^[a-f0-9]{64}$'),
  query_digest text NOT NULL CHECK (query_digest ~ '^[a-f0-9]{64}$'),
  root_field text NOT NULL CHECK (root_field ~ '^[_A-Za-z][_0-9A-Za-z]*$'),
  selected_field_count integer NOT NULL CHECK (selected_field_count BETWEEN 1 AND 40),
  required_scopes text[] NOT NULL CHECK (cardinality(required_scopes) <= 80),
  requires_level2 boolean NOT NULL,
  approval_evidence_digest text CHECK (
    approval_evidence_digest IS NULL OR approval_evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  status text NOT NULL
    REFERENCES control_plane.shopify_admin_query_execution_status_lookup(status),
  result_leaf_count integer CHECK (result_leaf_count BETWEEN 0 AND 200),
  response_bytes integer CHECK (response_bytes BETWEEN 0 AND 524288),
  response_digest text CHECK (response_digest IS NULL OR response_digest ~ '^[a-f0-9]{64}$'),
  scope_evidence_digest text CHECK (scope_evidence_digest IS NULL OR scope_evidence_digest ~ '^[a-f0-9]{64}$'),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 120000),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^shopify_admin_[a-z0-9_]{1,90}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,request_id),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  CHECK ((requires_level2 AND approval_evidence_digest IS NOT NULL)
      OR (NOT requires_level2 AND approval_evidence_digest IS NULL)),
  CHECK (
    (status='reserved' AND completed_at IS NULL AND result_leaf_count IS NULL AND response_bytes IS NULL)
    OR
    (status<>'reserved' AND completed_at IS NOT NULL AND result_leaf_count IS NOT NULL AND response_bytes IS NOT NULL)
  )
);

CREATE INDEX shopify_admin_query_turn_limit_idx
  ON control_plane.shopify_admin_query_executions(tenant_id,conversation_id,turn_id,created_at);
CREATE INDEX shopify_admin_query_connection_audit_idx
  ON control_plane.shopify_admin_query_executions(tenant_id,connection_id,connection_generation,created_at DESC);

COMMENT ON TABLE control_plane.shopify_admin_query_executions IS
  'Metadata-only one-use audit for registry-compiled Admin queries. It stores no GraphQL text, variables, result values, credential, token, or shop domain.';

ALTER TABLE control_plane.shopify_admin_catalogue_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_admin_catalogue_searches FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_admin_query_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_admin_query_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY shopify_admin_catalogue_sync_read
  ON control_plane.shopify_admin_catalogue_searches FOR SELECT TO albert_sync_control USING (true);
CREATE POLICY shopify_admin_catalogue_sync_insert
  ON control_plane.shopify_admin_catalogue_searches FOR INSERT TO albert_sync_control WITH CHECK (true);
CREATE POLICY shopify_admin_catalogue_migration_owner_access
  ON control_plane.shopify_admin_catalogue_searches FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);
CREATE POLICY shopify_admin_execution_sync_read
  ON control_plane.shopify_admin_query_executions FOR SELECT TO albert_sync_control USING (true);
CREATE POLICY shopify_admin_execution_sync_insert
  ON control_plane.shopify_admin_query_executions FOR INSERT TO albert_sync_control WITH CHECK (true);
CREATE POLICY shopify_admin_execution_sync_update
  ON control_plane.shopify_admin_query_executions FOR UPDATE TO albert_sync_control USING (true) WITH CHECK (true);
CREATE POLICY shopify_admin_execution_migration_owner_access
  ON control_plane.shopify_admin_query_executions FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE
  control_plane.shopify_admin_query_execution_status_lookup,
  control_plane.shopify_admin_catalogue_searches,
  control_plane.shopify_admin_query_executions
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_control_migration_owner,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,albert_deletion_control;

GRANT SELECT,INSERT ON control_plane.shopify_admin_catalogue_searches TO albert_sync_control;
GRANT SELECT,INSERT ON control_plane.shopify_admin_query_executions TO albert_sync_control;
GRANT UPDATE(status,result_leaf_count,response_bytes,response_digest,scope_evidence_digest,duration_ms,error_code,completed_at)
  ON control_plane.shopify_admin_query_executions TO albert_sync_control;
GRANT ALL ON TABLE
  control_plane.shopify_admin_query_execution_status_lookup,
  control_plane.shopify_admin_catalogue_searches,
  control_plane.shopify_admin_query_executions
TO albert_control_migration_owner;

COMMIT;
