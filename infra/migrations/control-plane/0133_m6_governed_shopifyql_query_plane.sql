BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_sync_control') THEN
    RAISE EXCEPTION 'Run the control-plane role bootstrap before ShopifyQL query-plane migration.'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='albert_control_migration_owner'
  ) THEN
    RAISE EXCEPTION 'Run the control-plane role bootstrap before ShopifyQL query-plane migration.'
      USING ERRCODE='55000';
  END IF;
END;
$$;

-- ShopifyQL execution includes a distinct parse_error terminal state. Keep it
-- separate from Admin GraphQL execution so neither query plane silently admits
-- states that its completion protocol cannot produce.
CREATE TABLE control_plane.shopifyql_query_execution_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.shopifyql_query_execution_status_lookup (
  status,description
) VALUES
  ('reserved','The one-use request is authorized and reserved but not yet completed'),
  ('succeeded','ShopifyQL returned a bounded response that passed validation'),
  ('parse_error','Shopify rejected the compiled ShopifyQL query as invalid'),
  ('failed','Execution terminated with a governed code-only failure'),
  ('response_rejected','Shopify returned a response that exceeded or violated the governed result contract');

-- App-wide Shopify Partner Dashboard approval evidence. This table has no
-- tenant or caller-controlled write path. A migration owner records the
-- reviewed Level-2 approval receipt digest using the production app client ID
-- hash; the credential worker can only read active evidence.
CREATE TABLE control_plane.shopify_protected_data_approvals (
  app_client_id_sha256 text PRIMARY KEY CHECK (app_client_id_sha256 ~ '^[a-f0-9]{64}$'),
  protected_data_level integer NOT NULL CHECK (protected_data_level=2),
  api_version text NOT NULL CHECK (api_version='2026-07'),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_reference text NOT NULL CHECK (
    length(btrim(evidence_reference)) BETWEEN 1 AND 500
    AND evidence_reference !~ '[\r\n\t]'
  ),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > approved_at),
  CHECK (revoked_at IS NULL OR revoked_at >= approved_at)
);

COMMENT ON TABLE control_plane.shopify_protected_data_approvals IS
  'Operator-controlled evidence that the production Shopify app passed Level-2 protected-customer-data review. Never inferred from a request boolean.';
COMMENT ON COLUMN control_plane.shopify_protected_data_approvals.evidence_reference IS
  'Non-secret operator reference only. Store a receipt/ticket identifier, never Shopify credentials or protected data.';

CREATE TABLE control_plane.shopifyql_catalogue_searches (
  tenant_id text NOT NULL REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  request_id text NOT NULL UNIQUE CHECK (control_plane.is_ulid(request_id)),
  -- Authenticated actor UUIDs are checked against memberships at execution
  -- time. New migrations must not depend directly on Supabase-owned auth
  -- relations (see the immutable auth compatibility boundary in 0042).
  actor_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('owner','manager')),
  conversation_id text NOT NULL CHECK (control_plane.is_ulid(conversation_id)),
  turn_id text NOT NULL CHECK (control_plane.is_ulid(turn_id)),
  search_digest text NOT NULL CHECK (search_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,request_id)
);

CREATE INDEX shopifyql_catalogue_turn_limit_idx
  ON control_plane.shopifyql_catalogue_searches(tenant_id,conversation_id,turn_id,occurred_at);

COMMENT ON TABLE control_plane.shopifyql_catalogue_searches IS
  'Bounded, actor-authorized audit of searches over the committed public ShopifyQL schema registry. Search text is represented only by a digest.';

