\set ON_ERROR_STOP on

-- Exercise executable measurements plus fail-closed missing/stale semantics in
-- PostgreSQL. Everything is rolled back so this harness remains repeatable.
BEGIN;

SET ROLE transform_rw;
SET LOCAL albert.tenant_id = '01H00000000000000000000801';

SELECT quality.run_all_invariants(
  '01H00000000000000000000801',
  '01H00000000000000000000802'
);

DO $$
DECLARE
  measured_count integer;
  declarative_count integer;
  blocked_count integer;
  stale_count integer;
BEGIN
  SELECT count(*) INTO measured_count
  FROM quality.check_result
  WHERE tenant_id='01H00000000000000000000801'
    AND run_id='01H00000000000000000000802'
    AND check_id IN (
      'pk_unique','orphan_rate','status_mapping_total','no_orphan_observations',
      'cost_coverage','labour_cost_coverage','currency_consistency','posting_bridge_coverage'
    )
    AND (
      details ? 'measurement' OR details ? 'eligible_lines'
      OR details ? 'approved_entries' OR details ? 'reconciliation_rows'
    );
  IF measured_count <> 8 THEN
    RAISE EXCEPTION 'expected eight measured quality checks, found %',measured_count;
  END IF;

  SELECT count(*) INTO declarative_count
  FROM quality.check_result
  WHERE tenant_id='01H00000000000000000000801'
    AND details ? 'enforced_by';
  IF declarative_count <> 0 THEN
    RAISE EXCEPTION 'quality harness found hard-coded declarative pass evidence';
  END IF;

  SELECT count(*) INTO blocked_count
  FROM quality.current_health(
    '01H00000000000000000000801',ARRAY['connector']::text[]
  )
  WHERE status='blocked'
    AND details->>'reason_code'='required_check_missing';
  IF blocked_count <> 7 THEN
    RAISE EXCEPTION 'missing connector checks did not fail closed: %',blocked_count;
  END IF;

  INSERT INTO quality.check_result (
    tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
  ) VALUES (
    '01H00000000000000000000801','01H00000000000000000000803',
    'cursor_completeness','connector','passed',1,1,
    '{"measurement":"cursor_page_chain"}'::jsonb,now()-interval '3 days'
  );

  SELECT count(*) INTO stale_count
  FROM quality.current_health(
    '01H00000000000000000000801',ARRAY['connector']::text[]
  )
  WHERE check_id='cursor_completeness'
    AND status='blocked'
    AND details->>'reason_code'='required_check_stale';
  IF stale_count <> 1 THEN
    RAISE EXCEPTION 'stale mandatory check did not fail closed';
  END IF;
END $$;

-- The run-level check_result key must never make connector publication
-- last-stream-wins. Retain both page/stream observations and roll up the worst
-- status with deterministic evidence ordering.
RESET ROLE;
SET ROLE ingest_rw;
SET LOCAL albert.tenant_id = '01H00000000000000000000801';

SELECT quality.publish_connector_quality_results(
  '01H00000000000000000000801','01H00000000000000000000804',
  '01H00000000000000000000805','01H00000000000000000000807',
  'lightspeed-r','sales',
  '[
    {"checkId":"cursor_completeness","status":"passed","observed":0,"threshold":0,"details":{"measurement":"page_contract"}},
    {"checkId":"scope_available","status":"passed","observed":0,"threshold":0,"details":{"measurement":"live_probe"}},
    {"checkId":"retention_limit_recorded","status":"warning","details":{"reason":"vendor_not_reported"}},
    {"checkId":"webhook_gap_recovered","status":"warning","details":{"reason":"sequence_unavailable"}},
    {"checkId":"delete_handling","status":"warning","observed":0,"threshold":1,"details":{"reason":"no_tombstone"}},
    {"checkId":"schema_drift","status":"blocked","observed":1,"threshold":0,"details":{"measurement":"manifest_rejection"}},
    {"checkId":"enum_drift","status":"warning","observed":0,"threshold":0,"details":{"reason":"enum_probe_unavailable"}}
  ]'::jsonb
);

SELECT quality.publish_connector_quality_results(
  '01H00000000000000000000801','01H00000000000000000000804',
  '01H00000000000000000000806','01H00000000000000000000807',
  'lightspeed-r','items',
  '[
    {"checkId":"cursor_completeness","status":"passed","observed":0,"threshold":0,"details":{"measurement":"page_contract"}},
    {"checkId":"scope_available","status":"passed","observed":0,"threshold":0,"details":{"measurement":"live_probe"}},
    {"checkId":"retention_limit_recorded","status":"passed","details":{"measurement":"source_setting"}},
    {"checkId":"webhook_gap_recovered","status":"passed","details":{"measurement":"reconciliation"}},
    {"checkId":"delete_handling","status":"passed","observed":1,"threshold":1,"details":{"measurement":"tombstone"}},
    {"checkId":"schema_drift","status":"passed","observed":0,"threshold":0,"details":{"measurement":"manifest"}},
    {"checkId":"enum_drift","status":"passed","observed":0,"threshold":0,"details":{"measurement":"typed_contract"}}
  ]'::jsonb
);

RESET ROLE;
SET ROLE transform_rw;
SET LOCAL albert.tenant_id = '01H00000000000000000000801';

DO $$
DECLARE
  rolled_status text;
  retained_rows integer;
  retained_evidence integer;
  rolled_checks integer;
BEGIN
  SELECT status,jsonb_array_length(details->'observations')
    INTO rolled_status,retained_evidence
    FROM quality.check_result
   WHERE tenant_id='01H00000000000000000000801'
     AND run_id='01H00000000000000000000804'
     AND check_id='schema_drift';
  SELECT count(*) INTO retained_rows
    FROM quality.connector_check_observation
   WHERE tenant_id='01H00000000000000000000801'
     AND run_id='01H00000000000000000000804'
     AND check_id='schema_drift';
  SELECT count(*) INTO rolled_checks
    FROM quality.check_result
   WHERE tenant_id='01H00000000000000000000801'
     AND run_id='01H00000000000000000000804'
     AND domain='connector';
  IF rolled_status<>'blocked' OR retained_rows<>2 OR retained_evidence<>2 OR rolled_checks<>7 THEN
    RAISE EXCEPTION 'connector roll-up lost evidence: status %, rows %, evidence %, checks %',
      rolled_status,retained_rows,retained_evidence,rolled_checks;
  END IF;
END $$;

RESET ROLE;
ROLLBACK;
