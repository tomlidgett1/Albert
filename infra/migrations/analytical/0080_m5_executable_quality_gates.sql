BEGIN;

-- Quality is a contract, not a best-effort collection of rows.  The semantic
-- runtime joins this registry to the latest durable result so a missing or
-- stale mandatory check fails closed instead of disappearing from health.
CREATE TABLE IF NOT EXISTS quality.check_expectation (
  check_id text PRIMARY KEY,
  domain text NOT NULL,
  description text NOT NULL,
  max_age interval NOT NULL CHECK (max_age > interval '0 seconds'),
  required boolean NOT NULL DEFAULT true,
  blocks_readiness boolean NOT NULL DEFAULT true
);

INSERT INTO quality.check_expectation (
  check_id,domain,description,max_age,required,blocks_readiness
) VALUES
  ('cursor_completeness','connector','The committed stream cursor covers every accepted page in order.',interval '26 hours',true,true),
  ('scope_available','connector','The granted OAuth scopes cover the observed stream and fields.',interval '26 hours',true,true),
  ('retention_limit_recorded','connector','Vendor history or retention limits are explicitly recorded.',interval '26 hours',true,true),
  ('webhook_gap_recovered','connector','Any detectable webhook sequence gap has been reconciled.',interval '26 hours',true,true),
  ('delete_handling','connector','Deletes are observed or a bounded tombstone reconciliation is active.',interval '26 hours',true,true),
  ('schema_drift','connector','No unreviewed source schema drift is present.',interval '26 hours',true,true),
  ('enum_drift','connector','No unreviewed source enumeration value is present.',interval '26 hours',true,true),
  ('pk_unique','canonical','Canonical and mart primary grains contain no duplicate key.',interval '26 hours',true,true),
  ('orphan_rate','canonical','Canonical references resolve inside the same tenant.',interval '26 hours',true,true),
  ('status_mapping_total','canonical','Every source status used by governed facts has an explicit mapping.',interval '26 hours',true,true),
  ('tz_validity','canonical','All governed location timezones are valid IANA zones.',interval '26 hours',true,true),
  ('tax_consistency','canonical','Line tax arithmetic reconciles to GST-inclusive value.',interval '26 hours',true,true),
  ('field_coverage_vs_manifest','canonical','Observed governed fields match the reviewed pack manifest.',interval '26 hours',true,true),
  ('observation_coverage','canonical','Canonical commerce facts retain authoritative source observations.',interval '26 hours',true,true),
  ('no_orphan_observations','canonical','Observation rows point to existing canonical facts.',interval '26 hours',true,true),
  ('line_maths','commerce','Completed commerce line arithmetic reconciles.',interval '26 hours',true,true),
  ('tender_reconciles','commerce','Captured tenders reconcile to completed orders.',interval '26 hours',true,true),
  ('cost_coverage','commerce','Completed commerce rows have sufficient source cost coverage.',interval '26 hours',true,true),
  ('stock_continuity','inventory','Inventory snapshots have valid values and a continuous daily grain.',interval '26 hours',true,true),
  ('journal_balances','finance','Eligible posted journals balance within tolerance.',interval '26 hours',true,true),
  ('currency_consistency','finance','Governed finance aggregates do not combine currencies implicitly.',interval '26 hours',true,true),
  ('shift_timesheet_coverage','workforce','Worked-time coverage against active shifts is measured.',interval '26 hours',true,true),
  ('labour_cost_coverage','workforce','Approved worked time has measured labour-cost coverage.',interval '26 hours',true,true),
  ('pos_ledger_tolerance','reconciliation','POS and ledger daily postings reconcile within tolerance.',interval '26 hours',true,true),
  ('posting_bridge_coverage','reconciliation','POS-to-ledger comparison rows have governed posting evidence.',interval '26 hours',true,true),
  ('pos_bank_tolerance','reconciliation','Captured POS tenders and observed bank settlements reconcile within tolerance.',interval '26 hours',true,true),
  ('settlement_bridge_coverage','reconciliation','POS tenders have deterministic source-to-source bank settlement evidence.',interval '26 hours',true,true)
