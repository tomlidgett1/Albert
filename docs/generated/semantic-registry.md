# Semantic registry 1.6.0

Generated from the registry. Do not hand-edit counts.

## Counts

- Metrics: 47
- Topics: 7
- commerce: 14
- composites: 5
- customers: 6
- finance: 9
- inventory: 7
- workforce: 6

## Metrics

- `commerce.gross_takings_inc_gst` — Completed sales including GST, net of refunds on the refund date.
- `commerce.tender_amount` — Captured POS tender value, net of tender refunds, on the operational trading date.
- `commerce.net_sales_ex_gst` — Completed sales excluding GST, with refunds subtracting when they occur.
- `commerce.units_sold` — Signed units sold after refund quantities.
- `commerce.transactions` — Distinct completed commercial orders.
- `commerce.avg_order_value` — GST-inclusive sales divided by completed transactions.
- `commerce.items_per_transaction` — Signed units divided by completed transactions.
- `commerce.discount_amount` — Discount value granted on completed sale lines.
- `commerce.discount_rate` — Discount amount as a percentage of pre-discount gross value.
- `commerce.refund_amount` — GST-inclusive value refunded on the date of refund.
- `commerce.refund_rate` — Refund value as a percentage of sale value in the selected period.
- `commerce.gross_margin` — Net sales excluding GST less signed cost of goods sold.
- `commerce.gross_margin_pct` — Operational gross margin divided by net sales excluding GST.
- `commerce.sell_price_realisation` — Realised sale value as a percentage of pre-discount gross value.
- `customers.active_customers` — Distinct identified customers purchasing inside the tenant-defined active window.
- `customers.new_customers` — Identified customers placing their first observed completed order.
- `customers.returning_customer_rate` — Share of identified purchasing customers whose order was not their first.
- `customers.repeat_purchase_rate` — Share of identified customers with at least two completed purchases in the selected period.
- `customers.avg_customer_value` — Net sales excluding GST per identified purchasing customer.
- `customers.lapsed_customers` — Identified customers whose last purchase precedes the tenant-defined lapse cutoff.
- `inventory.stock_on_hand_units` — Latest quantity on hand in the selected period and grouping.
- `inventory.stock_on_hand_value` — Latest cost value of stock on hand.
- `inventory.stock_cover_days` — Latest stock units divided by total trailing demand per calendar day over the tenant-approved velocity window.
- `inventory.sell_through_rate` — Units sold divided by opening units plus received units.
- `inventory.inventory_turns` — Cost of goods sold divided by average inventory value.
- `inventory.days_out_of_stock` — Distinct days ending with zero or negative stock on hand.
- `inventory.stocktake_variance` — Signed stocktake adjustment quantity.
- `workforce.rostered_hours` — Planned shift minutes converted to hours.
- `workforce.worked_hours` — Approved worked minutes converted to hours.
- `workforce.labour_cost` — Actual labour cost attached to worked time.
- `workforce.overtime_hours` — Overtime minutes converted to hours.
- `workforce.average_hourly_cost` — Labour cost divided by actual worked hours.
- `workforce.roster_adherence` — Worked hours as a percentage of rostered hours.
- `finance.accrued_revenue` — Income recognised on posted accounting entries, excluding GST.
- `finance.cash_receipts` — Positive bank receipts in the selected period.
- `finance.operating_expenses` — Posted operating expenses excluding GST.
- `finance.gross_profit_accounting` — Accrued revenue less accounting cost of sales.
- `finance.net_profit` — Accounting gross profit less operating expenses and other net costs.
- `finance.gst_collected` — GST liability recognised on sales.
- `finance.gst_paid` — GST credits recognised on purchases and expenses.
- `finance.receivables_outstanding` — Outstanding customer invoice balance at the selected date.
- `finance.payables_outstanding` — Outstanding supplier bill balance at the selected date.
- `composites.labour_cost_pct_of_sales` — Labour cost divided by net sales excluding GST after independent aggregation and alignment.
- `composites.sales_per_labour_hour` — Net sales excluding GST divided by worked hours after independent aggregation and alignment.
- `composites.gross_profit_per_labour_hour` — Operational gross profit from POS line cost divided by worked hours after each fact is aggregated independently and aligned on canonical worker.
- `composites.pos_to_ledger_variance` — Operational net sales less accrued ledger revenue after daily location aggregation and alignment.
- `composites.pos_to_bank_variance` — Captured POS tenders less authoritative bank receipts after independent daily location aggregation and identity alignment.

## Topics

- `sales_performance` — Operational sales, baskets, discounts, refunds and margin.
- `customers_retention` — Identified customer activity and repeat behaviour.
- `inventory_health` — Stock position, velocity, availability and stocktake variance.
- `workforce_labour` — Rostered and actual time, overtime, cost and adherence.
- `profitability_cash` — Accounting revenue, profit, tax, cash and outstanding balances.
- `workforce_sales` — Sales and labour sub-aggregates aligned on approved shared dimensions.
- `reconciliation` — Orders, payments, journals and bank transactions independently aggregated and aligned.
