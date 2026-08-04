BEGIN;

-- Terminal quality reconciles every completed order against its captured
-- tenders.  PostgreSQL does not create an index for the order foreign key, so
-- the previous correlated aggregate rescanned the tenant's entire payment
-- table once per order.
CREATE INDEX IF NOT EXISTS commerce_payment_tenant_order_status_idx
  ON core.commerce_payment(tenant_id,order_id,status)
  INCLUDE (amount);

-- sales_day_location is the transactionally refreshed materialisation of the
-- same non-void, non-internal commerce_sales_event measure and grain used by
-- this view.  Reading it avoids rebuilding the complete POS event aggregate
-- every time a terminal quality check asks for the aligned reconciliation.
CREATE OR REPLACE VIEW mart.reconciliation_aligned
WITH (security_barrier=true,security_invoker=true)
AS
WITH pos AS (
  SELECT
    sales.tenant_id,
    sales.business_date,
    sales.location_id,
    sum(sales.net_sales_ex_gst)::numeric(19,4) AS pos_net_sales_ex_gst
  FROM mart.sales_day_location AS sales
  GROUP BY sales.tenant_id,sales.business_date,sales.location_id
),
ledger AS (
  SELECT
    finance.tenant_id,
    finance.business_date,
    finance.location_id,
    sum(finance.accrued_revenue)::numeric(19,4) AS ledger_accrued_revenue
  FROM mart.finance_day_location AS finance
  GROUP BY finance.tenant_id,finance.business_date,finance.location_id
)
SELECT
  coalesce(pos.tenant_id,ledger.tenant_id) AS tenant_id,
  md5(concat_ws(
    '|',
    coalesce(pos.tenant_id,ledger.tenant_id),
    coalesce(pos.business_date,ledger.business_date),
    coalesce(pos.location_id,ledger.location_id)
  )) AS id,
  coalesce(pos.business_date,ledger.business_date) AS business_date,
  coalesce(pos.location_id,ledger.location_id) AS location_id,
  coalesce(pos.pos_net_sales_ex_gst,0)::numeric(19,4) AS pos_net_sales_ex_gst,
  coalesce(ledger.ledger_accrued_revenue,0)::numeric(19,4) AS ledger_accrued_revenue
FROM pos
FULL OUTER JOIN ledger
  ON ledger.tenant_id=pos.tenant_id
 AND ledger.business_date=pos.business_date
 AND ledger.location_id IS NOT DISTINCT FROM pos.location_id;

COMMENT ON VIEW mart.reconciliation_aligned IS
  'Daily POS-to-ledger alignment over transactionally refreshed governed day marts.';

GRANT SELECT ON mart.reconciliation_aligned TO semantic_ro,transform_rw,diagnostic_ro;

COMMIT;
