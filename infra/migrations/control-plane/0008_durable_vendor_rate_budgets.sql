BEGIN;

-- GCRA state turns the M2 vendor budget ledger into an atomic, cross-replica
-- request gate. The fixed ledger row remains tenant/connection scoped and is
-- deleted with its connection.
ALTER TABLE control_plane.vendor_rate_budgets
  ADD COLUMN IF NOT EXISTS emission_interval_ms integer,
  ADD COLUMN IF NOT EXISTS burst_capacity integer,
  ADD COLUMN IF NOT EXISTS theoretical_arrival_at timestamptz,
  ADD COLUMN IF NOT EXISTS blocked_until timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'control_plane.vendor_rate_budgets'::regclass
       AND conname = 'vendor_rate_budgets_gcra_parameters_check'
  ) THEN
    ALTER TABLE control_plane.vendor_rate_budgets
      ADD CONSTRAINT vendor_rate_budgets_gcra_parameters_check CHECK (
        (emission_interval_ms IS NULL OR emission_interval_ms BETWEEN 1 AND 86400000)
        AND (burst_capacity IS NULL OR burst_capacity BETWEEN 1 AND 10000)
      );
  END IF;
END;
$$;

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
  current_time timestamptz := clock_timestamp();
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
    0, '{}'::jsonb, p_emission_interval_ms, p_burst_capacity, current_time
  ) ON CONFLICT (tenant_id, connection_id, budget_key, window_started_at)
    DO NOTHING;

  SELECT budget.* INTO STRICT state
    FROM control_plane.vendor_rate_budgets AS budget
   WHERE budget.tenant_id = p_tenant_id
     AND budget.connection_id = p_connection_id
     AND budget.budget_key = p_budget_key
     AND budget.window_started_at = timestamptz '2000-01-01 00:00:00+00'
   FOR UPDATE;

  IF state.blocked_until IS NOT NULL AND state.blocked_until > current_time THEN
    RETURN QUERY SELECT false,
      greatest(1::bigint, ceil(extract(epoch FROM (state.blocked_until - current_time)) * 1000)::bigint);
    RETURN;
  END IF;

  interval_value := make_interval(secs => p_emission_interval_ms::double precision / 1000.0);
  next_arrival := greatest(coalesce(state.theoretical_arrival_at, current_time), current_time);
  allowed_at := next_arrival - make_interval(
    secs => ((p_burst_capacity - 1)::double precision * p_emission_interval_ms) / 1000.0
  );

  IF current_time < allowed_at THEN
    RETURN QUERY SELECT false,
      greatest(1::bigint, ceil(extract(epoch FROM (allowed_at - current_time)) * 1000)::bigint);
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

