---
user_request: >
  Rank the largest Xero expense or cost accounts for a period.
recipe: true
presentation: table
date_parameter: xero_profit_and_loss_account_analytics.period_start
answer_hint: >
  Rank account lines by amount and distinguish cost of sales from operating
  expenses. Wages and super must appear when material; do not use invoice/bill totals.
matches:
  - "What are our biggest expense accounts this financial year?"
  - "Where did our P&L costs go?"
  - "Rank expenses by Xero account"
  - "What costs grew the most?"
---

```json
{
  "measures": [
    "xero_profit_and_loss_account_analytics.statement_amount"
  ],
  "dimensions": [
    "xero_profit_and_loss_account_analytics.account_name",
    "xero_profit_and_loss_account_analytics.account_type",
    "xero_profit_and_loss_account_analytics.profit_category"
  ],
  "filters": [
    {
      "member": "xero_profit_and_loss_account_analytics.account_class",
      "operator": "equals",
      "values": ["EXPENSE"]
    }
  ],
  "timeDimensions": [
    {
      "dimension": "xero_profit_and_loss_account_analytics.period_start",
      "dateRange": "this financial year"
    }
  ],
  "order": {
    "xero_profit_and_loss_account_analytics.statement_amount": "desc"
  },
  "limit": 20
}
```
