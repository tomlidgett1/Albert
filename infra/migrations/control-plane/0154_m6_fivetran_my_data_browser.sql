-- Owner-facing Fivetran data browser.
--
-- The browser never receives a tenant selector or an analytical credential.
-- An owner/manager creates one short-lived request for the currently selected
-- organisation. The isolated diagnostic service claims it exactly once,
-- receives a tenant-bound diagnostic capability, reads only the registered
-- Fivetran destination schema(s), and records a terminal outcome before any
-- catalogue metadata or rows are returned.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.fivetran_my_data_requests (
  request_id text PRIMARY KEY CHECK (control_plane.is_ulid(request_id)),
  actor_user_id uuid NOT NULL,
  tenant_id text NOT NULL REFERENCES control_plane.tenants(tenant_id) ON DELETE RESTRICT,
  request_kind text NOT NULL CHECK (request_kind IN ('catalogue', 'rows')),
  schema_name text CHECK (schema_name IS NULL OR schema_name ~ '^[a-z][a-z0-9_]{0,62}$'),
  table_name text CHECK (table_name IS NULL OR table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  row_offset integer NOT NULL DEFAULT 0 CHECK (row_offset BETWEEN 0 AND 10000000),
  row_limit integer NOT NULL DEFAULT 25 CHECK (row_limit BETWEEN 1 AND 50),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '90 seconds'),
  CHECK (
    (request_kind = 'catalogue' AND schema_name IS NULL AND table_name IS NULL AND row_offset = 0)
    OR
    (request_kind = 'rows' AND schema_name IS NOT NULL AND table_name IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS control_plane.fivetran_my_data_claims (
  request_id text PRIMARY KEY
    REFERENCES control_plane.fivetran_my_data_requests(request_id) ON DELETE CASCADE,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS control_plane.fivetran_my_data_outcomes (
  request_id text PRIMARY KEY
    REFERENCES control_plane.fivetran_my_data_requests(request_id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  result_count integer NOT NULL CHECK (result_count BETWEEN 0 AND 1000),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (status = 'completed' AND error_code IS NULL)
    OR (status = 'failed' AND error_code IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS fivetran_my_data_requests_actor_recent_idx
  ON control_plane.fivetran_my_data_requests (actor_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS fivetran_my_data_requests_tenant_recent_idx
  ON control_plane.fivetran_my_data_requests (tenant_id, requested_at DESC);

ALTER TABLE control_plane.fivetran_my_data_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.fivetran_my_data_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.fivetran_my_data_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.fivetran_my_data_claims NO FORCE ROW LEVEL SECURITY;
ALTER TABLE control_plane.fivetran_my_data_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.fivetran_my_data_outcomes NO FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.reject_fivetran_my_data_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND control_plane.deletion_mutation_authorized() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Fivetran My Data records are append-only' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS fivetran_my_data_requests_reject_mutation
  ON control_plane.fivetran_my_data_requests;
CREATE TRIGGER fivetran_my_data_requests_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.fivetran_my_data_requests
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_fivetran_my_data_mutation();

DROP TRIGGER IF EXISTS fivetran_my_data_claims_reject_mutation
  ON control_plane.fivetran_my_data_claims;
CREATE TRIGGER fivetran_my_data_claims_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.fivetran_my_data_claims
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_fivetran_my_data_mutation();

DROP TRIGGER IF EXISTS fivetran_my_data_outcomes_reject_mutation
  ON control_plane.fivetran_my_data_outcomes;
CREATE TRIGGER fivetran_my_data_outcomes_reject_mutation
  BEFORE UPDATE OR DELETE ON control_plane.fivetran_my_data_outcomes
  FOR EACH ROW EXECUTE FUNCTION control_plane.reject_fivetran_my_data_mutation();

CREATE OR REPLACE FUNCTION public.begin_albert_fivetran_my_data_request(
  p_request_id text,
  p_request_kind text,
  p_schema_name text DEFAULT NULL,
  p_table_name text DEFAULT NULL,
  p_row_offset integer DEFAULT 0,
  p_row_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text;
  selected_role text;
  actor uuid := extensions.albert_auth_uid();
  issued_at timestamptz := clock_timestamp();
  expiry timestamptz := issued_at + interval '60 seconds';
BEGIN
  SELECT admin.tenant_id, admin.role
    INTO selected_tenant, selected_role
    FROM control_plane.current_connection_admin_membership() AS admin;
  IF actor IS NULL OR selected_tenant IS NULL THEN
    RAISE EXCEPTION 'authentication and an active organisation are required'
      USING ERRCODE = '42501';
  END IF;
  IF selected_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'owner or manager access is required' USING ERRCODE = '42501';
  END IF;
  IF NOT coalesce(control_plane.is_ulid(p_request_id), false)
     OR p_request_kind IS NULL OR p_request_kind NOT IN ('catalogue', 'rows')
     OR p_row_offset IS NULL OR p_row_offset NOT BETWEEN 0 AND 10000000
     OR p_row_limit IS NULL OR p_row_limit NOT BETWEEN 1 AND 50
     OR (
       p_request_kind = 'catalogue'
       AND (p_schema_name IS NOT NULL OR p_table_name IS NOT NULL OR p_row_offset <> 0)
     )
     OR (
       p_request_kind = 'rows'
       AND (
         p_schema_name IS NULL OR p_schema_name !~ '^[a-z][a-z0-9_]{0,62}$'
         OR p_table_name IS NULL OR p_table_name !~ '^[a-z_][a-z0-9_]{0,62}$'
       )
     ) THEN
    RAISE EXCEPTION 'Fivetran My Data request is invalid' USING ERRCODE = '22023';
  END IF;

  IF p_request_kind = 'rows' AND NOT EXISTS (
    SELECT 1
      FROM control_plane.fivetran_connections AS connection
     WHERE connection.tenant_id = selected_tenant
       AND connection.destination_schema = p_schema_name
       AND connection.status IN ('connected', 'degraded', 'blocked')
  ) THEN
    RAISE EXCEPTION 'Fivetran destination schema is not connected to this organisation'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('fivetran-my-data-rate:' || actor::text, 0)
  );
  IF (
    SELECT count(*)
      FROM control_plane.fivetran_my_data_requests AS request
     WHERE request.actor_user_id = actor
       AND request.requested_at > issued_at - interval '1 minute'
  ) >= 30 THEN
    RAISE EXCEPTION 'Fivetran My Data request limit exceeded' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO control_plane.fivetran_my_data_requests (
    request_id, actor_user_id, tenant_id, request_kind, schema_name, table_name,
    row_offset, row_limit, requested_at, expires_at
  ) VALUES (
    p_request_id, actor, selected_tenant, p_request_kind, p_schema_name, p_table_name,
    p_row_offset, p_row_limit, issued_at, expiry
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action, resource_type,
    resource_id, request_id, audit_metadata
  ) VALUES (
    selected_tenant, control_plane.generate_ulid(), actor, 'user',
    'fivetran.my_data.requested', 'fivetran_data_browser',
    coalesce(p_schema_name || '.' || p_table_name, 'catalogue'), p_request_id,
    jsonb_build_object(
      'request_kind', p_request_kind,
      'schema_name', p_schema_name,
      'table_name', p_table_name,
      'row_offset', p_row_offset,
      'row_limit', p_row_limit
    )
  );

  RETURN jsonb_build_object('request_id', p_request_id, 'expires_at', expiry);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_fivetran_my_data_request(p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  request control_plane.fivetran_my_data_requests%ROWTYPE;
  sources jsonb;
  capability text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_operator_diagnostic_control_runtime', 'albert_operator_diagnostic_control'
  );
  IF NOT coalesce(control_plane.is_ulid(p_request_id), false) THEN
    RAISE EXCEPTION 'Fivetran My Data request identifier is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO request
    FROM control_plane.fivetran_my_data_requests AS candidate
   WHERE candidate.request_id = p_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fivetran My Data request was not found' USING ERRCODE = 'P0002';
  END IF;
  IF request.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Fivetran My Data request expired' USING ERRCODE = '57014';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM control_plane.memberships AS membership
      JOIN control_plane.tenants AS tenant ON tenant.tenant_id = membership.tenant_id
     WHERE membership.tenant_id = request.tenant_id
       AND membership.user_id = request.actor_user_id
       AND membership.status = 'active'
       AND membership.role IN ('owner', 'manager')
       AND tenant.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Fivetran My Data authority is no longer active'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'connection_id', connection.connection_id,
    'destination_schema', connection.destination_schema,
    'service', connection.service,
    'display_name', connection.display_name,
    'status', connection.status,
    'last_sync_state', nullif(btrim(connection.last_sync_state), ''),
    'updated_at', connection.updated_at
  ) ORDER BY connection.created_at, connection.connection_id), '[]'::jsonb)
    INTO sources
    FROM control_plane.fivetran_connections AS connection
   WHERE connection.tenant_id = request.tenant_id
     AND connection.status IN ('connected', 'degraded', 'blocked')
     AND (
       request.request_kind = 'catalogue'
       OR connection.destination_schema = request.schema_name
     );

  IF request.request_kind = 'rows' AND jsonb_array_length(sources) <> 1 THEN
    RAISE EXCEPTION 'Fivetran destination schema is no longer connected'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO control_plane.fivetran_my_data_claims (request_id)
  VALUES (p_request_id);

  capability := control_plane.sign_analytical_capability(
    request.tenant_id,
    'analytical:diagnostic',
    'diagnostic',
    'fivetran-my-data:' || p_request_id,
    request.expires_at,
    jsonb_build_object(
      'kind', 'fivetran_my_data',
      'request_id', p_request_id,
      'request_kind', request.request_kind,
      'schema_name', request.schema_name,
      'table_name', request.table_name,
      'row_offset', request.row_offset,
      'row_limit', request.row_limit
    )
  );

  RETURN jsonb_build_object(
    'request_id', request.request_id,
    'tenant_id', request.tenant_id,
    'request_kind', request.request_kind,
    'schema_name', request.schema_name,
    'table_name', request.table_name,
    'row_offset', request.row_offset,
    'row_limit', request.row_limit,
    'sources', sources,
    'expires_at', request.expires_at,
    'analytical_capability', capability
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Fivetran My Data request was already consumed' USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_fivetran_my_data_request(
  p_request_id text,
  p_status text,
  p_result_count integer,
  p_error_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  request control_plane.fivetran_my_data_requests%ROWTYPE;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_operator_diagnostic_control_runtime', 'albert_operator_diagnostic_control'
  );
  IF p_status IS NULL OR p_status NOT IN ('completed', 'failed')
     OR p_result_count IS NULL OR p_result_count NOT BETWEEN 0 AND 1000
     OR (p_status = 'completed' AND p_error_code IS NOT NULL)
     OR (
       p_status = 'failed'
       AND (p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$')
     ) THEN
    RAISE EXCEPTION 'Fivetran My Data outcome is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT candidate.* INTO request
    FROM control_plane.fivetran_my_data_requests AS candidate
   WHERE candidate.request_id = p_request_id;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM control_plane.fivetran_my_data_claims AS claim
     WHERE claim.request_id = p_request_id
  ) THEN
    RAISE EXCEPTION 'claimed Fivetran My Data request was not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO control_plane.fivetran_my_data_outcomes (
    request_id, status, result_count, error_code
  ) VALUES (
    p_request_id, p_status, p_result_count, p_error_code
  );

  INSERT INTO control_plane.audit_log (
    tenant_id, audit_id, actor_user_id, actor_type, action, resource_type,
    resource_id, request_id, audit_metadata
  ) VALUES (
    request.tenant_id, control_plane.generate_ulid(), request.actor_user_id, 'user',
    CASE p_status
      WHEN 'completed' THEN 'fivetran.my_data.completed'
      ELSE 'fivetran.my_data.failed'
    END,
    'fivetran_data_browser',
    coalesce(request.schema_name || '.' || request.table_name, 'catalogue'),
    p_request_id,
    jsonb_build_object(
      'request_kind', request.request_kind,
      'schema_name', request.schema_name,
      'table_name', request.table_name,
      'row_offset', request.row_offset,
      'row_limit', request.row_limit,
      'result_count', p_result_count,
      'status', p_status,
      'error_code', p_error_code
    )
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Fivetran My Data outcome was already recorded' USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON TABLE
  control_plane.fivetran_my_data_requests,
  control_plane.fivetran_my_data_claims,
  control_plane.fivetran_my_data_outcomes
FROM PUBLIC, anon, authenticated, service_role,
     albert_sync_control, albert_transform_control, albert_semantic_control,
     albert_webhook_control, albert_deletion_control, albert_operator_diagnostic_control;

REVOKE ALL ON FUNCTION control_plane.reject_fivetran_my_data_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_albert_fivetran_my_data_request(
  text, text, text, text, integer, integer
) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION control_plane.claim_fivetran_my_data_request(text)
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_transform_control, albert_semantic_control,
       albert_webhook_control, albert_deletion_control;
REVOKE ALL ON FUNCTION control_plane.complete_fivetran_my_data_request(
  text, text, integer, text
) FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_transform_control, albert_semantic_control,
       albert_webhook_control, albert_deletion_control;

GRANT EXECUTE ON FUNCTION public.begin_albert_fivetran_my_data_request(
  text, text, text, text, integer, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION control_plane.claim_fivetran_my_data_request(text),
  control_plane.complete_fivetran_my_data_request(text, text, integer, text)
TO albert_operator_diagnostic_control;

NOTIFY pgrst, 'reload schema';

COMMIT;
