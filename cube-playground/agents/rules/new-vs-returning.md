---
type: agent_requested
description: >
  Definitions and method for new versus returning customer analysis, repeat
  purchase rate, and customer retention questions.
---

# New vs returning customers

- A customer is "new" in a period when their `customers_first_purchase_at`
  falls inside that period; otherwise a purchase from them is "returning".
- Repeat customers overall: `repeat_customers` and `repeat_purchase_rate_pct`
  on customer_analytics (share of purchasing customers with 2+ transactions).
- For a period split, run sales_analytics with `purchasing_customers` filtered
  by `customers_first_purchase_at` inside vs before the period.
- Walk-in sales with no attached customer cannot be classified: report the
  share of sales with `has_customer = false` alongside any new/returning
  split so the coverage is honest.