CREATE OR REPLACE FUNCTION control_plane.observe_vendor_api_response(
  p_tenant_id text,
  p_connection_id text,
  p_budget_key text,
  p_cooldown_ms integer,
  p_observed_headers jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  next_block timestamptz;
BEGIN
  IF p_budget_key !~ '^[a-z][a-z0-9_.-]*$'
     OR p_cooldown_ms NOT BETWEEN 0 AND 604800000
     OR p_observed_headers IS NULL
     OR jsonb_typeof(p_observed_headers) <> 'object'
     OR pg_column_size(p_observed_headers) > 8192 THEN
    RAISE EXCEPTION 'vendor response observation is invalid' USING ERRCODE = '22023';
  END IF;

  next_block := CASE WHEN p_cooldown_ms > 0 THEN
    clock_timestamp() + make_interval(secs => p_cooldown_ms::double precision / 1000.0)
  END;

  UPDATE control_plane.vendor_rate_budgets AS budget
     SET observed_headers = budget.observed_headers || p_observed_headers,
         blocked_until = CASE
           WHEN next_block IS NULL THEN budget.blocked_until
           ELSE greatest(coalesce(budget.blocked_until, next_block), next_block)
         END,
         vendor_reset_at = CASE
           WHEN next_block IS NULL THEN budget.vendor_reset_at
           ELSE greatest(coalesce(budget.vendor_reset_at, next_block), next_block)
         END
   WHERE budget.tenant_id = p_tenant_id
     AND budget.connection_id = p_connection_id
     AND budget.budget_key = p_budget_key
     AND budget.window_started_at = timestamptz '2000-01-01 00:00:00+00';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vendor rate budget state was not reserved' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Capacity deferrals are expected scheduling decisions, not failed attempts.
-- They retain the current PGMQ message and never cross the dead-letter limit.
CREATE OR REPLACE FUNCTION control_plane.defer_sync_job(
  p_queue_name text,
  p_message_id bigint,
  p_job_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_reason jsonb,
  p_delay_seconds integer
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pgmq
AS $$
DECLARE
  request_row control_plane.sync_job_requests%ROWTYPE;
  next_deadline timestamptz;
BEGIN
  IF p_reason IS NULL OR jsonb_typeof(p_reason) <> 'object'
     OR p_delay_seconds NOT BETWEEN 1 AND 604800 THEN
    RAISE EXCEPTION 'sync job deferral input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM control_plane.require_active_sync_job_lease(
    p_queue_name, p_message_id, p_job_request_id, p_worker_id, p_read_count
  );
  SELECT request.* INTO STRICT request_row
    FROM control_plane.sync_job_requests AS request
   WHERE request.job_request_id = p_job_request_id
     AND request.queue_name = p_queue_name
     AND request.queue_message_id = p_message_id
   FOR UPDATE;

  PERFORM pgmq.set_vt(p_queue_name, p_message_id, p_delay_seconds);
  next_deadline := clock_timestamp() + make_interval(secs => p_delay_seconds);
  UPDATE control_plane.sync_job_requests
     SET status = 'retry_wait', available_at = next_deadline, last_error = p_reason
   WHERE tenant_id = request_row.tenant_id AND job_request_id = p_job_request_id;
  INSERT INTO control_plane.sync_job_attempt_outcomes (
    tenant_id, job_attempt_outcome_id, job_attempt_id, outcome, error_metadata
  )
  SELECT request_row.tenant_id, control_plane.generate_ulid(),
    attempt.job_attempt_id, 'retry', p_reason
    FROM control_plane.sync_job_attempts AS attempt
   WHERE attempt.tenant_id = request_row.tenant_id
     AND attempt.job_request_id = p_job_request_id
     AND attempt.attempt_number = p_read_count
     AND attempt.worker_id = p_worker_id
  ON CONFLICT (tenant_id, job_attempt_id) DO NOTHING;
  RETURN next_deadline;
END;
$$;

-- Refresh tokens (especially Xero's rotating tokens) must never be exchanged
-- concurrently by two worker replicas. This ledger is keyed by the durable
-- tenant scope and connection (or by the single-use OAuth session before a
-- connection exists), not by a process-local mutex. A fencing token is kept
-- after release so a delayed holder can never regain authority through ABA.
CREATE TABLE IF NOT EXISTS control_plane.oauth_credential_refresh_leases (
  tenant_id text NOT NULL,
  credential_scope text NOT NULL CHECK (credential_scope IN ('connection', 'oauth_session')),
  scope_id text NOT NULL,
  connection_id text,
  token_ref_id text,
  oauth_session_id text,
  secret_reference text NOT NULL,
  lease_id text CHECK (lease_id IS NULL OR control_plane.is_ulid(lease_id)),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  acquired_at timestamptz,
  lease_expires_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, credential_scope, scope_id),
  UNIQUE (secret_reference),
  FOREIGN KEY (tenant_id, connection_id)
    REFERENCES control_plane.connections(tenant_id, connection_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, token_ref_id)
    REFERENCES control_plane.oauth_token_refs(tenant_id, token_ref_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, oauth_session_id)
    REFERENCES control_plane.oauth_sessions(tenant_id, oauth_session_id) ON DELETE CASCADE,
  CHECK (
    (credential_scope = 'connection'
      AND scope_id = connection_id
      AND connection_id IS NOT NULL
      AND token_ref_id IS NOT NULL
      AND oauth_session_id IS NULL)
    OR
    (credential_scope = 'oauth_session'
      AND scope_id = oauth_session_id
      AND connection_id IS NULL
      AND token_ref_id IS NULL
      AND oauth_session_id IS NOT NULL)
  ),
  CHECK (
    (lease_id IS NULL AND acquired_at IS NULL)
    OR (lease_id IS NOT NULL AND acquired_at IS NOT NULL)
  )
);

ALTER TABLE control_plane.oauth_credential_refresh_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.oauth_credential_refresh_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS migration_owner_refresh_lease_access
  ON control_plane.oauth_credential_refresh_leases;
CREATE POLICY migration_owner_refresh_lease_access
  ON control_plane.oauth_credential_refresh_leases
  FOR ALL TO albert_control_migration_owner USING (true) WITH CHECK (true);

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
  current_time timestamptz := clock_timestamp();
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

  next_expiry := current_time
    + make_interval(secs => p_lease_duration_ms::double precision / 1000.0);
  INSERT INTO control_plane.oauth_credential_refresh_leases AS lease (
    tenant_id, credential_scope, scope_id, connection_id, token_ref_id,
    oauth_session_id, secret_reference, lease_id, fencing_token,
    acquired_at, lease_expires_at, updated_at
  ) VALUES (
    p_tenant_id, p_credential_scope, p_scope_id, p_connection_id, p_token_ref_id,
    p_oauth_session_id, p_credential_ref, p_lease_id, 1,
    current_time, next_expiry, current_time
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
      ELSE current_time
    END,
    lease_expires_at = next_expiry,
    updated_at = current_time
  WHERE lease.lease_id IS NULL
     OR lease.lease_expires_at <= current_time
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
      active_lease.lease_expires_at - current_time
    )) * 1000)::bigint);
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.acquire_credential_refresh_lease(
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
  final_token control_plane.oauth_token_refs%ROWTYPE;
  session_tenant_id text;
  session_id text;
BEGIN
  SELECT token.* INTO final_token
    FROM control_plane.oauth_token_refs AS token
   WHERE token.secret_reference = p_credential_ref;
  IF FOUND THEN
    RETURN QUERY SELECT * FROM control_plane.acquire_credential_refresh_lease_scoped(
      final_token.tenant_id, 'connection', final_token.connection_id,
      final_token.connection_id, final_token.token_ref_id, NULL,
      p_credential_ref, p_lease_id, p_lease_duration_ms
    );
    RETURN;
  END IF;

  SELECT envelope.tenant_id, envelope.oauth_session_id
    INTO session_tenant_id, session_id
    FROM control_plane.oauth_session_secret_envelopes AS envelope
   WHERE envelope.secret_reference = p_credential_ref
     AND envelope.secret_kind = 'exchanged_credential'
     AND envelope.consumed_at IS NULL
     AND envelope.destroyed_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential was not found for refresh leasing' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT * FROM control_plane.acquire_credential_refresh_lease_scoped(
    session_tenant_id, 'oauth_session', session_id,
    NULL, NULL, session_id, p_credential_ref, p_lease_id, p_lease_duration_ms
  );
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
DECLARE current_time timestamptz := clock_timestamp();
BEGIN
  IF p_lease_id IS NULL OR NOT control_plane.is_ulid(p_lease_id)
     OR p_fencing_token IS NULL OR p_fencing_token < 1
     OR p_lease_duration_ms NOT BETWEEN 1000 AND 300000 THEN
    RAISE EXCEPTION 'credential refresh lease extension is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.oauth_credential_refresh_leases AS lease
     SET lease_expires_at = current_time
           + make_interval(secs => p_lease_duration_ms::double precision / 1000.0),
         updated_at = current_time
   WHERE lease.secret_reference = p_credential_ref
     AND lease.lease_id = p_lease_id
     AND lease.fencing_token = p_fencing_token
     AND lease.lease_expires_at > current_time;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.release_credential_refresh_lease(
  p_credential_ref text,
  p_lease_id text,
  p_fencing_token bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_lease_id IS NULL OR NOT control_plane.is_ulid(p_lease_id)
     OR p_fencing_token IS NULL OR p_fencing_token < 1 THEN
    RAISE EXCEPTION 'credential refresh lease release is invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE control_plane.oauth_credential_refresh_leases AS lease
     SET lease_id = NULL, acquired_at = NULL,
         lease_expires_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE lease.secret_reference = p_credential_ref
     AND lease.lease_id = p_lease_id
     AND lease.fencing_token = p_fencing_token;
  RETURN FOUND;
END;
$$;

-- The row lock survives until the caller's transaction commits. Calling this
-- immediately before compare-and-swap fences rotation atomically against a
-- replacement lease even if wall-clock expiry occurs during the transaction.
CREATE OR REPLACE FUNCTION control_plane.assert_credential_refresh_lease(
  p_credential_ref text,
  p_lease_id text,
  p_fencing_token bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE locked_reference text;
BEGIN
  SELECT lease.secret_reference INTO locked_reference
    FROM control_plane.oauth_credential_refresh_leases AS lease
   WHERE lease.secret_reference = p_credential_ref
     AND lease.lease_id = p_lease_id
     AND lease.fencing_token = p_fencing_token
     AND lease.lease_expires_at > clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential refresh lease is no longer active' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- The deletion login receives only claim-fenced wrappers. It cannot use a
-- guessed credential reference to lease or inspect another tenant's token.
CREATE OR REPLACE FUNCTION control_plane.acquire_deletion_credential_refresh_lease(
  p_message_id bigint,
  p_deletion_request_id text,
  p_worker_id text,
  p_read_count integer,
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
  request_row control_plane.deletion_requests%ROWTYPE;
  token_row control_plane.oauth_token_refs%ROWTYPE;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  SELECT token.* INTO token_row
    FROM control_plane.oauth_token_refs AS token
   WHERE token.secret_reference = p_credential_ref
     AND token.tenant_id = request_row.tenant_id
     AND (request_row.scope = 'tenant' OR token.connection_id = request_row.connection_id);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'deletion credential was not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY SELECT * FROM control_plane.acquire_credential_refresh_lease_scoped(
    token_row.tenant_id, 'connection', token_row.connection_id,
    token_row.connection_id, token_row.token_ref_id, NULL,
    p_credential_ref, p_lease_id, p_lease_duration_ms
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.extend_deletion_credential_refresh_lease(
  p_message_id bigint,
  p_deletion_request_id text,
  p_worker_id text,
  p_read_count integer,
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
DECLARE request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.oauth_token_refs AS token
     WHERE token.secret_reference = p_credential_ref
       AND token.tenant_id = request_row.tenant_id
       AND (request_row.scope = 'tenant' OR token.connection_id = request_row.connection_id)
  ) THEN
    RAISE EXCEPTION 'deletion credential was not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.extend_credential_refresh_lease(
    p_credential_ref, p_lease_id, p_fencing_token, p_lease_duration_ms
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.release_deletion_credential_refresh_lease(
  p_message_id bigint,
  p_deletion_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_credential_ref text,
  p_lease_id text,
  p_fencing_token bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.oauth_token_refs AS token
     WHERE token.secret_reference = p_credential_ref
       AND token.tenant_id = request_row.tenant_id
       AND (request_row.scope = 'tenant' OR token.connection_id = request_row.connection_id)
  ) THEN
    RAISE EXCEPTION 'deletion credential was not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN control_plane.release_credential_refresh_lease(
    p_credential_ref, p_lease_id, p_fencing_token
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.rotate_deletion_credential_under_refresh_lease(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer,
  p_credential_ref text,p_expected_version integer,p_algorithm text,p_ciphertext bytea,
  p_nonce bytea,p_authentication_tag bytea,p_wrapped_data_key bytea,p_key_reference text,
  p_key_version text,p_aad_digest text,p_granted_scopes text[],p_token_expires_at timestamptz,
  p_refresh_lease_id text,p_refresh_fencing_token bigint
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE request_row control_plane.deletion_requests%ROWTYPE;
BEGIN
  request_row := control_plane.require_active_deletion_lease(
    p_message_id, p_deletion_request_id, p_worker_id, p_read_count
  );
  IF NOT EXISTS (
    SELECT 1 FROM control_plane.oauth_token_refs AS token
     WHERE token.secret_reference = p_credential_ref
       AND token.tenant_id = request_row.tenant_id
       AND (request_row.scope = 'tenant' OR token.connection_id = request_row.connection_id)
  ) THEN
    RAISE EXCEPTION 'deletion credential was not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM control_plane.assert_credential_refresh_lease(
    p_credential_ref, p_refresh_lease_id, p_refresh_fencing_token
  );
  RETURN control_plane.rotate_deletion_credential(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count,
    p_credential_ref,p_expected_version,p_algorithm,p_ciphertext,p_nonce,
    p_authentication_tag,p_wrapped_data_key,p_key_reference,p_key_version,
    p_aad_digest,p_granted_scopes,p_token_expires_at
  );
END;
$$;

REVOKE ALL ON TABLE control_plane.oauth_credential_refresh_leases
  FROM PUBLIC, anon, authenticated, service_role,
    albert_sync_control, albert_deletion_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.acquire_credential_refresh_lease_scoped(
  text,text,text,text,text,text,text,text,integer
) FROM PUBLIC, anon, authenticated, service_role,
  albert_sync_control, albert_deletion_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.acquire_credential_refresh_lease(text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role, albert_deletion_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.extend_credential_refresh_lease(text,text,bigint,integer)
  FROM PUBLIC, anon, authenticated, service_role, albert_deletion_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.release_credential_refresh_lease(text,text,bigint)
  FROM PUBLIC, anon, authenticated, service_role, albert_deletion_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.assert_credential_refresh_lease(text,text,bigint)
  FROM PUBLIC, anon, authenticated, service_role, albert_deletion_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.acquire_deletion_credential_refresh_lease(
  bigint,text,text,integer,text,text,integer
) FROM PUBLIC, anon, authenticated, service_role, albert_sync_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.extend_deletion_credential_refresh_lease(
  bigint,text,text,integer,text,text,bigint,integer
) FROM PUBLIC, anon, authenticated, service_role, albert_sync_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.release_deletion_credential_refresh_lease(
  bigint,text,text,integer,text,text,bigint
) FROM PUBLIC, anon, authenticated, service_role, albert_sync_control, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.rotate_deletion_credential_under_refresh_lease(
  bigint,text,text,integer,text,integer,text,bytea,bytea,bytea,bytea,text,text,text,text[],
  timestamptz,text,bigint
) FROM PUBLIC, anon, authenticated, service_role, albert_sync_control, albert_webhook_control;

GRANT EXECUTE ON FUNCTION control_plane.acquire_credential_refresh_lease(text,text,integer),
  control_plane.extend_credential_refresh_lease(text,text,bigint,integer),
  control_plane.release_credential_refresh_lease(text,text,bigint),
  control_plane.assert_credential_refresh_lease(text,text,bigint)
TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.acquire_deletion_credential_refresh_lease(
  bigint,text,text,integer,text,text,integer
), control_plane.extend_deletion_credential_refresh_lease(
  bigint,text,text,integer,text,text,bigint,integer
), control_plane.release_deletion_credential_refresh_lease(
  bigint,text,text,integer,text,text,bigint
), control_plane.rotate_deletion_credential_under_refresh_lease(
  bigint,text,text,integer,text,integer,text,bytea,bytea,bytea,bytea,text,text,text,text[],
  timestamptz,text,bigint
) TO albert_deletion_control;

COMMENT ON TABLE control_plane.oauth_credential_refresh_leases IS
  'Cross-replica, expiring and fenced OAuth refresh leases scoped to a tenant connection or provisional OAuth session.';
COMMENT ON FUNCTION control_plane.assert_credential_refresh_lease(text,text,bigint) IS
  'Locks and proves an unexpired refresh lease so credential CAS is atomically fenced.';

REVOKE ALL ON FUNCTION control_plane.reserve_vendor_api_request(text, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.observe_vendor_api_response(text, text, text, integer, jsonb)
  FROM PUBLIC, anon, authenticated, service_role, albert_webhook_control;
REVOKE ALL ON FUNCTION control_plane.defer_sync_job(text, bigint, text, text, integer, jsonb, integer)
  FROM PUBLIC, anon, authenticated, service_role, albert_webhook_control;
GRANT EXECUTE ON FUNCTION control_plane.reserve_vendor_api_request(text, text, text, integer, integer)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.observe_vendor_api_response(text, text, text, integer, jsonb)
  TO albert_sync_control;
GRANT EXECUTE ON FUNCTION control_plane.defer_sync_job(text, bigint, text, text, integer, jsonb, integer)
  TO albert_sync_control;

COMMENT ON FUNCTION control_plane.reserve_vendor_api_request(text, text, text, integer, integer) IS
  'Atomically reserves one vendor API request using a tenant/connection-scoped GCRA budget.';
COMMENT ON FUNCTION control_plane.observe_vendor_api_response(text, text, text, integer, jsonb) IS
  'Persists allow-listed vendor limit headers and a shared Retry-After cooldown.';
COMMENT ON FUNCTION control_plane.defer_sync_job(text, bigint, text, text, integer, jsonb, integer) IS
  'Defers expected capacity-limited sync work without consuming its failure-attempt budget.';

COMMIT;
