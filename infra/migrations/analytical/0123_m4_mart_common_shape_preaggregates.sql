-- Pre-aggregated common shapes, so the questions people actually ask land on
-- grains where fan-out is structurally impossible and the SQL-first linter is
-- only a backstop. Both are plain views over mart.commerce_sales_event: the
-- line-event view already owns completed/refund semantics and effective-dated
-- category assignment, so these cannot drift from it. Filters mirror the
-- governed net-sales contract (voided and internal transactions excluded).
--
-- Each view carries a text id unique at its own grain, which is what backs
-- the runtime fan-out canary's count(DISTINCT id) probe.

BEGIN;

CREATE OR REPLACE VIEW mart.sales_day
WITH (security_barrier = true, security_invoker = true) AS
SELECT
  event.tenant_id,
  event.business_date::text AS id,
  event.business_date,
  sum(event.signed_net_amount_inc_tax) AS gross_takings_inc_gst,
  sum(event.signed_net_amount_ex_tax) AS net_sales_ex_gst,
  sum(event.signed_net_amount_ex_tax) - sum(event.signed_total_cost) AS gross_margin,
  sum(event.signed_quantity) AS units_sold,
  count(DISTINCT event.sale_order_id) FILTER (WHERE event.event_kind = 'sale') AS transactions,
  sum(event.refund_amount_inc_tax) FILTER (WHERE event.event_kind = 'refund') AS refund_amount_inc_tax,
  sum(event.discount_amount) FILTER (WHERE event.event_kind = 'sale') AS discount_amount
FROM mart.commerce_sales_event AS event
WHERE event.voided = false AND event.internal_transaction = false
GROUP BY event.tenant_id, event.business_date;

CREATE OR REPLACE VIEW mart.sales_day_location_category
WITH (security_barrier = true, security_invoker = true) AS
SELECT
  event.tenant_id,
  event.business_date::text || ':' || event.location_id || ':' || coalesce(event.product_category_id, 'uncategorised') AS id,
  event.business_date,
  event.location_id,
  event.product_category_id,
  sum(event.signed_net_amount_inc_tax) AS gross_takings_inc_gst,
  sum(event.signed_net_amount_ex_tax) AS net_sales_ex_gst,
  sum(event.signed_net_amount_ex_tax) - sum(event.signed_total_cost) AS gross_margin,
  sum(event.signed_quantity) AS units_sold,
  count(DISTINCT event.sale_order_id) FILTER (WHERE event.event_kind = 'sale') AS transactions,
  sum(event.refund_amount_inc_tax) FILTER (WHERE event.event_kind = 'refund') AS refund_amount_inc_tax,
  sum(event.discount_amount) FILTER (WHERE event.event_kind = 'sale') AS discount_amount
FROM mart.commerce_sales_event AS event
WHERE event.voided = false AND event.internal_transaction = false
GROUP BY event.tenant_id, event.business_date, event.location_id, event.product_category_id;

GRANT SELECT ON mart.sales_day, mart.sales_day_location_category
  TO semantic_ro, transform_rw, diagnostic_ro;

COMMIT;
