BEGIN;

-- This compatibility view is not the compiler's cross-fact execution path;
-- governed composite IR still aggregates the two source facts independently.
-- Keep the declared aligned fact complete for catalogue/publication consumers
-- and any reviewed diagnostics that inspect the same semantic vocabulary.
CREATE OR REPLACE VIEW mart.workforce_sales_aligned
WITH (security_barrier = true, security_invoker = true)
AS
WITH sales AS (
  SELECT
    tenant_id,
    business_date,
    location_id,
    worker_id,
    sum(signed_net_amount_ex_tax)::numeric(19,4) AS net_sales_ex_gst,
    (
      sum(signed_net_amount_ex_tax)-sum(signed_total_cost)
    )::numeric(19,4) AS gross_margin
  FROM mart.commerce_sales_event
  WHERE NOT voided AND NOT internal_transaction
  GROUP BY tenant_id,business_date,location_id,worker_id
),
labour AS (
  SELECT
    tenant_id,
    business_date,
    location_id,
    worker_id,
    sum(worked_minutes)::numeric/60 AS worked_hours,
    sum(labour_cost)::numeric(19,4) AS labour_cost
  FROM mart.workforce_day_worker_location
  GROUP BY tenant_id,business_date,location_id,worker_id
)
SELECT
  coalesce(sales.tenant_id,labour.tenant_id) AS tenant_id,
  md5(concat_ws(
    '|',
    coalesce(sales.tenant_id,labour.tenant_id),
    coalesce(sales.business_date,labour.business_date),
    coalesce(sales.location_id,labour.location_id),
    coalesce(sales.worker_id,labour.worker_id)
  )) AS id,
  coalesce(sales.business_date,labour.business_date) AS business_date,
  coalesce(sales.location_id,labour.location_id) AS location_id,
  coalesce(sales.worker_id,labour.worker_id) AS worker_id,
  labour.labour_cost,
  coalesce(labour.worked_hours,0) AS worked_hours,
  coalesce(sales.net_sales_ex_gst,0)::numeric(19,4) AS net_sales_ex_gst,
  sales.gross_margin
FROM sales
FULL OUTER JOIN labour
  ON labour.tenant_id=sales.tenant_id
 AND labour.business_date=sales.business_date
 AND labour.location_id IS NOT DISTINCT FROM sales.location_id
 AND labour.worker_id IS NOT DISTINCT FROM sales.worker_id;

GRANT SELECT ON mart.workforce_sales_aligned
  TO semantic_ro,transform_rw,diagnostic_ro;

COMMIT;
