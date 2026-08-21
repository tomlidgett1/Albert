---
type: agent_requested
description: >
  Definitions and method for new versus returning customer analysis, repeat
  purchase rate, and customer retention questions.
---

# New vs returning customers

- A customer is "new" in a period when their `customers_first_purchase_at`
  falls inside that period; otherwise a positive purchase from them is
  "returning". first_purchase_at and purchase_count exclude refunds.
- Repeat customers overall: `repeat_customers` and `repeat_purchase_rate_pct`
  on customer_analytics (share of purchasing profiles with 2+ positive
  purchases). This lifetime repeat rate is not cohort retention.
- For a period split, run sales_analytics with `purchasing_customers` filtered
  by `customers_first_purchase_at` inside vs before the period.
- Walk-in sales with no attached customer cannot be classified: report
  `identified_transaction_coverage_pct` and
  `identified_revenue_coverage_pct` for the same period alongside any
  new/returning split.
- "Is retention improving?" requires a like-for-like period mix or an explicit
  cohort/horizon. Do not call a changing new/returning sales mix causal evidence
  of retention, and do not invent a cohort metric the current view lacks.
