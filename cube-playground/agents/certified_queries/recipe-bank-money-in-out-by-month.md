---
user_request: >
  Cash in and cash out of the bank by month (bank activity trend).
recipe: true
presentation: line
date_parameter: xero_finance_analytics.cash_date
answer_hint: >
  Line chart with cash in and cash out as two series (extraYKeys); one sentence on the biggest month and the overall difference. Figures match Xero's "Cash in and out" tile (transfers excluded).
matches:
  - "Show money in and money out of the bank by month this year"
  - "How much money went out of the bank each month this year?"
  - "Bank activity by month"
  - "Cash in and out by month for the last 6 months"
---

```json
{
  "measures": [
    "xero_finance_analytics.cash_in",
    "xero_finance_analytics.cash_out"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_finance_analytics.cash_date",
      "granularity": "month",
      "dateRange": "this year"
    }
  ]
}
```
