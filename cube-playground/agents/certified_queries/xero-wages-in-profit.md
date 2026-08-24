---
user_request: >
  How much did mapped wages reduce Xero Net Profit for a period?
recipe: true
presentation: fact
date_parameter: xero_profit_and_loss_analytics.period_start
answer_hint: >
  Report mapped wage expense and Xero Net Profit for the same accrual period.
  Explain that Net Profit already deducts wages; before-wage profit is a clearly
  labelled scenario, not EBITDA. Do not include Wages Payable.
answer_template: >
  For {{period}}, mapped wage expenses of **{{xero_profit_and_loss_analytics.wage_expenses|currency}}**
  (plus **{{xero_profit_and_loss_analytics.employer_super_expenses|currency}}** employer super)
  are already in Xero Net Profit of **{{xero_profit_and_loss_analytics.net_profit|currency}}**.
  Profit before those mapped wages would be
  **{{xero_profit_and_loss_analytics.net_profit_before_mapped_wages|currency}}**.
follow_ups:
  - "What is our Xero Net Profit this financial year?"
  - "What did wages cost last month?"
  - "What's my gross profit margin this year?"
matches:
  - "Did net profit include wages?"
  - "How much did wages reduce profit?"
  - "What would profit be before wages?"
  - "Wages versus net profit this year"
---

```json
{
  "measures": [
    "xero_profit_and_loss_analytics.wage_expenses",
    "xero_profit_and_loss_analytics.employer_super_expenses",
    "xero_profit_and_loss_analytics.net_profit",
    "xero_profit_and_loss_analytics.net_profit_before_mapped_wages"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_profit_and_loss_analytics.period_start",
      "dateRange": "this financial year"
    }
  ]
}
```
