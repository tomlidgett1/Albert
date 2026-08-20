---
user_request: >
  How much cash came into / went out of the bank in a period (cash in and out)?
recipe: true
presentation: fact
date_parameter: xero_finance_analytics.cash_date
answer_hint: >
  One sentence with cash in, cash out and the difference for the period (these match Xero's "Cash in and out" dashboard tile: bank transactions plus invoice and bill payments, transfers between own accounts excluded); note if the latest bank date is a few days behind.
matches:
  - "How much money came into the bank over the last 7 days?"
  - "Bank deposits last week"
  - "How much went out of the bank last month?"
  - "How much cash came in and went out over the last 6 months?"
  - "Cash in and out this month"
  - "What was our cash flow last month?"
---

```json
{
  "measures": [
    "xero_finance_analytics.cash_in",
    "xero_finance_analytics.cash_out",
    "xero_finance_analytics.net_cash_movement"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_finance_analytics.cash_date",
      "dateRange": "last 7 days"
    }
  ]
}
```
