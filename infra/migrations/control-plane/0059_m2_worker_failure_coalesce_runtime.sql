BEGIN;

-- Migration 0058 intentionally fixes every worker failure document to a
-- bounded, code-only contract. Its wrappers qualified COALESCE as though it
-- were a pg_catalog function; PostgreSQL accepts that text when the PL/pgSQL
-- body is installed but fails on first execution because COALESCE is parser
-- syntax. Keep 0058 checksum-immutable and replace every affected wrapper.

CREATE OR REPLACE FUNCTION control_plane.retry_or_fail_sync_job(
  p_queue_name text,
  p_message_id bigint,
  p_job_request_id text,
  p_worker_id text,
  p_read_count integer,
  p_error jsonb,
  p_retry_delay_seconds integer,
  p_max_attempts integer DEFAULT 8
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF control_plane.worker_failure_document_has_exact_keys_0058(
       p_error,ARRAY['code','retryable']::text[]
     ) IS DISTINCT FROM true
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR control_plane.sync_failure_code_valid_0058(
       p_error->>'code'
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sync failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.retry_or_fail_sync_job_unvalidated_0058(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count,
    p_error,p_retry_delay_seconds,p_max_attempts
  );
END;
$$;

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
SET search_path=pg_catalog
AS $$
BEGIN
  IF control_plane.worker_failure_document_has_exact_keys_0058(
       p_reason,ARRAY['code']::text[]
     ) IS DISTINCT FROM true
     OR pg_catalog.jsonb_typeof(p_reason->'code')<>'string'
     OR control_plane.sync_failure_code_valid_0058(
       p_reason->>'code'
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'sync deferral evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.defer_sync_job_unvalidated_0058(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count,
    p_reason,p_delay_seconds
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.block_reconciliation_phase(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_reconciliation_sweep_id text,p_stream text,p_phase text,p_error jsonb,
  p_job_request_id text,p_queue_name text,p_message_id bigint,
  p_worker_id text,p_read_count integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF p_error IS NULL OR pg_catalog.jsonb_typeof(p_error)<>'object'
     OR NOT (p_error ?& ARRAY['code','retryable']::text[])
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_object_keys(p_error) AS supplied(key_name)
        WHERE key_name NOT IN ('code','retryable','optional','attempt')
     )
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR control_plane.sync_failure_code_valid_0058(
       p_error->>'code'
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'reconciliation failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  IF p_error ? 'optional'
     AND pg_catalog.jsonb_typeof(p_error->'optional')<>'boolean' THEN
    RAISE EXCEPTION 'reconciliation failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  IF p_error ? 'attempt'
     AND (
       pg_catalog.jsonb_typeof(p_error->'attempt')<>'number'
       OR (p_error->>'attempt') !~ '^[1-9][0-9]{0,8}$'
     ) THEN
    RAISE EXCEPTION 'reconciliation failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM control_plane.block_reconciliation_phase_unvalidated_0058(
    p_tenant_id,p_connection_id,p_connection_generation,
    p_reconciliation_sweep_id,p_stream,p_phase,p_error,
    p_job_request_id,p_queue_name,p_message_id,p_worker_id,p_read_count
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.fail_identity_decision_projection(
  p_tenant_id text,
  p_projection_id text,
  p_worker_id text,
  p_lease_token text,
  p_error jsonb,
  p_retry_delay_seconds integer,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF control_plane.worker_failure_document_has_exact_keys_0058(
       p_error,ARRAY['code','retryable']::text[]
     ) IS DISTINCT FROM true
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR control_plane.identity_projection_failure_code_valid_0058(
       p_error->>'code'
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'identity projection failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.fail_identity_projection_unvalidated_0058(
    p_tenant_id,p_projection_id,p_worker_id,p_lease_token,p_error,
    p_retry_delay_seconds,p_max_attempts
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.retry_or_fail_canonical_transform_job(
  p_tenant_id text,
  p_transform_job_id text,
  p_worker_id text,
  p_lease_token text,
  p_error jsonb,
  p_retry_delay_seconds integer,
  p_max_attempts integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF control_plane.worker_failure_document_has_exact_keys_0058(
       p_error,ARRAY['code','retryable']::text[]
     ) IS DISTINCT FROM true
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR control_plane.canonical_transform_failure_code_valid_0058(
       p_error->>'code'
     ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'canonical transform failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.retry_or_fail_transform_job_unvalidated_0058(
    p_tenant_id,p_transform_job_id,p_worker_id,p_lease_token,p_error,
    p_retry_delay_seconds,p_max_attempts
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_stream text,p_phase text,p_replay_version integer,p_error jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF control_plane.worker_failure_document_has_exact_keys_0058(
       p_error,ARRAY['code','retryable']::text[]
     ) IS DISTINCT FROM true
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR p_error->>'code'<>'capability_unavailable' THEN
    RAISE EXCEPTION 'optional stream unavailable evidence is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM control_plane.mark_stream_phase_unavailable_unvalidated_0058(
    p_tenant_id,p_connection_id,p_connection_generation,p_stream,p_phase,
    p_replay_version,p_error
  );
END;
$$;

COMMIT;
