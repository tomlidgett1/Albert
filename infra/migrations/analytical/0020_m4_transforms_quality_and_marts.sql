BEGIN;

-- Source-neutral semantic aggregate sets. Connector-specific mapping remains in
-- connector packs; these views consume only canonical facts and aggregate every
-- fact independently before any alignment.

CREATE OR REPLACE VIEW mart.commerce_sales_event
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  line.tenant_id,
  line.id,
  'sale'::text AS event_kind,
  line.order_id AS sale_order_id,
  line.location_id,
  line.register_id,
  line.channel_id,
  line.product_variant_id,
  category.product_category_id,
  line.customer_account_id,
  line.worker_id,
  line.business_date,
  line.quantity AS signed_quantity,
  line.gross_amount,
  line.discount_amount,
  line.net_amount_inc_tax AS sale_amount_inc_tax,
  line.net_amount_inc_tax AS signed_net_amount_inc_tax,
  line.net_amount_ex_tax AS signed_net_amount_ex_tax,
  line.total_cost AS signed_total_cost,
  0::numeric(19,4) AS refund_amount_inc_tax,
  line.voided,
  line.internal_transaction,
  line.currency
FROM core.commerce_order_line AS line
LEFT JOIN LATERAL (
  SELECT assignment.product_category_id
  FROM core.product_category_assignment AS assignment
  WHERE assignment.tenant_id = line.tenant_id
    AND assignment.product_variant_id = line.product_variant_id
    AND assignment.effective_from <= now()
    AND (assignment.effective_to IS NULL OR assignment.effective_to > now())
  ORDER BY assignment.effective_from DESC, assignment.id DESC
  LIMIT 1
) AS category ON true
UNION ALL
SELECT
  refund.tenant_id,
  refund.id,
  'refund'::text,
  original.order_id,
  refund.location_id,
  original.register_id,
  original.channel_id,
  refund.product_variant_id,
  category.product_category_id,
  original.customer_account_id,
  refund.worker_id,
  refund.business_date,
  -refund.quantity,
  0::numeric(19,4),
  0::numeric(19,4),
  0::numeric(19,4),
  -refund.refund_amount_inc_tax,
  -refund.refund_amount_ex_tax,
  -COALESCE(refund.total_cost_reversed,0),
  refund.refund_amount_inc_tax,
  false,
  original.internal_transaction,
  refund.currency
FROM core.commerce_refund_line AS refund
JOIN core.commerce_order_line AS original
  ON original.tenant_id = refund.tenant_id AND original.id = refund.original_order_line_id
LEFT JOIN LATERAL (
  SELECT assignment.product_category_id
  FROM core.product_category_assignment AS assignment
  WHERE assignment.tenant_id = refund.tenant_id
    AND assignment.product_variant_id = refund.product_variant_id
    AND assignment.effective_from <= now()
    AND (assignment.effective_to IS NULL OR assignment.effective_to > now())
  ORDER BY assignment.effective_from DESC, assignment.id DESC
  LIMIT 1
) AS category ON true;

CREATE OR REPLACE VIEW mart.customer_order_activity
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
  order_row.tenant_id,
  order_row.id,
  order_row.customer_account_id,
  order_row.location_id,
  order_row.channel_id,
  order_row.business_date,
  row_number() OVER (
    PARTITION BY order_row.tenant_id,order_row.customer_account_id
    ORDER BY COALESCE(order_row.completed_at,order_row.ordered_at),order_row.id
  ) AS customer_order_number,
  count(*) OVER (PARTITION BY order_row.tenant_id,order_row.customer_account_id) AS period_order_count,
  max(COALESCE(order_row.completed_at,order_row.ordered_at)) OVER (
    PARTITION BY order_row.tenant_id,order_row.customer_account_id
  ) AS last_order_at,
  order_row.net_amount_ex_tax
FROM core.commerce_order AS order_row
WHERE order_row.customer_account_id IS NOT NULL
  AND order_row.status = 'completed'
  AND NOT order_row.voided
  AND NOT order_row.internal_transaction;

