-- mart.inventory_health_day aggregated the whole sales history and the whole
-- movement ledger on every read. Its movement and sales CTEs carried no bound,
-- and the outer date predicate cannot reach them: it filters snapshot_date,
-- which comes from dense_snapshot, so the planner has nothing to push down.
--
-- Measured on the dogfood tenant: the sales CTE alone takes 31s and builds
-- 67,861 groups spanning five years, to be joined against 33,935 dense rows
-- covering two days. A plain count(*) over the view then exceeds a 120s
-- statement timeout, and because the compiler renders last_value_over_time as
-- a correlated subquery over the same relation, the view is re-evaluated once
-- per row -- so every inventory question timed out.
--
-- Dense rows only exist inside a (variant, stock_location) snapshot span, and
-- both CTEs are joined on snapshot_date, so a row outside the overall span can
-- never match. Bounding them to that span is a restriction to rows the join
-- already discards, including for the 30-row trailing average, which reads
-- only dense rows. Semantics are unchanged.

BEGIN;

CREATE OR REPLACE VIEW mart.inventory_health_day
WITH (security_barrier = true, security_invoker = true)
AS
 WITH snapshot_bounds AS (
         SELECT inventory_balance_snapshot.tenant_id,
            inventory_balance_snapshot.product_variant_id,
            inventory_balance_snapshot.stock_location_id,
            min(inventory_balance_snapshot.snapshot_date) AS first_snapshot_date,
            max(inventory_balance_snapshot.snapshot_date) AS last_snapshot_date
           FROM core.inventory_balance_snapshot
          GROUP BY inventory_balance_snapshot.tenant_id, inventory_balance_snapshot.product_variant_id, inventory_balance_snapshot.stock_location_id
        ), dense_snapshot AS (
         SELECT bounds.tenant_id,
            bounds.product_variant_id,
            bounds.stock_location_id,
            day.calendar_date AS snapshot_date,
            observed.id AS observed_snapshot_id,
            observed.snapshot_at,
            observed.quantity_on_hand,
            observed.stock_value,
            observed.currency
           FROM snapshot_bounds bounds
             JOIN core.calendar_day day ON day.calendar_date >= bounds.first_snapshot_date AND day.calendar_date <= bounds.last_snapshot_date
             JOIN LATERAL ( SELECT snapshot.id,
                    snapshot.snapshot_at,
                    snapshot.quantity_on_hand,
                    snapshot.stock_value,
                    snapshot.currency
                   FROM core.inventory_balance_snapshot snapshot
                  WHERE snapshot.tenant_id = bounds.tenant_id AND snapshot.product_variant_id = bounds.product_variant_id AND snapshot.stock_location_id = bounds.stock_location_id AND snapshot.snapshot_date <= day.calendar_date
                  ORDER BY snapshot.snapshot_date DESC, snapshot.snapshot_at DESC, snapshot.id DESC
                 LIMIT 1) observed ON true
        ), movement AS (
         SELECT inventory_movement.tenant_id,
            inventory_movement.business_date,
            inventory_movement.product_variant_id,
            inventory_movement.stock_location_id,
            sum(inventory_movement.quantity_delta) FILTER (WHERE inventory_movement.movement_type = 'receipt'::text) AS received_units,
            sum(inventory_movement.quantity_delta) FILTER (WHERE inventory_movement.movement_type = 'stocktake'::text) AS stocktake_variance_units
           FROM core.inventory_movement
          WHERE inventory_movement.business_date >= (SELECT min(snapshot_bounds.first_snapshot_date) FROM snapshot_bounds)
            AND inventory_movement.business_date <= (SELECT max(snapshot_bounds.last_snapshot_date) FROM snapshot_bounds)
          GROUP BY inventory_movement.tenant_id, inventory_movement.business_date, inventory_movement.product_variant_id, inventory_movement.stock_location_id
        ), sales AS (
         SELECT event.tenant_id,
            event.business_date,
            event.product_variant_id,
            event.location_id,
            sum(event.signed_quantity) AS units_sold,
                CASE
                    WHEN count(*) = count(event.signed_total_cost) THEN sum(event.signed_total_cost)
                    ELSE NULL::numeric
                END::numeric(19,4) AS cost_of_goods_sold
           FROM mart.commerce_sales_event event
          WHERE event.business_date >= (SELECT min(snapshot_bounds.first_snapshot_date) FROM snapshot_bounds)
            AND event.business_date <= (SELECT max(snapshot_bounds.last_snapshot_date) FROM snapshot_bounds)
          GROUP BY event.tenant_id, event.business_date, event.product_variant_id, event.location_id
        ), dense_flow AS (
         SELECT snapshot.tenant_id,
            snapshot.product_variant_id,
            snapshot.stock_location_id,
            snapshot.snapshot_date,
            snapshot.observed_snapshot_id,
            snapshot.snapshot_at,
            snapshot.quantity_on_hand,
            snapshot.stock_value,
            snapshot.currency,
            stock_location.location_id,
            COALESCE(sales.units_sold, 0::numeric)::numeric(19,4) AS units_sold,
            sales.cost_of_goods_sold,
            COALESCE(movement.received_units, 0::numeric)::numeric(19,4) AS received_units,
            COALESCE(movement.stocktake_variance_units, 0::numeric)::numeric(19,4) AS stocktake_variance_units
           FROM dense_snapshot snapshot
             LEFT JOIN core.stock_location stock_location ON stock_location.tenant_id = snapshot.tenant_id AND stock_location.id = snapshot.stock_location_id
             LEFT JOIN sales ON sales.tenant_id = snapshot.tenant_id AND sales.business_date = snapshot.snapshot_date AND sales.product_variant_id = snapshot.product_variant_id AND NOT sales.location_id IS DISTINCT FROM stock_location.location_id
             LEFT JOIN movement ON movement.tenant_id = snapshot.tenant_id AND movement.business_date = snapshot.snapshot_date AND movement.product_variant_id = snapshot.product_variant_id AND movement.stock_location_id = snapshot.stock_location_id
        ), daily AS (
         SELECT dense_flow.tenant_id,
            dense_flow.product_variant_id,
            dense_flow.stock_location_id,
            dense_flow.snapshot_date,
            dense_flow.observed_snapshot_id,
            dense_flow.snapshot_at,
            dense_flow.quantity_on_hand,
            dense_flow.stock_value,
            dense_flow.currency,
            dense_flow.location_id,
            dense_flow.units_sold,
            dense_flow.cost_of_goods_sold,
            dense_flow.received_units,
            dense_flow.stocktake_variance_units,
            sum(dense_flow.units_sold) OVER (PARTITION BY dense_flow.tenant_id, dense_flow.product_variant_id, dense_flow.stock_location_id ORDER BY dense_flow.snapshot_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) / 30::numeric AS trailing_daily_units_sold
           FROM dense_flow
        )
 SELECT daily.tenant_id,
    md5(concat_ws('|'::text, 'inventory-day', daily.tenant_id, daily.product_variant_id, daily.stock_location_id, daily.snapshot_date)) AS id,
    daily.snapshot_date,
    daily.snapshot_date AS business_date,
    daily.stock_location_id,
    daily.product_variant_id,
    category.product_category_id,
    daily.quantity_on_hand,
    daily.stock_value,
    daily.trailing_daily_units_sold::numeric(19,4) AS trailing_daily_units_sold,
    daily.units_sold,
    (daily.quantity_on_hand + daily.units_sold - daily.received_units)::numeric(19,4) AS opening_units,
    daily.received_units,
    daily.cost_of_goods_sold,
    daily.stocktake_variance_units,
    daily.currency
   FROM daily
     LEFT JOIN LATERAL ( SELECT assignment.product_category_id
           FROM core.product_category_assignment assignment
          WHERE assignment.tenant_id = daily.tenant_id AND assignment.product_variant_id = daily.product_variant_id AND assignment.effective_from <= daily.snapshot_at AND (assignment.effective_to IS NULL OR assignment.effective_to > daily.snapshot_at)
          ORDER BY assignment.effective_from DESC, assignment.id DESC
         LIMIT 1) category ON true;;

GRANT SELECT ON mart.inventory_health_day TO semantic_ro,transform_rw,diagnostic_ro;

COMMIT;
