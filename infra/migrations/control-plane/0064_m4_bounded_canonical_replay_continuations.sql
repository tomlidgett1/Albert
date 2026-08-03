BEGIN;

ALTER TABLE control_plane.canonical_transform_jobs
  ADD COLUMN IF NOT EXISTS continuation_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS continuation_candidate_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS continuation_command_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_continuation_at timestamptz,
  ADD COLUMN IF NOT EXISTS continuation_result jsonb;

ALTER TABLE control_plane.canonical_transform_jobs
  DROP CONSTRAINT IF EXISTS canonical_transform_jobs_continuation_count_nonnegative;
ALTER TABLE control_plane.canonical_transform_jobs
  ADD CONSTRAINT canonical_transform_jobs_continuation_count_nonnegative
  CHECK (continuation_count>=0 AND continuation_candidate_count>=0
         AND continuation_command_count>=0);
ALTER TABLE control_plane.canonical_transform_jobs
  DROP CONSTRAINT IF EXISTS canonical_transform_jobs_continuation_result_object;
ALTER TABLE control_plane.canonical_transform_jobs
  ADD CONSTRAINT canonical_transform_jobs_continuation_result_object
  CHECK (continuation_result IS NULL OR jsonb_typeof(continuation_result)='object');

CREATE TABLE IF NOT EXISTS control_plane.canonical_transform_continuation_progress (
  tenant_id text NOT NULL,
  transform_job_id text NOT NULL,
  progress_token text NOT NULL CHECK (progress_token ~ '^[a-f0-9]{64}$'),
  continuation_ordinal bigint NOT NULL CHECK (continuation_ordinal>0),
  candidate_count integer NOT NULL CHECK (candidate_count BETWEEN 0 AND 1000),
  command_count integer NOT NULL CHECK (command_count BETWEEN 0 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,transform_job_id,progress_token),
  UNIQUE (tenant_id,transform_job_id,continuation_ordinal),
  FOREIGN KEY (tenant_id,transform_job_id)
    REFERENCES control_plane.canonical_transform_jobs(tenant_id,transform_job_id)
    ON DELETE CASCADE,
  CHECK (candidate_count+command_count>0)
);

ALTER TABLE control_plane.canonical_transform_continuation_progress
  ENABLE ROW LEVEL SECURITY;