CREATE OR REPLACE VIEW mart.inventory_health_day
WITH (security_barrier = true, security_invoker = true)
AS
WITH movement AS (
  SELECT
    tenant_id,business_date,product_variant_id,stock_location_id,
    sum(quantity_delta) FILTER (WHERE movement_type = 'receipt') AS received_units,
    sum(quantity_delta) FILTER (WHERE movement_type = 'stocktake') AS stocktake_variance_units
  FROM core.inventory_movement
  GROUP BY tenant_id,business_date,product_variant_id,stock_location_id
),
sales AS (
  SELECT
    event.tenant_id,event.business_date,event.product_variant_id,event.location_id,
    sum(event.signed_quantity) AS units_sold,
    sum(event.signed_total_cost) AS cost_of_goods_sold
  FROM mart.commerce_sales_event AS event
  WHERE NOT event.voided AND NOT event.internal_transaction
  GROUP BY event.tenant_id,event.business_date,event.product_variant_id,event.location_id
),
velocity AS (
  SELECT
    event.tenant_id,event.business_date,event.product_variant_id,event.location_id,
    sum(event.signed_quantity) OVER (
      PARTITION BY event.tenant_id,event.product_variant_id,event.location_id
      ORDER BY event.business_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) / 30::numeric AS trailing_daily_units_sold
  FROM (
    SELECT tenant_id,business_date,product_variant_id,location_id,sum(signed_quantity) AS signed_quantity
    FROM mart.commerce_sales_event
    WHERE NOT voided AND NOT internal_transaction
    GROUP BY tenant_id,business_date,product_variant_id,location_id
  ) AS event
)
SELECT
  snapshot.tenant_id,
  snapshot.id,
  snapshot.snapshot_date,
  snapshot.snapshot_date AS business_date,
  snapshot.stock_location_id,
  snapshot.product_variant_id,
  category.product_category_id,
  snapshot.quantity_on_hand,
  snapshot.stock_value,
  COALESCE(velocity.trailing_daily_units_sold,0)::numeric(19,4) AS trailing_daily_units_sold,
  COALESCE(sales.units_sold,0)::numeric(19,4) AS units_sold,
  (snapshot.quantity_on_hand + COALESCE(sales.units_sold,0) - COALESCE(movement.received_units,0))::numeric(19,4) AS opening_units,
  COALESCE(movement.received_units,0)::numeric(19,4) AS received_units,
  COALESCE(sales.cost_of_goods_sold,0)::numeric(19,4) AS cost_of_goods_sold,
  COALESCE(movement.stocktake_variance_units,0)::numeric(19,4) AS stocktake_variance_units,
  snapshot.currency
FROM core.inventory_balance_snapshot AS snapshot
LEFT JOIN movement
  ON movement.tenant_id = snapshot.tenant_id
 AND movement.business_date = snapshot.snapshot_date
 AND movement.product_variant_id = snapshot.product_variant_id
 AND movement.stock_location_id = snapshot.stock_location_id
LEFT JOIN core.stock_location AS stock_location
  ON stock_location.tenant_id = snapshot.tenant_id AND stock_location.id = snapshot.stock_location_id
LEFT JOIN sales
  ON sales.tenant_id = snapshot.tenant_id
 AND sales.business_date = snapshot.snapshot_date
 AND sales.product_variant_id = snapshot.product_variant_id
 AND sales.location_id = stock_location.location_id
LEFT JOIN velocity
  ON velocity.tenant_id = snapshot.tenant_id
 AND velocity.business_date = snapshot.snapshot_date
 AND velocity.product_variant_id = snapshot.product_variant_id
 AND velocity.location_id = stock_location.location_id
LEFT JOIN LATERAL (
  SELECT assignment.product_category_id
  FROM core.product_category_assignment AS assignment
  WHERE assignment.tenant_id = snapshot.tenant_id
    AND assignment.product_variant_id = snapshot.product_variant_id
    AND assignment.effective_from <= snapshot.snapshot_at
    AND (assignment.effective_to IS NULL OR assignment.effective_to > snapshot.snapshot_at)
  ORDER BY assignment.effective_from DESC,assignment.id DESC LIMIT 1
) AS category ON true;

