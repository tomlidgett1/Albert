---
user_request: >
  How much is owed to us right now (accounts receivable outstanding and overdue)?
recipe: true
presentation: fact
answer_hint: >
  One or two sentences: total owed to us and the overdue part.
matches:
  - "How much is owed to us right now?"
  - "How much money is owed to us?"
  - "Outstanding invoices"
---

```json
{
  "measures": [
    "xero_finance_analytics.total_receivable_outstanding",
    "xero_finance_analytics.total_receivable_overdue"
  ]
}
```
