BEGIN;

-- PL/pgSQL variables named current_time shadow PostgreSQL's built-in timetz
-- function in SQL expressions. That made reserve_vendor_api_request try to
-- store a time-of-day value into theoretical_arrival_at (timestamptz).
CREATE OR REPLACE FUNCTION control_plane.reserve_vendor_api_request(
  p_tenant_id text,
  p_connection_id text,
  p_budget_key text,
  p_emission_interval_ms integer,
  p_burst_capacity integer
)
RETURNS TABLE (allowed boolean, retry_after_ms bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  state control_plane.vendor_rate_budgets%ROWTYPE;
  as_of timestamptz := clock_timestamp();
  next_arrival timestamptz;
  allowed_at timestamptz;
  interval_value interval;
BEGIN
  IF p_tenant_id IS NULL OR length(btrim(p_tenant_id)) = 0
     OR p_connection_id IS NULL OR length(btrim(p_connection_id)) = 0
     OR p_budget_key !~ '^[a-z][a-z0-9_.-]*$'
     OR p_emission_interval_ms NOT BETWEEN 1 AND 86400000
     OR p_burst_capacity NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'vendor rate budget input is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO control_plane.vendor_rate_budgets (
    tenant_id, connection_id, budget_key, window_started_at, window_ends_at,
    requests_used, observed_headers, emission_interval_ms, burst_capacity,
    theoretical_arrival_at
  ) VALUES (
    p_tenant_id, p_connection_id, p_budget_key,
    timestamptz '2000-01-01 00:00:00+00',
    timestamptz '9999-12-31 23:59:59+00',
    0, '{}'::jsonb, p_emission_interval_ms, p_burst_capacity, as_of
  ) ON CONFLICT (tenant_id, connection_id, budget_key, window_started_at)
    DO NOTHING;

  SELECT budget.* INTO STRICT state
    FROM control_plane.vendor_rate_budgets AS budget
   WHERE budget.tenant_id = p_tenant_id
     AND budget.connection_id = p_connection_id
     AND budget.budget_key = p_budget_key
     AND budget.window_started_at = timestamptz '2000-01-01 00:00:00+00'
   FOR UPDATE;

  IF state.blocked_until IS NOT NULL AND state.blocked_until > as_of THEN
    RETURN QUERY SELECT false,
      greatest(1::bigint, ceil(extract(epoch FROM (state.blocked_until - as_of)) * 1000)::bigint);
    RETURN;
  END IF;

  interval_value := make_interval(secs => p_emission_interval_ms::double precision / 1000.0);
  next_arrival := greatest(coalesce(state.theoretical_arrival_at, as_of), as_of);
  allowed_at := next_arrival - make_interval(
    secs => ((p_burst_capacity - 1)::double precision * p_emission_interval_ms) / 1000.0
  );

  IF as_of < allowed_at THEN
    RETURN QUERY SELECT false,
      greatest(1::bigint, ceil(extract(epoch FROM (allowed_at - as_of)) * 1000)::bigint);
    RETURN;
  END IF;

  UPDATE control_plane.vendor_rate_budgets AS budget
     SET requests_used = budget.requests_used + 1,
         emission_interval_ms = p_emission_interval_ms,
         burst_capacity = p_burst_capacity,
         theoretical_arrival_at = next_arrival + interval_value
   WHERE budget.tenant_id = p_tenant_id
     AND budget.connection_id = p_connection_id
     AND budget.budget_key = p_budget_key
     AND budget.window_started_at = timestamptz '2000-01-01 00:00:00+00';

  RETURN QUERY SELECT true, 0::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.acquire_credential_refresh_lease_scoped(
  p_tenant_id text,
  p_credential_scope text,
  p_scope_id text,
  p_connection_id text,
  p_token_ref_id text,
  p_oauth_session_id text,
  p_credential_ref text,
  p_lease_id text,
  p_lease_duration_ms integer
)
RETURNS TABLE (acquired boolean, fencing_token bigint, retry_after_ms bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  as_of timestamptz := clock_timestamp();
  next_expiry timestamptz;
  granted_fence bigint;
  active_lease control_plane.oauth_credential_refresh_leases%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR length(btrim(p_tenant_id)) = 0
     OR p_scope_id IS NULL OR length(btrim(p_scope_id)) = 0
     OR p_credential_ref IS NULL OR length(btrim(p_credential_ref)) = 0
     OR p_lease_id IS NULL OR NOT control_plane.is_ulid(p_lease_id)
     OR p_lease_duration_ms NOT BETWEEN 1000 AND 300000
     OR NOT (
       (p_credential_scope = 'connection' AND p_connection_id = p_scope_id
         AND p_token_ref_id IS NOT NULL AND p_oauth_session_id IS NULL)
       OR
       (p_credential_scope = 'oauth_session' AND p_oauth_session_id = p_scope_id
         AND p_connection_id IS NULL AND p_token_ref_id IS NULL)
     ) THEN
    RAISE EXCEPTION 'credential refresh lease input is invalid' USING ERRCODE = '22023';
  END IF;

  next_expiry := as_of
    + make_interval(secs => p_lease_duration_ms::double precision / 1000.0);
  INSERT INTO control_plane.oauth_credential_refresh_leases AS lease (
    tenant_id, credential_scope, scope_id, connection_id, token_ref_id,
    oauth_session_id, secret_reference, lease_id, fencing_token,
    acquired_at, lease_expires_at, updated_at
  ) VALUES (
    p_tenant_id, p_credential_scope, p_scope_id, p_connection_id, p_token_ref_id,
    p_oauth_session_id, p_credential_ref, p_lease_id, 1,
    as_of, next_expiry, as_of
  ) ON CONFLICT (tenant_id, credential_scope, scope_id) DO UPDATE SET
    connection_id = excluded.connection_id,
    token_ref_id = excluded.token_ref_id,
    oauth_session_id = excluded.oauth_session_id,
    secret_reference = excluded.secret_reference,
    lease_id = excluded.lease_id,
    fencing_token = CASE
      WHEN lease.lease_id = excluded.lease_id THEN lease.fencing_token
      ELSE lease.fencing_token + 1
    END,
    acquired_at = CASE
      WHEN lease.lease_id = excluded.lease_id THEN lease.acquired_at
      ELSE as_of
    END,
    lease_expires_at = next_expiry,
    updated_at = as_of
  WHERE lease.lease_id IS NULL
     OR lease.lease_expires_at <= as_of
     OR lease.lease_id = excluded.lease_id
  RETURNING lease.fencing_token INTO granted_fence;

  IF granted_fence IS NOT NULL THEN
    RETURN QUERY SELECT true, granted_fence, 0::bigint;
    RETURN;
  END IF;

  SELECT lease.* INTO STRICT active_lease
    FROM control_plane.oauth_credential_refresh_leases AS lease
   WHERE lease.tenant_id = p_tenant_id
     AND lease.credential_scope = p_credential_scope
     AND lease.scope_id = p_scope_id;
  RETURN QUERY SELECT false, NULL::bigint,
    greatest(1::bigint, ceil(extract(epoch FROM (
      active_lease.lease_expires_at - as_of
    )) * 1000)::bigint);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.extend_credential_refresh_lease(
  p_credential_ref text,
  p_lease_id text,
  p_fencing_token bigint,
  p_lease_duration_ms integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  as_of timestamptz := clock_timestamp();
BEGIN
  IF p_lease_id IS NULL OR NOT control_plane.is_ulid(p_lease_id)
     OR p_fencing_token IS NULL OR p_fencing_token < 1
     OR p_lease_duration_ms NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION 'credential refresh lease extension is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.oauth_credential_refresh_leases AS lease
     SET lease_expires_at = as_of
       + make_interval(secs => p_lease_duration_ms::double precision / 1000.0),
         updated_at = as_of
   WHERE lease.secret_reference = p_credential_ref
     AND lease.lease_id = p_lease_id
     AND lease.fencing_token = p_fencing_token
     AND lease.lease_expires_at > as_of;
  RETURN FOUND;
END;
$$;

COMMIT;
