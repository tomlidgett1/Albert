---
user_request: >
  What are Xero Gross Profit and Gross Profit margin for a period?
recipe: true
presentation: fact
date_parameter: xero_profit_and_loss_analytics.period_start
answer_hint: >
  Give sales revenue, cost of sales, Gross Profit and margin. Explain that
  ordinary operating wages are below Gross Profit; direct-cost wages are in COGS.
answer_template: >
  For {{period}}, Gross Profit was **{{xero_profit_and_loss_analytics.gross_profit|currency}}**
  on **{{xero_profit_and_loss_analytics.sales_revenue|currency}}** sales revenue after
  **{{xero_profit_and_loss_analytics.cost_of_sales|currency}}** cost of sales
  (**{{xero_profit_and_loss_analytics.gross_margin_pct|percent}}** gross margin).
follow_ups:
  - "What is our Xero Net Profit this financial year?"
  - "How much did we sell last month?"
  - "How much did wages reduce profit?"
matches:
  - "What's my gross profit margin this year?"
  - "Gross profit last month"
  - "How much did we make after cost of sales?"
---

```json
{
  "measures": [
    "xero_profit_and_loss_analytics.sales_revenue",
    "xero_profit_and_loss_analytics.cost_of_sales",
    "xero_profit_and_loss_analytics.gross_profit",
    "xero_profit_and_loss_analytics.gross_margin_pct"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_profit_and_loss_analytics.period_start",
      "dateRange": "this financial year"
    }
  ]
}
```
