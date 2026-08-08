# Purchasing dimension — supplier orders, receiving, vendors

Primary tables: `ls_purchase_orders` · `ls_purchase_order_lines` · `ls_vendors` ·
`ls_item_vendor_nums` (supplier SKUs and buy costs) · `ls_catalog_vendor_items`
(supplier catalogues). `ls_order_shipments` / `_items` and `ls_vendor_returns` exist
but are **empty at this shop**.

## Purchasing rules

- **"Orders" from the owner almost never means POs** — customer demand is `ls_sales`.
  Only "on order", "ordered from <supplier>", "incoming stock" mean purchasing.
- **The PO id is `order_id`.** `ls_purchase_orders.order_id` is the primary key and
  `ls_purchase_order_lines.order_id` is the join key (with `order_line_id` as the line
  pk). There is no `purchase_order_id` column on either table.
- **PO state:** `ls_purchase_orders.complete` (boolean, live name — not `is_complete`)
  plus `archived`. Open POs: `complete = false AND NOT COALESCE(archived, false)`.
  Dates: `ordered_date`, `received_date` (on the header).
- **Line columns use vendor names:** `price` (unit buy cost), `original_price`,
  `vendor_cost`, `checked_in`, `num_received`, `total` — not `unit_cost` /
  `qty_checked_in` / `line_total` aliases.
- **Parent-projected line columns are NULL.** `vendor_id`, `shop_id`, `complete`,
  `ordered_date`, `received_date`, `archived` exist on `ls_purchase_order_lines` but
  are unpopulated — join `ls_purchase_orders` on `order_id` for all of them.
- **Vendor name** is `ls_purchase_orders.name` → prefer joining `ls_vendors` via
  `vendor_id` for the canonical vendor row. Vendors are suppliers;
  `ls_manufacturers` are brands. An item has one manufacturer, many possible vendors.
- **Receiving history** at this shop is on `ls_inventory_logs` (the shipments tables
  never synced) — a "what arrived last week" answer uses positive-quantity log entries,
  disclosed as movement-based.
- **`ls_catalog_vendor_items`** is what suppliers *could* ship — not owned, not on
  order, possibly foreign currency. Never mix it into PO or stock figures.

## Worked shape

"What's on order at the moment":

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_purchase_orders
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
SELECT po.order_id,
       COALESCE(v.name, po.name) AS vendor,
       po.ordered_date,
       po.total_quantity,
       SUM(l.quantity)           AS units_on_lines,
       SUM(l.quantity * l.price) AS order_value,
       SUM(l.num_received)       AS units_received
FROM source_lightspeed.ls_purchase_orders po
LEFT JOIN source_lightspeed.ls_purchase_order_lines l ON l.order_id = po.order_id
  AND l.mapping_version = (SELECT mv FROM pack) AND NOT l.tombstone
LEFT JOIN source_lightspeed.ls_vendors v ON v.vendor_id = po.vendor_id
  AND v.mapping_version = (SELECT mv FROM pack) AND NOT v.tombstone
WHERE po.mapping_version = (SELECT mv FROM pack) AND NOT po.tombstone
  AND po.complete = false
  AND NOT COALESCE(po.archived, false)
GROUP BY 1, 2, 3, 4
ORDER BY po.ordered_date DESC NULLS LAST;
```

**LEFT JOIN the lines, never inner-join:** verified live, the only open POs at this
shop are three 2018–19 drafts whose lines were never staged — an inner join silently
drops them and "what's on order" comes back empty. When the open list is old drafts
like these, say the shop has nothing currently on order and name the stale drafts,
rather than reporting zero.
