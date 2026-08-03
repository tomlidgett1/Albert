BEGIN;

CREATE INDEX IF NOT EXISTS quarantine_records_open_identity_idx
  ON ingestion.quarantine_records(
    tenant_id,connection_id,stream,source_object_type,source_record_id
  ) WHERE status='open' AND source_record_id IS NOT NULL;

-- The founding invariant is exact, not a 99% sampling target. Orders and lines
-- have explicit many-to-many bridges; payment/refund facts retain their exact
-- authoritative source observation in canonical_record_state plus the
-- concept-scoped source_authority that was checked before the fact was written.
CREATE OR REPLACE FUNCTION quality.run_domain_invariants(
  p_tenant_id text,p_run_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,quality,semantic_internal
AS $$
DECLARE
  line_component_failures bigint:=0;
  header_failures bigint:=0;
  refund_component_failures bigint:=0;
  refund_link_failures bigint:=0;
  line_failures bigint:=0;
  journal_failures bigint:=0;
  total_commerce_facts bigint:=0;
  missing_order_observations bigint:=0;
  missing_line_observations bigint:=0;
  missing_payment_observations bigint:=0;
  missing_refund_observations bigint:=0;
  missing_observations bigint:=0;
  coverage numeric(19,4):=1;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_run_id) THEN
    RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE='22023';
  END IF;

  SELECT count(*) INTO line_component_failures
    FROM core.commerce_order_line line
   WHERE line.tenant_id=p_tenant_id AND (
     abs((line.gross_amount-line.discount_amount)-line.net_amount_inc_tax)>0.0001
     OR abs((line.net_amount_ex_tax+line.tax_amount)-line.net_amount_inc_tax)>0.0001
   );
  SELECT count(*) INTO header_failures
    FROM core.commerce_order order_row
    LEFT JOIN LATERAL (
      SELECT coalesce(sum(line.gross_amount),0) gross_amount,
             coalesce(sum(line.discount_amount),0) discount_amount,
             coalesce(sum(line.net_amount_inc_tax),0) net_amount_inc_tax,
             coalesce(sum(line.tax_amount),0) tax_amount,
             coalesce(sum(line.net_amount_ex_tax),0) net_amount_ex_tax,
             count(*) line_count
        FROM core.commerce_order_line line
       WHERE line.tenant_id=order_row.tenant_id AND line.order_id=order_row.id
    ) lines ON true
   WHERE order_row.tenant_id=p_tenant_id AND (
     abs(order_row.gross_amount-lines.gross_amount)>0.01
     OR abs(order_row.discount_amount-lines.discount_amount)>0.01
     OR abs(order_row.net_amount_inc_tax-lines.net_amount_inc_tax)>0.01
     OR abs(order_row.tax_amount-lines.tax_amount)>0.01
     OR abs(order_row.net_amount_ex_tax-lines.net_amount_ex_tax)>0.01
   );
  SELECT count(*) INTO refund_component_failures
    FROM core.commerce_refund_line refund
   WHERE refund.tenant_id=p_tenant_id
     AND abs((refund.refund_amount_ex_tax+refund.tax_amount)-refund.refund_amount_inc_tax)>0.0001;
  SELECT count(*) INTO refund_link_failures
    FROM core.commerce_refund_line refund
    JOIN core.commerce_order_line original
      ON original.tenant_id=refund.tenant_id AND original.id=refund.original_order_line_id
   WHERE refund.tenant_id=p_tenant_id
     AND NOT EXISTS (
       SELECT 1 FROM core.event_link link
        WHERE link.tenant_id=refund.tenant_id
          AND link.link_type='reversal_of'
          AND link.from_connection_id=refund.primary_connection_id
          AND link.from_source_record_id=refund.primary_source_record_id
          AND link.to_connection_id=original.primary_connection_id
          AND link.to_source_record_id=original.primary_source_record_id
     );
  line_failures:=line_component_failures+header_failures+
    refund_component_failures+refund_link_failures;
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'line_maths','commerce',
    CASE WHEN line_failures=0 THEN 'passed' ELSE 'failed' END,
    line_failures,0,
    jsonb_build_object(
      'measurement','line_header_refund_reconciliation',
      'line_component_failures',line_component_failures,
      'header_failures',header_failures,
      'refund_component_failures',refund_component_failures,
      'refund_reversal_link_failures',refund_link_failures,
      'header_tolerance','0.0100','component_tolerance','0.0001'
    ),now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO journal_failures FROM (
    SELECT journal_id FROM core.finance_journal_line WHERE tenant_id=p_tenant_id
    GROUP BY journal_id HAVING abs(sum(debit_amount)-sum(credit_amount))>0.01
  ) unbalanced;
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'journal_balances','finance',
    CASE WHEN journal_failures=0 THEN 'passed' ELSE 'failed' END,
    journal_failures,0,'{"measurement":"journal_debits_equal_credits","tolerance":"0.0100"}'::jsonb,now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO missing_order_observations
    FROM core.commerce_order fact
   WHERE fact.tenant_id=p_tenant_id
     AND (
       NOT EXISTS (
         SELECT 1 FROM core.order_source_observation observation
          WHERE observation.tenant_id=fact.tenant_id
            AND observation.order_id=fact.id
            AND observation.relationship='authoritative'
       ) OR NOT EXISTS (
         SELECT 1 FROM semantic_internal.canonical_record_state state
          WHERE state.tenant_id=fact.tenant_id
            AND state.canonical_table='commerce_order'
            AND state.canonical_id=fact.id
            AND state.connection_id=fact.primary_connection_id
            AND state.source_record_id=fact.primary_source_record_id
       )
     );
  SELECT count(*) INTO missing_line_observations
    FROM core.commerce_order_line fact
   WHERE fact.tenant_id=p_tenant_id
     AND (
       NOT EXISTS (
         SELECT 1 FROM core.order_line_source_observation observation
          WHERE observation.tenant_id=fact.tenant_id
            AND observation.order_line_id=fact.id
            AND observation.relationship='authoritative'
       ) OR NOT EXISTS (
         SELECT 1 FROM semantic_internal.canonical_record_state state
          WHERE state.tenant_id=fact.tenant_id
            AND state.canonical_table='commerce_order_line'
            AND state.canonical_id=fact.id
            AND state.connection_id=fact.primary_connection_id
            AND state.source_record_id=fact.primary_source_record_id
       )
     );
  SELECT count(*) INTO missing_payment_observations
    FROM core.commerce_payment fact
   WHERE fact.tenant_id=p_tenant_id
     AND NOT EXISTS (
       SELECT 1
         FROM semantic_internal.canonical_record_state state
         JOIN core.source_authority authority
           ON authority.tenant_id=state.tenant_id
          AND authority.concept='operational_sales'
          AND authority.scope_type='tenant'
          AND authority.scope_id=state.tenant_id
          AND authority.authoritative_connection_id=state.connection_id
          AND authority.effective_from<=state.source_updated_at
          AND (authority.effective_to IS NULL OR authority.effective_to>state.source_updated_at)
        WHERE state.tenant_id=fact.tenant_id
          AND state.canonical_table='commerce_payment'
          AND state.canonical_id=fact.id
          AND state.connection_id=fact.primary_connection_id
          AND state.source_record_id=fact.primary_source_record_id
     );
  SELECT count(*) INTO missing_refund_observations
    FROM core.commerce_refund_line fact
   WHERE fact.tenant_id=p_tenant_id
     AND NOT EXISTS (
       SELECT 1
         FROM semantic_internal.canonical_record_state state
         JOIN core.source_authority authority
           ON authority.tenant_id=state.tenant_id
          AND authority.concept='operational_sales'
          AND authority.scope_type='tenant'
          AND authority.scope_id=state.tenant_id
          AND authority.authoritative_connection_id=state.connection_id
          AND authority.effective_from<=state.source_updated_at
          AND (authority.effective_to IS NULL OR authority.effective_to>state.source_updated_at)
        WHERE state.tenant_id=fact.tenant_id
          AND state.canonical_table='commerce_refund_line'
          AND state.canonical_id=fact.id
          AND state.connection_id=fact.primary_connection_id
          AND state.source_record_id=fact.primary_source_record_id
     );
  SELECT
    (SELECT count(*) FROM core.commerce_order WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_order_line WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_payment WHERE tenant_id=p_tenant_id)+
    (SELECT count(*) FROM core.commerce_refund_line WHERE tenant_id=p_tenant_id)
    INTO total_commerce_facts;
  missing_observations:=missing_order_observations+missing_line_observations+
    missing_payment_observations+missing_refund_observations;
  coverage:=CASE WHEN total_commerce_facts=0 THEN 1
    ELSE (total_commerce_facts-missing_observations)::numeric/total_commerce_facts END;
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'observation_coverage','canonical',
    CASE WHEN missing_observations=0 THEN 'passed' ELSE 'failed' END,
    coverage,1,
    jsonb_build_object(
      'measurement','authoritative_commerce_fact_observation_coverage',
      'total_commerce_facts',total_commerce_facts,
      'missing_observations',missing_observations,
      'orders_missing',missing_order_observations,
      'order_lines_missing',missing_line_observations,
      'payments_missing',missing_payment_observations,
      'refund_lines_missing',missing_refund_observations
    ),now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;
