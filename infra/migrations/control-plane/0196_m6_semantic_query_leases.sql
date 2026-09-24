-- 0196: semantic query leases for partner clients (ADR 0153).
--
-- A partner product (Yellow Jersey's dashboard editor) runs governed Cube JSON
-- queries for its tenant without an Omni turn. Albert's web route validates
-- every query against the live catalogue, as a dashboard refresh does, and
-- runs it under a short semantic-query lease: the claim Cube's driver trades
-- for a signed semantic_read capability, like a running turn or a claimed
-- tile refresh.
--
-- One lease serves every query the same member runs in a short window: a
-- claim returns the member's current lease while it has at least 75 seconds
-- left, so a dashboard's dozen queries share one Cube orchestrator and one
-- connection pool instead of opening one each. A lease lives three minutes
-- and a tenant may hold at most six unexpired leases.
--
-- Access posture: private table, FORCE RLS with the migration-owner policy
-- (the 0118 pattern), no client grants. Members reach it only through the
-- claim RPC; only albert_semantic_control may issue the capability.

BEGIN;

CREATE TABLE IF NOT EXISTS control_plane.semantic_query_leases (
  tenant_id text NOT NULL REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  lease_id text NOT NULL CHECK (control_plane.is_ulid(lease_id)),
  actor_user_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'manager')),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_.:-]{2,63}$'),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, lease_id),
  CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '3 minutes')
);

CREATE INDEX IF NOT EXISTS semantic_query_leases_actor_idx
  ON control_plane.semantic_query_leases (tenant_id, actor_user_id, purpose, expires_at DESC);

ALTER TABLE control_plane.semantic_query_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_query_leases FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE control_plane.semantic_query_leases
  FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY semantic_query_leases_migration_role_access
  ON control_plane.semantic_query_leases
  FOR ALL TO albert_control_migration_owner
  USING (true) WITH CHECK (true);

-- Claims (or reuses) the calling member's lease for a purpose. The partner
-- names the tenant it expects: the acting member may belong to several
-- organisations and could switch between them during a session, so a
-- mismatch fails closed instead of querying the wrong tenant.
CREATE OR REPLACE FUNCTION public.albert_semantic_query_lease_claim(
  p_expected_tenant_id text,
  p_purpose text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  selected_tenant text := control_plane.require_current_tenant_id();
  actor uuid := extensions.albert_auth_uid();
  member_role text;
  lease control_plane.semantic_query_leases%ROWTYPE;
  open_leases integer;
  claimed_at timestamptz := clock_timestamp();
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'authentication is required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_tenant_id IS NULL OR selected_tenant <> p_expected_tenant_id THEN
    RAISE EXCEPTION 'the session is bound to another organisation' USING ERRCODE = 'AL409';
  END IF;
  IF p_purpose IS NULL OR p_purpose !~ '^[a-z][a-z0-9_.:-]{2,63}$' THEN
    RAISE EXCEPTION 'semantic query purpose is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT membership.role INTO member_role
  FROM control_plane.memberships AS membership
  WHERE membership.tenant_id = selected_tenant
    AND membership.user_id = actor
    AND membership.status = 'active';
  IF member_role IS NULL OR member_role NOT IN ('owner', 'manager') THEN
    RAISE EXCEPTION 'owner or manager access is required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('semantic-query-lease:' || selected_tenant, 0));

  SELECT existing.* INTO lease
  FROM control_plane.semantic_query_leases AS existing
  WHERE existing.tenant_id = selected_tenant
    AND existing.actor_user_id = actor
    AND existing.purpose = p_purpose
    AND existing.expires_at > claimed_at + interval '75 seconds'
  ORDER BY existing.expires_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT count(*) INTO open_leases
    FROM control_plane.semantic_query_leases AS existing
    WHERE existing.tenant_id = selected_tenant
      AND existing.expires_at > claimed_at;
    IF open_leases >= 6 THEN
      RAISE EXCEPTION 'too many semantic query leases are open' USING ERRCODE = '53400';
    END IF;
    -- Expired leases are only an audit trail; keep a day of them.
    DELETE FROM control_plane.semantic_query_leases AS stale
    WHERE stale.tenant_id = selected_tenant
      AND stale.expires_at < claimed_at - interval '1 day';
    INSERT INTO control_plane.semantic_query_leases (
      tenant_id, lease_id, actor_user_id, actor_role, purpose, issued_at, expires_at
    ) VALUES (
      selected_tenant, control_plane.generate_ulid(), actor, member_role, p_purpose,
      claimed_at, claimed_at + interval '3 minutes'
    )
    RETURNING * INTO lease;
  END IF;

  RETURN jsonb_build_object(
    'leaseId', lease.lease_id,
    'tenantId', lease.tenant_id,
    'role', lease.actor_role,
    'expiresAt', lease.expires_at
  );
END;
$$;

-- Trades an active lease for a semantic_read capability (the tile issuer in
-- 0121, keyed by lease instead of tile). Callable only by Cube's control role.
CREATE OR REPLACE FUNCTION control_plane.issue_semantic_query_analytical_capability(
  p_tenant_id text,
  p_lease_id text,
  p_scope text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  lease_row control_plane.semantic_query_leases%ROWTYPE;
  audience text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime', 'albert_semantic_control'
  );
  IF NOT control_plane.is_ulid(p_lease_id)
     OR p_scope NOT IN ('semantic_read', 'semantic_metadata') THEN
    RAISE EXCEPTION 'semantic query claims are invalid' USING ERRCODE = '22023';
  END IF;

  SELECT lease.* INTO lease_row
  FROM control_plane.semantic_query_leases AS lease
  WHERE lease.tenant_id = p_tenant_id
    AND lease.lease_id = p_lease_id
    AND lease.expires_at > clock_timestamp()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic query lease is not active' USING ERRCODE = '55000';
  END IF;

  audience := CASE p_scope
    WHEN 'semantic_read' THEN 'analytical:semantic-read'
    ELSE 'analytical:semantic-metadata'
  END;
  RETURN control_plane.sign_analytical_capability(
    p_tenant_id,
    audience,
    p_scope,
    'semantic-query:' || p_lease_id,
    lease_row.expires_at,
    jsonb_build_object(
      'kind', 'semantic_query',
      'lease_id', p_lease_id,
      'actor_user_id', lease_row.actor_user_id,
      'purpose', lease_row.purpose
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.albert_semantic_query_lease_claim(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.albert_semantic_query_lease_claim(text, text) TO authenticated;

REVOKE ALL ON FUNCTION control_plane.issue_semantic_query_analytical_capability(text, text, text)
  FROM PUBLIC, anon, authenticated, service_role, albert_sync_control,
       albert_transform_control, albert_semantic_control, albert_webhook_control,
       albert_deletion_control, albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.issue_semantic_query_analytical_capability(text, text, text)
  TO albert_semantic_control;

INSERT INTO control_plane.rate_limit_policies (action, request_limit, window_seconds, audit_excess)
VALUES ('semantic.query', 240, 60, false)
ON CONFLICT (action) DO UPDATE SET
  request_limit = EXCLUDED.request_limit,
  window_seconds = EXCLUDED.window_seconds,
  audit_excess = EXCLUDED.audit_excess;

NOTIFY pgrst, 'reload schema';

COMMIT;