-- The generation column became mandatory in 0038. Re-publish enqueue with an
-- explicit immutable value from the sync-run authority and reject a stale or
-- disconnected connection before a transform job can exist.
CREATE OR REPLACE FUNCTION control_plane.enqueue_canonical_transform_job(
  p_tenant_id text,
  p_batch_id text,
  p_mapping_version text,
  p_domains text[],
  p_backfill_complete boolean
) RETURNS TABLE (transform_job_id text,created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE manifest_row record; existing_id text; generated_id text;
BEGIN
  IF p_tenant_id IS NULL OR NOT control_plane.is_ulid(p_tenant_id)
     OR p_batch_id IS NULL OR NOT control_plane.is_ulid(p_batch_id)
     OR p_mapping_version IS NULL
     OR p_mapping_version !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
     OR p_domains IS NULL OR cardinality(p_domains)=0
     OR EXISTS (
       SELECT 1 FROM unnest(p_domains) domain(value)
       WHERE value !~ '^[a-z][a-z0-9_]*$'
     ) THEN
    RAISE EXCEPTION 'canonical transform enqueue input is invalid' USING ERRCODE='22023';
  END IF;

  SELECT manifest.tenant_id,manifest.batch_id,manifest.sync_run_id,
         manifest.connection_id,manifest.connector_key,manifest.stream,
         run.connection_generation
    INTO manifest_row
    FROM control_plane.raw_batch_manifests manifest
    JOIN control_plane.raw_batch_landings landing
      ON landing.tenant_id=manifest.tenant_id AND landing.batch_id=manifest.batch_id
    JOIN control_plane.sync_runs run
      ON run.tenant_id=manifest.tenant_id AND run.sync_run_id=manifest.sync_run_id
     AND run.connection_id=manifest.connection_id
    JOIN control_plane.connections connection
      ON connection.tenant_id=manifest.tenant_id
     AND connection.connection_id=manifest.connection_id
     AND connection.connection_generation=run.connection_generation
     AND connection.status IN ('connected','degraded')
   WHERE manifest.tenant_id=p_tenant_id AND manifest.batch_id=p_batch_id
     AND landing.status IN ('landed','quarantined')
     AND landing.analytical_committed_at IS NOT NULL
   FOR UPDATE OF landing,connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical transform batch is not durably landed on the active connection generation'
      USING ERRCODE='55000';
  END IF;

  SELECT job.transform_job_id INTO existing_id
    FROM control_plane.canonical_transform_jobs job
   WHERE job.tenant_id=p_tenant_id AND job.batch_id=p_batch_id
     AND job.mapping_version=p_mapping_version;
  IF existing_id IS NOT NULL THEN
    RETURN QUERY SELECT existing_id,false;
    RETURN;
  END IF;

  generated_id:=control_plane.generate_ulid();
  INSERT INTO control_plane.canonical_transform_jobs (
    tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,
    connection_generation,connector_id,stream,domains,mapping_version,
    backfill_complete
  ) VALUES (
    manifest_row.tenant_id,generated_id,manifest_row.batch_id,
    manifest_row.sync_run_id,manifest_row.connection_id,
    manifest_row.connection_generation,manifest_row.connector_key,
    manifest_row.stream,
    ARRAY(SELECT DISTINCT value FROM unnest(p_domains) domain(value) ORDER BY value),
    p_mapping_version,p_backfill_complete
  );
  RETURN QUERY SELECT generated_id,true;
END;
$$;

-- Preserve the deployed claim contract and add the immutable generation to a
-- versioned function consumed by the generation-aware worker.
CREATE OR REPLACE FUNCTION control_plane.claim_canonical_transform_job_v2(
  p_worker_id text,p_mapping_version text,p_lease_seconds integer
) RETURNS TABLE (
  tenant_id text,transform_job_id text,batch_id text,sync_run_id text,
  connection_id text,connection_generation bigint,connector_id text,
  stream text,domains text[],mapping_version text,backfill_complete boolean,
  attempt_count integer,lease_token text,lease_expires_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
  SELECT claimed.tenant_id,claimed.transform_job_id,claimed.batch_id,
         claimed.sync_run_id,claimed.connection_id,job.connection_generation,
         claimed.connector_id,claimed.stream,claimed.domains,
         claimed.mapping_version,claimed.backfill_complete,
         claimed.attempt_count,claimed.lease_token,claimed.lease_expires_at
    FROM control_plane.claim_canonical_transform_job(
      p_worker_id,p_mapping_version,p_lease_seconds
    ) claimed
    JOIN control_plane.canonical_transform_jobs job
      ON job.tenant_id=claimed.tenant_id
     AND job.transform_job_id=claimed.transform_job_id
     AND job.connection_id=claimed.connection_id
$$;

/**
 * Release one bounded compatibility-replay invocation back to the durable
 * queue. A continuation is progress, not a failed attempt: compensate for the
 * claim-time attempt increment so an arbitrarily large valid backlog cannot
 * exhaust the transform failure budget.
 */
CREATE OR REPLACE FUNCTION control_plane.continue_canonical_transform_job(
  p_tenant_id text,
  p_transform_job_id text,
  p_worker_id text,
  p_lease_token text,
  p_progress jsonb,
  p_delay_seconds integer
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE next_count bigint;
BEGIN
  IF p_tenant_id IS NULL OR NOT control_plane.is_ulid(p_tenant_id)
     OR p_transform_job_id IS NULL
     OR NOT control_plane.is_ulid(p_transform_job_id)
     OR p_worker_id IS NULL
     OR length(btrim(p_worker_id)) NOT BETWEEN 1 AND 160
     OR p_lease_token IS NULL OR NOT control_plane.is_ulid(p_lease_token)
     OR p_progress IS NULL OR jsonb_typeof(p_progress)<>'object'
     OR p_delay_seconds IS NULL OR p_delay_seconds NOT BETWEEN 0 AND 300 THEN
    RAISE EXCEPTION 'canonical transform continuation evidence is invalid'
      USING ERRCODE='22023';
  END IF;

  IF (SELECT count(*) FROM jsonb_object_keys(p_progress))<>5
     OR NOT (p_progress ?& ARRAY['kind','pending','candidates','commands','progressToken']::text[])
     OR p_progress->>'kind'<>'compatibility_replay'
     OR jsonb_typeof(p_progress->'pending')<>'boolean'
     OR p_progress->'pending' IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(p_progress->'candidates')<>'number'
     OR p_progress->>'candidates' !~ '^(0|[1-9][0-9]{0,3})$'
     OR jsonb_typeof(p_progress->'commands')<>'number'
     OR p_progress->>'commands' !~ '^(0|[1-9][0-9]{0,4})$'
     OR jsonb_typeof(p_progress->'progressToken')<>'string'
     OR p_progress->>'progressToken' !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'canonical transform continuation evidence is invalid'
      USING ERRCODE='22023';
  END IF;

  IF (p_progress->>'candidates')::integer>1000
     OR (p_progress->>'commands')::integer>5000
     OR (p_progress->>'candidates')::integer+
          (p_progress->>'commands')::integer<1 THEN
    RAISE EXCEPTION 'canonical transform continuation evidence is invalid'
      USING ERRCODE='22023';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM control_plane.canonical_transform_continuation_progress progress
     WHERE progress.tenant_id=p_tenant_id
       AND progress.transform_job_id=p_transform_job_id
       AND progress.progress_token=p_progress->>'progressToken'
  ) THEN
    RAISE EXCEPTION 'canonical transform continuation did not advance'
      USING ERRCODE='55000';
  END IF;

  UPDATE control_plane.canonical_transform_jobs job
     SET status='retry_wait',
         available_at=now()+make_interval(secs=>p_delay_seconds),
         -- claim_canonical_transform_job increments this counter. Continuation
         -- work is neither a failure nor a fresh retry attempt.
         attempt_count=greatest(job.attempt_count-1,0),
         continuation_count=job.continuation_count+1,
         continuation_candidate_count=job.continuation_candidate_count+
           (p_progress->>'candidates')::integer,
         continuation_command_count=job.continuation_command_count+
           (p_progress->>'commands')::integer,
         last_continuation_at=now(),continuation_result=p_progress,
         last_error=NULL,completed_at=NULL,
         lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
   WHERE job.tenant_id=p_tenant_id
     AND job.transform_job_id=p_transform_job_id
     AND job.status='running'
     AND job.lease_owner=p_worker_id
     AND job.lease_token=p_lease_token
     AND job.lease_expires_at>now()
     AND job.continuation_result->>'progressToken'
           IS DISTINCT FROM p_progress->>'progressToken'
  RETURNING job.continuation_count INTO next_count;

  IF next_count IS NULL THEN
    RAISE EXCEPTION 'canonical transform lease is stale' USING ERRCODE='55000';
  END IF;
  INSERT INTO control_plane.canonical_transform_continuation_progress (
    tenant_id,transform_job_id,progress_token,continuation_ordinal,
    candidate_count,command_count
  ) VALUES (
    p_tenant_id,p_transform_job_id,p_progress->>'progressToken',next_count,
    (p_progress->>'candidates')::integer,(p_progress->>'commands')::integer
  );
  RETURN next_count;
END;
$$;

REVOKE ALL ON control_plane.canonical_transform_continuation_progress
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
  albert_transform_control,albert_webhook_control,albert_semantic_control,
  albert_deletion_control,albert_operator_diagnostic_control;

REVOKE ALL ON FUNCTION control_plane.continue_canonical_transform_job(
  text,text,text,text,jsonb,integer
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
  albert_transform_control,albert_webhook_control,albert_semantic_control,
  albert_deletion_control,albert_operator_diagnostic_control;

REVOKE ALL ON FUNCTION control_plane.claim_canonical_transform_job_v2(
  text,text,integer
) FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
  albert_transform_control,albert_webhook_control,albert_semantic_control,
  albert_deletion_control,albert_operator_diagnostic_control;

GRANT EXECUTE ON FUNCTION control_plane.continue_canonical_transform_job(
  text,text,text,text,jsonb,integer
) TO albert_transform_control;

GRANT EXECUTE ON FUNCTION control_plane.claim_canonical_transform_job_v2(
  text,text,integer
) TO albert_transform_control;

COMMENT ON FUNCTION control_plane.continue_canonical_transform_job(
  text,text,text,text,jsonb,integer
) IS 'Lease-fenced durable continuation for bounded canonical compatibility replay; progress does not consume the failure-attempt budget.';

COMMIT;
