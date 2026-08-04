BEGIN;

-- Canonical tender amounts are signed: captured payments are positive and
-- refunds are negative. Reconcile completed order headers against every live
-- tender status as one tenant-scoped aggregate. Archived Lightspeed attempts
-- are projected as voided and are deliberately excluded here.
CREATE OR REPLACE FUNCTION quality.run_all_invariants(p_tenant_id text,p_run_id text)
RETURNS void
LANGUAGE plpgsql
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

  WITH tender_totals AS MATERIALIZED (
    SELECT payment.tenant_id,payment.order_id,sum(payment.amount) AS amount
      FROM core.commerce_payment payment
     WHERE payment.tenant_id=p_tenant_id
       AND payment.status IN ('captured','refunded')
     GROUP BY payment.tenant_id,payment.order_id
  )
  SELECT count(*) INTO failures
    FROM core.commerce_order order_row
    LEFT JOIN tender_totals tender
      ON tender.tenant_id=order_row.tenant_id
     AND tender.order_id=order_row.id
   WHERE order_row.tenant_id=p_tenant_id
     AND order_row.status='completed'
     AND NOT order_row.voided
     AND abs(order_row.net_amount_inc_tax-coalesce(tender.amount,0))>0.01;
  PERFORM quality.record_check(
    p_tenant_id,p_run_id,'tender_reconciles','commerce',
    CASE WHEN failures=0 THEN 'passed' ELSE 'failed' END,failures,0,
    jsonb_build_object(
      'measurement','signed_live_tenders_reconcile_completed_orders',
      'staged_records',staged_count,'quarantined_records',quarantine_count
    )
  );

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

REVOKE ALL ON FUNCTION quality.run_all_invariants(text,text)
  FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.run_all_invariants(text,text) TO transform_rw;

COMMIT;
