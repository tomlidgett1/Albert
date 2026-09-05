---
user_request: >
  What is our Xero Net Profit for a month, quarter, year or financial year to date?
recipe: true
presentation: fact
date_parameter: xero_profit_and_loss_analytics.period_start
answer_hint: >
  Lead with Xero Net Profit (or Net Loss) and the exact accrual period. State
  that it already includes wages and all posted expenses. If the selected range
  includes the current month, say it is month-to-date through report_updated_at.
answer_template: >
  For {{period}}, Xero Net Profit was **{{xero_profit_and_loss_analytics.net_profit|currency}}**
  on **{{xero_profit_and_loss_analytics.total_income|currency}}** income and
  **{{xero_profit_and_loss_analytics.total_expenses|currency}}** expenses
  (**{{xero_profit_and_loss_analytics.net_profit_margin_pct|percent}}** margin).
  Wage expenses in that result were **{{xero_profit_and_loss_analytics.wage_expenses|currency}}**.
follow_ups:
  - "What's my gross profit margin this year?"
  - "How much did wages reduce profit?"
  - "How much cash came in and went out this month?"
matches:
  - "What's my net profit this financial year so far?"
  - "What was our net profit last month?"
  - "Did we make a profit this quarter?"
  - "How profitable are we year to date?"
---

```json
{
  "measures": [
    "xero_profit_and_loss_analytics.total_income",
    "xero_profit_and_loss_analytics.total_expenses",
    "xero_profit_and_loss_analytics.wage_expenses",
    "xero_profit_and_loss_analytics.net_profit",
    "xero_profit_and_loss_analytics.net_profit_margin_pct",
    "xero_profit_and_loss_analytics.report_periods"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_profit_and_loss_analytics.period_start",
      "dateRange": "this financial year"
    }
  ]
}
```
