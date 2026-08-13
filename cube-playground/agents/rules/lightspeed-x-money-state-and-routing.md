---
type: always
---

# Lightspeed Retail X-Series semantics and routing

Apply these rules whenever a result comes from a `lightspeed_x_*` view:

- Treat Lightspeed Retail X-Series as a distinct connector from Lightspeed
  R-Series. Never combine or join their records unless the user explicitly asks
  for a cross-system comparison and the response labels each source separately.
- API timestamps are UTC. Use the associated outlet timezone for trading-day
  questions; curated `business_date` members already do this. Use the retailer
  timezone only when no outlet is associated. Never reinterpret an already
  outlet-local business date.
- X-Series API monetary fields are decimal major-unit values, not integer minor
  units. Group monetary results by `currency_code` if more than one currency is
  possible. Never divide a curated amount by 100 and never add unlike currencies.
- Headline sales use `lightspeed_x_sales_analytics.net_sales_including_tax` over
  `sold_at` or outlet-local `business_date`. Only `state = closed` contributes.
  Closed return sales carry negative totals and subtract naturally. Parked,
  pending and voided sales may contain complete-looking totals but are not
  realised revenue.
- `gross_sales_including_tax` excludes return sales;
  `returns_including_tax` is their absolute value. Do not subtract returns again
  from `net_sales_including_tax`, and do not add `net_tax` to a tax-inclusive
  total.
- Gift-card load lines create stored-value liability rather than earned sales.
  Curated header and product sales exclude them. Gift-card redemption is a
  tender/liability movement, not new revenue. A `REVERSING` gift-card event has
  no safe direction without its related transaction, so the signed movement
  measure excludes it and reports its magnitude separately.
- Product/SKU/category/brand/supplier performance uses
  `lightspeed_x_product_sales_analytics`. `net_product_sales_excluding_tax` is
  signed, includes explicit line discounts and excludes the system discount
  product, so it is before unallocated sale-level discounts. Report
  `sale_level_discounts` separately; never allocate them across products unless
  the user explicitly requests an allocation rule. Realised cost/profit uses the
  cost recorded on the sale line, not current catalogue supply cost.
- Tender mix and collection/refund cashflow use
  `lightspeed_x_payments_analytics`. Positive payment amounts are collections;
  negative amounts are refund tenders. Payment totals do not replace sale
  revenue and payment surcharge metadata must not be added to revenue blindly.
- Return lifecycle/value uses `lightspeed_x_refunds_analytics`; only closed
  returns are realised. Returned products use the product view filtered by
  `is_return_line`; refund destination uses the payment view.
- Current inventory, gift-card balances, store-credit balances, customer
  account/loyalty balances and current catalogue/price-book values are snapshots.
  Aggregate them across entities at the current loaded state, never across API
  versions or ingestion observations.
- `current_inventory_level` is the API's available-to-sell stock.
  `quantity_to_procure` is demand for open fulfilments/service orders, not extra
  stock. A non-zero `reorder_amount` alone does not prove a reorder breach;
  filter `at_or_below_reorder_point` or use `reorder_point_breaches`.
- Manual/custom stock-adjustment reads and their custom reason definitions require
  the official `inventory:write` scope. Albert's read-only grant never requests
  that scope, so adjustment-event questions are Unavailable rather than inferred
  from current balances. Consignments and sales still expose their own documented
  operational activity; neither is a complete stock ledger.
- Consignment `type` controls meaning: SUPPLIER is a stock/purchase order,
  OUTLET a transfer, RETURN a supplier return, STOCKTAKE a stocktake. SENT is a
  notification state and does not itself create stock movement. Operational
  ordered cost is not accounting supplier spend; bills/payments/amounts owed
  belong in Xero.
- Fulfilment state and line quantities are current snapshots. The exposed
  created-to-updated cycle is an observed proxy, not exact delivery time; use
  history fields through the source explorer for transition-level questions.
- Each Service Order creates a corresponding sale. Service-order totals and line
  values are reference values and must never be added to sales revenue. Service
  statuses can be custom; a passed scheduled date is not automatically overdue.
- X-Series shifts are POS till-login time, not roster, award interpretation,
  payroll or fully loaded labour cost.
- Promotion action value is contextual: percent actions are rates and fixed
  actions are currency values. Never sum action values across definitions. One
  sale line can have multiple promotions, so applied-promotion analytics exposes
  discount and affected counts but not duplicated attributed revenue.
- Use `lightspeed_x_source_explorer` only when no curated view exposes the field.
  Filter one exact `parent_stream` or `source_object_type` and `field_path`, then
  use the typed value matching `value_type`. Never aggregate `number_value` until
  that documented path is known to be additive. A missing path means the API
  returned no value; do not infer or fabricate it.
- Curated views omit direct customer/user/supplier contacts, store addresses,
  card numbers, notes, audit value diffs, IP addresses and security details.
  The explorer can contain them. Reveal PII only when explicitly requested and
  tenant-authorised; otherwise aggregate, mask or omit it.
