-- The readiness quality gates run once per sync run, on the page that completes
-- its stream. Every earlier page commits fail-closed 'blocked' statuses that
-- were never measured. Two readers took those placeholders literally:
--
--   * complete_canonical_transform_job capped readiness progress at 0.95 for
--     every domain on the job, so a settled 100% was dragged back down by each
--     mid-scan page and pushed up again by the next projection. A long
--     reconciliation scan made a domain oscillate for hours.
--   * sync_readiness_inputs read the placeholder as this stream's quality
--     verdict, holding a required stream at 'blocked' for the whole scan.
--
-- The worker now records whether the gates actually ran. An ungated page keeps
-- its fail-closed statuses for any reader that ignores the flag, but neither
-- readiness path treats it as a verdict. Absent or malformed flags read as
-- gated, so pre-existing rows keep their historical meaning.
--
-- An ungated stream is not evidence of a passing gate either: a required stream
-- with no measured quality now reports 'incomplete' rather than falling through
-- to 'passed' and certifying complete readiness on no evidence at all.

BEGIN;

CREATE OR REPLACE FUNCTION control_plane.transform_result_was_gated(p_result jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_result->'qualityEvaluated')='boolean'
      THEN (p_result->>'qualityEvaluated')::boolean
    ELSE true
  END;
$$;

COMMENT ON FUNCTION control_plane.transform_result_was_gated(jsonb) IS
  'True unless a transform result explicitly reports that the readiness quality gates did not run for it. Absent or malformed flags read as gated so historical results keep their meaning.';

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
                WHEN job.status<>'succeeded' THEN NULL
                WHEN NOT control_plane.transform_result_was_gated(job.result_metadata)
                  THEN NULL
                ELSE coalesce(
                  job.result_metadata->>'partialQualityStatus',
                  job.result_metadata->>'qualityStatus','blocked'
                )
           END AS partial_quality_status,
           CASE WHEN job.batch_id=p_current_batch_id THEN p_current_complete_quality
                WHEN job.status<>'succeeded' THEN NULL
                WHEN NOT control_plane.transform_result_was_gated(job.result_metadata)
                  THEN NULL
                ELSE coalesce(
                  job.result_metadata->>'completeQualityStatus',
                  job.result_metadata->>'qualityStatus','blocked'
                )
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
        OR partial_quality_status IS NULL
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

CREATE OR REPLACE FUNCTION control_plane.complete_canonical_transform_job(
  p_tenant_id text,p_transform_job_id text,p_worker_id text,p_lease_token text,p_result jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE partial_quality text;
DECLARE complete_quality text;
BEGIN
  partial_quality:=coalesce(
    p_result->>'partialQualityStatus',p_result->>'qualityStatus','blocked'
  );
  complete_quality:=coalesce(
    p_result->>'completeQualityStatus',p_result->>'qualityStatus','blocked'
  );
  IF p_result IS NULL OR jsonb_typeof(p_result)<>'object'
     OR partial_quality NOT IN ('passed','warning','failed','blocked')
     OR complete_quality NOT IN ('passed','warning','failed','blocked')
     OR array_position(ARRAY['passed','warning','failed','blocked'],complete_quality)
        <array_position(ARRAY['passed','warning','failed','blocked'],partial_quality) THEN
    RAISE EXCEPTION 'canonical transform quality tiers are invalid' USING ERRCODE='22023';
  END IF;

  PERFORM control_plane.complete_canonical_transform_job_pre_quality_tiers(
    p_tenant_id,p_transform_job_id,p_worker_id,p_lease_token,p_result
  );

  -- Only a page the gates actually ran against may hold readiness back.
  IF control_plane.transform_result_was_gated(p_result)
     AND complete_quality IN ('blocked','failed') THEN
    UPDATE control_plane.readiness readiness
       SET state=CASE
             WHEN readiness.state IN ('blocked','degraded') THEN readiness.state
             WHEN partial_quality='blocked' THEN 'blocked'
             WHEN partial_quality='failed' THEN 'degraded'
             ELSE 'ready_partial'
           END,
           progress=CASE
             WHEN readiness.state IN ('blocked','degraded') THEN readiness.progress
             ELSE least(coalesce(readiness.progress,0.95),0.95)
           END,
           reason_code=CASE
             WHEN readiness.state IN ('blocked','degraded') THEN readiness.reason_code
             WHEN partial_quality IN ('blocked','failed')
               THEN 'quality_'||partial_quality
             ELSE 'complete_quality_pending'
           END,
           reason_detail=CASE
             WHEN readiness.state IN ('blocked','degraded') THEN readiness.reason_detail
             WHEN partial_quality IN ('blocked','failed')
               THEN 'A mandatory recent-coverage quality check has not passed.'
             ELSE 'Recent data remains queryable, but complete readiness is waiting for mandatory full-history or reconciliation evidence.'
           END,
           evaluated_at=now(),updated_at=now()
      FROM control_plane.canonical_transform_jobs job
     WHERE job.tenant_id=p_tenant_id
       AND job.transform_job_id=p_transform_job_id
       AND readiness.tenant_id=job.tenant_id
       AND readiness.connection_id=job.connection_id
       AND readiness.domain=ANY(job.domains);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION control_plane.transform_result_was_gated(jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION control_plane.sync_readiness_inputs(
  text,text,text[],text,text,text
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.sync_readiness_inputs(
  text,text,text[],text,text,text
) TO albert_transform_control;

REVOKE ALL ON FUNCTION control_plane.complete_canonical_transform_job(
  text,text,text,text,jsonb
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION control_plane.complete_canonical_transform_job(
  text,text,text,text,jsonb
) TO albert_transform_control;

COMMENT ON FUNCTION control_plane.sync_readiness_inputs(
  text,text,text[],text,text,text
) IS
  'Readiness inputs for a connection generation. Quality is read only from a succeeded transform whose gates actually ran; pending and ungated jobs report incomplete.';

COMMIT;
