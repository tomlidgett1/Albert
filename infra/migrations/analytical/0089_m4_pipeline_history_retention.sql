BEGIN;

CREATE INDEX IF NOT EXISTS quality_pipeline_stats_retention_idx
  ON quality.pipeline_stats(tenant_id,domain,snapshot_at DESC);
CREATE INDEX IF NOT EXISTS readiness_projection_published_retention_idx
  ON semantic_internal.readiness_projection_outbox(tenant_id,published_at)
  WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS identity_projection_published_retention_idx
  ON semantic_internal.identity_review_projection_outbox(tenant_id,published_at)
  WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS pipeline_projection_published_retention_idx
  ON semantic_internal.pipeline_table_stats_projection_outbox(tenant_id,published_at)
  WHERE published_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS promotion_projection_published_retention_idx
  ON semantic_internal.promotion_candidate_outbox(tenant_id,published_at)
  WHERE published_at IS NOT NULL;

-- This function is intentionally SECURITY DEFINER because the promotion relay
-- outbox is function-only.  A verified, unexpired transform capability still
-- supplies the tenant identity, and the dedicated runtime login is checked
-- before any row can be removed.
CREATE OR REPLACE FUNCTION semantic_internal.retain_pipeline_history(
  p_tenant_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  pipeline_stats_removed bigint:=0;
  legacy_outbox_removed bigint:=0;
  projection_rows_removed bigint:=0;
  removed bigint:=0;
BEGIN
  IF session_user<>'albert_transform_analytical_runtime'
     OR p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'analytical pipeline retention scope is invalid'
      USING ERRCODE='42501';
  END IF;

  WITH ranked AS MATERIALIZED (
    SELECT stat.tenant_id,stat.snapshot_at,stat.domain,
           row_number() OVER (
             PARTITION BY stat.domain,
               CASE
                 WHEN stat.snapshot_at>=statement_timestamp()-interval '48 hours'
                   THEN date_trunc('hour',stat.snapshot_at)
                 WHEN stat.snapshot_at>=statement_timestamp()-interval '35 days'
                   THEN date_trunc('day',stat.snapshot_at)
                 ELSE date_trunc('month',stat.snapshot_at)
               END
             ORDER BY stat.snapshot_at DESC
           ) AS bucket_rank
      FROM quality.pipeline_stats stat
     WHERE stat.tenant_id=p_tenant_id
  ), deleted AS (
    DELETE FROM quality.pipeline_stats stat
     USING ranked candidate
     WHERE stat.tenant_id=candidate.tenant_id
       AND stat.snapshot_at=candidate.snapshot_at
       AND stat.domain=candidate.domain
       AND (
         candidate.snapshot_at<statement_timestamp()-interval '400 days'
         OR candidate.bucket_rank>1
       )
    RETURNING 1
  )
  SELECT count(*) INTO pipeline_stats_removed FROM deleted;

  -- Superseded by pipeline_table_stats_projection_outbox in migration 0050;
  -- no runtime has ever consumed this legacy aggregate projection.
  DELETE FROM semantic_internal.pipeline_stats_projection_outbox
   WHERE tenant_id=p_tenant_id;
  GET DIAGNOSTICS legacy_outbox_removed=ROW_COUNT;

  DELETE FROM semantic_internal.readiness_projection_outbox
   WHERE tenant_id=p_tenant_id
     AND published_at<statement_timestamp()-interval '24 hours';
  GET DIAGNOSTICS removed=ROW_COUNT;
  projection_rows_removed:=projection_rows_removed+removed;

  DELETE FROM semantic_internal.identity_review_projection_outbox
   WHERE tenant_id=p_tenant_id
     AND published_at<statement_timestamp()-interval '30 days';
  GET DIAGNOSTICS removed=ROW_COUNT;
  projection_rows_removed:=projection_rows_removed+removed;

  DELETE FROM semantic_internal.pipeline_table_stats_projection_outbox
   WHERE tenant_id=p_tenant_id
     AND published_at<statement_timestamp()-interval '24 hours';
  GET DIAGNOSTICS removed=ROW_COUNT;
  projection_rows_removed:=projection_rows_removed+removed;

  DELETE FROM semantic_internal.promotion_candidate_outbox
   WHERE tenant_id=p_tenant_id
     AND published_at<statement_timestamp()-interval '30 days';
  GET DIAGNOSTICS removed=ROW_COUNT;
  projection_rows_removed:=projection_rows_removed+removed;

  RETURN jsonb_build_object(
    'pipeline_stats_removed',pipeline_stats_removed,
    'legacy_outbox_removed',legacy_outbox_removed,
    'projection_rows_removed',projection_rows_removed,
    'hourly_retention_hours',48,
    'daily_retention_days',35,
    'maximum_retention_days',400
  );
END;
$$;

REVOKE ALL ON FUNCTION semantic_internal.retain_pipeline_history(text)
  FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION semantic_internal.retain_pipeline_history(text)
  TO transform_rw;

COMMIT;
