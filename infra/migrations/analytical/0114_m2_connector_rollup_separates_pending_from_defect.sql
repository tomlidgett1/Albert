-- quality.current_health (the getForDomain path in
-- services/semantic-query/src/postgres-adapters.ts) reads the durable
-- check_result rows this rollup writes, while getForTopic reads the
-- capability-scoped live function. The two disagreed, so the agent refused on
-- connector checks that the reviewed scoped path already reports as fine.
--
-- Two defects, both fixed here by adopting the scoped function's semantics
-- verbatim (0095, durable_stream_check):
--
-- 1. No pending tier. "reconciliation has not completed yet" and "totals are
--    not measured yet" were counted as gaps and reported blocked, identical to
--    a real reconciliation defect or a genuine source-total mismatch. A sweep
--    in flight therefore took every governed answer down. Split the durable
--    defect (reconciliation_gap_count>0, or a mismatch between two measured
--    totals) from the pending state, and report pending as warning.
--
-- 2. enum_drift summed unresolved enum drift with the open canonical
--    quarantine backlog and demanded zero. That backlog is already reported as
--    canonical_mapping_total in the always-included canonical domain; counting
--    it twice escalated a warning into an outage. Measure enum drift, and keep
--    the quarantine count in the details.
--
-- This is an alignment, not a relaxation: with 0 reconciliation_gap_count and
-- 0 unresolved_enum_drift_count on every required stream, and every measured
-- source total matching exactly, there is no defect for either check to hide.

BEGIN;

CREATE OR REPLACE FUNCTION quality.refresh_connector_quality_rollup(p_tenant_id text, p_run_id text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'quality'
AS $function$
DECLARE check_name text;check_status text;check_details jsonb;observed numeric;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() OR NOT core.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'connector quality rollup input is invalid' USING ERRCODE='22023';
  END IF;
  FOR check_name IN SELECT unnest(ARRAY[
    'cursor_completeness','scope_available','retention_limit_recorded',
    'webhook_gap_recovered','delete_handling','schema_drift','enum_drift'
  ]) LOOP
    WITH current_generation AS (
      SELECT connection_id,max(connection_generation) AS connection_generation
        FROM quality.connector_stream_state WHERE tenant_id=p_tenant_id GROUP BY connection_id
    ), required_state AS (
      SELECT state.* FROM quality.connector_stream_state state
      JOIN current_generation current USING (connection_id,connection_generation)
      WHERE state.tenant_id=p_tenant_id AND state.required
    ), measured AS (
      SELECT count(*) AS expected,
        count(*) FILTER (WHERE observed_page_count=0) AS missing,
        count(*) FILTER (WHERE NOT cursor_complete OR NOT cursor_chain_valid) AS cursor_gap,
        count(*) FILTER (WHERE NOT backfill_complete OR retention_evidence IS NULL) AS retention_gap,
        count(*) FILTER (WHERE reconciliation_gap_count>0) AS reconciliation_defect,
        count(*) FILTER (
          WHERE reconciliation_completed_at IS NULL
             OR reconciliation_completed_at<now()-interval '26 hours'
        ) AS reconciliation_pending,
        count(*) FILTER (
          WHERE source_total IS NOT NULL AND local_live_total IS NOT NULL
            AND source_total<>local_live_total
        ) AS source_total_mismatch,
        count(*) FILTER (
          WHERE source_total IS NULL OR local_live_total IS NULL
        ) AS source_total_unmeasured,
        sum(unresolved_schema_drift_count) AS schema_drift,
        sum(unresolved_enum_drift_count) AS enum_drift,
        sum(unresolved_quarantine_count) AS quarantine
      FROM required_state
    ) SELECT
      CASE check_name
        WHEN 'cursor_completeness' THEN CASE WHEN expected>0 AND missing=0 AND cursor_gap=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'scope_available' THEN CASE WHEN expected>0 AND missing=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'retention_limit_recorded' THEN CASE WHEN expected>0 AND retention_gap=0 THEN 'passed' ELSE 'blocked' END
        WHEN 'webhook_gap_recovered' THEN CASE
          WHEN expected=0 OR reconciliation_defect>0 THEN 'blocked'
          WHEN reconciliation_pending>0 THEN 'warning'
          ELSE 'passed' END
        WHEN 'delete_handling' THEN CASE
          WHEN expected=0 OR reconciliation_defect>0 OR source_total_mismatch>0 THEN 'blocked'
          WHEN reconciliation_pending>0 OR source_total_unmeasured>0 THEN 'warning'
          ELSE 'passed' END
        WHEN 'schema_drift' THEN CASE WHEN expected>0 AND schema_drift=0 THEN 'passed' ELSE 'blocked' END
        ELSE CASE WHEN expected>0 AND enum_drift=0 THEN 'passed' ELSE 'blocked' END
      END,
      jsonb_build_object(
        'reason_code','durable_required_stream_rollup','expected_required_streams',expected,
        'unobserved_required_streams',missing,'cursor_gaps',cursor_gap,
        'retention_gaps',retention_gap,
        'reconciliation_defects',reconciliation_defect,
        'reconciliation_pending',reconciliation_pending,
        'source_total_mismatches',source_total_mismatch,
        'source_total_unmeasured',source_total_unmeasured,
        'unresolved_schema_drift',schema_drift,
        'unresolved_enum_drift',enum_drift,
        'unresolved_quarantine',quarantine
      ),
      CASE check_name
        WHEN 'schema_drift' THEN schema_drift
        WHEN 'enum_drift' THEN enum_drift
        WHEN 'retention_limit_recorded' THEN retention_gap
        WHEN 'webhook_gap_recovered' THEN reconciliation_defect
        WHEN 'delete_handling' THEN reconciliation_defect+source_total_mismatch
        WHEN 'cursor_completeness' THEN cursor_gap
        ELSE missing
      END
      INTO check_status,check_details,observed FROM measured;
    PERFORM quality.record_check(
      p_tenant_id,p_run_id,check_name,'connector',check_status,observed,0,check_details
    );
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION quality.refresh_connector_quality_rollup(text,text)
  FROM PUBLIC,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.refresh_connector_quality_rollup(text,text)
  TO ingest_rw,transform_rw;

COMMIT;
