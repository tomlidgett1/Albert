---
type: always
---

# Square money, state and routing

Apply these rules whenever a result comes from a `square_*` view:

- Square API Money values are integer base units paired with a Square Currency
  code. Curated currency measures apply a numeric exponent only when it is
  documented by the official ISO 4217 current list for that pinned Square
  Currency value. An unknown, historical-without-current-minor-unit, metal,
  accounting, test, crypto or future code returns a null curated money measure;
  use the source explorer to report its raw amount and code instead of guessing.
  Never divide a curated measure again and never assume every currency has two
  decimals; JPY has zero and BHD/KWD have three. Every query containing a money
  measure must filter to one same-grain currency member or include that member
  as a dimension. Use unprefixed `currency` for each view's base cube,
  `square_payment_fees_currency` for fee-entry measures and
  `square_payout_entries_currency` for payout-entry measures. Never add or
  compare numeric totals from different currencies, and never infer an exchange
  rate.
- Headline Square sales use `square_sales_analytics.net_order_value` over
  `closed_at`. Only `COMPLETED` orders count. `OPEN` and `DRAFT` orders can have
  fully populated totals, while `CANCELED` orders retain totals and a close time.
- Square order value is tax inclusive and includes tips and service charges.
  `net_order_value` subtracts Square order returns. Do not add `tax_collected`
  to it. State that definition when reporting revenue.
- Product/category/SKU questions use `square_product_sales_analytics`. Its
  current item measures do not subtract nested itemised return-line quantities;
  disclose this for return-sensitive product analysis. Gift-card load lines are
  stored-value liabilities and are excluded from earned product sales.
- Collected tender and payment-method questions use
  `square_payments_analytics.collected_amount`, status `COMPLETED`, over
  `created_at`. Payment total includes tip. Do not substitute payment takings for
  order revenue when the user asked for sales.
- Refund flow uses `square_refunds_analytics.refund_value` over `completed_at`.
  A PaymentRefund is a money-out event, not a product allocation. Never name the
  refunded product/category without an actual order-return line.
- Processing-fee members and payment members have different grains. Payout
  headers and payout-entry members also have different grains. Query one grain
  at a time and reconcile results in the answer.
- A Square payout is processor settlement evidence, not a bank transaction or
  accounting revenue. Use `PAID`, `arrival_date` and `end_to_end_id` for bank
  matching. Do not double count it against Xero bank receipts.
- Dispute money is current exposure, not automatically a realised expense or
  refund. Interpret it with the dispute state and evidence due date.
- Gift-card activation and load create stored-value liability, not earned
  revenue. Current gift-card balance is a snapshot; redemption settles the
  liability when the underlying sale occurs.
- Current inventory and loyalty balances are snapshots. Never sum them over
  time. Inventory direction comes from from/to state; `units_affected` is
  absolute rather than signed net movement.
- Square timecards are actual work, not roster or payroll.
  `estimated_labour_cost` uses the recorded wage rate and excludes overtime,
  taxes, benefits/super and payroll adjustments. Use
  `square_labour_sales_analytics` for ratios because it aggregates sales and
  labour to store-day before joining. A timecard without a wage currency is
  grouped once under its connection-scoped Square Location currency so its
  worked hours can still align to store sales; it does not create an estimated
  labour cost when the wage amount itself is absent. If any timecard in a
  store-day-currency group lacks a wage amount or a supported currency exponent,
  the group's estimated labour cost is null rather than a misleading partial sum.
- Square `source_name` is the application that last touched an order and can
  change over its lifecycle. Do not call it acquisition/origin channel.
- Use `square_source_explorer` only if no curated Square view exposes the field.
  Filter one exact `parent_stream` or `source_object_type` and `field_path`, then
  select the value member matching `value_type`. Never aggregate
  `number_value` until the exact documented field is fixed and known additive.
  A missing field means Square returned no value; do not infer or fabricate it.
- The explorer can contain customer/team contact data. Only reveal PII for an
  explicit, tenant-authorized request; otherwise aggregate or omit it.
