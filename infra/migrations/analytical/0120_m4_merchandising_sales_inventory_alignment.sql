BEGIN;

-- Sales and stock aligned on the product grain, for buying and range decisions
-- ("what should I stop stocking", "where is working capital tied up"). As with
-- the workforce alignment, this view is not the compiler's cross-fact execution
-- path: governed composite IR still aggregates each source fact independently
-- and full-outer-aligns the sub-aggregates. It exists so the declared aligned
-- fact is complete for catalogue, publication and reviewed diagnostics that
-- read the same semantic vocabulary.
CREATE OR REPLACE VIEW mart.merchandising_aligned
WITH (security_barrier = true, security_invoker = true)
AS
WITH sales AS (
  SELECT
    tenant_id,
    business_date,
    product_category_id,
    product_variant_id,
    sum(signed_net_amount_ex_tax)::numeric(19,4) AS net_sales_ex_gst,
    (
      sum(signed_net_amount_ex_tax)-sum(signed_total_cost)
    )::numeric(19,4) AS gross_margin,
    sum(signed_quantity)::numeric(19,4) AS units_sold
  FROM mart.commerce_sales_event
  WHERE NOT voided AND NOT internal_transaction
  GROUP BY tenant_id,business_date,product_category_id,product_variant_id
),
-- Stock on hand is a snapshot: take the latest observation per product rather
-- than summing across days, which would multiply the holding by its day count.
stock AS (
  SELECT DISTINCT ON (tenant_id,product_variant_id)
    tenant_id,
    business_date,
    product_category_id,
    product_variant_id,
    quantity_on_hand::numeric(19,4) AS stock_on_hand_units,
    stock_value::numeric(19,4) AS stock_on_hand_value
  FROM mart.inventory_health_day
  ORDER BY tenant_id,product_variant_id,snapshot_date DESC
)
SELECT
  coalesce(sales.tenant_id,stock.tenant_id) AS tenant_id,
  md5(concat_ws(
    '|',
    coalesce(sales.tenant_id,stock.tenant_id),
    coalesce(sales.business_date,stock.business_date),
    coalesce(sales.product_category_id,stock.product_category_id),
    coalesce(sales.product_variant_id,stock.product_variant_id)
  )) AS id,
  coalesce(sales.business_date,stock.business_date) AS business_date,
  coalesce(sales.product_category_id,stock.product_category_id) AS product_category_id,
  coalesce(sales.product_variant_id,stock.product_variant_id) AS product_variant_id,
  coalesce(sales.net_sales_ex_gst,0)::numeric(19,4) AS net_sales_ex_gst,
  sales.gross_margin,
  coalesce(sales.units_sold,0)::numeric(19,4) AS units_sold,
  coalesce(stock.stock_on_hand_units,0)::numeric(19,4) AS stock_on_hand_units,
  coalesce(stock.stock_on_hand_value,0)::numeric(19,4) AS stock_on_hand_value
FROM sales
FULL OUTER JOIN stock
  ON stock.tenant_id=sales.tenant_id
 AND stock.product_variant_id IS NOT DISTINCT FROM sales.product_variant_id
 AND stock.business_date=sales.business_date;

GRANT SELECT ON mart.merchandising_aligned
  TO semantic_ro,transform_rw,diagnostic_ro;

COMMIT;