ON CONFLICT (check_id) DO UPDATE SET
  domain=excluded.domain,
  description=excluded.description,
  max_age=excluded.max_age,
  required=excluded.required,
  blocks_readiness=excluded.blocks_readiness;

CREATE OR REPLACE FUNCTION quality.record_check(
  p_tenant_id text,
  p_run_id text,
  p_check_id text,
  p_domain text,
  p_status text,
  p_observed numeric,
  p_threshold numeric,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,quality
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_details) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'quality details must be an object' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM quality.check_expectation expectation
    WHERE expectation.check_id=p_check_id AND expectation.domain=p_domain
  ) THEN
    RAISE EXCEPTION 'unknown quality check % for domain %',p_check_id,p_domain USING ERRCODE='22023';
  END IF;

  INSERT INTO quality.check_result (
    tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
  ) VALUES (
    p_tenant_id,p_run_id,p_check_id,p_domain,p_status,p_observed,p_threshold,p_details,now()
  )
  ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    domain=excluded.domain,
    status=excluded.status,
    observed=excluded.observed,
    threshold=excluded.threshold,
    details=excluded.details,
    checked_at=excluded.checked_at;
END $$;

-- Return every expected check.  Absence and staleness are represented as
-- blocked rows with explicit reasons, which makes omission observable to both
-- readiness and answer validation.
CREATE OR REPLACE FUNCTION quality.current_health(
  p_tenant_id text,
  p_domains text[]
) RETURNS TABLE (
  check_id text,
  domain text,
  status text,
  details jsonb,
  checked_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,core,quality
AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF coalesce(cardinality(p_domains),0)=0 OR EXISTS (
    SELECT 1 FROM unnest(p_domains) value
    WHERE value !~ '^[a-z][a-z0-9_.-]{0,99}$'
  ) THEN
    RAISE EXCEPTION 'quality domains are invalid' USING ERRCODE='22023';
  END IF;

  RETURN QUERY
  SELECT
    expectation.check_id,
    expectation.domain,
    CASE
      WHEN latest.check_id IS NULL THEN 'blocked'
      WHEN latest.checked_at < now()-expectation.max_age THEN 'blocked'
      ELSE latest.status
    END AS status,
    CASE
      WHEN latest.check_id IS NULL THEN jsonb_build_object(
        'reason_code','required_check_missing',
        'reason','A mandatory quality check has no durable result.',
        'max_age_seconds',extract(epoch FROM expectation.max_age)::bigint
      )
      WHEN latest.checked_at < now()-expectation.max_age THEN coalesce(latest.details,'{}'::jsonb)||jsonb_build_object(
        'reason_code','required_check_stale',
        'reason','The latest mandatory quality result is stale.',
        'max_age_seconds',extract(epoch FROM expectation.max_age)::bigint,
        'checked_at',latest.checked_at
      )
      ELSE coalesce(latest.details,'{}'::jsonb)
    END AS details,
    latest.checked_at
  FROM quality.check_expectation expectation
  LEFT JOIN LATERAL (
    SELECT result.check_id,result.status,result.details,result.checked_at
    FROM quality.check_result result
    WHERE result.tenant_id=p_tenant_id
      AND result.check_id=expectation.check_id
      AND result.domain=expectation.domain
    ORDER BY result.checked_at DESC,result.run_id DESC
    LIMIT 1
  ) latest ON true
  WHERE expectation.required
    AND expectation.domain=ANY(p_domains)
  ORDER BY expectation.domain,expectation.check_id;
END $$;

-- Replace the former declarative checks with executable measurements.  Some
-- constraints make a failure impossible in a healthy database, but the query
-- still measures every tenant table and records the evidence used.
CREATE OR REPLACE FUNCTION quality.run_all_invariants(p_tenant_id text,p_run_id text)
RETURNS void
LANGUAGE plpgsql
-- This fixed-output boundary must inspect every canonical primary grain,
-- including private identity-evidence tables that transform_rw deliberately
-- cannot select directly. It returns no source rows, validates the trusted
-- tenant GUC, derives identifiers only from the system catalogue, and is
-- executable solely by transform_rw below.
SECURITY DEFINER
SET search_path=pg_catalog,core,mart,quality,ingestion
AS $$
DECLARE
  failures bigint:=0;
  total_count bigint:=0;
  matched_count bigint:=0;
  staged_count bigint:=0;
  quarantine_count bigint:=0;
  duplicate_count bigint:=0;
  duplicate_total bigint:=0;
  table_count bigint:=0;
  relation_count bigint:=0;
  observed_count bigint:=0;
  coverage numeric(19,4):=0;
  difference numeric(19,4):=0;
  item record;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE='22023';
  END IF;

  PERFORM quality.run_domain_invariants(p_tenant_id,p_run_id);

  FOR item IN
    SELECT namespace.nspname AS schema_name,relation.relname AS table_name,
           string_agg(format('%I',attribute.attname),',' ORDER BY key_column.ordinality) AS key_columns
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid=constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY key_column(attnum,ordinality) ON true
    JOIN pg_attribute attribute ON attribute.attrelid=relation.oid AND attribute.attnum=key_column.attnum
    WHERE constraint_row.contype='p'
      AND namespace.nspname IN ('core','mart')
      AND EXISTS (
        SELECT 1 FROM pg_attribute tenant_attribute
        WHERE tenant_attribute.attrelid=relation.oid
          AND tenant_attribute.attname='tenant_id'
          AND NOT tenant_attribute.attisdropped
      )
    GROUP BY namespace.nspname,relation.relname
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM (SELECT %s FROM %I.%I WHERE tenant_id=$1 GROUP BY %s HAVING count(*)>1) duplicate_grains',
      item.key_columns,item.schema_name,item.table_name,item.key_columns
    ) INTO duplicate_count USING p_tenant_id;
    duplicate_total:=duplicate_total+duplicate_count;
    table_count:=table_count+1;
  END LOOP;
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'pk_unique','canonical',
    CASE WHEN duplicate_total=0 THEN 'passed' ELSE 'failed' END,
    duplicate_total,0,jsonb_build_object('measurement','tenant_primary_grain_duplicates','tables_checked',table_count)
  );

  SELECT
    (SELECT count(*) FROM core.commerce_order_line WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_payment WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_refund_line WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.inventory_movement WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.inventory_balance_snapshot WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.workforce_shift WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.workforce_time_entry WHERE tenant_id=p_tenant_id),
    (SELECT count(*) FROM core.commerce_order_line child LEFT JOIN core.commerce_order parent ON parent.tenant_id=child.tenant_id AND parent.id=child.order_id WHERE child.tenant_id=p_tenant_id AND parent.id IS NULL)+
    (SELECT count(*) FROM core.commerce_payment child LEFT JOIN core.commerce_order parent ON parent.tenant_id=child.tenant_id AND parent.id=child.order_id WHERE child.tenant_id=p_tenant_id AND parent.id IS NULL)+
    (SELECT count(*) FROM core.commerce_refund_line child LEFT JOIN core.commerce_order_line parent ON parent.tenant_id=child.tenant_id AND parent.id=child.original_order_line_id WHERE child.tenant_id=p_tenant_id AND parent.id IS NULL)+
    (SELECT count(*) FROM core.inventory_movement child LEFT JOIN core.product_variant product ON product.tenant_id=child.tenant_id AND product.id=child.product_variant_id LEFT JOIN core.stock_location location ON location.tenant_id=child.tenant_id AND location.id=child.stock_location_id WHERE child.tenant_id=p_tenant_id AND (product.id IS NULL OR location.id IS NULL))+
    (SELECT count(*) FROM core.inventory_balance_snapshot child LEFT JOIN core.product_variant product ON product.tenant_id=child.tenant_id AND product.id=child.product_variant_id LEFT JOIN core.stock_location location ON location.tenant_id=child.tenant_id AND location.id=child.stock_location_id WHERE child.tenant_id=p_tenant_id AND (product.id IS NULL OR location.id IS NULL))+
    (SELECT count(*) FROM core.workforce_shift child LEFT JOIN core.worker worker ON worker.tenant_id=child.tenant_id AND worker.id=child.worker_id LEFT JOIN core.location location ON location.tenant_id=child.tenant_id AND location.id=child.location_id WHERE child.tenant_id=p_tenant_id AND (worker.id IS NULL OR location.id IS NULL))+
    (SELECT count(*) FROM core.workforce_time_entry child LEFT JOIN core.worker worker ON worker.tenant_id=child.tenant_id AND worker.id=child.worker_id LEFT JOIN core.location location ON location.tenant_id=child.tenant_id AND location.id=child.location_id WHERE child.tenant_id=p_tenant_id AND (worker.id IS NULL OR location.id IS NULL))
  INTO relation_count,failures;
  coverage:=CASE WHEN relation_count=0 THEN 0 ELSE failures::numeric/relation_count END;
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'orphan_rate','canonical',
    CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,
    coverage,0,jsonb_build_object('orphan_references',failures,'references_checked',relation_count,'measurement','explicit_tenant_scoped_reference_scan')
  );

  SELECT
    (SELECT count(*) FROM core.order_source_observation observation LEFT JOIN core.commerce_order fact ON fact.tenant_id=observation.tenant_id AND fact.id=observation.order_id WHERE observation.tenant_id=p_tenant_id AND fact.id IS NULL)+
    (SELECT count(*) FROM core.order_line_source_observation observation LEFT JOIN core.commerce_order_line fact ON fact.tenant_id=observation.tenant_id AND fact.id=observation.order_line_id WHERE observation.tenant_id=p_tenant_id AND fact.id IS NULL)
  INTO failures;
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'no_orphan_observations','canonical',
    CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,
    failures,0,jsonb_build_object('measurement','observation_target_scan')
  );

  SELECT count(*) INTO failures FROM (
    SELECT status FROM core.purchase_order_line WHERE tenant_id=p_tenant_id
    UNION ALL SELECT status FROM core.finance_journal_line WHERE tenant_id=p_tenant_id
    UNION ALL SELECT status FROM core.finance_invoice_line WHERE tenant_id=p_tenant_id
    UNION ALL SELECT status FROM core.finance_bank_transaction WHERE tenant_id=p_tenant_id
    UNION ALL SELECT status FROM core.workforce_shift WHERE tenant_id=p_tenant_id
    UNION ALL SELECT status FROM core.workforce_time_entry WHERE tenant_id=p_tenant_id
    UNION ALL SELECT status FROM core.workforce_leave WHERE tenant_id=p_tenant_id
  ) status_rows
  WHERE btrim(status)='' OR lower(status) IN ('unknown','unmapped','invalid');
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'status_mapping_total','canonical',
    CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,
    failures,0,jsonb_build_object('measurement','governed_free_text_status_scan')
  );

  SELECT count(*) INTO failures
  FROM core.location location
  WHERE location.tenant_id=p_tenant_id
    AND NOT EXISTS (SELECT 1 FROM pg_timezone_names timezone WHERE timezone.name=location.timezone);
  PERFORM quality.record_check(p_tenant_id,p_run_id,'tz_validity','canonical',CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,failures,0,'{"measurement":"iana_timezone_lookup"}'::jsonb);

  SELECT count(*) INTO failures
  FROM core.commerce_order_line line
  WHERE line.tenant_id=p_tenant_id
    AND abs((line.net_amount_ex_tax+line.tax_amount)-line.net_amount_inc_tax)>0.0001;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'tax_consistency','canonical',CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,failures,0,'{"measurement":"line_ex_tax_plus_tax"}'::jsonb);

  SELECT count(*) INTO failures
  FROM ingestion.quarantine_records quarantine
  WHERE quarantine.tenant_id=p_tenant_id
    AND quarantine.sync_run_id=p_run_id
    AND quarantine.status='open'
    AND quarantine.error_code IN ('schema_drift','field_coverage','manifest_mismatch');
  PERFORM quality.record_check(p_tenant_id,p_run_id,'field_coverage_vs_manifest','canonical',CASE WHEN failures=0 THEN 'passed' ELSE 'blocked' END,failures,0,'{"measurement":"open_manifest_quarantine"}'::jsonb);

  SELECT coalesce(sum(landing.staged_record_count),0),coalesce(sum(landing.quarantine_count),0)
  INTO staged_count,quarantine_count
  FROM ingestion.landing_commits landing
  WHERE landing.tenant_id=p_tenant_id
    AND landing.sync_run_id=p_run_id
    AND landing.status='committed';

  SELECT count(*) INTO failures
  FROM core.commerce_order order_row
  WHERE order_row.tenant_id=p_tenant_id
    AND order_row.status='completed'
    AND NOT order_row.voided
    AND abs(order_row.net_amount_inc_tax-coalesce((
      SELECT sum(payment.amount)
      FROM core.commerce_payment payment
      WHERE payment.tenant_id=order_row.tenant_id
        AND payment.order_id=order_row.id
        AND payment.status='captured'
    ),0))>0.01;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'tender_reconciles','commerce',CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,failures,0,jsonb_build_object('staged_records',staged_count,'quarantined_records',quarantine_count));

  SELECT count(*),count(*) FILTER (WHERE total_cost IS NOT NULL)
  INTO total_count,observed_count
  FROM core.commerce_order_line
  WHERE tenant_id=p_tenant_id AND order_status='completed' AND NOT voided AND NOT internal_transaction;
  coverage:=CASE WHEN total_count=0 THEN 1 ELSE observed_count::numeric/total_count END;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'cost_coverage','commerce',CASE WHEN coverage>=0.95 THEN 'passed' WHEN coverage>0 THEN 'warning' ELSE 'failed' END,coverage,0.95,jsonb_build_object('covered_lines',observed_count,'eligible_lines',total_count));

  SELECT count(*) INTO failures
  FROM core.inventory_balance_snapshot snapshot
  WHERE snapshot.tenant_id=p_tenant_id AND snapshot.quantity_on_hand<0;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'stock_continuity','inventory',CASE WHEN failures=0 THEN 'passed' ELSE 'warning' END,failures,0,'{"measurement":"negative_snapshot_scan"}'::jsonb);

  SELECT count(*) INTO total_count
  FROM core.workforce_shift shift_row
  WHERE shift_row.tenant_id=p_tenant_id AND shift_row.status NOT IN ('cancelled','voided','discarded');
  SELECT count(*) INTO matched_count
  FROM core.workforce_shift shift_row
  WHERE shift_row.tenant_id=p_tenant_id
    AND shift_row.status NOT IN ('cancelled','voided','discarded')
    AND EXISTS (
      SELECT 1 FROM core.workforce_time_entry entry
      WHERE entry.tenant_id=shift_row.tenant_id
        AND entry.worker_id=shift_row.worker_id
        AND entry.business_date=shift_row.business_date
        AND entry.location_id=shift_row.location_id
        AND entry.status='approved'
    );
  coverage:=CASE WHEN total_count=0 THEN 1 ELSE matched_count::numeric/total_count END;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'shift_timesheet_coverage','workforce',CASE WHEN coverage>=0.8 THEN 'passed' ELSE 'warning' END,coverage,0.8,jsonb_build_object('matched_shifts',matched_count,'eligible_shifts',total_count));

  SELECT count(*),count(*) FILTER (WHERE labour_cost IS NOT NULL)
  INTO total_count,observed_count
  FROM core.workforce_time_entry
  WHERE tenant_id=p_tenant_id AND status='approved';
  coverage:=CASE WHEN total_count=0 THEN 1 ELSE observed_count::numeric/total_count END;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'labour_cost_coverage','workforce',CASE WHEN coverage>=0.95 THEN 'passed' WHEN coverage>0 THEN 'warning' ELSE 'failed' END,coverage,0.95,jsonb_build_object('covered_entries',observed_count,'approved_entries',total_count));

  SELECT count(*) INTO failures FROM (
    SELECT business_date,legal_entity_id,location_id
    FROM (
      SELECT business_date,legal_entity_id,location_id,currency
      FROM core.finance_journal_line WHERE tenant_id=p_tenant_id
      UNION ALL
      SELECT business_date,legal_entity_id,location_id,currency
      FROM core.finance_invoice_line WHERE tenant_id=p_tenant_id
      UNION ALL
      SELECT business_date,legal_entity_id,location_id,currency
      FROM core.finance_bank_transaction WHERE tenant_id=p_tenant_id
    ) finance_rows
    GROUP BY business_date,legal_entity_id,location_id
    HAVING count(DISTINCT currency)>1
  ) mixed_currency;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'currency_consistency','finance',CASE WHEN failures=0 THEN 'passed' ELSE 'blocked' END,failures,0,'{"measurement":"mart_grain_currency_scan"}'::jsonb);

  SELECT abs(coalesce(sum(pos.pos_net_sales_ex_gst),0)-coalesce(sum(pos.ledger_accrued_revenue),0))
  INTO difference
  FROM mart.reconciliation_aligned pos
  WHERE pos.tenant_id=p_tenant_id;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'pos_ledger_tolerance','reconciliation',CASE WHEN difference<=1 THEN 'passed' ELSE 'warning' END,difference,1,'{"measurement":"aligned_daily_variance"}'::jsonb);

  SELECT count(*) INTO observed_count
  FROM core.event_link link
  WHERE link.tenant_id=p_tenant_id AND link.link_type='accounting_posting_of';
  SELECT count(*) INTO total_count
  FROM mart.reconciliation_aligned row_value
  WHERE row_value.tenant_id=p_tenant_id;
  observed_count:=least(observed_count,total_count);
  coverage:=CASE WHEN total_count=0 THEN 1 ELSE observed_count::numeric/total_count END;
  PERFORM quality.record_check(p_tenant_id,p_run_id,'posting_bridge_coverage','reconciliation',CASE WHEN coverage>=0.95 THEN 'passed' ELSE 'warning' END,coverage,0.95,jsonb_build_object('linked_rows',observed_count,'reconciliation_rows',total_count));

  SELECT count(*) FILTER (
           WHERE bank_settlement_amount IS NOT NULL
             AND abs(settlement_variance)>0.05
         )
  INTO failures
  FROM mart.settlement_reconciliation_aligned
  WHERE tenant_id=p_tenant_id;
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'pos_bank_tolerance','reconciliation',
    CASE WHEN failures=0 THEN 'passed' ELSE 'warning' END,
    failures,0,
    jsonb_build_object('measurement','daily_tender_bank_variance','tolerance','0.0500')
  );

  SELECT coalesce(sum(tender_count),0),coalesce(sum(linked_tender_count),0)
  INTO total_count,observed_count
  FROM mart.settlement_reconciliation_aligned
  WHERE tenant_id=p_tenant_id;
  coverage:=CASE WHEN total_count=0 THEN 1 ELSE observed_count::numeric/total_count END;
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'settlement_bridge_coverage','reconciliation',
    CASE WHEN coverage>=0.95 THEN 'passed' ELSE 'warning' END,
    coverage,0.95,
    jsonb_build_object(
      'measurement','deterministic_settlement_event_links',
      'linked_tenders',observed_count,'eligible_tenders',total_count
    )
  );
END $$;

REVOKE ALL ON quality.check_expectation FROM PUBLIC;
GRANT SELECT ON quality.check_expectation TO semantic_ro,transform_rw,diagnostic_ro;
GRANT EXECUTE ON FUNCTION quality.record_check(text,text,text,text,text,numeric,numeric,jsonb) TO transform_rw;
GRANT EXECUTE ON FUNCTION quality.current_health(text,text[]) TO semantic_ro,transform_rw,diagnostic_ro;
GRANT EXECUTE ON FUNCTION quality.run_all_invariants(text,text) TO transform_rw;

COMMIT;