CREATE TABLE control_plane.shopifyql_query_executions (
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
  schema_name text NOT NULL CHECK (schema_name ~ '^[a-z][a-z0-9_]*$'),
  since_date date NOT NULL,
  until_date date NOT NULL,
  row_limit integer NOT NULL CHECK (row_limit BETWEEN 1 AND 250),
  approval_evidence_digest text NOT NULL CHECK (approval_evidence_digest ~ '^[a-f0-9]{64}$'),
  status text NOT NULL
    REFERENCES control_plane.shopifyql_query_execution_status_lookup(status),
  row_count integer CHECK (row_count BETWEEN 0 AND 250),
  -- Failed oversize attempts can be above the 512-KiB response ceiling; keep
  -- their bounded observed size for audit without ever returning the payload.
  response_bytes integer CHECK (response_bytes BETWEEN 0 AND 1048576),
  response_digest text CHECK (response_digest IS NULL OR response_digest ~ '^[a-f0-9]{64}$'),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 120000),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^shopifyql_[a-z0-9_]{1,90}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id,request_id),
  FOREIGN KEY (tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  CHECK (until_date >= since_date),
  CHECK ((until_date-since_date)+1 BETWEEN 1 AND 366),
  CHECK (
    (status='reserved' AND completed_at IS NULL AND row_count IS NULL AND response_bytes IS NULL)
    OR
    (status<>'reserved' AND completed_at IS NOT NULL AND row_count IS NOT NULL AND response_bytes IS NOT NULL)
  )
);

CREATE INDEX shopifyql_query_turn_limit_idx
  ON control_plane.shopifyql_query_executions(tenant_id,conversation_id,turn_id,created_at);
CREATE INDEX shopifyql_query_connection_audit_idx
  ON control_plane.shopifyql_query_executions(tenant_id,connection_id,connection_generation,created_at DESC);

COMMENT ON TABLE control_plane.shopifyql_query_executions IS
  'Metadata-only ShopifyQL authorization/execution audit and one-use request ledger. It deliberately stores no compiled query text, filter literals, result rows, token or shop domain.';

ALTER TABLE control_plane.shopify_protected_data_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopify_protected_data_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopifyql_catalogue_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopifyql_catalogue_searches FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopifyql_query_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.shopifyql_query_executions FORCE ROW LEVEL SECURITY;

CREATE POLICY shopify_pcd_sync_read
  ON control_plane.shopify_protected_data_approvals
  FOR SELECT TO albert_sync_control USING (true);
CREATE POLICY shopify_pcd_migration_owner_access
  ON control_plane.shopify_protected_data_approvals
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);
CREATE POLICY shopifyql_catalogue_sync_read
  ON control_plane.shopifyql_catalogue_searches
  FOR SELECT TO albert_sync_control USING (true);
CREATE POLICY shopifyql_catalogue_sync_insert
  ON control_plane.shopifyql_catalogue_searches
  FOR INSERT TO albert_sync_control WITH CHECK (true);
CREATE POLICY shopifyql_catalogue_migration_owner_access
  ON control_plane.shopifyql_catalogue_searches
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);
CREATE POLICY shopifyql_execution_sync_read
  ON control_plane.shopifyql_query_executions
  FOR SELECT TO albert_sync_control USING (true);
CREATE POLICY shopifyql_execution_sync_insert
  ON control_plane.shopifyql_query_executions
  FOR INSERT TO albert_sync_control WITH CHECK (true);
CREATE POLICY shopifyql_execution_sync_update
  ON control_plane.shopifyql_query_executions
  FOR UPDATE TO albert_sync_control USING (true) WITH CHECK (true);
CREATE POLICY shopifyql_execution_migration_owner_access
  ON control_plane.shopifyql_query_executions
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE
  control_plane.shopifyql_query_execution_status_lookup,
  control_plane.shopify_protected_data_approvals,
  control_plane.shopifyql_catalogue_searches,
  control_plane.shopifyql_query_executions
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_control_migration_owner,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;

GRANT SELECT ON control_plane.shopify_protected_data_approvals TO albert_sync_control;
GRANT SELECT,INSERT ON control_plane.shopifyql_catalogue_searches TO albert_sync_control;
GRANT SELECT,INSERT ON control_plane.shopifyql_query_executions TO albert_sync_control;
GRANT UPDATE(status,row_count,response_bytes,response_digest,duration_ms,error_code,completed_at)
  ON control_plane.shopifyql_query_executions TO albert_sync_control;
GRANT ALL ON TABLE
  control_plane.shopifyql_query_execution_status_lookup,
  control_plane.shopify_protected_data_approvals,
  control_plane.shopifyql_catalogue_searches,
  control_plane.shopifyql_query_executions
TO albert_control_migration_owner;

COMMIT;
