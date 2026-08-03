BEGIN;

-- Section 19 row samples are exceptional, explicit data access. The browser
-- first creates a short-lived, table-specific grant through the authenticated
-- operator boundary. A separately deployed diagnostic service consumes that
-- grant exactly once and records an outcome before any sampled rows are
-- returned to the operator.

CREATE TABLE IF NOT EXISTS control_plane.operator_diagnostic_reveal_requests (
  reveal_id text PRIMARY KEY CHECK (control_plane.is_ulid(reveal_id)),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  tenant_id text NOT NULL CHECK (control_plane.is_ulid(tenant_id)),
  pipeline_stage text NOT NULL CHECK (pipeline_stage IN ('staging','canonical','marts')),
  schema_name text NOT NULL CHECK (schema_name IN ('source_lightspeed','source_xero','source_deputy','core','mart')),
  table_name text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  row_limit integer NOT NULL CHECK (row_limit BETWEEN 1 AND 5),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '90 seconds'),
  CHECK (
    (pipeline_stage='staging' AND schema_name IN ('source_lightspeed','source_xero','source_deputy'))
    OR (pipeline_stage='canonical' AND schema_name='core')
    OR (pipeline_stage='marts' AND schema_name='mart')
  )
);

CREATE TABLE IF NOT EXISTS control_plane.operator_diagnostic_reveal_claims (
  reveal_id text PRIMARY KEY REFERENCES control_plane.operator_diagnostic_reveal_requests(reveal_id) ON DELETE RESTRICT,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS control_plane.operator_diagnostic_reveal_outcomes (
  reveal_id text PRIMARY KEY REFERENCES control_plane.operator_diagnostic_reveal_requests(reveal_id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('completed','failed')),
  row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 5),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status='completed' AND error_code IS NULL) OR (status='failed' AND error_code IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS operator_diagnostic_reveal_requests_actor_idx
  ON control_plane.operator_diagnostic_reveal_requests (actor_user_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS operator_diagnostic_reveal_requests_tenant_idx
  ON control_plane.operator_diagnostic_reveal_requests (tenant_id,requested_at DESC);

ALTER TABLE control_plane.operator_diagnostic_reveal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.operator_diagnostic_reveal_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.operator_diagnostic_reveal_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.operator_diagnostic_reveal_claims NO FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.operator_diagnostic_reveal_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.operator_diagnostic_reveal_outcomes NO FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.reject_operator_diagnostic_reveal_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'operator diagnostic reveal records are append-only' USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS operator_diagnostic_reveal_requests_reject_mutation
  ON control_plane.operator_diagnostic_reveal_requests;
CREATE TRIGGER operator_diagnostic_reveal_requests_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.operator_diagnostic_reveal_requests
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_operator_diagnostic_reveal_mutation();
DROP TRIGGER IF EXISTS operator_diagnostic_reveal_claims_reject_mutation
  ON control_plane.operator_diagnostic_reveal_claims;
CREATE TRIGGER operator_diagnostic_reveal_claims_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.operator_diagnostic_reveal_claims
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_operator_diagnostic_reveal_mutation();
DROP TRIGGER IF EXISTS operator_diagnostic_reveal_outcomes_reject_mutation
  ON control_plane.operator_diagnostic_reveal_outcomes;
CREATE TRIGGER operator_diagnostic_reveal_outcomes_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.operator_diagnostic_reveal_outcomes
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_operator_diagnostic_reveal_mutation();

CREATE OR REPLACE FUNCTION public.begin_albert_operator_row_reveal(
  p_reveal_id text,
  p_tenant_id text,
  p_pipeline_stage text,
  p_schema_name text,
  p_table_name text,
  p_row_limit integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  actor uuid:=auth.uid();
  issued_at timestamptz:=clock_timestamp();
  expiry timestamptz:=issued_at+interval '60 seconds';
BEGIN
  IF actor IS NULL OR NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE='42501';
  END IF;
  IF NOT control_plane.is_ulid(p_reveal_id)
     OR NOT control_plane.is_ulid(p_tenant_id)
     OR p_pipeline_stage NOT IN ('staging','canonical','marts')
     OR p_schema_name NOT IN ('source_lightspeed','source_xero','source_deputy','core','mart')
     OR p_table_name !~ '^[a-z_][a-z0-9_]{0,62}$'
     OR p_row_limit NOT BETWEEN 1 AND 5
     OR NOT (
       (p_pipeline_stage='staging' AND p_schema_name IN ('source_lightspeed','source_xero','source_deputy'))
       OR (p_pipeline_stage='canonical' AND p_schema_name='core')
       OR (p_pipeline_stage='marts' AND p_schema_name='mart')
     ) THEN
    RAISE EXCEPTION 'operator row reveal request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.tenants tenant
    WHERE tenant.tenant_id=p_tenant_id AND tenant.status<>'deleted'
  ) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE='P0002';
  END IF;
  -- This is the identifier allowlist. A table is revealable only when the
  -- post-sync/hourly projection has observed that exact tenant/schema/table.
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.pipeline_stats stat
    WHERE stat.tenant_id=p_tenant_id
      AND stat.schema_name=p_schema_name
      AND stat.table_name=p_table_name
  ) THEN
    RAISE EXCEPTION 'table is not present in the tenant pipeline snapshot' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('operator-row-reveal-rate:'||actor::text,0)
  );
  IF (
    SELECT count(*) FROM control_plane.operator_diagnostic_reveal_requests request
    WHERE request.actor_user_id=actor AND request.requested_at>issued_at-interval '1 minute'
  ) >= 20 THEN
    RAISE EXCEPTION 'operator row reveal rate limit exceeded' USING ERRCODE='P0001';
  END IF;

  INSERT INTO control_plane.operator_diagnostic_reveal_requests (
    reveal_id,actor_user_id,tenant_id,pipeline_stage,schema_name,table_name,
    row_limit,requested_at,expires_at
  ) VALUES (
    p_reveal_id,actor,p_tenant_id,p_pipeline_stage,p_schema_name,p_table_name,
    p_row_limit,issued_at,expiry
  );
  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata
  ) VALUES (
    control_plane.generate_ulid(),actor,'operator.row_sample_reveal_requested',p_tenant_id,
    jsonb_build_object(
      'reveal_id',p_reveal_id,'stage',p_pipeline_stage,'schema_name',p_schema_name,
      'table_name',p_table_name,'row_limit',p_row_limit
    )
  );
  RETURN jsonb_build_object('reveal_id',p_reveal_id,'expires_at',expiry);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_operator_diagnostic_reveal(p_reveal_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  request control_plane.operator_diagnostic_reveal_requests%ROWTYPE;
BEGIN
  IF NOT control_plane.is_ulid(p_reveal_id) THEN
    RAISE EXCEPTION 'diagnostic reveal identifier is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO request
    FROM control_plane.operator_diagnostic_reveal_requests candidate
    WHERE candidate.reveal_id=p_reveal_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diagnostic reveal was not found' USING ERRCODE='P0002';
  END IF;
  IF request.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'diagnostic reveal grant expired' USING ERRCODE='57014';
  END IF;
  INSERT INTO control_plane.operator_diagnostic_reveal_claims (reveal_id)
  VALUES (p_reveal_id);
  RETURN jsonb_build_object(
    'reveal_id',request.reveal_id,'tenant_id',request.tenant_id,
    'pipeline_stage',request.pipeline_stage,'schema_name',request.schema_name,
    'table_name',request.table_name,'row_limit',request.row_limit,
    'expires_at',request.expires_at
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'diagnostic reveal grant was already consumed' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_operator_diagnostic_reveal(
  p_reveal_id text,
  p_status text,
  p_row_count integer,
  p_error_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  request control_plane.operator_diagnostic_reveal_requests%ROWTYPE;
BEGIN
  IF p_status NOT IN ('completed','failed') OR p_row_count NOT BETWEEN 0 AND 5
     OR (p_status='completed' AND p_error_code IS NOT NULL)
     OR (p_status='failed' AND (p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$')) THEN
    RAISE EXCEPTION 'diagnostic reveal outcome is invalid' USING ERRCODE='22023';
  END IF;
  SELECT * INTO request FROM control_plane.operator_diagnostic_reveal_requests
  WHERE reveal_id=p_reveal_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM control_plane.operator_diagnostic_reveal_claims WHERE reveal_id=p_reveal_id
  ) THEN
    RAISE EXCEPTION 'claimed diagnostic reveal was not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO control_plane.operator_diagnostic_reveal_outcomes (
    reveal_id,status,row_count,error_code
  ) VALUES (p_reveal_id,p_status,p_row_count,p_error_code);
  INSERT INTO control_plane.operator_audit_log (
    operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata
  ) VALUES (
    control_plane.generate_ulid(),request.actor_user_id,
    CASE p_status WHEN 'completed' THEN 'operator.row_sample_reveal_completed'
      ELSE 'operator.row_sample_reveal_failed' END,
    request.tenant_id,
    jsonb_build_object(
      'reveal_id',p_reveal_id,'stage',request.pipeline_stage,
      'schema_name',request.schema_name,'table_name',request.table_name,
      'row_limit',request.row_limit,'row_count',p_row_count,
      'status',p_status,'error_code',p_error_code
    )
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'diagnostic reveal outcome was already recorded' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_operator_diagnostic_control_ready()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  login_role name:=session_user;
BEGIN
  IF login_role IN ('postgres','supabase_admin','albert_control_migration_owner') THEN
    RETURN true;
  END IF;
  IF login_role<>'albert_operator_diagnostic_control_runtime'
     OR NOT pg_catalog.pg_has_role(login_role,'albert_operator_diagnostic_control','member')
     OR (SELECT count(*) FROM pg_catalog.pg_auth_members membership
         JOIN pg_catalog.pg_roles member ON member.oid=membership.member
         WHERE member.rolname=login_role)<>1 THEN
    RAISE EXCEPTION 'operator diagnostic control login has an unsafe role boundary' USING ERRCODE='42501';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON TABLE
  control_plane.operator_diagnostic_reveal_requests,
  control_plane.operator_diagnostic_reveal_claims,
  control_plane.operator_diagnostic_reveal_outcomes
FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION control_plane.reject_operator_diagnostic_reveal_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_albert_operator_row_reveal(text,text,text,text,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.claim_operator_diagnostic_reveal(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.complete_operator_diagnostic_reveal(text,text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION control_plane.assert_operator_diagnostic_control_ready() FROM PUBLIC;

GRANT USAGE ON SCHEMA control_plane TO albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION public.begin_albert_operator_row_reveal(text,text,text,text,text,integer)
  TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.claim_operator_diagnostic_reveal(text),
  control_plane.complete_operator_diagnostic_reveal(text,text,integer,text),
  control_plane.assert_operator_diagnostic_control_ready()
  TO albert_operator_diagnostic_control;

COMMIT;
