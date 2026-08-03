BEGIN;

-- Overtime is nullable by design. No supported Deputy field provides an
-- auditable overtime split, so a stored zero would be fabricated evidence.
ALTER TABLE core.workforce_time_entry
  ALTER COLUMN overtime_minutes DROP DEFAULT,
  ALTER COLUMN overtime_minutes DROP NOT NULL;
ALTER TABLE mart.labour_day_location
  ALTER COLUMN overtime_minutes DROP NOT NULL;
UPDATE core.workforce_time_entry SET overtime_minutes = NULL;

-- Operational sales are recognised only after completion. Cost nullability is
-- preserved all the way to the semantic coverage gate.
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
  line.currency,
  line.order_status,
  (line.total_cost IS NOT NULL) AS cost_observed
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
WHERE line.order_status = 'completed'
  AND NOT line.voided
  AND NOT line.internal_transaction
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
  -refund.total_cost_reversed,
  refund.refund_amount_inc_tax,
  false,
  original.internal_transaction,
  refund.currency,
  original.order_status,
  (refund.total_cost_reversed IS NOT NULL)
FROM core.commerce_refund_line AS refund
JOIN core.commerce_order_line AS original
  ON original.tenant_id = refund.tenant_id
 AND original.id = refund.original_order_line_id
LEFT JOIN LATERAL (
  SELECT assignment.product_category_id
  FROM core.product_category_assignment AS assignment
  WHERE assignment.tenant_id = refund.tenant_id
    AND assignment.product_variant_id = refund.product_variant_id
    AND assignment.effective_from <= now()
    AND (assignment.effective_to IS NULL OR assignment.effective_to > now())
  ORDER BY assignment.effective_from DESC, assignment.id DESC
  LIMIT 1
) AS category ON true
WHERE original.order_status IN ('completed','refunded')
  AND NOT original.voided
  AND NOT original.internal_transaction;

-- One row per variant/location/calendar day. The latest observed balance is
-- carried only across bounded gaps between real daily observations; it is not
-- extrapolated beyond the latest snapshot. This makes ROWS windows calendar
-- windows and preserves unchanged days.
CREATE OR REPLACE VIEW mart.inventory_health_day
WITH (security_barrier = true, security_invoker = true)
AS
WITH snapshot_bounds AS (
  SELECT tenant_id,product_variant_id,stock_location_id,
         min(snapshot_date) AS first_snapshot_date,
         max(snapshot_date) AS last_snapshot_date
  FROM core.inventory_balance_snapshot
  GROUP BY tenant_id,product_variant_id,stock_location_id
),
dense_snapshot AS (
  SELECT
    bounds.tenant_id,
    bounds.product_variant_id,
    bounds.stock_location_id,
    day.calendar_date AS snapshot_date,
    observed.id AS observed_snapshot_id,
    observed.snapshot_at,
    observed.quantity_on_hand,
    observed.stock_value,
    observed.currency
  FROM snapshot_bounds AS bounds
  JOIN core.calendar_day AS day
    ON day.calendar_date BETWEEN bounds.first_snapshot_date AND bounds.last_snapshot_date
  JOIN LATERAL (
    SELECT snapshot.id,snapshot.snapshot_at,snapshot.quantity_on_hand,
           snapshot.stock_value,snapshot.currency
    FROM core.inventory_balance_snapshot AS snapshot
    WHERE snapshot.tenant_id = bounds.tenant_id
      AND snapshot.product_variant_id = bounds.product_variant_id
      AND snapshot.stock_location_id = bounds.stock_location_id
      AND snapshot.snapshot_date <= day.calendar_date
    ORDER BY snapshot.snapshot_date DESC,snapshot.snapshot_at DESC,snapshot.id DESC
    LIMIT 1
  ) AS observed ON true
),
movement AS (
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
    CASE
      WHEN count(*) = count(event.signed_total_cost)
      THEN sum(event.signed_total_cost)
      ELSE NULL
    END::numeric(19,4) AS cost_of_goods_sold
  FROM mart.commerce_sales_event AS event
  GROUP BY event.tenant_id,event.business_date,event.product_variant_id,event.location_id
),
dense_flow AS (
  SELECT
    snapshot.*,
    stock_location.location_id,
    COALESCE(sales.units_sold,0)::numeric(19,4) AS units_sold,
    sales.cost_of_goods_sold,
    COALESCE(movement.received_units,0)::numeric(19,4) AS received_units,
    COALESCE(movement.stocktake_variance_units,0)::numeric(19,4) AS stocktake_variance_units
  FROM dense_snapshot AS snapshot
  LEFT JOIN core.stock_location AS stock_location
    ON stock_location.tenant_id = snapshot.tenant_id
   AND stock_location.id = snapshot.stock_location_id
  LEFT JOIN sales
    ON sales.tenant_id = snapshot.tenant_id
   AND sales.business_date = snapshot.snapshot_date
   AND sales.product_variant_id = snapshot.product_variant_id
   AND sales.location_id IS NOT DISTINCT FROM stock_location.location_id
  LEFT JOIN movement
    ON movement.tenant_id = snapshot.tenant_id
   AND movement.business_date = snapshot.snapshot_date
   AND movement.product_variant_id = snapshot.product_variant_id
   AND movement.stock_location_id = snapshot.stock_location_id
),
daily AS (
  SELECT
    dense_flow.*,
    sum(units_sold) OVER (
      PARTITION BY tenant_id,product_variant_id,stock_location_id
      ORDER BY snapshot_date
      ROWS BETWEEN 29 PRECEDING AND CURRENT ROW
    ) / 30::numeric AS trailing_daily_units_sold
  FROM dense_flow
)
SELECT
  daily.tenant_id,
  md5(concat_ws('|','inventory-day',daily.tenant_id,daily.product_variant_id,daily.stock_location_id,daily.snapshot_date)) AS id,
  daily.snapshot_date,
  daily.snapshot_date AS business_date,
  daily.stock_location_id,
  daily.product_variant_id,
  category.product_category_id,
  daily.quantity_on_hand,
  daily.stock_value,
  daily.trailing_daily_units_sold::numeric(19,4),
  daily.units_sold,
  (daily.quantity_on_hand + daily.units_sold - daily.received_units)::numeric(19,4) AS opening_units,
  daily.received_units,
  daily.cost_of_goods_sold,
  daily.stocktake_variance_units,
  daily.currency
