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
  "dimensions": [
    "xero_profit_and_loss_analytics.currency"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_profit_and_loss_analytics.period_start",
      "dateRange": "this financial year"
    }
  ]
}
```
