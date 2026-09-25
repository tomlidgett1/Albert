-- Fivetran-managed Xero ingest. Albert stores only the Fivetran connection
-- identity and Connect Card session. Fivetran owns OAuth tokens and writes
-- its native Xero tables into the destination schema `xero`. This path is
-- deliberately outside is_known_connector so Albert sync workers never try
-- to extract Xero themselves.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.fivetran_connections (
  tenant_id text NOT NULL,
  connection_id text NOT NULL CHECK (control_plane.is_ulid(connection_id)),
  fivetran_connection_id text NOT NULL
    CHECK (fivetran_connection_id ~ '^[A-Za-z0-9_]{6,64}$'),
  destination_schema text NOT NULL
    CHECK (destination_schema ~ '^[a-z][a-z0-9_]{0,127}$'),
  service text NOT NULL CHECK (service = 'xero'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'pending'
    REFERENCES control_plane.connection_status_lookup(status),
  auth_health text NOT NULL DEFAULT 'unknown'
    REFERENCES control_plane.connection_auth_health_lookup(status),
  account_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  authorised_by uuid,
  authorised_at timestamptz,
  last_checked_at timestamptz,
  last_sync_state text,
  disconnected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, connection_id),
  UNIQUE (fivetran_connection_id),
  FOREIGN KEY (tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(account_metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS control_plane.fivetran_oauth_sessions (
  tenant_id text NOT NULL,
  oauth_session_id text NOT NULL CHECK (control_plane.is_ulid(oauth_session_id)),
  connection_id text NOT NULL,
  fivetran_connection_id text NOT NULL
    CHECK (fivetran_connection_id ~ '^[A-Za-z0-9_]{6,64}$'),
  initiated_by uuid NOT NULL,
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 12 AND 1000),
  state_nonce_hash text NOT NULL CHECK (state_nonce_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, oauth_session_id),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.fivetran_connections(tenant_id, connection_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS fivetran_oauth_sessions_pending
  ON control_plane.fivetran_oauth_sessions (tenant_id, initiated_by, expires_at)
  WHERE status = 'pending';

ALTER TABLE control_plane.fivetran_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.fivetran_oauth_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_members_read ON control_plane.fivetran_connections;
CREATE POLICY tenant_members_read ON control_plane.fivetran_connections
  FOR SELECT TO authenticated
  USING (control_plane.is_tenant_member(tenant_id));

DROP POLICY IF EXISTS sync_runtime_access ON control_plane.fivetran_connections;
CREATE POLICY sync_runtime_access ON control_plane.fivetran_connections
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sync_runtime_access ON control_plane.fivetran_oauth_sessions;
CREATE POLICY sync_runtime_access ON control_plane.fivetran_oauth_sessions
  FOR ALL TO albert_sync_control USING (true) WITH CHECK (true);

GRANT SELECT ON TABLE control_plane.fivetran_connections TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE
  control_plane.fivetran_connections,
  control_plane.fivetran_oauth_sessions
TO albert_sync_control;
GRANT INSERT ON TABLE control_plane.audit_log TO albert_sync_control;

CREATE OR REPLACE FUNCTION public.albert_fivetran_workspace_connections()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'connection_id', connection.connection_id,
    'connector_key', 'fivetran-xero',
    'display_name', connection.display_name,
    'status', connection.status,
    'auth_health', connection.auth_health,
    'account_metadata', connection.account_metadata,
    'authorised_at', connection.authorised_at,
    'last_checked_at', connection.last_checked_at,
    'manual_ingestion_start_required', false,
    'ingestion_blocked_reason', NULL,
    'ingestion_state', CASE
      WHEN connection.status = 'disconnected' THEN 'inactive'
      WHEN connection.status = 'pending' THEN 'queued'
      WHEN connection.last_sync_state IN ('syncing', 'rescheduled') THEN 'running'
      ELSE 'active'
    END,
    'readiness', jsonb_build_array(jsonb_build_object(
      'domain', 'accounting',
      'state', CASE
        WHEN connection.status = 'disconnected' THEN 'blocked'
        WHEN connection.status = 'pending' THEN 'not_started'
        WHEN connection.last_sync_state IN ('syncing', 'rescheduled', 'scheduled') THEN 'syncing'
        WHEN connection.last_sync_state = 'succeeded' THEN 'ready_complete'
        WHEN connection.status = 'degraded' THEN 'degraded'
        ELSE 'syncing'
      END,
      'progress', NULL,
      'data_ready_through', NULL,
      'backfill_complete', connection.last_sync_state = 'succeeded',
      'reason_code', NULL
    ))
  ) ORDER BY connection.created_at), '[]'::jsonb)
  FROM control_plane.fivetran_connections AS connection
  WHERE connection.tenant_id = control_plane.require_current_tenant_id()
    AND connection.status <> 'disconnected';
$$;

CREATE OR REPLACE FUNCTION public.albert_is_fivetran_connection(
  p_connection_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM control_plane.fivetran_connections AS connection
    WHERE connection.tenant_id = control_plane.require_current_tenant_id()
      AND connection.connection_id = p_connection_id
  );
$$;

REVOKE ALL ON FUNCTION public.albert_fivetran_workspace_connections() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.albert_is_fivetran_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.albert_fivetran_workspace_connections() TO authenticated;
GRANT EXECUTE ON FUNCTION public.albert_is_fivetran_connection(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
