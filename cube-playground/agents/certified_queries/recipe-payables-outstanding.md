---
user_request: >
  How much do we currently owe suppliers (accounts payable outstanding and overdue)?
recipe: true
presentation: fact
answer_hint: >
  One or two sentences: total owed and how much of it is overdue.
matches:
  - "How much do we currently owe suppliers?"
  - "What do we owe?"
  - "How much is outstanding to suppliers?"
---

```json
{
  "measures": [
    "xero_finance_analytics.total_payable_outstanding",
    "xero_finance_analytics.total_payable_overdue"
  ]
}
```
