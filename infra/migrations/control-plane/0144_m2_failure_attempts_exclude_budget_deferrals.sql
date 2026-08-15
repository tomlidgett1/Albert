-- retry_or_fail_sync_job counted the queue message's raw read count as the
-- failure attempt number. Vendor-budget deferrals (defer_sync_job) also
-- redeliver the same message, so every budget wait incremented the count. A
-- backfill paced by a daily budget — Xero's 1,000-call allowance spread over
-- 24h across ~190 stream jobs — accumulates dozens of reads per job from
-- waiting alone; the first ordinary transient error afterwards then met
-- read_ct >= 8 and dead-lettered the job permanently.
--
-- Count genuine failures instead: the retry outcomes this job has recorded
-- whose error code is anything other than rate_limited (deferrals record a
-- rate_limited retry outcome). Everything else — lease fencing, evidence
-- rows, dead-letter shape — is unchanged from 0058.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.retry_or_fail_sync_job_unvalidated_0058(
  p_queue_name text, p_message_id bigint, p_job_request_id text, p_worker_id text,
  p_read_count integer, p_error jsonb, p_retry_delay_seconds integer,
  p_max_attempts integer DEFAULT 8
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pgmq'
AS $$
DECLARE
  request_row control_plane.sync_job_requests%ROWTYPE;
  attempt_count integer;
BEGIN
  IF p_error IS NULL OR jsonb_typeof(p_error) <> 'object'
     OR p_retry_delay_seconds NOT BETWEEN 1 AND 604800
     OR p_max_attempts NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'job failure input is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM control_plane.require_active_sync_job_lease(
    p_queue_name, p_message_id, p_job_request_id, p_worker_id, p_read_count
  );
  SELECT * INTO STRICT request_row
  FROM control_plane.sync_job_requests AS request
  WHERE request.job_request_id = p_job_request_id
    AND request.queue_name = p_queue_name
    AND request.queue_message_id = p_message_id
  FOR UPDATE;

  -- This failure plus every prior genuine failure. Budget deferrals leave a
  -- rate_limited retry outcome and are not attempts at the work.
  SELECT 1 + count(*) INTO attempt_count
  FROM control_plane.sync_job_attempt_outcomes AS outcome
  JOIN control_plane.sync_job_attempts AS attempt
    ON attempt.tenant_id = outcome.tenant_id
   AND attempt.job_attempt_id = outcome.job_attempt_id
  WHERE outcome.tenant_id = request_row.tenant_id
    AND attempt.job_request_id = p_job_request_id
    AND outcome.outcome = 'retry'
    AND coalesce(outcome.error_metadata->>'code', '') <> 'rate_limited';

  IF attempt_count < p_max_attempts THEN
    PERFORM pgmq.set_vt(p_queue_name, p_message_id, p_retry_delay_seconds);
    UPDATE control_plane.sync_job_requests
    SET status = 'retry_wait',
        available_at = now() + make_interval(secs => p_retry_delay_seconds),
        last_error = p_error
    WHERE tenant_id = request_row.tenant_id AND job_request_id = p_job_request_id;
    INSERT INTO control_plane.sync_job_attempt_outcomes (
      tenant_id, job_attempt_outcome_id, job_attempt_id, outcome, error_metadata
    )
    SELECT request_row.tenant_id, control_plane.generate_ulid(),
      attempt.job_attempt_id, 'retry', p_error
    FROM control_plane.sync_job_attempts AS attempt
    WHERE attempt.tenant_id = request_row.tenant_id
      AND attempt.job_request_id = p_job_request_id
      AND attempt.attempt_number = p_read_count
      AND attempt.worker_id = p_worker_id
    ON CONFLICT (tenant_id, job_attempt_id) DO NOTHING;
    RETURN 'retry_wait';
  END IF;

  IF NOT pgmq.archive(p_queue_name, p_message_id) THEN
    RAISE EXCEPTION 'queue message could not be archived' USING ERRCODE = '55000';
  END IF;
  PERFORM pgmq.send(
    'albert_sync_deadletter',
    jsonb_build_object(
      'jobRequestId', p_job_request_id,
      'tenantId', request_row.tenant_id,
      'connectionId', request_row.connection_id,
      'sourceQueue', p_queue_name,
      'sourceMessageId', p_message_id,
      'attempts', attempt_count,
      'error', p_error,
      'payload', request_row.payload,
      'failedAt', now()
    )
  );
  UPDATE control_plane.sync_job_requests
  SET status = 'failed', completed_at = now(), last_error = p_error
  WHERE tenant_id = request_row.tenant_id AND job_request_id = p_job_request_id;
  INSERT INTO control_plane.sync_job_attempt_outcomes (
    tenant_id, job_attempt_outcome_id, job_attempt_id, outcome, error_metadata
  )
  SELECT request_row.tenant_id, control_plane.generate_ulid(),
    attempt.job_attempt_id, 'failed', p_error
  FROM control_plane.sync_job_attempts AS attempt
  WHERE attempt.tenant_id = request_row.tenant_id
    AND attempt.job_request_id = p_job_request_id
    AND attempt.attempt_number = p_read_count
    AND attempt.worker_id = p_worker_id
  ON CONFLICT (tenant_id, job_attempt_id) DO NOTHING;
  RETURN 'failed';
END;
$$;

REVOKE ALL ON FUNCTION control_plane.retry_or_fail_sync_job_unvalidated_0058(
  text,bigint,text,text,integer,jsonb,integer,integer
) FROM PUBLIC;

DO $$
BEGIN
  IF pg_get_functiondef('control_plane.retry_or_fail_sync_job_unvalidated_0058(text,bigint,text,text,integer,jsonb,integer,integer)'::regprocedure)
       !~ 'rate_limited' THEN
    RAISE EXCEPTION 'failure attempt counting still uses raw read count';
  END IF;
END $$;

COMMIT;