CREATE OR REPLACE VIEW mart.workforce_day_worker_location
WITH (security_barrier = true, security_invoker = true)
AS
WITH roster AS (
  SELECT tenant_id,business_date,location_id,worker_id,currency,sum(rostered_minutes)::bigint AS rostered_minutes
  FROM core.workforce_shift WHERE status NOT IN ('cancelled','voided')
  GROUP BY tenant_id,business_date,location_id,worker_id,currency
),
actual AS (
  SELECT tenant_id,business_date,location_id,worker_id,currency,
         sum(worked_minutes)::bigint AS worked_minutes,sum(overtime_minutes)::bigint AS overtime_minutes,sum(labour_cost)::numeric(19,4) AS labour_cost
  FROM core.workforce_time_entry WHERE status NOT IN ('rejected','voided')
  GROUP BY tenant_id,business_date,location_id,worker_id,currency
)
SELECT
  COALESCE(roster.tenant_id,actual.tenant_id) AS tenant_id,
  md5(concat_ws('|',COALESCE(roster.tenant_id,actual.tenant_id),COALESCE(roster.business_date,actual.business_date),COALESCE(roster.location_id,actual.location_id),COALESCE(roster.worker_id,actual.worker_id))) AS id,
  COALESCE(roster.business_date,actual.business_date) AS business_date,
  COALESCE(roster.location_id,actual.location_id) AS location_id,
  COALESCE(roster.worker_id,actual.worker_id) AS worker_id,
  COALESCE(roster.currency,actual.currency) AS currency,
  COALESCE(roster.rostered_minutes,0) AS rostered_minutes,
  COALESCE(actual.worked_minutes,0) AS worked_minutes,
  COALESCE(actual.overtime_minutes,0) AS overtime_minutes,
  actual.labour_cost
FROM roster FULL OUTER JOIN actual
  ON actual.tenant_id = roster.tenant_id AND actual.business_date = roster.business_date
 AND actual.location_id = roster.location_id AND actual.worker_id = roster.worker_id AND actual.currency=roster.currency;

CREATE OR REPLACE VIEW mart.finance_day_location
WITH (security_barrier = true, security_invoker = true)
AS
WITH journal AS (
  SELECT
    line.tenant_id,line.business_date,line.location_id,line.legal_entity_id,line.gl_account_id,line.tax_code_id,
    sum(CASE WHEN account.account_class = 'revenue' THEN line.credit_amount-line.debit_amount ELSE 0 END)::numeric(19,4) AS accrued_revenue,
    sum(CASE WHEN account.account_class = 'cost_of_sales' THEN line.debit_amount-line.credit_amount ELSE 0 END)::numeric(19,4) AS cost_of_sales,
    sum(CASE WHEN account.account_class = 'operating_expense' THEN line.debit_amount-line.credit_amount ELSE 0 END)::numeric(19,4) AS operating_expenses,
    sum(CASE WHEN account.account_class NOT IN ('revenue','cost_of_sales','operating_expense','asset','liability','equity') THEN line.debit_amount-line.credit_amount ELSE 0 END)::numeric(19,4) AS other_net_expenses,
    sum(CASE WHEN tax.input_or_output IN ('output','both') THEN line.tax_amount ELSE 0 END)::numeric(19,4) AS gst_collected,
    sum(CASE WHEN tax.input_or_output IN ('input','both') THEN line.tax_amount ELSE 0 END)::numeric(19,4) AS gst_paid
  FROM core.finance_journal_line AS line
  JOIN core.gl_account AS account ON account.tenant_id=line.tenant_id AND account.id=line.gl_account_id
  LEFT JOIN core.tax_code AS tax ON tax.tenant_id=line.tenant_id AND tax.id=line.tax_code_id
  WHERE line.status NOT IN ('voided','deleted')
  GROUP BY line.tenant_id,line.business_date,line.location_id,line.legal_entity_id,line.gl_account_id,line.tax_code_id
),
bank AS (
  SELECT tenant_id,business_date,location_id,legal_entity_id,gl_account_id,
         sum(amount) FILTER (WHERE amount > 0)::numeric(19,4) AS cash_receipts
  FROM core.finance_bank_transaction WHERE status NOT IN ('voided','deleted')
  GROUP BY tenant_id,business_date,location_id,legal_entity_id,gl_account_id
),
invoice AS (
  SELECT tenant_id,business_date,location_id,legal_entity_id,
    sum(outstanding_amount) FILTER (WHERE invoice_type='sales_invoice')::numeric(19,4) AS receivables_outstanding,
    sum(outstanding_amount) FILTER (WHERE invoice_type='supplier_bill')::numeric(19,4) AS payables_outstanding
  FROM core.finance_invoice_line WHERE status NOT IN ('voided','deleted')
  GROUP BY tenant_id,business_date,location_id,legal_entity_id
)
SELECT
  journal.tenant_id,md5(concat_ws('|','journal',journal.tenant_id,journal.business_date,journal.location_id,journal.legal_entity_id,journal.gl_account_id,journal.tax_code_id)) AS id,
  journal.business_date,journal.location_id,journal.legal_entity_id,journal.gl_account_id,journal.tax_code_id,
  journal.accrued_revenue AS accrued_revenue,0::numeric(19,4) AS cash_receipts,
  journal.operating_expenses AS operating_expenses,journal.cost_of_sales AS cost_of_sales,journal.other_net_expenses AS other_net_expenses,
  journal.gst_collected AS gst_collected,journal.gst_paid AS gst_paid,
  0::numeric(19,4) AS receivables_outstanding,0::numeric(19,4) AS payables_outstanding
