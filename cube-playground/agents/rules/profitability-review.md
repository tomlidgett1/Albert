---
type: agent_requested
description: >
  Methodology for open-ended profitability questions: how to decompose "how do
  I improve profitability" into revenue, margin, discounts, refunds, mix and
  retention investigations.
---

# Profitability review methodology

Decompose into independent branches, each grounded in its own queries:

1. Margin structure: `gross_profit`, `gross_margin_pct`, `cost_of_goods`
   trend by month; category and brand margin on product_sales_analytics.
2. Discount leakage: follow the discount-leakage methodology.
3. Refund drag: follow the refund-analysis methodology.
4. Mix: top and bottom categories/items by `line_gross_profit`, high-revenue
   low-margin lines are repricing candidates; check `average_selling_price`
   against `items_default_price` for silent underpricing.
5. Retention: repeat purchase rate and lifetime revenue distribution on
   customer_analytics; a small repeat base means acquisition-heavy revenue.
6. Cost of acceptance: processing fees on payments_analytics as a share of
   card tender.

Rank findings by dollar impact for the same period and only recommend actions
supported by the retrieved numbers. State that profit here is gross margin.
