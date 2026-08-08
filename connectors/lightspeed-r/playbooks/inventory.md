# Inventory dimension — stock on hand, movement, ageing, stocktakes, catalogue

Primary tables: `ls_item_shops` (snapshot) · `ls_inventory_logs` (ledger) ·
`ls_items` / `ls_categories` (catalogue) · stocktake trio (`ls_inventory_count_calcs`,
`_items`, `_reconciles`) · `ls_special_orders` · `ls_serialized`.

## Grain rules

**Stock snapshot — `ls_item_shops`.** What is on the shelf **right now**. Overwritten in
place; there is no as-at date and no history. "How much stock did we hold in March" is
unanswerable from it. Key columns: `item_id`, `shop_id`, `qoh`,
`archived` (not `item_archived`), `time_stamp`. Whole-business stock uses
`shop_id = 0`; never sum `shop_id = 0` with per-shop rows.

**Names and costs are NOT on the stock row at this shop.** Verified live:
`ls_item_shops.description` and `ls_item_shops.avg_cost` are NULL on every row.
Always join `ls_items` on `item_id` for the name (`i.description`) and the cost
(`COALESCE(i.avg_cost, i.default_cost)`) — valuing stock from the snapshot's own
`avg_cost` prices the whole shop at $0 and the report looks plausible but says
nothing.

**Movement — `ls_inventory_logs`.** The only dated stock ledger (~127k rows). Reach for
it for "where did the stock go", shrinkage, receiving history, and **aged inventory**
(days since last quantity movement, via `ls_inventory_logs.create_time`). Never scan it
unfiltered — always bound by `item_id`, `shop_id` or a `create_time` range.

## Inventory traps

- **Movement dates cluster on system events, so age alone cannot rank items.**
  Verified live: 360 on-hand items share a last movement of 29 September 2025 and
  another 306 share 30 June 2026 — bulk imports and stocktakes, not sales. Sorting
  stale stock by days-since-movement produces mass ties broken arbitrarily, which
  surfaces $4 tubes ahead of $5,000 bikes. Rank stale stock by **value tied up**
  (`qoh * unit_cost DESC` within the stale window); days-since-movement is a
  column in the output, not the sort key. A cluster of identical dates in a result
  is a system event — say so rather than presenting it as real activity.
- **Zero-cost rows are missing data, not free stock.** A `COALESCE(avg_cost,
  default_cost)` of 0 usually means the cost was never recorded. Keep such items
  out of value rankings (they sort as $0 anyway) and mention them separately when
  they are old — an uncosted stale item is still a stale item.

- **`ls_item_shops.shop_id = 0` is an all-shops rollup, not a shop.** Verified: 17,005
  rollup rows and 17,005 real shop rows. Whole business → `shop_id = 0`. Per shop →
  `shop_id > 0`. Never both in one aggregate.
- **Stock value** is `qoh * COALESCE(i.avg_cost, i.default_cost)` (cost basis, from
  the joined `ls_items` row — see above). There is no staged selling price
  (`ls_item_prices` and `ls_items.amount_where_use_type_default` / `_msrp` are empty),
  so retail-value questions can only use historical charged prices from
  `ls_sale_lines.unit_price`, disclosed as such.
- **Stocktakes:** `ls_inventory_count_calcs` is system-vs-counted, `_items` is each
  counting act, `_reconciles` is the posted adjustment — **only the last one moves the
  books**.
- **`ls_serialized`** tracks bikes and frames by serial, but serials are often blank —
  identity lives in `description`.
- **`ls_special_orders`:** the follow-up list is `completed = false AND
  contacted = false`.
- **Archived items keep history.** Excluding `archived` rows is right for "what do we
  stock today", wrong for historical movement reports.
- **`ls_catalog_vendor_items`** is what suppliers *could* ship (not owned, not sold,
  possibly a different currency). Never count it as stock.

## Worked shape

"Give me an aged inventory report" — on-hand stock aged by last movement. Use
`ls_item_shops.archived` (never `item_archived`), `shop_id = 0` for the whole shop,
`ls_inventory_logs.create_time` for age (never `created_at`), and join `ls_items`
for names and costs:

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_item_shops
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
),
on_hand AS (
  SELECT s.item_id, i.description, s.qoh,
         COALESCE(i.avg_cost, i.default_cost, 0) AS unit_cost
  FROM source_lightspeed.ls_item_shops s
  JOIN source_lightspeed.ls_items i ON i.item_id = s.item_id
    AND i.mapping_version = (SELECT mv FROM pack) AND NOT i.tombstone
  WHERE s.mapping_version = (SELECT mv FROM pack)
    AND NOT s.tombstone
    AND s.shop_id = 0
    AND NOT COALESCE(s.archived, false)
    AND s.qoh <> 0
),
last_move AS (
  SELECT l.item_id, max(l.create_time) AS last_moved_at
  FROM source_lightspeed.ls_inventory_logs l
  WHERE l.mapping_version = (SELECT mv FROM pack)
    AND NOT l.tombstone
  GROUP BY 1
)
SELECT
  CASE
    WHEN m.last_moved_at IS NULL THEN 'No movement history'
    WHEN m.last_moved_at >= now() - interval '30 days' THEN '0-30 days'
    WHEN m.last_moved_at >= now() - interval '60 days' THEN '31-60 days'
    WHEN m.last_moved_at >= now() - interval '90 days' THEN '61-90 days'
    WHEN m.last_moved_at >= now() - interval '180 days' THEN '91-180 days'
    ELSE '180+ days'
  END AS age_band,
  count(*) AS skus,
  sum(o.qoh) AS units,
  sum(o.qoh * o.unit_cost) AS stock_value
FROM on_hand o
LEFT JOIN last_move m ON m.item_id = o.item_id
GROUP BY 1
ORDER BY min(coalesce(m.last_moved_at, '1970-01-01'::timestamptz));
```

The bands alone are half a report. Follow with the detail cut in the same turn —
the stalest stock ranked by value tied up, so the owner knows *which* items are the
problem (reuse the same `pack`, `on_hand`, `last_move` CTEs):

```sql
SELECT o.description, o.qoh, o.unit_cost,
       o.qoh * o.unit_cost AS stock_value,
       m.last_moved_at::date AS last_movement
FROM on_hand o
LEFT JOIN last_move m ON m.item_id = o.item_id
WHERE m.last_moved_at IS NULL OR m.last_moved_at < now() - interval '90 days'
ORDER BY o.qoh * o.unit_cost DESC
LIMIT 25
```

Then answer as a report: headline (how much stock value is sitting in the stale
bands), the band table, the stalest-items table, and what stands out.
