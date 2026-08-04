BEGIN;

CREATE INDEX IF NOT EXISTS canonical_transform_jobs_stream_backlog_idx
  ON control_plane.canonical_transform_jobs (
    tenant_id,connection_id,connection_generation,stream,mapping_version,status
  )
  WHERE status IN ('queued','running','retry_wait');

-- A refund or other child observation can be encountered before the page that
-- materialises its canonical parent. While ordinary sibling pages remain in
-- the same stream backlog, a missing-reference outcome is dependency waiting,
-- not a failed attempt. Once only missing-reference waiters remain, the normal
-- bounded failure budget resumes and a genuinely absent parent still fails
-- closed.
CREATE OR REPLACE FUNCTION control_plane.retry_or_fail_transform_job_unvalidated_0058(
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
DECLARE next_status text;
DECLARE reference_backlog boolean:=false;
BEGIN
  IF p_error IS NULL OR jsonb_typeof(p_error)<>'object'
     OR p_retry_delay_seconds NOT BETWEEN 1 AND 86400
     OR p_max_attempts NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'canonical transform failure input is invalid' USING ERRCODE='22023';
  END IF;

  IF p_error->>'code'='canonical_reference_missing'
     AND coalesce((p_error->>'retryable')::boolean,false) THEN
    SELECT EXISTS (
      SELECT 1
        FROM control_plane.canonical_transform_jobs current_job
        JOIN control_plane.canonical_transform_jobs sibling
          ON sibling.tenant_id=current_job.tenant_id
         AND sibling.connection_id=current_job.connection_id
         AND sibling.connection_generation=current_job.connection_generation
         AND sibling.stream=current_job.stream
         AND sibling.mapping_version=current_job.mapping_version
         AND sibling.transform_job_id<>current_job.transform_job_id
       WHERE current_job.tenant_id=p_tenant_id
         AND current_job.transform_job_id=p_transform_job_id
         AND current_job.status='running'
         AND current_job.lease_owner=p_worker_id
         AND current_job.lease_token=p_lease_token
         AND current_job.lease_expires_at>now()
         AND (
           sibling.status='queued'
           OR (
             sibling.status='retry_wait'
             AND sibling.last_error->>'code' IS DISTINCT FROM 'canonical_reference_missing'
           )
         )
    ) INTO reference_backlog;
  END IF;

  UPDATE control_plane.canonical_transform_jobs job
     SET status=CASE
           WHEN reference_backlog THEN 'retry_wait'
           WHEN job.attempt_count>=p_max_attempts
             OR coalesce((p_error->>'retryable')::boolean,false)=false THEN 'failed'
           ELSE 'retry_wait'
         END,
         available_at=CASE
           WHEN reference_backlog
             THEN now()+make_interval(secs=>greatest(p_retry_delay_seconds,30))
           WHEN job.attempt_count>=p_max_attempts
             OR coalesce((p_error->>'retryable')::boolean,false)=false
             THEN job.available_at
           ELSE now()+make_interval(secs=>p_retry_delay_seconds)
         END,
         attempt_count=CASE WHEN reference_backlog
           THEN greatest(job.attempt_count-1,0) ELSE job.attempt_count END,
         last_error=p_error,
         completed_at=CASE
           WHEN NOT reference_backlog AND (
             job.attempt_count>=p_max_attempts
             OR coalesce((p_error->>'retryable')::boolean,false)=false
           ) THEN now()
           ELSE NULL
         END,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE job.tenant_id=p_tenant_id
     AND job.transform_job_id=p_transform_job_id
     AND job.status='running'
     AND job.lease_owner=p_worker_id
     AND job.lease_token=p_lease_token
     AND job.lease_expires_at>now()
  RETURNING job.status INTO next_status;

  IF next_status IS NULL THEN
    RAISE EXCEPTION 'canonical transform lease is stale' USING ERRCODE='55000';
  END IF;
  IF next_status='failed' THEN
    UPDATE control_plane.readiness readiness
       SET state='blocked',reason_code='canonical_transform_failed',
           reason_detail='Canonical transformation failed.',
           evaluated_at=now(),updated_at=now()
      FROM control_plane.canonical_transform_jobs job
     WHERE job.tenant_id=p_tenant_id
       AND job.transform_job_id=p_transform_job_id
       AND readiness.tenant_id=job.tenant_id
       AND readiness.connection_id=job.connection_id
       AND readiness.domain=ANY(job.domains);
  END IF;
  RETURN next_status;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.retry_or_fail_transform_job_unvalidated_0058(
  text,text,text,text,jsonb,integer,integer
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_webhook_control,albert_transform_control,albert_semantic_control,
       albert_operator_diagnostic_control,albert_deletion_control;

COMMENT ON FUNCTION control_plane.retry_or_fail_transform_job_unvalidated_0058(
  text,text,text,text,jsonb,integer,integer
) IS 'Internal lease-fenced transform outcome writer; missing references wait without consuming attempts while ordinary sibling pages remain.';

COMMIT;
