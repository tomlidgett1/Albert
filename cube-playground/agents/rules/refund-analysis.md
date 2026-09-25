---
type: agent_requested
description: >
  Methodology for analysing refunds and returns: refund rate, refund hotspots
  by store, staff, product or category, and refunded-tender reconciliation.
---

# Refund analysis methodology

1. Size the problem first: `refund_transactions` and `refund_value` against
   `transactions` and `gross_takings` for the same period. Refund rate =
   refund_transactions / transactions.
2. Locate hotspots by dimension, one query each: `shops_name`,
   `employees_full_name` on sales_analytics; `categories_full_path_name`,
   `items_name`, `manufacturers_name` with `units_returned` and `return_lines`
   on product_sales_analytics.
3. Money actually returned to customers by tender lives in payments_analytics
   (`refund_tender_total`). Header refund value and refunded tender can differ
   on exchanges: state which one you are quoting.
4. Compare the refund rate against the prior equivalent period before calling
   something a spike.
