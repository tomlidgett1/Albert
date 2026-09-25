---
user_request: >
  Show Xero's Profit and Loss by month for a period.
recipe: true
presentation: table
date_parameter: xero_profit_and_loss_analytics.period_start
answer_hint: >
  Present monthly sales revenue, cost of sales, Gross Profit, operating
  expenses and Net Profit. Name the accrual basis and mark the current month as partial.
matches:
  - "Give me the P&L for this financial year split by month"
  - "Show monthly profit and loss"
  - "How has net profit trended each month?"
  - "Compare last quarter's profit to the quarter before"
---

```json
{
  "measures": [
    "xero_profit_and_loss_analytics.sales_revenue",
    "xero_profit_and_loss_analytics.cost_of_sales",
    "xero_profit_and_loss_analytics.gross_profit",
    "xero_profit_and_loss_analytics.operating_expenses",
    "xero_profit_and_loss_analytics.net_profit"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_profit_and_loss_analytics.period_start",
      "granularity": "month",
      "dateRange": "this financial year"
    }
  ],
  "order": {
    "xero_profit_and_loss_analytics.period_start": "asc"
  }
}
```
