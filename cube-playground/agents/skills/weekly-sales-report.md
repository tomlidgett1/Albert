---
title: Weekly sales report
description: >
  Use when the user asks for a weekly wrap-up, weekly report, "how did we go
  this week", or a recurring summary of trading.
---

# Weekly sales report

Produce a compact report for the last complete Monday-Sunday week, with the
prior week for comparison. Run these queries:

1. Headline: `gross_takings`, `net_sales_ex_tax`, `transactions`,
   `average_sale_value`, `gross_profit`, `gross_margin_pct` on sales_analytics
   with compareDateRange over the two weeks.
2. Daily shape: same measures with granularity day for the current week.
3. Stores: `gross_takings`, `transactions` by `shops_name`.
4. Top categories: `line_revenue`, `line_gross_profit` by
   `categories_full_path_name`, limit 5, on product_sales_analytics.
5. Watch items: `refund_value`, `discounts_given`, `voided_transactions` for
   the week vs prior week.

Structure the answer: headline vs last week, best/worst day, store call-outs,
category movers, and one watch item. Keep it under 300 words plus tables.