FROM journal
UNION ALL
SELECT
  bank.tenant_id,md5(concat_ws('|','bank',bank.tenant_id,bank.business_date,bank.location_id,bank.legal_entity_id,bank.gl_account_id)),
  bank.business_date,bank.location_id,bank.legal_entity_id,bank.gl_account_id,NULL::text,
  0::numeric(19,4),COALESCE(bank.cash_receipts,0),0::numeric(19,4),0::numeric(19,4),0::numeric(19,4),
  0::numeric(19,4),0::numeric(19,4),0::numeric(19,4),0::numeric(19,4)
FROM bank
UNION ALL
SELECT
  invoice.tenant_id,md5(concat_ws('|','invoice',invoice.tenant_id,invoice.business_date,invoice.location_id,invoice.legal_entity_id)),
  invoice.business_date,invoice.location_id,invoice.legal_entity_id,NULL::text,NULL::text,
  0::numeric(19,4),0::numeric(19,4),0::numeric(19,4),0::numeric(19,4),0::numeric(19,4),
  0::numeric(19,4),0::numeric(19,4),COALESCE(invoice.receivables_outstanding,0),COALESCE(invoice.payables_outstanding,0)
FROM invoice;

CREATE OR REPLACE VIEW mart.workforce_sales_aligned
WITH (security_barrier = true, security_invoker = true)
AS
WITH sales AS (
  SELECT tenant_id,business_date,location_id,worker_id,sum(signed_net_amount_ex_tax)::numeric(19,4) AS net_sales_ex_gst
  FROM mart.commerce_sales_event WHERE NOT voided AND NOT internal_transaction
  GROUP BY tenant_id,business_date,location_id,worker_id
),
labour AS (
  SELECT tenant_id,business_date,location_id,worker_id,
         sum(worked_minutes)::numeric / 60 AS worked_hours,sum(labour_cost)::numeric(19,4) AS labour_cost
  FROM mart.workforce_day_worker_location GROUP BY tenant_id,business_date,location_id,worker_id
)
SELECT
  COALESCE(sales.tenant_id,labour.tenant_id) AS tenant_id,
  md5(concat_ws('|',COALESCE(sales.tenant_id,labour.tenant_id),COALESCE(sales.business_date,labour.business_date),COALESCE(sales.location_id,labour.location_id),COALESCE(sales.worker_id,labour.worker_id))) AS id,
  COALESCE(sales.business_date,labour.business_date) AS business_date,
  COALESCE(sales.location_id,labour.location_id) AS location_id,
  COALESCE(sales.worker_id,labour.worker_id) AS worker_id,
  labour.labour_cost,COALESCE(labour.worked_hours,0) AS worked_hours,COALESCE(sales.net_sales_ex_gst,0)::numeric(19,4) AS net_sales_ex_gst
FROM sales FULL OUTER JOIN labour
  ON labour.tenant_id=sales.tenant_id AND labour.business_date=sales.business_date
 AND labour.location_id=sales.location_id AND labour.worker_id IS NOT DISTINCT FROM sales.worker_id;

CREATE OR REPLACE VIEW mart.reconciliation_aligned
WITH (security_barrier = true, security_invoker = true)
AS
WITH pos AS (
  SELECT tenant_id,business_date,location_id,sum(signed_net_amount_ex_tax)::numeric(19,4) AS pos_net_sales_ex_gst
  FROM mart.commerce_sales_event WHERE NOT voided AND NOT internal_transaction GROUP BY tenant_id,business_date,location_id
),
ledger AS (
  SELECT tenant_id,business_date,location_id,sum(accrued_revenue)::numeric(19,4) AS ledger_accrued_revenue
  FROM mart.finance_day_location GROUP BY tenant_id,business_date,location_id
)
SELECT
  COALESCE(pos.tenant_id,ledger.tenant_id) AS tenant_id,
  md5(concat_ws('|',COALESCE(pos.tenant_id,ledger.tenant_id),COALESCE(pos.business_date,ledger.business_date),COALESCE(pos.location_id,ledger.location_id))) AS id,
  COALESCE(pos.business_date,ledger.business_date) AS business_date,
  COALESCE(pos.location_id,ledger.location_id) AS location_id,
  COALESCE(pos.pos_net_sales_ex_gst,0)::numeric(19,4) AS pos_net_sales_ex_gst,
  COALESCE(ledger.ledger_accrued_revenue,0)::numeric(19,4) AS ledger_accrued_revenue
