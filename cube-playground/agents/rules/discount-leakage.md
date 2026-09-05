---
type: agent_requested
description: >
  Methodology for analysing discount usage and margin leakage: which discount
  rules, staff, stores, products or categories give away the most margin.
---

# Discount leakage methodology

1. Total giveaway: `discounts_given` on sales_analytics and `line_discounts`
   on product_sales_analytics for the period, next to `gross_takings` and
   `gross_profit` so the leakage has a denominator.
2. Break down by the named discount rule (`discounts_name` on
   sales_analytics), then by `employees_full_name` and `shops_name` to find
   who applies them.
3. On product_sales_analytics, compare `line_discounts` with
   `line_gross_profit` by category or item: a heavily discounted line with
   thin margin is the leak.
4. Distinguish rule-based discounts from ad-hoc price overrides: overrides
   appear as discount amounts with no discount rule name attached.