FROM daily
LEFT JOIN LATERAL (
  SELECT assignment.product_category_id
  FROM core.product_category_assignment AS assignment
  WHERE assignment.tenant_id = daily.tenant_id
    AND assignment.product_variant_id = daily.product_variant_id
    AND assignment.effective_from <= daily.snapshot_at
    AND (assignment.effective_to IS NULL OR assignment.effective_to > daily.snapshot_at)
  ORDER BY assignment.effective_from DESC,assignment.id DESC
  LIMIT 1
) AS category ON true;

-- Only approved actual work contributes to worked-time marts. Leave, pending
-- approvals and discarded records remain available canonically but not as work.
CREATE OR REPLACE VIEW mart.workforce_day_worker_location
WITH (security_barrier = true, security_invoker = true)
AS
WITH roster AS (
  SELECT tenant_id,business_date,location_id,worker_id,currency,
         sum(rostered_minutes)::bigint AS rostered_minutes
  FROM core.workforce_shift
  WHERE status NOT IN ('cancelled','voided')
  GROUP BY tenant_id,business_date,location_id,worker_id,currency
),
actual AS (
  SELECT tenant_id,business_date,location_id,worker_id,currency,
         sum(worked_minutes)::bigint AS worked_minutes,
         sum(overtime_minutes)::bigint AS overtime_minutes,
         sum(labour_cost)::numeric(19,4) AS labour_cost
  FROM core.workforce_time_entry
  WHERE status = 'approved'
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
  actual.overtime_minutes,
  actual.labour_cost
FROM roster
FULL OUTER JOIN actual
  ON actual.tenant_id = roster.tenant_id
 AND actual.business_date = roster.business_date
 AND actual.location_id = roster.location_id
 AND actual.worker_id = roster.worker_id
 AND actual.currency = roster.currency;

-- Posted/authorised facts only. Advanced Journals are authoritative over their
-- linked ManualJournal source documents. Non-applicable measures stay null so
-- snapshot and currency gates can identify the contributing rows precisely.
CREATE OR REPLACE VIEW mart.finance_day_location
WITH (security_barrier = true, security_invoker = true)
AS
WITH journal AS (
  SELECT
    line.tenant_id,line.business_date,line.location_id,line.legal_entity_id,
    line.gl_account_id,line.tax_code_id,line.currency,
    sum(CASE WHEN account.account_class = 'revenue' THEN line.credit_amount-line.debit_amount ELSE 0 END)::numeric(19,4) AS accrued_revenue,
    sum(CASE WHEN account.account_class = 'cost_of_sales' THEN line.debit_amount-line.credit_amount ELSE 0 END)::numeric(19,4) AS cost_of_sales,
    sum(CASE WHEN account.account_class = 'operating_expense' THEN line.debit_amount-line.credit_amount ELSE 0 END)::numeric(19,4) AS operating_expenses,
    sum(CASE WHEN account.account_class = 'unknown' THEN line.debit_amount-line.credit_amount ELSE 0 END)::numeric(19,4) AS other_net_expenses,
    sum(CASE WHEN tax.input_or_output IN ('output','both') THEN line.tax_amount ELSE 0 END)::numeric(19,4) AS gst_collected,
    sum(CASE WHEN tax.input_or_output IN ('input','both') THEN line.tax_amount ELSE 0 END)::numeric(19,4) AS gst_paid
  FROM core.finance_journal_line AS line
  JOIN core.gl_account AS account
    ON account.tenant_id = line.tenant_id AND account.id = line.gl_account_id
  LEFT JOIN core.tax_code AS tax
    ON tax.tenant_id = line.tenant_id AND tax.id = line.tax_code_id
  WHERE line.status = 'posted'
    AND NOT EXISTS (
      SELECT 1
      FROM core.event_link AS posting
      WHERE posting.tenant_id = line.tenant_id
        AND posting.link_type = 'accounting_posting_of'
        AND posting.from_object_type = 'Journals'
        AND posting.to_connection_id = line.primary_connection_id
        AND posting.to_object_type = 'ManualJournals'
        AND posting.to_source_record_id = line.journal_id
    )
  GROUP BY line.tenant_id,line.business_date,line.location_id,line.legal_entity_id,
           line.gl_account_id,line.tax_code_id,line.currency
),
bank AS (
  SELECT tenant_id,business_date,location_id,legal_entity_id,gl_account_id,currency,
         sum(amount) FILTER (WHERE amount > 0)::numeric(19,4) AS cash_receipts
  FROM core.finance_bank_transaction
  WHERE status IN ('authorised','paid','posted','reconciled')
  GROUP BY tenant_id,business_date,location_id,legal_entity_id,gl_account_id,currency
),
eligible_invoice AS (
  SELECT *,COALESCE(source_updated_at,updated_at) AS observed_at
  FROM core.finance_invoice_line
  WHERE status IN ('authorised','paid','posted','reconciled')
),
invoice_observation AS (
  SELECT tenant_id,legal_entity_id,location_id,max(observed_at)::date AS snapshot_date
  FROM eligible_invoice
  GROUP BY tenant_id,legal_entity_id,location_id
),
invoice AS (
  SELECT line.tenant_id,observation.snapshot_date AS business_date,
         line.location_id,line.legal_entity_id,line.currency,
         sum(line.outstanding_amount) FILTER (WHERE line.invoice_type='sales_invoice')::numeric(19,4) AS receivables_outstanding,
         sum(line.outstanding_amount) FILTER (WHERE line.invoice_type='supplier_bill')::numeric(19,4) AS payables_outstanding
  FROM eligible_invoice AS line
  JOIN invoice_observation AS observation
    ON observation.tenant_id = line.tenant_id
   AND observation.legal_entity_id = line.legal_entity_id
   AND observation.location_id IS NOT DISTINCT FROM line.location_id
  GROUP BY line.tenant_id,observation.snapshot_date,line.location_id,line.legal_entity_id,line.currency
)
SELECT
  journal.tenant_id,
  md5(concat_ws('|','journal',journal.tenant_id,journal.business_date,journal.location_id,journal.legal_entity_id,journal.gl_account_id,journal.tax_code_id,journal.currency)) AS id,
  journal.business_date,journal.location_id,journal.legal_entity_id,journal.gl_account_id,journal.tax_code_id,
  journal.accrued_revenue,NULL::numeric AS cash_receipts,
  journal.operating_expenses,journal.cost_of_sales,journal.other_net_expenses,
  journal.gst_collected,journal.gst_paid,
  NULL::numeric AS receivables_outstanding,
  NULL::numeric AS payables_outstanding,
  journal.currency
FROM journal
UNION ALL
SELECT
  bank.tenant_id,
  md5(concat_ws('|','bank',bank.tenant_id,bank.business_date,bank.location_id,bank.legal_entity_id,bank.gl_account_id,bank.currency)),
  bank.business_date,bank.location_id,bank.legal_entity_id,bank.gl_account_id,NULL::text,
  NULL::numeric(19,4),bank.cash_receipts::numeric,NULL::numeric(19,4),NULL::numeric(19,4),NULL::numeric(19,4),
  NULL::numeric(19,4),NULL::numeric(19,4),NULL::numeric,NULL::numeric,
  bank.currency
FROM bank
UNION ALL
SELECT
  invoice.tenant_id,
  md5(concat_ws('|','invoice',invoice.tenant_id,invoice.business_date,invoice.location_id,invoice.legal_entity_id,invoice.currency)),
  invoice.business_date,invoice.location_id,invoice.legal_entity_id,NULL::text,NULL::text,
  NULL::numeric(19,4),NULL::numeric,NULL::numeric(19,4),NULL::numeric(19,4),NULL::numeric(19,4),
  NULL::numeric(19,4),NULL::numeric(19,4),
  COALESCE(invoice.receivables_outstanding,0)::numeric,COALESCE(invoice.payables_outstanding,0)::numeric,
  invoice.currency
FROM invoice;

COMMIT;