END;
$$;

CREATE OR REPLACE FUNCTION quality.compute_stock_continuity(p_tenant_id text)
RETURNS TABLE(status text,observed numeric,details jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path=pg_catalog,core,quality
AS $$
DECLARE
  negative_snapshots bigint:=0;
  missing_snapshot_days bigint:=0;
  reconciled_pairs bigint:=0;
  movement_mismatches bigint:=0;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO negative_snapshots
    FROM core.inventory_balance_snapshot snapshot
   WHERE snapshot.tenant_id=p_tenant_id AND snapshot.quantity_on_hand<0;
  WITH ordered AS (
    SELECT snapshot.snapshot_date,
           lag(snapshot.snapshot_date) OVER (
             PARTITION BY snapshot.product_variant_id,snapshot.stock_location_id
             ORDER BY snapshot.snapshot_date
           ) previous_date
      FROM core.inventory_balance_snapshot snapshot
     WHERE snapshot.tenant_id=p_tenant_id
  )
  SELECT coalesce(sum(greatest(snapshot_date-previous_date-1,0)),0)
    INTO missing_snapshot_days
    FROM ordered WHERE previous_date IS NOT NULL;
  WITH latest_complete_stream AS (
    SELECT DISTINCT ON (state.connection_id)
           state.connection_id,state.connection_generation
      FROM quality.connector_stream_state state
     WHERE state.tenant_id=p_tenant_id AND state.stream='inventory_logs'
       AND state.cursor_chain_valid AND state.cursor_complete
       AND state.backfill_complete
       AND state.unresolved_quarantine_count=0
     ORDER BY state.connection_id,state.connection_generation DESC
  ), ordered AS (
    SELECT snapshot.*,
           lag(snapshot.quantity_on_hand) OVER grain_order previous_quantity,
           lag(snapshot.snapshot_at) OVER grain_order previous_at,
           lag(snapshot.snapshot_date) OVER grain_order previous_date
      FROM core.inventory_balance_snapshot snapshot
     WHERE snapshot.tenant_id=p_tenant_id
     WINDOW grain_order AS (
       PARTITION BY snapshot.product_variant_id,snapshot.stock_location_id,
                    snapshot.primary_connection_id
       ORDER BY snapshot.snapshot_at,snapshot.id
     )
  ), comparisons AS (
    SELECT snapshot.*,
           coalesce((
             SELECT sum(movement.quantity_delta)
               FROM core.inventory_movement movement
              WHERE movement.tenant_id=snapshot.tenant_id
                AND movement.product_variant_id=snapshot.product_variant_id
                AND movement.stock_location_id=snapshot.stock_location_id
                AND movement.primary_connection_id=snapshot.primary_connection_id
                AND movement.occurred_at>snapshot.previous_at
                AND movement.occurred_at<=snapshot.snapshot_at
           ),0) movement_delta
      FROM ordered snapshot
      JOIN latest_complete_stream stream
        ON stream.connection_id=snapshot.primary_connection_id
     WHERE snapshot.previous_at IS NOT NULL
       AND snapshot.snapshot_date>snapshot.previous_date
  )
  SELECT count(*),count(*) FILTER (
           WHERE abs(quantity_on_hand-(previous_quantity+movement_delta))>0.0001
         )
    INTO reconciled_pairs,movement_mismatches
    FROM comparisons;
  status:=CASE
    WHEN missing_snapshot_days>0 OR movement_mismatches>0 THEN 'failed'
    WHEN negative_snapshots>0 THEN 'warning'
    ELSE 'passed'
  END;
  observed:=missing_snapshot_days+movement_mismatches+negative_snapshots;
  details:=jsonb_build_object(
    'measurement','daily_snapshot_and_movement_balance_continuity',
    'negative_snapshots',negative_snapshots,
    'missing_snapshot_days',missing_snapshot_days,
    'movement_pairs_reconciled',reconciled_pairs,
    'movement_balance_mismatches',movement_mismatches,
    'tolerance','0.0001'
  );
  RETURN NEXT;
END;
$$;

-- Keep the broad invariant runner backward-compatible while replacing its
-- legacy negative-only stock result at the single durable check-write seam.
CREATE OR REPLACE FUNCTION quality.record_check(
  p_tenant_id text,p_run_id text,p_check_id text,p_domain text,p_status text,
  p_observed numeric,p_threshold numeric,p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog,core,quality
AS $$
DECLARE stock record;
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
    RAISE EXCEPTION 'unknown quality check % for domain %',p_check_id,p_domain
      USING ERRCODE='22023';
  END IF;
  IF p_check_id='stock_continuity' AND p_domain='inventory' THEN
    SELECT * INTO STRICT stock FROM quality.compute_stock_continuity(p_tenant_id);
    p_status:=stock.status;
    p_observed:=stock.observed;
    p_threshold:=0;
    p_details:=stock.details;
  END IF;
  INSERT INTO quality.check_result(
    tenant_id,run_id,check_id,domain,status,observed,threshold,details,checked_at
  ) VALUES(
    p_tenant_id,p_run_id,p_check_id,p_domain,p_status,p_observed,p_threshold,p_details,now()
  ) ON CONFLICT(tenant_id,run_id,check_id) DO UPDATE SET
    domain=excluded.domain,status=excluded.status,observed=excluded.observed,
    threshold=excluded.threshold,details=excluded.details,checked_at=excluded.checked_at;
END;
$$;

REVOKE ALL ON FUNCTION quality.run_domain_invariants(text,text),
  quality.compute_stock_continuity(text),
  quality.record_check(text,text,text,text,text,numeric,numeric,jsonb)
  FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.run_domain_invariants(text,text),
  quality.compute_stock_continuity(text),
  quality.record_check(text,text,text,text,text,numeric,numeric,jsonb)
  TO transform_rw;

COMMIT;
