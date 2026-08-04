BEGIN;

-- Domain quality is evaluated through transform_rw with FORCE RLS.  The
-- previous implementation used correlated subqueries for every order, order
-- line, payment, and refund.  On a full-history tenant that multiplied a
-- tenant-wide gate into millions of repeated buffer lookups.  Materialise each
-- tenant-scoped relation once and reconcile it with set joins instead.
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

  WITH line_totals AS MATERIALIZED (
    SELECT line.tenant_id,line.order_id,
           sum(line.gross_amount) AS gross_amount,
           sum(line.discount_amount) AS discount_amount,
           sum(line.net_amount_inc_tax) AS net_amount_inc_tax,
           sum(line.tax_amount) AS tax_amount,
           sum(line.net_amount_ex_tax) AS net_amount_ex_tax
      FROM core.commerce_order_line line
     WHERE line.tenant_id=p_tenant_id
     GROUP BY line.tenant_id,line.order_id
  )
  SELECT count(*) INTO header_failures
    FROM core.commerce_order order_row
    LEFT JOIN line_totals lines
      ON lines.tenant_id=order_row.tenant_id
     AND lines.order_id=order_row.id
   WHERE order_row.tenant_id=p_tenant_id AND (
     abs(order_row.gross_amount-coalesce(lines.gross_amount,0))>0.01
     OR abs(order_row.discount_amount-coalesce(lines.discount_amount,0))>0.01
     OR abs(order_row.net_amount_inc_tax-coalesce(lines.net_amount_inc_tax,0))>0.01
     OR abs(order_row.tax_amount-coalesce(lines.tax_amount,0))>0.01
     OR abs(order_row.net_amount_ex_tax-coalesce(lines.net_amount_ex_tax,0))>0.01
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

  WITH authoritative_order_observations AS MATERIALIZED (
    SELECT DISTINCT observation.tenant_id,observation.order_id
      FROM core.order_source_observation observation
     WHERE observation.tenant_id=p_tenant_id
       AND observation.relationship='authoritative'
  ), order_states AS MATERIALIZED (
    SELECT state.tenant_id,state.canonical_id,state.connection_id,state.source_record_id
      FROM semantic_internal.canonical_record_state state
     WHERE state.tenant_id=p_tenant_id
       AND state.canonical_table='commerce_order'
  )
  SELECT count(*) INTO missing_order_observations
    FROM core.commerce_order fact
    LEFT JOIN authoritative_order_observations observation
      ON observation.tenant_id=fact.tenant_id
     AND observation.order_id=fact.id
    LEFT JOIN order_states state
      ON state.tenant_id=fact.tenant_id
     AND state.canonical_id=fact.id
     AND state.connection_id=fact.primary_connection_id
     AND state.source_record_id=fact.primary_source_record_id
   WHERE fact.tenant_id=p_tenant_id
     AND (observation.order_id IS NULL OR state.canonical_id IS NULL);

  WITH authoritative_line_observations AS MATERIALIZED (
    SELECT DISTINCT observation.tenant_id,observation.order_line_id
      FROM core.order_line_source_observation observation
     WHERE observation.tenant_id=p_tenant_id
       AND observation.relationship='authoritative'
  ), line_states AS MATERIALIZED (
    SELECT state.tenant_id,state.canonical_id,state.connection_id,state.source_record_id
      FROM semantic_internal.canonical_record_state state
     WHERE state.tenant_id=p_tenant_id
       AND state.canonical_table='commerce_order_line'
  )
  SELECT count(*) INTO missing_line_observations
    FROM core.commerce_order_line fact
    LEFT JOIN authoritative_line_observations observation
      ON observation.tenant_id=fact.tenant_id
     AND observation.order_line_id=fact.id
    LEFT JOIN line_states state
      ON state.tenant_id=fact.tenant_id
     AND state.canonical_id=fact.id
     AND state.connection_id=fact.primary_connection_id
     AND state.source_record_id=fact.primary_source_record_id
   WHERE fact.tenant_id=p_tenant_id
     AND (observation.order_line_id IS NULL OR state.canonical_id IS NULL);

  -- Preserve source_is_authoritative's exact semantics: precisely one active
  -- authority interval must exist and it must name the state connection.  The
  -- grouped joins evaluate that rule once for every fact as a set.
  WITH payment_authority AS MATERIALIZED (
    SELECT fact.tenant_id,fact.id,state.canonical_id,state.connection_id,
           count(authority.id)::bigint AS authority_count,
           min(authority.authoritative_connection_id) AS authoritative_connection_id
      FROM core.commerce_payment fact
      LEFT JOIN semantic_internal.canonical_record_state state
        ON state.tenant_id=fact.tenant_id
       AND state.canonical_table='commerce_payment'
       AND state.canonical_id=fact.id
       AND state.connection_id=fact.primary_connection_id
       AND state.source_record_id=fact.primary_source_record_id
      LEFT JOIN core.source_authority authority
        ON authority.tenant_id=fact.tenant_id
       AND authority.concept='operational_sales'
       AND authority.scope_type='location'
       AND authority.scope_id=fact.location_id
       AND authority.effective_from<=fact.paid_at
       AND (authority.effective_to IS NULL OR authority.effective_to>fact.paid_at)
     WHERE fact.tenant_id=p_tenant_id
     GROUP BY fact.tenant_id,fact.id,state.canonical_id,state.connection_id
  )
  SELECT count(*) INTO missing_payment_observations
    FROM payment_authority coverage_row
   WHERE coverage_row.canonical_id IS NULL
      OR coverage_row.authority_count<>1
      OR coverage_row.authoritative_connection_id
           IS DISTINCT FROM coverage_row.connection_id;

  WITH refund_authority AS MATERIALIZED (
    SELECT fact.tenant_id,fact.id,state.canonical_id,state.connection_id,
           count(authority.id)::bigint AS authority_count,
           min(authority.authoritative_connection_id) AS authoritative_connection_id
      FROM core.commerce_refund_line fact
      LEFT JOIN semantic_internal.canonical_record_state state
        ON state.tenant_id=fact.tenant_id
       AND state.canonical_table='commerce_refund_line'
       AND state.canonical_id=fact.id
       AND state.connection_id=fact.primary_connection_id
       AND state.source_record_id=fact.primary_source_record_id
      LEFT JOIN core.source_authority authority
        ON authority.tenant_id=fact.tenant_id
       AND authority.concept='operational_sales'
       AND authority.scope_type='location'
       AND authority.scope_id=fact.location_id
       AND authority.effective_from<=fact.refunded_at
       AND (authority.effective_to IS NULL OR authority.effective_to>fact.refunded_at)
     WHERE fact.tenant_id=p_tenant_id
     GROUP BY fact.tenant_id,fact.id,state.canonical_id,state.connection_id
  )
  SELECT count(*) INTO missing_refund_observations
    FROM refund_authority coverage_row
   WHERE coverage_row.canonical_id IS NULL
      OR coverage_row.authority_count<>1
      OR coverage_row.authoritative_connection_id
           IS DISTINCT FROM coverage_row.connection_id;

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

REVOKE ALL ON FUNCTION quality.run_domain_invariants(text,text)
  FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;
GRANT EXECUTE ON FUNCTION quality.run_domain_invariants(text,text)
  TO transform_rw;

COMMENT ON FUNCTION quality.run_domain_invariants(text,text) IS
  'Runs tenant commerce and finance invariants with one set-based pass per governed relation.';

COMMIT;
