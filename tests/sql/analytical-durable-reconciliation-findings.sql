\set ON_ERROR_STOP on

BEGIN;

SELECT set_config('albert.tenant_id','01J0000000000000000000FAND',true);

-- The same day/location/check identity is deterministic across retries and
-- later runs. Its first-observed run remains immutable while current evidence
-- and the last-observed run advance.
SELECT quality.upsert_reconciliation_finding(
  '01J0000000000000000000FAND','01J0000000000000000000RAN1',
  'pos_ledger_tolerance','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',date '2026-08-03',
  '01J000000000000000000010C1',NULL,-12.50,
  '{"measurement":"daily_pos_ledger_variance","posNetSalesExGst":100,"ledgerAccruedRevenue":112.5}'::jsonb
);

SELECT quality.upsert_reconciliation_finding(
  '01J0000000000000000000FAND','01J0000000000000000000RAN2',
  'pos_ledger_tolerance','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',date '2026-08-03',
  '01J000000000000000000010C1',NULL,-10.25,
  '{"measurement":"daily_pos_ledger_variance","posNetSalesExGst":100,"ledgerAccruedRevenue":110.25}'::jsonb
);

DO $$
DECLARE finding_row record;
BEGIN
  SELECT * INTO STRICT finding_row
    FROM quality.finding
   WHERE tenant_id='01J0000000000000000000FAND'
     AND entity_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  IF (SELECT count(*) FROM quality.finding
       WHERE tenant_id='01J0000000000000000000FAND'
         AND entity_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')<>1
     OR finding_row.run_id<>'01J0000000000000000000RAN1'
     OR finding_row.last_observed_run_id<>'01J0000000000000000000RAN2'
     OR finding_row.status<>'open'
     OR finding_row.entity_type<>'reconciliation_day_location'
     OR finding_row.evidence->>'businessDate'<>'2026-08-03'
     OR (finding_row.evidence->>'variance')::numeric<>-10.25
     OR (finding_row.evidence->>'absoluteVariance')::numeric<>10.25
     OR (finding_row.evidence->>'tolerance')::numeric<>1.00 THEN
    RAISE EXCEPTION 'daily finding lifecycle/evidence is incomplete: %',row_to_json(finding_row);
  END IF;
END $$;

-- record_check invokes the real governed mart materialiser. There are no
-- current rows for this isolated tenant, so the formerly open variance is
-- resolved by the next run rather than silently disappearing.
SELECT quality.record_check(
  '01J0000000000000000000FAND','01J0000000000000000000RAN3',
  'pos_ledger_tolerance','reconciliation','passed',0,1,
  '{"measurement":"aligned_daily_variance"}'::jsonb
);

DO $$
DECLARE finding_row record;
BEGIN
  SELECT * INTO STRICT finding_row
    FROM quality.finding
   WHERE tenant_id='01J0000000000000000000FAND'
     AND entity_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  IF finding_row.status<>'resolved'
     OR finding_row.resolved_at IS NULL
     OR finding_row.resolution_run_id<>'01J0000000000000000000RAN3' THEN
    RAISE EXCEPTION 'a disappeared daily variance was not resolved: %',row_to_json(finding_row);
  END IF;
END $$;

-- A later recurrence reopens the same identity; it does not manufacture a
-- second finding or rewrite when it was first observed.
SELECT quality.upsert_reconciliation_finding(
  '01J0000000000000000000FAND','01J0000000000000000000RAN4',
  'pos_ledger_tolerance','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',date '2026-08-03',
  '01J000000000000000000010C1',NULL,9.00,
  '{"measurement":"daily_pos_ledger_variance"}'::jsonb
);

DO $$
BEGIN
  IF (SELECT count(*) FROM quality.finding
       WHERE tenant_id='01J0000000000000000000FAND'
         AND check_id='pos_ledger_tolerance'
         AND entity_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')<>1 THEN
    RAISE EXCEPTION 'a recurring variance duplicated its durable finding';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quality.finding
     WHERE tenant_id='01J0000000000000000000FAND'
       AND entity_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
       AND status='open' AND resolved_at IS NULL AND resolution_run_id IS NULL
       AND run_id='01J0000000000000000000RAN1'
       AND last_observed_run_id='01J0000000000000000000RAN4'
  ) THEN
    RAISE EXCEPTION 'a recurring variance did not reopen its original identity';
  END IF;
END $$;

-- The bank policy carries its own currency-level tolerance and narrative
-- evidence. Exact-threshold values are rejected by the internal writer.
SELECT quality.upsert_reconciliation_finding(
  '01J0000000000000000000FAND','01J0000000000000000000RAN4',
  'pos_bank_tolerance','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',date '2026-08-03',
  '01J000000000000000000010C1','AUD',-0.06,
  '{"measurement":"daily_tender_bank_variance","posTenderAmount":250,"bankSettlementAmount":250.06}'::jsonb
);

DO $$
BEGIN
  BEGIN
    PERFORM quality.upsert_reconciliation_finding(
      '01J0000000000000000000FAND','01J0000000000000000000RAN4',
      'pos_bank_tolerance','cccccccccccccccccccccccccccccccc',date '2026-08-03',
      '01J000000000000000000010C1','AUD',0.05,'{}'::jsonb
    );
    RAISE EXCEPTION 'an at-threshold value became a finding';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  IF (SELECT count(*) FROM quality.finding_status_lookup
       WHERE value IN ('open','resolved'))<>2
     OR (SELECT count(*) FROM quality.finding_severity_lookup
       WHERE value IN ('info','warning','error'))<>3 THEN
    RAISE EXCEPTION 'finding lifecycle vocabularies are not lookup-backed';
  END IF;
  IF has_table_privilege('transform_rw','quality.finding','INSERT')
     OR has_table_privilege('transform_rw','quality.finding','UPDATE')
     OR has_table_privilege('transform_rw','quality.finding','DELETE')
     OR has_function_privilege(
       'transform_rw',
       'quality.upsert_reconciliation_finding(text,text,text,text,date,text,text,numeric,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'transform_rw','quality.materialise_reconciliation_findings(text,text,text)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'transform runtime can bypass the governed finding materialiser';
  END IF;
END $$;

-- Replacing record_check for reconciliation must not undo migration 0085's
-- complete stock-continuity computation. On this empty tenant the governed
-- computation passes with zero observations even if a legacy negative-only
-- caller supplies a contradictory result.
SELECT quality.record_check(
  '01J0000000000000000000FAND','01J0000000000000000000STK1',
  'stock_continuity','inventory','failed',999,999,
  '{"measurement":"legacy_negative_only_stock_result"}'::jsonb
);

DO $$
DECLARE stock_result quality.check_result%ROWTYPE;
BEGIN
  SELECT * INTO STRICT stock_result
    FROM quality.check_result
   WHERE tenant_id='01J0000000000000000000FAND'
     AND run_id='01J0000000000000000000STK1'
     AND check_id='stock_continuity';
  IF stock_result.status<>'passed'
     OR stock_result.observed<>0
     OR stock_result.threshold<>0
     OR stock_result.details->>'measurement'<>'daily_snapshot_and_movement_balance_continuity' THEN
    RAISE EXCEPTION 'record_check restored the legacy negative-only stock result: %',
      row_to_json(stock_result);
  END IF;
END $$;

ROLLBACK;
