-- ADR 0056 mints a fresh batchId for every InitialBackfill page after the first
-- inside one claim. Raw Storage grants previously required the object key's
-- batchId to equal the durable job payload batchId, so page 2+ uploads failed
-- with "sync raw object is not bound to the claimed job".
--
-- Bind grants to the claimed job's tenant/connection/stream/date prefix, and
-- allow any ULID batch object under that prefix while the write permit and
-- sync-run fence remain active.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.issue_raw_storage_sync_session(
  p_permit_id text,
  p_worker_id text,
  p_object_key text,
  p_auth_user_id uuid,
  p_auth_session_id uuid,
  p_auth_token_expires_at timestamptz
)
RETURNS TABLE (
  grant_id text,tenant_id text,connection_id text,object_key text,expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  permit control_plane.sync_write_permits%ROWTYPE;
  request_payload jsonb;
  attempt_deadline timestamptz;
  grant_issued_at timestamptz;
  deadline timestamptz;
  generated_id text;
  expected_prefix text;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_sync_control_runtime','albert_sync_control'
  );
  IF p_auth_user_id IS NULL OR p_auth_session_id IS NULL
     OR p_auth_token_expires_at IS NULL
     OR p_auth_token_expires_at<=clock_timestamp()+interval '5 seconds'
     OR NOT extensions.albert_raw_storage_machine_user_matches('sync',p_auth_user_id) THEN
    RAISE EXCEPTION 'raw Storage sync Auth session is invalid' USING ERRCODE='22023';
  END IF;
  SELECT candidate.* INTO permit
    FROM control_plane.sync_write_permits AS candidate
   WHERE candidate.permit_id=p_permit_id
     AND candidate.worker_id=p_worker_id
     AND candidate.expires_at>clock_timestamp()
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync write permit is not active' USING ERRCODE='55000';
  END IF;
  PERFORM control_plane.require_active_sync_job_lease(
    permit.queue_name,permit.message_id,permit.job_request_id,
    permit.worker_id,permit.read_count
  );
  SELECT job.payload,attempt.visibility_deadline INTO request_payload,attempt_deadline
    FROM control_plane.sync_job_requests AS job
    JOIN control_plane.sync_job_attempts AS attempt
      ON attempt.tenant_id=job.tenant_id
     AND attempt.job_request_id=job.job_request_id
     AND attempt.attempt_number=permit.read_count
     AND attempt.worker_id=permit.worker_id
    JOIN control_plane.sync_runs AS run
      ON run.tenant_id=permit.tenant_id AND run.sync_run_id=permit.sync_run_id
    JOIN control_plane.connections AS connection
      ON connection.tenant_id=permit.tenant_id
     AND connection.connection_id=permit.connection_id
    JOIN control_plane.tenants AS tenant ON tenant.tenant_id=permit.tenant_id
   WHERE job.tenant_id=permit.tenant_id
     AND job.job_request_id=permit.job_request_id
     AND job.status='running'
     AND job.queue_name=permit.queue_name
     AND job.queue_message_id=permit.message_id
     AND attempt.visibility_deadline>clock_timestamp()
     AND attempt.finished_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.sync_job_attempt_outcomes AS outcome
        WHERE outcome.tenant_id=attempt.tenant_id
          AND outcome.job_attempt_id=attempt.job_attempt_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.sync_job_attempts AS later
        WHERE later.tenant_id=attempt.tenant_id
          AND later.job_request_id=attempt.job_request_id
          AND later.attempt_number>attempt.attempt_number
     )
     AND run.status='running'
     AND run.connection_id=permit.connection_id
     AND run.connection_generation=permit.connection_generation
     AND connection.connection_generation=permit.connection_generation
     AND connection.status IN ('connected','degraded')
     AND tenant.status='active'
     AND NOT EXISTS (
       SELECT 1 FROM control_plane.deletion_requests AS deletion
        WHERE deletion.tenant_id=permit.tenant_id
          AND (deletion.scope='tenant' OR deletion.connection_id=permit.connection_id)
          AND deletion.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF job,attempt,run,connection,tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sync raw write is fenced by stale work or deletion' USING ERRCODE='55000';
  END IF;
  BEGIN
    expected_prefix:=concat_ws(
      '/','tenant',permit.tenant_id,'connection',permit.connection_id,'stream',
      request_payload->>'stream','date',
      to_char((request_payload->>'requestedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'sync job raw object identity is invalid' USING ERRCODE='22023';
  END;
  -- Multipage InitialBackfill (ADR 0056) mints a fresh batchId per page after
  -- the first. Bind to the claimed job's stream/date prefix; any ULID batch
  -- under that prefix is allowed while the permit and sync-run fence hold.
  IF expected_prefix IS NULL
     OR expected_prefix !~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR left(p_object_key, length(expected_prefix) + 1)
        IS DISTINCT FROM expected_prefix || '/'
     OR substring(p_object_key from length(expected_prefix) + 2)
        !~ '^batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl[.]gz$'
     OR p_object_key ~ '/stream/webhook_' THEN
    RAISE EXCEPTION 'sync raw object is not bound to the claimed job' USING ERRCODE='22023';
  END IF;
  DELETE FROM control_plane.raw_storage_sync_session_grants AS expired
   WHERE expired.grant_id IN (
     SELECT candidate.grant_id
      FROM control_plane.raw_storage_sync_session_grants AS candidate
      WHERE candidate.expires_at<=clock_timestamp()
      ORDER BY candidate.expires_at,candidate.grant_id
      LIMIT 100
      FOR UPDATE SKIP LOCKED
   );
  grant_issued_at:=clock_timestamp();
  deadline:=least(
    p_auth_token_expires_at,permit.expires_at,attempt_deadline,
    grant_issued_at+interval '5 minutes'
  );
  IF deadline IS NULL OR deadline<=grant_issued_at+interval '5 seconds' THEN
    RAISE EXCEPTION 'sync raw Storage grant would already be expired' USING ERRCODE='55000';
  END IF;
  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.raw_storage_sync_session_grants(
    tenant_id,grant_id,permit_id,worker_id,auth_user_id,auth_session_id,
    object_key,issued_at,expires_at
  ) VALUES (
    permit.tenant_id,generated_id,permit.permit_id,permit.worker_id,
    p_auth_user_id,p_auth_session_id,p_object_key,grant_issued_at,deadline
  );
  RETURN QUERY SELECT generated_id,permit.tenant_id,permit.connection_id,p_object_key,deadline;
END;
$$;

REVOKE ALL ON FUNCTION
  control_plane.issue_raw_storage_sync_session(text,text,text,uuid,uuid,timestamptz)
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;

GRANT EXECUTE ON FUNCTION
  control_plane.issue_raw_storage_sync_session(text,text,text,uuid,uuid,timestamptz)
TO albert_sync_control;

COMMIT;
