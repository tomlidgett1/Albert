---
user_request: >
  Money in and money out of the bank by month (bank activity trend).
recipe: true
presentation: line
date_parameter: xero_finance_analytics.bank_occurred_on
answer_hint: >
  Line chart with money in and money out as two series (extraYKeys); one sentence on the biggest month.
matches:
  - "Show money in and money out of the bank by month this year"
  - "How much money went out of the bank each month this year?"
  - "Bank activity by month"
---

```json
{
  "measures": [
    "xero_finance_analytics.money_in",
    "xero_finance_analytics.money_out"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_finance_analytics.bank_occurred_on",
      "granularity": "month",
      "dateRange": "this year"
    }
  ]
}
```