FROM pos FULL OUTER JOIN ledger
  ON ledger.tenant_id=pos.tenant_id AND ledger.business_date=pos.business_date AND ledger.location_id IS NOT DISTINCT FROM pos.location_id;

CREATE TABLE IF NOT EXISTS semantic_internal.pipeline_stats_projection_outbox (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)), snapshot_at timestamptz NOT NULL, domain text NOT NULL,
  source_rows bigint NOT NULL, canonical_rows bigint NOT NULL, rejected_rows bigint NOT NULL,
  observed_entities bigint NOT NULL, linked_entities bigint NOT NULL,
  source_watermarks jsonb NOT NULL, invariant_status jsonb NOT NULL,
  published_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,snapshot_at,domain)
);
ALTER TABLE semantic_internal.pipeline_stats_projection_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_internal.pipeline_stats_projection_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON semantic_internal.pipeline_stats_projection_outbox;
CREATE POLICY tenant_isolation ON semantic_internal.pipeline_stats_projection_outbox
USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id());

CREATE OR REPLACE FUNCTION mart.refresh_tenant_day_marts(p_tenant_id text,p_from date,p_to date)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,mart AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501'; END IF;
  IF p_to < p_from OR p_to-p_from > 400 THEN RAISE EXCEPTION 'invalid mart refresh range' USING ERRCODE='22023'; END IF;

  DELETE FROM mart.sales_day_location WHERE tenant_id=p_tenant_id AND business_date BETWEEN p_from AND p_to;
  INSERT INTO mart.sales_day_location (
    tenant_id,business_date,location_id,currency,gross_takings_inc_gst,net_sales_ex_gst,units_sold,transactions,discount_amount,refund_amount_inc_tax,total_cost,refreshed_at
  )
  SELECT tenant_id,business_date,location_id,currency,
    sum(signed_net_amount_inc_tax),sum(signed_net_amount_ex_tax),sum(signed_quantity),
    count(DISTINCT sale_order_id) FILTER (WHERE event_kind='sale'),sum(discount_amount),sum(refund_amount_inc_tax),sum(signed_total_cost),now()
  FROM mart.commerce_sales_event
  WHERE tenant_id=p_tenant_id AND business_date BETWEEN p_from AND p_to AND NOT voided AND NOT internal_transaction
  GROUP BY tenant_id,business_date,location_id,currency;

  DELETE FROM mart.labour_day_location WHERE tenant_id=p_tenant_id AND business_date BETWEEN p_from AND p_to;
  INSERT INTO mart.labour_day_location (
    tenant_id,business_date,location_id,currency,rostered_minutes,worked_minutes,overtime_minutes,labour_cost,refreshed_at
  )
  SELECT tenant_id,business_date,location_id,currency,sum(rostered_minutes),sum(worked_minutes),sum(overtime_minutes),sum(labour_cost),now()
  FROM mart.workforce_day_worker_location
  WHERE tenant_id=p_tenant_id AND business_date BETWEEN p_from AND p_to
  GROUP BY tenant_id,business_date,location_id,currency;
END $$;

