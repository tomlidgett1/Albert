BEGIN;

-- A compromised worker already owns a valid queue/lease identity. That must
-- not also give it a durable text exfiltration path through operational error
-- JSON. Keep the proven transition bodies, but put exact code-only contracts
-- in front of every sync/transform failure-evidence write.

CREATE FUNCTION control_plane.worker_failure_document_has_exact_keys_0058(
  p_document jsonb,
  p_exact_keys text[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT CASE
    WHEN p_document IS NULL
      OR pg_catalog.jsonb_typeof(p_document)<>'object'
      OR p_exact_keys IS NULL
      OR pg_catalog.cardinality(p_exact_keys) NOT BETWEEN 1 AND 8
    THEN false
    ELSE pg_catalog.cardinality(p_exact_keys)=(
           SELECT pg_catalog.count(DISTINCT key_name)
             FROM pg_catalog.unnest(p_exact_keys) AS expected(key_name)
         )
     AND (
           SELECT pg_catalog.bool_and(p_document ? key_name)
             FROM pg_catalog.unnest(p_exact_keys) AS expected(key_name)
         )
     AND (
           SELECT pg_catalog.count(*)
             FROM pg_catalog.jsonb_object_keys(p_document) AS actual(key_name)
         )=pg_catalog.cardinality(p_exact_keys)
  END
$$;

CREATE FUNCTION control_plane.sync_failure_code_valid_0058(p_code text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT p_code IN (
    'authentication_required',
    'backfill_completion_evidence_missing',
    'backfill_continuation_requires_stream',
    'backfill_plan_requires_coordinator',
    'backfill_phase_requires_stream',
    'backfill_successor_requires_stream',
    'capability_unavailable',
    'configuration_invalid',
    'connection_account_mismatch',
    'connection_generation_stale',
    'connection_not_ready',
    'connector_page_invalid_pagination_block',
    'connector_page_missing_continuation_cursor',
    'connector_page_non_advancing_cursor',
    'connector_stream_not_found',
    'credential_conflict',
    'cursor_invalid',
    'database_deadlock',
    'database_integrity_violation',
    'database_permission_denied',
    'database_serialization_conflict',
    'database_unavailable',
    'incremental_sync_requires_stream',
    'oauth_exchange_failed',
    'rate_limited',
    'reconnect_modified_watermark_missing',
    'reconciliation_snapshot_failed',
    'reconciliation_snapshot_incomplete',
    'remote_response_invalid',
    'remote_unavailable',
    'sync_analytical_capability_invalid',
    'sync_internal_error',
    'sync_operation_timeout',
    'sync_stream_phase_lease_stale',
    'sync_write_permit_invalid',
    'sync_write_permit_missing',
    'unexpected_sync_failure',
    'webhook_signature_invalid'
  )
$$;

CREATE FUNCTION control_plane.canonical_transform_failure_code_valid_0058(p_code text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT p_code IN (
    'canonical_authority_scope_missing',
    'canonical_authority_scope_undefined',
    'canonical_authority_undefined',
    'canonical_base_currency_invalid',
    'canonical_business_date_invalid',
    'canonical_category_assignment_reference_missing',
    'canonical_command_kind_mismatch',
    'canonical_domain_invalid',
    'canonical_employment_episode_ambiguous',
    'canonical_employment_episode_lookup_date_invalid',
    'canonical_employment_episode_lookup_scope_invalid',
    'canonical_employment_episode_missing',
    'canonical_field_unsupported',
    'canonical_landing_not_committed',
    'canonical_manifest_missing',
    'canonical_mapper_empty',
    'canonical_mapper_missing',
    'canonical_mapping_context_missing',
    'canonical_mapping_version_mismatch',
    'canonical_natural_key_ambiguous',
    'canonical_natural_key_missing',
    'canonical_natural_key_scope_invalid',
    'canonical_reference_id_missing',
    'canonical_reference_missing',
    'canonical_reference_table_unsupported',
    'canonical_source_identity_missing',
    'canonical_staging_contract_missing',
    'canonical_staging_lineage_mismatch',
    'canonical_table_unsupported',
    'canonical_timezone_invalid',
    'canonical_tombstone_unrepresented',
    'canonical_trading_day_cutoff_invalid',
    'canonical_update_only_without_tombstone',
    'canonical_values_empty',
    'database_deadlock',
    'database_integrity_violation',
    'database_permission_denied',
    'database_serialization_conflict',
    'database_unavailable',
    'dossier_timezone_invalid',
    'dossier_timezone_missing',
    'identity_corroborating_scope_reference_invalid',
    'identity_evidence_reference_invalid',
    'identity_evidence_reference_limit_exceeded',
    'identity_evidence_reference_self',
    'projection_key_invalid',
    'projection_table_invalid',
    'readiness_connection_missing',
    'readiness_domain_not_declared',
    'readiness_generation_invalid',
    'readiness_quality_status_invalid',
    'readiness_stream_snapshot_incomplete',
    'readiness_worst_state_invalid',
    'source_authority_target_mismatch',
    'source_authority_unmapped',
    'transform_analytical_capability_invalid',
    'transform_control_database_role_not_ready',
    'transform_control_scope_not_established',
    'transform_internal_error',
    'transform_operation_timeout',
    'transform_scope_not_established',
    'unexpected_transform_failure',
    'unsafe_identifier'
  )
$$;

CREATE FUNCTION control_plane.identity_projection_failure_code_valid_0058(p_code text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT p_code IN (
    'identity_projection_candidate_stale',
    'identity_projection_database_conflict',
    'identity_projection_database_unavailable',
    'identity_projection_integrity_violation',
    'identity_projection_internal_error',
    'identity_projection_invalid',
    'identity_projection_payload_conflict',
    'identity_projection_permission_denied',
    'identity_projection_result_invalid',
    'identity_projection_timeout',
    'transform_analytical_capability_invalid',
    'transform_control_database_role_not_ready',
    'transform_control_scope_not_established',
    'transform_scope_not_established',
    'unexpected_identity_projection_failure'
  )
$$;

ALTER FUNCTION control_plane.retry_or_fail_sync_job(
  text,bigint,text,text,integer,jsonb,integer,integer
) RENAME TO retry_or_fail_sync_job_unvalidated_0058;

ALTER FUNCTION control_plane.defer_sync_job(
  text,bigint,text,text,integer,jsonb,integer
) RENAME TO defer_sync_job_unvalidated_0058;

ALTER FUNCTION control_plane.block_reconciliation_phase(
  text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer
) RENAME TO block_reconciliation_phase_unvalidated_0058;

ALTER FUNCTION control_plane.fail_identity_decision_projection(
  text,text,text,text,jsonb,integer,integer
) RENAME TO fail_identity_projection_unvalidated_0058;

ALTER FUNCTION control_plane.retry_or_fail_canonical_transform_job(
  text,text,text,text,jsonb,integer,integer
) RENAME TO retry_or_fail_transform_job_unvalidated_0058;

ALTER FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  text,text,bigint,text,text,integer,jsonb
) RENAME TO mark_stream_phase_unavailable_unvalidated_0058;

CREATE FUNCTION control_plane.retry_or_fail_sync_job(
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
  IF NOT pg_catalog.coalesce(
       control_plane.worker_failure_document_has_exact_keys_0058(
         p_error,ARRAY['code','retryable']::text[]
       ),false
     )
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR NOT pg_catalog.coalesce(
       control_plane.sync_failure_code_valid_0058(p_error->>'code'),false
     ) THEN
    RAISE EXCEPTION 'sync failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.retry_or_fail_sync_job_unvalidated_0058(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count,
    p_error,p_retry_delay_seconds,p_max_attempts
  );
END;
$$;

CREATE FUNCTION control_plane.defer_sync_job(
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
  IF NOT pg_catalog.coalesce(
       control_plane.worker_failure_document_has_exact_keys_0058(
         p_reason,ARRAY['code']::text[]
       ),false
     )
     OR pg_catalog.jsonb_typeof(p_reason->'code')<>'string'
     OR NOT pg_catalog.coalesce(
       control_plane.sync_failure_code_valid_0058(p_reason->>'code'),false
     ) THEN
    RAISE EXCEPTION 'sync deferral evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.defer_sync_job_unvalidated_0058(
    p_queue_name,p_message_id,p_job_request_id,p_worker_id,p_read_count,
    p_reason,p_delay_seconds
  );
END;
$$;

CREATE FUNCTION control_plane.block_reconciliation_phase(
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
     OR NOT pg_catalog.coalesce(
       control_plane.sync_failure_code_valid_0058(p_error->>'code'),false
     ) THEN
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

CREATE FUNCTION control_plane.fail_identity_decision_projection(
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
  IF NOT pg_catalog.coalesce(
       control_plane.worker_failure_document_has_exact_keys_0058(
         p_error,ARRAY['code','retryable']::text[]
       ),false
     )
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR NOT pg_catalog.coalesce(
       control_plane.identity_projection_failure_code_valid_0058(p_error->>'code'),false
     ) THEN
    RAISE EXCEPTION 'identity projection failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.fail_identity_projection_unvalidated_0058(
    p_tenant_id,p_projection_id,p_worker_id,p_lease_token,p_error,
    p_retry_delay_seconds,p_max_attempts
  );
END;
$$;

CREATE FUNCTION control_plane.retry_or_fail_canonical_transform_job(
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
  IF NOT pg_catalog.coalesce(
       control_plane.worker_failure_document_has_exact_keys_0058(
         p_error,ARRAY['code','retryable']::text[]
       ),false
     )
     OR pg_catalog.jsonb_typeof(p_error->'code')<>'string'
     OR pg_catalog.jsonb_typeof(p_error->'retryable')<>'boolean'
     OR NOT pg_catalog.coalesce(
       control_plane.canonical_transform_failure_code_valid_0058(p_error->>'code'),false
     ) THEN
    RAISE EXCEPTION 'canonical transform failure evidence is invalid' USING ERRCODE='22023';
  END IF;
  RETURN control_plane.retry_or_fail_transform_job_unvalidated_0058(
    p_tenant_id,p_transform_job_id,p_worker_id,p_lease_token,p_error,
    p_retry_delay_seconds,p_max_attempts
  );
END;
$$;

CREATE FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  p_tenant_id text,p_connection_id text,p_connection_generation bigint,
  p_stream text,p_phase text,p_replay_version integer,p_error jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  IF NOT pg_catalog.coalesce(
       control_plane.worker_failure_document_has_exact_keys_0058(
         p_error,ARRAY['code','retryable']::text[]
       ),false
     )
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

-- Renaming retains the old grants on the implementation objects. Strip those
-- grants explicitly, including every runtime group, before publishing the
-- validated compatibility wrappers under the original names.
REVOKE ALL ON FUNCTION control_plane.worker_failure_document_has_exact_keys_0058(jsonb,text[]),
  control_plane.sync_failure_code_valid_0058(text),
  control_plane.canonical_transform_failure_code_valid_0058(text),
  control_plane.identity_projection_failure_code_valid_0058(text),
  control_plane.retry_or_fail_sync_job_unvalidated_0058(text,bigint,text,text,integer,jsonb,integer,integer),
  control_plane.defer_sync_job_unvalidated_0058(text,bigint,text,text,integer,jsonb,integer),
  control_plane.block_reconciliation_phase_unvalidated_0058(text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer),
  control_plane.fail_identity_projection_unvalidated_0058(text,text,text,text,jsonb,integer,integer),
  control_plane.retry_or_fail_transform_job_unvalidated_0058(text,text,text,text,jsonb,integer,integer),
  control_plane.mark_stream_phase_unavailable_unvalidated_0058(text,text,bigint,text,text,integer,jsonb)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
  albert_transform_control,albert_webhook_control,albert_semantic_control,
  albert_deletion_control,albert_operator_diagnostic_control;

REVOKE ALL ON FUNCTION control_plane.retry_or_fail_sync_job(text,bigint,text,text,integer,jsonb,integer,integer),
  control_plane.defer_sync_job(text,bigint,text,text,integer,jsonb,integer),
  control_plane.block_reconciliation_phase(text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer),
  control_plane.mark_sync_stream_phase_unavailable(text,text,bigint,text,text,integer,jsonb),
  control_plane.fail_identity_decision_projection(text,text,text,text,jsonb,integer,integer),
  control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer)
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
  albert_transform_control,albert_webhook_control,albert_semantic_control,
  albert_deletion_control,albert_operator_diagnostic_control;

GRANT EXECUTE ON FUNCTION
  control_plane.retry_or_fail_sync_job(text,bigint,text,text,integer,jsonb,integer,integer),
  control_plane.defer_sync_job(text,bigint,text,text,integer,jsonb,integer),
  control_plane.block_reconciliation_phase(text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer),
  control_plane.mark_sync_stream_phase_unavailable(text,text,bigint,text,text,integer,jsonb)
TO albert_sync_control;

GRANT EXECUTE ON FUNCTION
  control_plane.fail_identity_decision_projection(text,text,text,text,jsonb,integer,integer),
  control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer)
TO albert_transform_control;

COMMENT ON FUNCTION control_plane.retry_or_fail_sync_job(
  text,bigint,text,text,integer,jsonb,integer,integer
) IS 'Lease-fenced sync failure transition accepting only an exact code and boolean retryability.';
COMMENT ON FUNCTION control_plane.defer_sync_job(
  text,bigint,text,text,integer,jsonb,integer
) IS 'Lease-fenced sync deferral accepting one allowlisted operational code and no free text.';
COMMENT ON FUNCTION control_plane.block_reconciliation_phase(
  text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer
) IS 'Lease-fenced reconciliation block transition with bounded typed code-only evidence.';
COMMENT ON FUNCTION control_plane.fail_identity_decision_projection(
  text,text,text,text,jsonb,integer,integer
) IS 'Lease-fenced identity projection failure transition accepting exact code-only evidence.';
COMMENT ON FUNCTION control_plane.retry_or_fail_canonical_transform_job(
  text,text,text,text,jsonb,integer,integer
) IS 'Lease-fenced canonical transform failure transition accepting exact code-only evidence.';
COMMENT ON FUNCTION control_plane.mark_sync_stream_phase_unavailable(
  text,text,bigint,text,text,integer,jsonb
) IS 'Marks an optional stream unavailable using only capability_unavailable and boolean retryability.';

DO $$
DECLARE
  checked_role text;
  private_signature text;
BEGIN
  FOREACH checked_role IN ARRAY ARRAY[
    'anon','authenticated','service_role','albert_sync_control',
    'albert_transform_control','albert_webhook_control','albert_semantic_control',
    'albert_deletion_control','albert_operator_diagnostic_control'
  ] LOOP
    FOREACH private_signature IN ARRAY ARRAY[
      'control_plane.worker_failure_document_has_exact_keys_0058(jsonb,text[])',
      'control_plane.sync_failure_code_valid_0058(text)',
      'control_plane.canonical_transform_failure_code_valid_0058(text)',
      'control_plane.identity_projection_failure_code_valid_0058(text)',
      'control_plane.retry_or_fail_sync_job_unvalidated_0058(text,bigint,text,text,integer,jsonb,integer,integer)',
      'control_plane.defer_sync_job_unvalidated_0058(text,bigint,text,text,integer,jsonb,integer)',
      'control_plane.block_reconciliation_phase_unvalidated_0058(text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer)',
      'control_plane.fail_identity_projection_unvalidated_0058(text,text,text,text,jsonb,integer,integer)',
      'control_plane.retry_or_fail_transform_job_unvalidated_0058(text,text,text,text,jsonb,integer,integer)',
      'control_plane.mark_stream_phase_unavailable_unvalidated_0058(text,text,bigint,text,text,integer,jsonb)'
    ] LOOP
      IF pg_catalog.has_function_privilege(checked_role,private_signature,'EXECUTE') THEN
        RAISE EXCEPTION 'private worker failure routine % remains executable by %',
          private_signature,checked_role USING ERRCODE='42501';
      END IF;
    END LOOP;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
       'albert_sync_control',
       'control_plane.retry_or_fail_sync_job(text,bigint,text,text,integer,jsonb,integer,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'albert_sync_control',
       'control_plane.defer_sync_job(text,bigint,text,text,integer,jsonb,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'albert_sync_control',
       'control_plane.block_reconciliation_phase(text,text,bigint,text,text,text,jsonb,text,text,bigint,text,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'albert_sync_control',
       'control_plane.mark_sync_stream_phase_unavailable(text,text,bigint,text,text,integer,jsonb)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'albert_transform_control',
       'control_plane.fail_identity_decision_projection(text,text,text,text,jsonb,integer,integer)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'albert_transform_control',
       'control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'validated worker failure wrapper grants are incomplete'
      USING ERRCODE='42501';
  END IF;

  IF pg_catalog.has_function_privilege(
       'albert_transform_control',
       'control_plane.retry_or_fail_sync_job(text,bigint,text,text,integer,jsonb,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'albert_sync_control',
       'control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'control_plane.retry_or_fail_sync_job(text,bigint,text,text,integer,jsonb,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'control_plane.retry_or_fail_canonical_transform_job(text,text,text,text,jsonb,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'validated worker failure wrapper grants are over-broad'
      USING ERRCODE='42501';
  END IF;
END;
$$;

COMMIT;
