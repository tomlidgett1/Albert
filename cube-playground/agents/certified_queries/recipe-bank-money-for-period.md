---
user_request: >
  How much came into / went out of the bank in a period?
recipe: true
presentation: fact
date_parameter: xero_finance_analytics.bank_occurred_on
answer_hint: >
  One sentence with the figure asked for; note if the latest bank date is a few days behind.
matches:
  - "How much money came into the bank over the last 7 days?"
  - "Bank deposits last week"
  - "How much went out of the bank last month?"
---

```json
{
  "measures": [
    "xero_finance_analytics.money_in",
    "xero_finance_analytics.money_out",
    "xero_finance_analytics.bank_transaction_count"
  ],
  "timeDimensions": [
    {
      "dimension": "xero_finance_analytics.bank_occurred_on",
      "dateRange": "last 7 days"
    }
  ]
}
```