CREATE OR REPLACE FUNCTION quality.snapshot_pipeline_stats(
  p_tenant_id text,p_snapshot_at timestamptz,p_domain text,p_source_rows bigint,p_canonical_rows bigint,p_rejected_rows bigint,
  p_observed_entities bigint,p_linked_entities bigint,p_source_watermarks jsonb,p_invariant_status jsonb
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,quality,semantic_internal AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501'; END IF;
  IF p_source_rows<0 OR p_canonical_rows<0 OR p_rejected_rows<0 OR p_observed_entities<0 OR p_linked_entities<0 THEN
    RAISE EXCEPTION 'pipeline counts must be non-negative' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_source_watermarks) <> 'object' OR jsonb_typeof(p_invariant_status) <> 'object' THEN
    RAISE EXCEPTION 'pipeline JSON values must be objects' USING ERRCODE='22023';
  END IF;
  INSERT INTO quality.pipeline_stats VALUES (
    p_tenant_id,p_snapshot_at,p_domain,p_source_rows,p_canonical_rows,p_rejected_rows,p_observed_entities,p_linked_entities,p_source_watermarks,p_invariant_status
  ) ON CONFLICT (tenant_id,snapshot_at,domain) DO NOTHING;
  INSERT INTO semantic_internal.pipeline_stats_projection_outbox (
    tenant_id,snapshot_at,domain,source_rows,canonical_rows,rejected_rows,observed_entities,linked_entities,source_watermarks,invariant_status
  ) VALUES (
    p_tenant_id,p_snapshot_at,p_domain,p_source_rows,p_canonical_rows,p_rejected_rows,p_observed_entities,p_linked_entities,p_source_watermarks,p_invariant_status
  ) ON CONFLICT (tenant_id,snapshot_at,domain) DO NOTHING;
END $$;

-- Core invariant checks write durable results and never interpolate identifiers.
CREATE OR REPLACE FUNCTION quality.run_domain_invariants(p_tenant_id text,p_run_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,quality AS $$
DECLARE line_failures bigint; journal_failures bigint; orders_without_observation bigint; total_orders bigint;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501'; END IF;
  IF NOT core.is_ulid(p_run_id) THEN RAISE EXCEPTION 'run id must be a ULID' USING ERRCODE='22023'; END IF;

  SELECT count(*) INTO line_failures FROM core.commerce_order_line
  WHERE tenant_id=p_tenant_id AND (
    abs((gross_amount-discount_amount)-net_amount_inc_tax)>0.0001 OR abs((net_amount_ex_tax+tax_amount)-net_amount_inc_tax)>0.0001
  );
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'line_maths','commerce',CASE WHEN line_failures=0 THEN 'passed' ELSE 'failed' END,line_failures,0,'{}',now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO journal_failures FROM (
    SELECT journal_id FROM core.finance_journal_line WHERE tenant_id=p_tenant_id
    GROUP BY journal_id HAVING abs(sum(debit_amount)-sum(credit_amount))>0.01
  ) AS unbalanced;
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'journal_balances','finance',CASE WHEN journal_failures=0 THEN 'passed' ELSE 'failed' END,journal_failures,0,'{}',now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;

  SELECT count(*) INTO total_orders FROM core.commerce_order WHERE tenant_id=p_tenant_id;
  SELECT count(*) INTO orders_without_observation FROM core.commerce_order AS order_row
  WHERE order_row.tenant_id=p_tenant_id AND NOT EXISTS (
    SELECT 1 FROM core.order_source_observation AS observation
    WHERE observation.tenant_id=order_row.tenant_id AND observation.order_id=order_row.id
  );
  INSERT INTO quality.check_result VALUES (
    p_tenant_id,p_run_id,'observation_coverage','canonical',
    CASE WHEN total_orders=0 OR (total_orders-orders_without_observation)::numeric/total_orders>=0.99 THEN 'passed' ELSE 'failed' END,
    CASE WHEN total_orders=0 THEN 1 ELSE (total_orders-orders_without_observation)::numeric/total_orders END,0.99,
    jsonb_build_object('orders_without_observation',orders_without_observation,'total_orders',total_orders),now()
  ) ON CONFLICT (tenant_id,run_id,check_id) DO UPDATE SET
    status=excluded.status,observed=excluded.observed,threshold=excluded.threshold,
    details=excluded.details,checked_at=excluded.checked_at;
END $$;

GRANT SELECT ON mart.commerce_sales_event,mart.customer_order_activity,mart.inventory_health_day,mart.workforce_day_worker_location,
  mart.finance_day_location,mart.workforce_sales_aligned,mart.reconciliation_aligned TO semantic_ro,transform_rw,diagnostic_ro;
GRANT SELECT,INSERT,UPDATE,DELETE ON semantic_internal.pipeline_stats_projection_outbox TO transform_rw;
GRANT EXECUTE ON FUNCTION mart.refresh_tenant_day_marts(text,date,date) TO transform_rw;
GRANT EXECUTE ON FUNCTION quality.snapshot_pipeline_stats(text,timestamptz,text,bigint,bigint,bigint,bigint,bigint,jsonb,jsonb) TO transform_rw;
GRANT EXECUTE ON FUNCTION quality.run_domain_invariants(text,text) TO transform_rw;

COMMIT;
