-- A transform job that has not finished yet carries no quality evidence, and
-- `coalesce(result_metadata->>'partialQualityStatus',...,'blocked')` turned that
-- absence into a critical quality blocker. Every queued or running page therefore
-- drove worstState to 'blocked', so a domain flipped to blocked readiness for the
-- few minutes each incremental sync or reconciliation page took to transform, and
-- the projection could only reach ready_complete by racing the schedule.
--
-- The function already models the correct outcome: a stream with no transform job
-- at all leaves transform_status NULL and lands on the 'incomplete' branch. Work
-- in flight is the same state as work not yet started, so score it the same way.
-- Keep the fail-closed default where it belongs — a job that reports 'succeeded'
-- without quality evidence is a genuine invariant breach and must still block.
--
-- 'failed' needs no quality opinion: transform_status='failed' already forces
-- 'blocked' one clause earlier. 'retry_wait' is a retryable failure serving its
-- backoff, not a terminal one, so it reads as in-flight.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.sync_readiness_inputs(
  p_tenant_id text,p_connection_id text,p_streams text[],
  p_current_batch_id text,p_current_partial_quality text,
  p_current_complete_quality text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE generation bigint; result jsonb;
BEGIN
  IF p_streams IS NULL OR cardinality(p_streams)=0
     OR EXISTS (
       SELECT 1 FROM unnest(p_streams) AS stream_name(value)
        WHERE value !~ '^[a-z][a-z0-9_]*$'
     )
     OR NOT control_plane.is_ulid(p_current_batch_id)
     OR p_current_partial_quality NOT IN ('passed','warning','failed','blocked')
     OR p_current_complete_quality NOT IN ('passed','warning','failed','blocked')
     OR array_position(
          ARRAY['passed','warning','failed','blocked'],p_current_complete_quality
        )<array_position(
          ARRAY['passed','warning','failed','blocked'],p_current_partial_quality
        ) THEN
    RAISE EXCEPTION 'readiness stream set is invalid' USING ERRCODE='22023';
  END IF;
  IF nullif(current_setting('albert.tenant_id',true),'') IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'readiness tenant scope mismatch' USING ERRCODE='42501';
  END IF;
  SELECT connection_generation INTO generation FROM control_plane.connections
   WHERE tenant_id=p_tenant_id AND connection_id=p_connection_id;
  IF generation IS NULL THEN
    RAISE EXCEPTION 'readiness connection missing' USING ERRCODE='P0002';
  END IF;

  WITH required_streams AS (
    SELECT DISTINCT value AS stream FROM unnest(p_streams) AS stream_name(value)
  ), latest_transform AS (
    SELECT DISTINCT ON (job.stream) job.stream,
           CASE WHEN job.batch_id=p_current_batch_id THEN 'succeeded' ELSE job.status END AS status,
           -- Quality is an outcome, so only a job that produced one may assert it.
           CASE WHEN job.batch_id=p_current_batch_id THEN p_current_partial_quality
                WHEN job.status='succeeded' THEN coalesce(
                  job.result_metadata->>'partialQualityStatus',
                  job.result_metadata->>'qualityStatus','blocked'
                )
                ELSE NULL
           END AS partial_quality_status,
           CASE WHEN job.batch_id=p_current_batch_id THEN p_current_complete_quality
                WHEN job.status='succeeded' THEN coalesce(
                  job.result_metadata->>'completeQualityStatus',
                  job.result_metadata->>'qualityStatus','blocked'
                )
                ELSE NULL
           END AS complete_quality_status
      FROM control_plane.canonical_transform_jobs job
      JOIN control_plane.sync_runs run
        ON run.tenant_id=job.tenant_id AND run.sync_run_id=job.sync_run_id
      JOIN required_streams required ON required.stream=job.stream
     WHERE job.tenant_id=p_tenant_id AND job.connection_id=p_connection_id
       AND run.connection_generation=generation
     ORDER BY job.stream,job.created_at DESC,job.transform_job_id DESC
  ), stream_state AS (
    SELECT required.stream,
           coalesce(cursor.backfill_complete,false) AS backfill_complete,
           cursor.source_watermark,
           coalesce((
             SELECT CASE
               WHEN bool_or(phase.required AND phase.status='failed') THEN 'failed'
               WHEN bool_or(phase.required AND phase.status IN ('planned','queued','running')) THEN 'incomplete'
               WHEN bool_and(phase.status IN ('succeeded','unavailable')) THEN 'complete'
               ELSE 'missing'
             END
             FROM control_plane.sync_stream_phases phase
             WHERE phase.tenant_id=p_tenant_id AND phase.connection_id=p_connection_id
               AND phase.connection_generation=generation AND phase.stream=required.stream
           ),'missing') AS phase_state,
           transform.status AS transform_status,
           transform.partial_quality_status,
           transform.complete_quality_status
      FROM required_streams required
      LEFT JOIN control_plane.stream_cursors cursor
        ON cursor.tenant_id=p_tenant_id AND cursor.connection_id=p_connection_id
       AND cursor.connection_generation=generation AND cursor.stream=required.stream
      LEFT JOIN latest_transform transform ON transform.stream=required.stream
  )
  SELECT jsonb_build_object(
    'connectionGeneration',generation,
    'streams',coalesce(jsonb_agg(jsonb_build_object(
      'stream',stream,'backfillComplete',backfill_complete,
      'sourceWatermark',source_watermark,'phaseState',phase_state,
      'transformStatus',transform_status,
      'partialQualityStatus',partial_quality_status,
      'completeQualityStatus',complete_quality_status
    ) ORDER BY stream),'[]'::jsonb),
    'worstState',CASE
      WHEN bool_or(
        phase_state='failed' OR transform_status='failed'
        OR partial_quality_status='blocked'
      ) THEN 'blocked'
      WHEN bool_or(partial_quality_status='failed') THEN 'degraded'
      WHEN bool_or(
        phase_state IN ('missing','incomplete')
        OR transform_status IS NULL OR transform_status<>'succeeded'
      ) THEN 'incomplete'
      -- Complete-quality failures hold a fully extracted domain at
      -- ready_partial; they do not revoke its already proven recent slice.
      WHEN bool_or(
        backfill_complete
        AND complete_quality_status IN ('blocked','failed')
      ) THEN 'incomplete'
      WHEN bool_or(
        partial_quality_status='warning'
        OR (backfill_complete AND complete_quality_status='warning')
      ) THEN 'warning'
      ELSE 'passed'
    END
  ) INTO result FROM stream_state;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.sync_readiness_inputs(
  text,text,text[],text,text,text
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.sync_readiness_inputs(
  text,text,text[],text,text,text
) TO albert_transform_control;

COMMENT ON FUNCTION control_plane.sync_readiness_inputs(
  text,text,text[],text,text,text
) IS
  'Readiness inputs for a connection generation. Quality is read only from a succeeded transform; queued, running and retry_wait jobs report incomplete, matching a stream with no transform job at all.';

COMMIT;
